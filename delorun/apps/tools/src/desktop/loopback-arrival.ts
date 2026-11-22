/**
 * Measure whether a request that a Windows program sends to a Delorun home in WSL2 arrives as "this computer".
 * It starts a scratch home from this worktree inside WSL (mode 0700, a port in 18660–18679, a placeholder key that is never
 * sent), then calls `curl.exe` through WSL's Windows interop to sign in with a one-time link and to request a route that
 * the home guards with `requireComputerOrDevice`. A request the home places on its loopback listener passes that guard; any
 * other request is answered `403 LOOPBACK_REQUIRED`. Two controls hold the result steady over the same path: a request
 * with a foreign `Host` header must be refused, and a request sent from inside WSL must pass. The run reads
 * `wslinfo --networking-mode` and reports it. It never edits `.wslconfig`, never runs `wsl --shutdown`, never restarts WSL,
 * and builds and writes nothing under `/mnt/c`. Run from the repository root after `pnpm run build:artifacts`:
 *
 * `node_modules/.bin/tsx delorun/apps/tools/src/desktop/loopback-arrival.ts [--port <18660-18679>] [--keep]`
 *
 * Exit codes: 0 the Windows-side request arrived as loopback, 1 it did not or a control failed, 2 usage or the probe
 * could not run (no interop, no `curl.exe`).
 *
 * @module @delorun/tools/desktop/loopback-arrival
 */
import { execFile, spawn } from 'node:child_process'
import { appendFile, chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { setupDemoHome } from '../demo-home.ts'
import { packagesWithoutLib } from '../fresh-home-smoke.ts'

const exec = promisify(execFile)

/** The ports this probe may use, so it never touches an owner's studio. */
export const PROBE_PORT_RANGE = { first: 18660, last: 18679 } as const

/** A route guarded by `requireComputerOrDevice`: a request not placed on the loopback listener is refused. */
export const GUARDED_PATH = '/api/delorunPermission.everywhere'

/** How long the home gets to listen, in milliseconds. */
const LISTEN_TIMEOUT_MS = 180_000

/** One HTTP answer, as `curl.exe -i` prints it. */
export interface HttpAnswer {
  /** Status code; 0 when no answer was read. */
  readonly status: number
  /** Header names in lower case, each with its values. */
  readonly headers: Readonly<Record<string, readonly string[]>>
  /** Body text. */
  readonly body: string
}

/** Where a request arrived, as far as the guarded route shows. */
export type Arrival = 'loopback' | 'not-loopback' | 'inconclusive'

/**
 * Read the output of `curl.exe -s -i`.
 * @param output - Headers (CRLF), a blank line, then the body.
 * @returns the answer; status 0 when the text holds no status line.
 */
export function parseCurlOutput(output: string): HttpAnswer {
  const split = output.search(/\r?\n\r?\n/u)
  const head = split < 0 ? output : output.slice(0, split)
  const body = split < 0 ? '' : output.slice(split).replace(/^\r?\n\r?\n/u, '')
  const lines = head.split(/\r?\n/u)
  const status = Number(/^HTTP\/\S+ (\d{3})/u.exec(lines[0] ?? '')?.[1] ?? 0)
  const headers: Record<string, string[]> = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon > 0) (headers[line.slice(0, colon).toLowerCase()] ??= []).push(line.slice(colon + 1).trim())
  }
  return { status, headers, body }
}

/**
 * Classify the answer of the guarded route.
 * @param answer - The route's answer.
 * @returns `not-loopback` for `403` with `LOOPBACK_REQUIRED`, `loopback` for `200`, otherwise `inconclusive`.
 */
export function classifyArrival(answer: HttpAnswer): Arrival {
  if (answer.status === 403 && answer.body.includes('LOOPBACK_REQUIRED')) return 'not-loopback'
  return answer.status === 200 ? 'loopback' : 'inconclusive'
}

/**
 * The cookie header a sign-in answer sets.
 * @param answer - The sign-in answer, a `303` with `Set-Cookie`.
 * @returns `name=value` pairs joined for a `Cookie` header; `undefined` when the answer is not a sign-in.
 */
export function cookieOf(answer: HttpAnswer): string | undefined {
  const cookies = (answer.headers['set-cookie'] ?? []).map(each => each.split(';')[0] ?? '').filter(each => each !== '')
  return answer.status === 303 && cookies.length > 0 ? cookies.join('; ') : undefined
}

/**
 * Pick a free port in the probe's range.
 * @param wanted - The port asked for, if any.
 * @returns the port.
 * @throws when the wanted port is outside the range or taken, or none is free.
 */
export async function pickProbePort(wanted?: number): Promise<number> {
  const free = (port: number): Promise<boolean> => new Promise((done) => {
    const server = createServer()
    server.once('error', () => { done(false) })
    server.listen(port, '127.0.0.1', () => { server.close(() => { done(true) }) })
  })
  const { first, last } = PROBE_PORT_RANGE
  if (wanted !== undefined) {
    if (wanted < first || wanted > last) throw new Error(`port ${String(wanted)} is outside ${String(first)}-${String(last)}`)
    if (!await free(wanted)) throw new Error(`port ${String(wanted)} is in use`)
    return wanted
  }
  for (let port = first; port <= last; port++) if (await free(port)) return port
  throw new Error('no free port in the range')
}

/** The probe's outcome. */
export interface ProbeResult {
  /** Whether the Windows-side request arrived as loopback and both controls held. */
  readonly ok: boolean
  /** Whether the probe could run at all. */
  readonly ran: boolean
  /** What each step found, one line each. */
  readonly lines: readonly string[]
}

/** A Windows-side request through interop. */
async function windowsRequest(url: string, extra: readonly string[], cookie?: string): Promise<HttpAnswer> {
  const args = ['-s', '-i', '--max-time', '20', ...extra, ...cookie === undefined ? [] : ['-H', `Cookie: ${cookie}`], url]
  const { stdout } = await exec('curl.exe', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  return parseCurlOutput(stdout)
}

/**
 * Run the probe.
 * @param root - The repository root.
 * @param port - The home's port.
 * @param keep - Leave the scratch home in place.
 * @returns the outcome.
 */
export async function runProbe(root: string, port: number, keep: boolean): Promise<ProbeResult> {
  const lines: string[] = []
  const unbuilt = packagesWithoutLib(root)
  if (unbuilt.length > 0) return { ok: false, ran: false, lines: [`no lib/ in: ${unbuilt.join(', ')}; run pnpm run build:artifacts`] }
  const mode = await exec('wslinfo', ['--networking-mode']).then(result => result.stdout.trim(), () => 'unknown')
  lines.push(`WSL networking mode: ${mode}${mode === 'mirrored' ? '' : ' (mirrored mode not measured: it is not active)'}`)
  const version = await exec('curl.exe', ['--version'], { timeout: 20_000 }).then(result => result.stdout.split('\n')[0]?.trim() ?? '', () => undefined)
  if (version === undefined) return { ok: false, ran: false, lines: [...lines, 'curl.exe is not reachable through Windows interop; nothing measured'] }
  lines.push(`Windows client: ${version}`)
  const scratch = await mkdtemp(join(tmpdir(), 'delorun-arrival-'))
  await chmod(scratch, 0o700)
  const home = join(scratch, 'home')
  const tsx = join(root, 'node_modules', '.bin', 'tsx')
  const cli = join(root, 'delorun/apps/cli')
  const env = { ...process.env, HOME: scratch, DELORUN_HOME: home, DEMO_HOME_KEY: 'sk-demonstration-placeholder-never-sent', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
  let studio: ReturnType<typeof spawn> | undefined
  try {
    await setupDemoHome(root, home, scratch)
    await appendFile(join(home, 'profiles/default/cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${String(port)}\n`)
    studio = spawn(tsx, ['src/bin.ts', 'start', '--foreground'], { cwd: cli, env, stdio: ['ignore', 'ignore', 'ignore'] })
    const deadline = Date.now() + LISTEN_TIMEOUT_MS
    let listening = false
    while (Date.now() < deadline && !listening && studio.exitCode === null) {
      listening = await fetch(`http://127.0.0.1:${String(port)}/`).then(() => true, () => false)
      if (!listening) await new Promise(done => setTimeout(done, 1000))
    }
    if (!listening) return { ok: false, ran: false, lines: [...lines, `the scratch home never listened on ${String(port)}`] }
    const link = async (): Promise<string> => {
      const printed = (await exec(tsx, ['src/bin.ts', 'open', '--print'], { cwd: cli, env, timeout: 60_000 })).stdout.match(/http:\/\/127[^\s]+/u)?.[0]
      if (printed === undefined) throw new Error('delorun open --print printed no link')
      return printed
    }
    // From the Windows side: sign in with a one-time link, then ask the guarded route under each spelling of the address.
    const windowsCookie = cookieOf(await windowsRequest(await link(), []))
    lines.push(windowsCookie === undefined ? 'Windows sign-in with the one-time link: FAILED (no cookie)' : 'Windows sign-in with the one-time link: cookie received')
    if (windowsCookie === undefined) return { ok: false, ran: true, lines }
    const spellings = [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]
    const arrivals: Arrival[] = []
    for (const host of spellings) {
      const answer = await windowsRequest(`http://${host}${GUARDED_PATH}`, [], windowsCookie).catch(() => ({ status: 0, headers: {}, body: '' }))
      const arrival = classifyArrival(answer)
      arrivals.push(arrival)
      lines.push(`Windows curl.exe to ${host}: HTTP ${String(answer.status)} -> ${answer.status === 0 ? 'unreachable' : arrival}${answer.status === 401 ? ' (the sign-in cookie is bound to the address the link named, 127.0.0.1)' : ''}`)
    }
    // Control 1: a foreign Host header over the same path must not be admitted. The home's Host fence usually answers
    // before the route's arrival check, so any refusal counts; a 200 would mean the guard is not live on this path.
    const foreignAnswer = await windowsRequest(`http://127.0.0.1:${String(port)}${GUARDED_PATH}`, ['-H', 'Host: studio.example.test'], windowsCookie)
    const foreignRefused = foreignAnswer.status >= 400
    lines.push(`Control, Windows with a foreign Host header: HTTP ${String(foreignAnswer.status)}${foreignRefused ? ' (refused, as expected)' : ' (UNEXPECTED)'}`)
    // Control 2: a request from inside WSL, signed in with a fresh link, must pass.
    const inside = await fetch(await link(), { redirect: 'manual' })
    const insideCookie = inside.headers.getSetCookie().map(each => each.split(';')[0]).join('; ')
    const insideAnswer = await fetch(`http://127.0.0.1:${String(port)}${GUARDED_PATH}`, { headers: { cookie: insideCookie } })
    const insideArrival: Arrival = insideAnswer.status === 200 ? 'loopback' : 'inconclusive'
    lines.push(`Control, from inside WSL: HTTP ${String(insideAnswer.status)} -> ${insideArrival}${insideArrival === 'loopback' ? ' (as expected)' : ' (UNEXPECTED)'}`)
    const ok = arrivals[0] === 'loopback' && foreignRefused && insideArrival === 'loopback'
    lines.push(ok ? 'RESULT: a Windows request to 127.0.0.1 arrives as "this computer"' : 'RESULT: a Windows request to 127.0.0.1 did NOT arrive as "this computer", or a control failed')
    return { ok, ran: true, lines }
  } catch (error) {
    return { ok: false, ran: false, lines: [...lines, `the probe stopped: ${error instanceof Error ? error.message : String(error)}`] }
  } finally {
    await exec(tsx, ['src/bin.ts', 'stop'], { cwd: cli, env, timeout: 60_000 }).catch(() => undefined /* the home may already be gone; the kill below covers it */)
    if (studio !== undefined && studio.exitCode === null) {
      studio.kill('SIGTERM')
      await new Promise(done => setTimeout(done, 3000))
      if (studio.exitCode === null) studio.kill('SIGKILL')
    }
    if (!keep) await rm(scratch, { recursive: true, force: true })
    else lines.push(`kept ${scratch}`)
  }
}

/** Run the command line. */
async function main(): Promise<void> {
  let values: { port?: string | undefined, keep?: boolean | undefined }
  try {
    values = parseArgs({ options: { port: { type: 'string' }, keep: { type: 'boolean' } } }).values
  } catch (error) {
    process.stderr.write(`loopback-arrival: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
  const port = await pickProbePort(values.port === undefined ? undefined : Number(values.port))
  const result = await runProbe(root, port, values.keep === true)
  for (const line of result.lines) process.stdout.write(`loopback-arrival: ${line}\n`)
  process.exitCode = result.ok ? 0 : result.ran ? 1 : 2
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`loopback-arrival: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
