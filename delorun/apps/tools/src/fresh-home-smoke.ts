/**
 * Start the shipped studio from a fresh home and check that it comes up: a scratch home (mode 0700) is set up with a
 * placeholder key that is never sent, the studio runs from source on a pinned port in 18600–18619, and the check fails
 * when the port never listens, the log holds a start-up failure, or the onboarding guide's setup record does not answer.
 * It then stops the studio it started and removes the home. Run from the repository root after `pnpm run build:artifacts`:
 *
 * `node_modules/.bin/tsx delorun/apps/tools/src/fresh-home-smoke.ts [--port <18600-18619>] [--keep]`
 *
 * Exit codes: 0 the studio came up, 1 a check failed, 2 usage.
 *
 * @module @delorun/tools/fresh-home-smoke
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { appendFile, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { setupDemoHome } from './demo-home.ts'

const exec = promisify(execFile)

/** The ports a smoke run may use, so it never touches an owner's studio. */
export const PORT_RANGE = { first: 18600, last: 18619 } as const

/** The onboarding guide's setup record route, which answers once the plugin is loaded. */
export const SETUP_RECORD_PATH = '/api/delorunOnboarding.setupRecord'

/** How long the studio gets to listen, in milliseconds. */
const LISTEN_TIMEOUT_MS = 180_000

/** Log text that means the studio did not start or stopped. */
export const FAILURE_PATTERNS: readonly RegExp[] = [/failed to start/i, /failed to import/i, /\bstopped\b/i, /ValidationError/, /Cannot find (module|package)/, /ERR_MODULE_NOT_FOUND/]

/**
 * @param log - the studio's output.
 * @returns the first line that reports a start-up failure, or undefined when none does.
 */
export function failureLine(log: string): string | undefined {
  return log.split('\n').find(line => FAILURE_PATTERNS.some(pattern => pattern.test(line)))
}

/**
 * @param port - a port.
 * @returns whether nothing listens on it on the loopback address.
 */
async function isFree(port: number): Promise<boolean> {
  return await new Promise((done) => {
    const server = createServer()
    server.once('error', () => { done(false) })
    server.listen(port, '127.0.0.1', () => { server.close(() => { done(true) }) })
  })
}

/**
 * @param wanted - the port asked for, if any.
 * @returns a free port in the range; the wanted one when given.
 * @throws when the wanted port is outside the range or taken, or none is free.
 */
export async function pickPort(wanted?: number): Promise<number> {
  if (wanted !== undefined) {
    if (wanted < PORT_RANGE.first || wanted > PORT_RANGE.last) throw new Error(`port ${String(wanted)} is outside ${String(PORT_RANGE.first)}-${String(PORT_RANGE.last)}`)
    if (!await isFree(wanted)) throw new Error(`port ${String(wanted)} is in use`)
    return wanted
  }
  for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port++) if (await isFree(port)) return port
  throw new Error('no free port in the range')
}

/**
 * The Delorun packages whose manifest has a `build` script and which have no `lib/` directory: a build that failed
 * silently, or never ran, leaves the studio importing a file that is not there.
 * @param root - the repository root.
 * @returns the package directory names without a `lib/`.
 */
export function packagesWithoutLib(root: string): readonly string[] {
  const packages = join(root, 'delorun/packages')
  return readdirSync(packages).filter((name) => {
    const manifest = join(packages, name, 'package.json')
    if (!existsSync(manifest)) return false
    const scripts = (JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> }).scripts
    return scripts?.build !== undefined && !existsSync(join(packages, name, 'lib'))
  })
}

/** The smoke run's outcome. */
export interface SmokeResult {
  /** Whether every check passed. */
  readonly ok: boolean
  /** What each check found, one line each. */
  readonly lines: readonly string[]
}

/**
 * Run the smoke check.
 * @param root - the repository root.
 * @param port - the pinned port.
 * @param keep - leave the home in place.
 * @returns the outcome.
 */
export async function runSmoke(root: string, port: number, keep: boolean): Promise<SmokeResult> {
  const lines: string[] = []
  const unbuilt = packagesWithoutLib(root)
  if (unbuilt.length > 0) return { ok: false, lines: [`FAIL no lib/ in: ${unbuilt.join(', ')}; run the delorun packages build`] }
  const scratch = await mkdtemp(join(tmpdir(), 'delorun-smoke-'))
  await chmod(scratch, 0o700)
  const home = join(scratch, 'home')
  const tsx = join(root, 'node_modules', '.bin', 'tsx')
  const cli = join(root, 'delorun/apps/cli')
  const env = { ...process.env, HOME: scratch, DELORUN_HOME: home, DEMO_HOME_KEY: 'sk-demonstration-placeholder-never-sent', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
  let studio: ReturnType<typeof spawn> | undefined
  let log = ''
  try {
    await setupDemoHome(root, home, scratch)
    await appendFile(join(home, 'profiles/default/cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${String(port)}\n`)
    await writeFile(join(scratch, 'port'), String(port))
    studio = spawn(tsx, ['src/bin.ts', 'start', '--foreground'], { cwd: cli, env, stdio: ['ignore', 'pipe', 'pipe'] })
    studio.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString() })
    studio.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString() })
    const exited = new Promise<number | null>(done => { studio?.once('exit', code => { done(code) }) })
    const deadline = Date.now() + LISTEN_TIMEOUT_MS
    let listening = false
    while (Date.now() < deadline && !listening) {
      if (studio.exitCode !== null) break
      listening = await fetch(`http://127.0.0.1:${String(port)}/`).then(() => true, () => false)
      if (!listening) await new Promise(done => setTimeout(done, 1000))
    }
    lines.push(listening ? `listening on ${String(port)}` : `FAIL the studio never listened on ${String(port)}${studio.exitCode === null ? '' : ` (exited ${String(await exited)})`}`)
    const failure = failureLine(log)
    lines.push(failure === undefined ? 'log has no start-up failure' : `FAIL log: ${failure}`)
    let recordOk = false
    if (listening) {
      const link = (await exec(tsx, ['src/bin.ts', 'open', '--print'], { cwd: cli, env, timeout: 60_000 })).stdout.match(/http:\/\/127[^\s]+/)?.[0]
      const signedIn = link === undefined ? undefined : await fetch(link, { redirect: 'manual' })
      const cookie = signedIn?.headers.getSetCookie().map(each => each.split(';')[0]).join('; ')
      const record = cookie === undefined || cookie === '' ? undefined : await fetch(`http://127.0.0.1:${String(port)}${SETUP_RECORD_PATH}`, { headers: { cookie } })
      recordOk = record?.ok === true
      lines.push(recordOk ? 'the onboarding setup record answers' : `FAIL the onboarding setup record did not answer (${record === undefined ? 'could not sign in' : String(record.status)})`)
    }
    return { ok: listening && failure === undefined && recordOk, lines }
  } catch (error) {
    lines.push(`FAIL ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, lines }
  } finally {
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
    process.stderr.write(`fresh-home-smoke: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const port = await pickPort(values.port === undefined ? undefined : Number(values.port))
  const result = await runSmoke(root, port, values.keep === true)
  for (const line of result.lines) process.stdout.write(`fresh-home-smoke: ${line}\n`)
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`fresh-home-smoke: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
