/**
 * The update rehearsal: signs real local releases with the release tooling and walks a person's update journey on this
 * computer, outside the test harness. It builds release 1 as `build-closure.ts` does, derives the later releases from it,
 * signs and logs each with `local-release.ts`, serves the channel and the release log over HTTP on loopback (the launcher accepts `http:` only there, and the runtime
 * never inherits `NODE_EXTRA_CA_CERTS`, so a self-signed HTTPS channel cannot be updated from), packs `delorun/apps/npm-launcher` with those origins and the run's root,
 * and drives the packed launcher with `npx`. See "The rehearsal" in `delorun/apps/release/README.md`.
 *
 * `tsx delorun/apps/release/scripts/rehearsal.ts [--work <dir>] [--closure <dir>] [--candidate <dir>] [--only <id>,...] [--keep]`
 *
 * `--candidate` names a directory with another build's release-1 archive and file list: release 2 is that build, so the
 * update scenario runs from `--closure`'s release to the candidate and expects `--yes` to take it.
 *
 * `--windows` runs the Windows probe instead, from WSL: the packed launcher runs under the Windows `node.exe` in a folder
 * under the Windows temporary directory, which nothing outside is touched by, and must refuse before it downloads.
 * Releases publish no Windows runtime, so the probe needs no closure.
 *
 * @module rehearsal
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, chmodSync, statfsSync, createReadStream, statSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'

import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildBaseClosure, deriveInChild, launcher, publish, runTrust } from '../tests/journey/parts.ts'
import { runEntryAsync } from '../tests/local/support.ts'
import { freeLoopbackPort, serveJourneyLog } from '../tests/journey/servers.ts'

/** The releases: the first signed release, a later one, one whose Host never answers, one with a changed archive byte, a recovery release, and one that only a folder carries. */
const R1 = '0.1.0-rc.1'
const R2 = '0.1.0-rc.2'
const R3 = '0.1.0-rc.3'
const R4 = '0.1.0-rc.4'
const R5 = '0.1.0-rc.5'
const R6 = '0.1.0-rc.6'

/** The result of a finished command. */
interface Finished {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

const { values: options } = parseArgs({ options: { 'work': { type: 'string' }, 'closure': { type: 'string' }, 'candidate': { type: 'string' }, 'only': { type: 'string' }, 'keep': { type: 'boolean' }, 'windows': { type: 'boolean' } } })
const only = options.only?.split(',')
const work = resolve(options.work ?? mkdtempSync(join(tmpdir(), 'delorun-rehearsal-')))
mkdirSync(work, { recursive: true })
const personHome = join(work, 'person')
const home = join(personHome, 'delorun-home')
mkdirSync(join(personHome, '.local', 'bin'), { recursive: true })
const logFile = join(work, 'rehearsal.log')
const results: { id: string, title: string, ok: boolean, detail: string }[] = []

/**
 * Write a line to the console and the run's log.
 * @param line - the line.
 */
function say(line: string): void {
  process.stdout.write(`${line}\n`)
  appendFileSync(logFile, `${line}\n`)
}

/**
 * Run a command without blocking this process, because the servers the command talks to run in it.
 * @param command - the executable.
 * @param args - its arguments.
 * @param env - extra environment over the person's.
 * @param timeout - the limit in milliseconds.
 * @returns the status and output.
 */
function run(command: string, args: readonly string[], env: Readonly<Record<string, string>> = {}, timeout = 240_000): Promise<Finished> {
  return new Promise((done) => {
    const child = spawn(command, [...args], { env: { ...personEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('close', (status) => {
      clearTimeout(timer)
      appendFileSync(logFile, `$ ${command} ${args.join(' ')}\n[${String(status)}]\n${stdout}${stderr}\n`)
      done({ status, stdout, stderr })
    })
  })
}

/**
 * Run a command on a terminal, as a person types it, and answer its prompts.
 * @param command - the executable.
 * @param args - its arguments.
 * @param answers - when the output, without escapes, spaces and rules, matches `when`, send `send` as typed, once.
 * @param env - extra environment over the person's.
 * @returns the status and the terminal output.
 */
function terminal(command: string, args: readonly string[], answers: readonly { when: RegExp, send: string }[], env: Readonly<Record<string, string>> = {}): Promise<Finished> {
  return new Promise((done) => {
    const quoted = [command, ...args].map(part => `'${part.replaceAll('\'', '\'\\\'\'')}'`).join(' ')
    const child = spawn('script', ['-qfec', quoted, '/dev/null'], { env: { ...personEnv(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const sent = new Set<number>()
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      // A prompt that redraws one character at a time is matched on its text without escapes, spaces and rules.
      const squashed = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '').replace(/[\s│◆○●└]/gu, '')
      answers.forEach((answer, index) => {
        if (!sent.has(index) && answer.when.test(squashed)) {
          sent.add(index)
          child.stdin.write(answer.send)
        }
      })
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      appendFileSync(logFile, `$ (terminal) ${quoted}\n[${String(status)}]\n${out}\n`)
      done({ status, stdout: out.replaceAll('\r', ''), stderr: '' })
    })
  })
}

/** The environment of a person's shell: a home of their own, the pinned global command first on the path, Node 24, and trust in the rehearsal's certificate. */
function personEnv(): Record<string, string> {
  return {
    HOME: personHome,
    PATH: [join(personHome, '.local', 'bin'), dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
    LANG: 'C.UTF-8',
    DELORUN_HOME: home,
    DEEPSEEK_API_KEY: 'sk-rehearsal-throwaway',
    BROWSER: 'true',
    npm_config_cache: join(work, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    ...(clockOffsetMs === 0 ? {} : { NODE_OPTIONS: `--require=${join(work, 'clock-shim.cjs')}`, REHEARSAL_CLOCK_OFFSET_MS: String(clockOffsetMs) }),
  }
}

/** How far the person's clock is ahead of real time, for the clock scenario. */
let clockOffsetMs = 0

/**
 * Record a scenario's result and keep going.
 * @param id - the scenario's short name, for `--only`.
 * @param title - what it proves.
 * @param body - the steps; it returns a one-line detail and throws when the product did not do what the scenario expects.
 */
async function scenario(id: string, title: string, body: () => Promise<string>): Promise<void> {
  if (only !== undefined && !only.includes(id)) return
  say(`\n== ${id}: ${title}`)
  try {
    const detail = await body()
    results.push({ id, title, ok: true, detail })
    say(`PASS ${id}: ${detail}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    results.push({ id, title, ok: false, detail })
    say(`FAIL ${id}: ${detail}`)
  }
}

/**
 * Fail the scenario unless a condition holds.
 * @param condition - what must hold.
 * @param message - what to print otherwise.
 */
function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * The first lines of a command's output, for a scenario's detail.
 * @param finished - the finished command.
 * @returns the lines that are not npm's own, joined.
 */
function excerpt(finished: Finished): string {
  return `${finished.stdout}\n${finished.stderr}`.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('npm ')).slice(0, 4).join(' | ')
}

/**
 * The version of the home process, or `undefined` when none runs.
 * @returns the version.
 */
async function running(): Promise<string | undefined> {
  const answer = await run('delorun', ['status', '--json'])
  try {
    return (JSON.parse(answer.stdout) as { ok: boolean, status?: { runtime: { running: string } } }).status?.runtime.running
  } catch {
    // The output is not JSON when no home process runs; the caller treats that as not running.
    return undefined
  }
}

/** The version `delorun --version` prints. */
async function printedVersion(): Promise<string> {
  const answer = await run('delorun', ['--version'])
  return /Delorun? (\S+)/u.exec(answer.stdout)?.[1] ?? `(none: ${excerpt(answer)})`
}

/**
 * A static, restartable HTTP server on loopback over a channel directory.
 * @param directory - the directory.
 * @param port - the port, or 0 for any.
 * @returns the server's controls.
 */
function channelServer(directory: string, port = 0): { start(): Promise<void>, stop(): Promise<void>, origin(): string } {
  let bound = port
  let server: ReturnType<typeof createHttpServer> | undefined
  return {
    async start() {
      server = createHttpServer((request, response) => {
        const path = join(directory, new URL(request.url ?? '/', 'http://channel').pathname)
        if (!path.startsWith(`${directory}/`) || !existsSync(path) || !statSync(path).isFile()) {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { 'content-length': statSync(path).size })
        createReadStream(path).pipe(response)
      })
      await new Promise<void>(done => server!.listen(bound, '127.0.0.1', done))
      bound = (server.address() as AddressInfo).port
    },
    stop: () => new Promise<void>((done) => {
      server?.closeAllConnections()
      server?.close(() => done())
    }),
    origin: () => `http://127.0.0.1:${String(bound)}`,
  }
}

/** The preload that moves `Date` ahead by `REHEARSAL_CLOCK_OFFSET_MS`, standing in for a clock jump (no `faketime` is needed). */
const CLOCK_SHIM = `const offset = Number(process.env.REHEARSAL_CLOCK_OFFSET_MS ?? 0)
const RealDate = Date
class ShiftedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args) }
  static now() { return RealDate.now() + offset }
}
globalThis.Date = ShiftedDate
`

const MARKER = join(home, 'attachments', 'rehearsal-marker.txt')

/**
 * The files of a directory below another, relative.
 * @param directory - the directory.
 * @returns the names.
 */
function names(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : []
}

writeFileSync(join(work, 'clock-shim.cjs'), CLOCK_SHIM)
const trust = await runTrust(work)
const log = await serveJourneyLog(trust.trusted)
const channel = join(work, 'channel')
mkdirSync(channel)
const server = channelServer(channel)
await server.start()
say(`rehearsal: work ${work}; channel ${server.origin()} and log ${log.origin} (HTTP, loopback)`)

if (options.windows === true) {
  // The Windows probe: the packed launcher run by the Windows Node, which refuses before it downloads; a home on the Windows disk.
  const winNode = process.env['REHEARSAL_WINDOWS_NODE'] ?? '/mnt/c/nvm4w/nodejs/node.exe'
  const winTemp = execFileSync('wslpath', ['-u', execFileSync('cmd.exe', ['/c', 'echo %TEMP%'], { encoding: 'utf8', cwd: '/mnt/c' }).trim()], { encoding: 'utf8' }).trim()
  const winWork = join(winTemp, `delorun-rehearsal-${String(Date.now())}`)
  const winPath = (path: string): string => execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim()
  mkdirSync(join(winWork, 'home'), { recursive: true })
  const winLauncher = await launcher(trust, work, server.origin(), log.origin)
  execFileSync('tar', ['-xzf', winLauncher.tarball, '-C', winWork])
  const entry = winPath(join(winWork, 'package', 'dist', 'bin.js'))
  const winEnv = { ...process.env, DELORUN_HOME: winPath(join(winWork, 'home')), WSLENV: 'DELORUN_HOME/w:DEEPSEEK_API_KEY', DEEPSEEK_API_KEY: 'sk-rehearsal-throwaway' }
  const winRun = (args: readonly string[]): Promise<Finished> => new Promise((done) => {
    const child = spawn(winNode, [entry, ...args], { env: winEnv, stdio: ['ignore', 'pipe', 'pipe'], cwd: '/mnt/c' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      appendFileSync(logFile, `$ node.exe ${args.join(' ')}\n[${String(status)}]\n${stdout}${stderr}\n`)
      done({ status, stdout, stderr })
    })
  })
  await scenario('win-refuses', 'the packed launcher under the Windows Node stops before it downloads, names WSL2, and writes nothing into the home', async () => {
    const refused = await winRun(['--version'])
    const said = refused.stderr.includes('Delorun 0.1.0 runs in WSL2, not on native Windows. Nothing was downloaded.')
    expect(refused.status === 1 && said, `the launcher did not refuse: [${String(refused.status)}] ${excerpt(refused)}`)
    expect(readdirSync(join(winWork, 'home')).length === 0, 'the refusal wrote into the home')
    return excerpt(refused).slice(0, 300)
  })
  await log.close()
  const failedWindows = results.filter(result => !result.ok)
  say(`\nrehearsal (windows): ${String(results.length - failedWindows.length)} of ${String(results.length)} scenarios passed; Windows folder ${winWork}; log ${logFile}`)
  process.exit(failedWindows.length === 0 ? 0 : 1)
}

try {
  const base = await buildBaseClosure(work, R1, options.closure)
  const candidate = options.candidate === undefined ? undefined : await buildBaseClosure(work, R1, options.candidate)
  const derived = Promise.all([
    candidate === undefined ? deriveInChild(base, work, R2, 'bundle-row-disabled') : deriveInChild(candidate, work, R2, 'none'),
    deriveInChild(base, work, R3, 'studio-without-index'),
    deriveInChild(base, work, R4, 'tampered'),
    deriveInChild(base, work, R5, 'none'),
    deriveInChild(base, work, R6, 'none'),
  ]).then(([two, three, four, five, six]) => ({ [R1]: base.directory, [R2]: two, [R3]: three, [R4]: four, [R5]: five, [R6]: six }) as Record<string, string>)
  derived.catch(() => undefined)
  /**
   * Publish one release and delete its closure directory, which the channel now holds a copy of; the disk of a shared
   * machine holds many 190 MB archives otherwise.
   * @param target - the channel directory.
   * @param version - the release.
   * @param signer - the signer's trust.
   */
  async function publishRelease(version: string, target = channel, signer = trust): Promise<void> {
    await publish(signer, log, target, version, releases[version]!)
    if (version !== R1) rmSync(releases[version]!, { recursive: true, force: true })
  }

  await publish(trust, log, channel, R1, base.directory)
  const built = await launcher(trust, work, server.origin(), log.origin)
  const tarball = built.tarball
  const releases = await derived

  /**
   * Run the packed launcher as `npx <tarball>` does.
   * @param args - the arguments after the command.
   * @param env - extra environment.
   * @returns the finished run.
   */
  const npx = (args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<Finished> => run('npx', ['--yes', '--offline', `--package=${tarball}`, '--', 'delorun', ...args], env)

  await scenario('install', 'npx of the packed launcher installs release 1 over the local channel and verifies it', async () => {
    const first = await npx(['--version'])
    expect(first.status === 0, `install failed: ${excerpt(first)}`)
    const lines = first.stderr.split('\n').filter(line => line !== '' && !line.startsWith('npm '))
    expect(lines.length >= 5 && lines.some(line => line.startsWith('✔ Release log checked')), `unexpected progress lines: ${lines.join(' | ')}`)
    const record = JSON.parse(readFileSync(join(home, 'trust', 'release-log.json'), 'utf8')) as { releases: Record<string, { state: string }> }
    expect(record.releases[R1]?.state === 'verified', 'the release log check was not recorded as verified')
    return `${first.stdout.trim().split('\n')[0] ?? ''}; ${String(lines.length)} progress lines; log verified`
  })

  await scenario('setup', 'the pinned command is installed, setup runs non-interactively, and Delorun starts', async () => {
    const globalInstall = await run('npm', ['install', '--global', '--offline', '--prefix', join(personHome, '.local'), tarball])
    expect(globalInstall.status === 0, `npm install --global failed: ${excerpt(globalInstall)}`)
    const answers = join(work, 'answers.json')
    writeFileSync(answers, `${JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'safer', background: true, profile: { name: null, port: await freeLoopbackPort() }, reach: { option: 'none', identityFactor: null }, importStockHome: false }, undefined, 2)}\n`)
    const setup = await run('delorun', ['setup', '--config', answers])
    expect(setup.status === 0, `setup failed: ${excerpt(setup)}`)
    const started = await run('delorun', [])
    expect(started.status === 0, `start failed: ${excerpt(started)}`)
    const version = await running()
    expect(version === R1, `the home process runs ${String(version)}, not ${R1}`)
    mkdirSync(join(home, 'attachments'), { recursive: true })
    writeFileSync(MARKER, 'a file of the person\'s, outside the program store\n')
    return `setup exit 0, started, running ${version}`
  })

  await scenario('update', 'a later signed release is taken with delorun update', async () => {
    await publishRelease(R2)
    const checked = await run('delorun', ['update', '--check'])
    expect(checked.stdout.includes(R2) || checked.stderr.includes(R2), `update --check does not name ${R2}: ${excerpt(checked)}`)
    if (candidate !== undefined) {
      const taken = await run('delorun', ['update', '--yes'])
      expect(taken.status === 0, `update to the candidate failed: [${String(taken.status)}] ${excerpt(taken)}`)
      const reached = await running()
      expect(reached === R2 && existsSync(MARKER), `the home process runs ${String(reached)}, not ${R2}, or the person's file is gone`)
      return `candidate taken with --yes, running ${reached}`
    }
    // Release 2's own bundle patch switches off a row, so the report names it and `--yes` does not confirm it.
    const refused = await run('delorun', ['update', '--yes'])
    expect(refused.status !== 0 && await running() === R1, `--yes confirmed a report that disables a row: [${String(refused.status)}] ${excerpt(refused)}`)
    const updated = await terminal('delorun', ['update'], [{ when: /Applytheupdateto/u, send: 'y' }])
    expect(updated.status === 0 && /session-turn-outline/u.test(updated.stdout), `update failed or did not name the row: [${String(updated.status)}] ${excerpt(updated)}`)
    const version = await running()
    expect(version === R2, `the home process runs ${String(version)}, not ${R2}`)
    expect(existsSync(MARKER), 'the person\'s file is gone')
    return `report named the row; update exit 0, running ${version}`
  })

  await scenario('rollback-auto', 'a release whose Host never becomes ready rolls back on its own', async () => {
    await publishRelease(R3)
    const updated = await terminal('delorun', ['update'], [{ when: /Applytheupdateto/u, send: 'y' }])
    expect(updated.status === 1 && /failed its health check/u.test(updated.stdout), `expected a failed health check, got [${String(updated.status)}] ${excerpt(updated)}`)
    const version = await running()
    expect(version === R2, `after the rollback the home process runs ${String(version)}, not ${R2}`)
    return `${/failed its health check \([^)]*\)/u.exec(updated.stdout)?.[0] ?? 'health check failed'}; running ${version}`
  })

  await scenario('tampered', 'a release with one changed archive byte is refused by a fresh install and by an update', async () => {
    await publishRelease(R4)
    const fresh = await npx(['--version'], { DELORUN_HOME: join(work, 'tampered-home') })
    expect(fresh.status === 1 && /did not verify/u.test(fresh.stderr), `a fresh install was not refused: [${String(fresh.status)}] ${excerpt(fresh)}`)
    expect(names(join(work, 'tampered-home', 'runtimes')).filter(name => name.includes(R4)).length === 0, 'the tampered release left files in the store')
    const updated = await run('delorun', ['update', '--yes'])
    expect(updated.status === 1, `the update was not refused: [${String(updated.status)}] ${excerpt(updated)}`)
    expect(await running() === R2, 'the home process no longer runs the previous release')
    return `fresh install: ${excerpt(fresh).slice(0, 120)}; update: ${excerpt(updated).slice(0, 120)}`
  })

  await scenario('clock', 'the clock jumps 4 days ahead of the 3-day timestamp: a fresh install is refused naming the expiry, an installed release still starts, and the next signed release updates normally', async () => {
    clockOffsetMs = 4 * 24 * 3600 * 1000
    try {
      const fresh = await npx(['--version'], { DELORUN_HOME: join(work, 'ahead-home') })
      const installed = await npx(['--version'])
      expect(fresh.status !== 0 && /expired/u.test(fresh.stderr), `a fresh install did not refuse naming the expiry: ${excerpt(fresh)}`)
      expect(installed.status === 0, `a start of the installed release failed: ${excerpt(installed)}`)
      return `fresh install: ${excerpt(fresh).slice(0, 260)}; start: ${excerpt(installed).slice(0, 80)}`
    } finally {
      clockOffsetMs = 0
    }
  })

  await scenario('update-after-clock', 'with the clock back, the next signed release updates with no other action', async () => {
    await run('delorun', [])
    await publishRelease(R5)
    const checked = await run('delorun', ['update', '--check'])
    expect(checked.stdout.includes(R5) || checked.stderr.includes(R5), `update --check does not name ${R5}: ${excerpt(checked)}`)
    const updated = await run('delorun', ['update', '--yes'])
    expect(updated.status === 0, `update failed: ${excerpt(updated)}`)
    const version = await running()
    expect(version === R5, `the home process runs ${String(version)}, not ${R5}`)
    return `running ${version}`
  })

  await scenario('repair', 'delorun repair replaces a program that fails its start check and keeps the data', async () => {
    const stopped = await run('delorun', ['stop'])
    expect(stopped.status === 0, `stop failed: ${excerpt(stopped)}`)
    const entry = join(home, 'runtimes', R5, 'app', 'node_modules', '@delorun', 'cli', 'package.json')
    expect(existsSync(entry), `${entry} does not exist`)
    chmodSync(entry, 0o644)
    appendFileSync(entry, ' ')
    const broken = await run('delorun', ['--version'])
    const repaired = await terminal('npx', ['--yes', '--offline', `--package=${tarball}`, '--', 'delorun', 'repair'], [{ when: /\[y\/N\]/u, send: 'y\n' }])
    expect(repaired.status === 0, `repair failed: [${String(repaired.status)}] ${excerpt(repaired)}`)
    const after = await run('delorun', ['--version'])
    expect(after.status === 0 && after.stdout.includes(R5), `after the repair delorun does not start ${R5}: ${excerpt(after)}`)
    expect(existsSync(MARKER), 'the person\'s file is gone')
    const aside = names(join(home)).filter(name => name.startsWith('runtimes.set-aside-'))
    expect(aside.length === 1, `expected one set-aside program store, found ${aside.join(', ')}`)
    const listed = await run('delorun', ['recover', 'status'])
    expect(listed.stdout.includes(aside[0]!), `delorun recover status does not list ${aside[0]!}: ${excerpt(listed)}`)
    const discarded = await run('delorun', ['recover', 'discard', aside[0]!])
    expect(discarded.status === 0 && !existsSync(join(home, aside[0]!)), `delorun recover discard did not remove ${aside[0]!}: ${excerpt(discarded)}`)
    return `broken start: [${String(broken.status)}] ${excerpt(broken).slice(0, 160)}; repair exit 0; set aside ${aside[0]}, listed by recover status and removed by recover discard; data kept`
  })

  await scenario('from', 'delorun update --from installs a downloaded release with the channel unreachable, and refuses a lower one', async () => {
    const page = join(work, 'release-page')
    mkdirSync(page)
    const state = { ...trust, state: join(work, 'keys', 'page-state.json') }
    await publishRelease(R6, page, state)
    const folder = join(page, 'releases', 'download', `v${R6}`)
    const lower = join(channel, 'releases', 'download', `v${R1}`)
    await server.stop()
    try {
      const started = await run('delorun', [])
      expect(started.status === 0, `start failed: ${excerpt(started)}`)
      const refusedLower = await run('delorun', ['update', '--from', lower, '--yes'])
      expect(refusedLower.status === 1, `the lower release was not refused: [${String(refusedLower.status)}] ${excerpt(refusedLower)}`)
      const missing = await run('delorun', ['update', '--from', join(work, 'no-such-folder'), '--yes'])
      expect(missing.status === 1, `a missing folder was not refused: ${excerpt(missing)}`)
      const updated = await terminal('delorun', ['update', '--from', folder], [{ when: /cannotconfirmthat.*onitssignature/u, send: 'y' }, { when: /Applytheupdateto/u, send: 'y' }])
      expect(updated.status === 0, `update --from failed: [${String(updated.status)}] ${excerpt(updated)}`)
      const version = await running()
      expect(version === R6, `the home process runs ${String(version)}, not ${R6}`)
      return `lower: ${excerpt(refusedLower).slice(0, 140)}; from folder: exit 0, running ${version}`
    } finally {
      await server.start()
    }
  })

  await scenario('by-hand', 'the last resort in the troubleshooting guide, followed literally, brings back a working program', async () => {
    expect((await run('delorun', ['stop'])).status === 0, 'stop failed')
    const backup = join(personHome, 'delorun-backup')
    // Step 2 copies the whole home, runtimes included (about 1.5 GB per release); on a full disk the copy leaves the program store out.
    const wholeHome = execFileSync('du', ['-sk', home], { encoding: 'utf8' }).split('\t')[0]
    const free = statfsSync(home).bavail * statfsSync(home).bsize / 1024
    const complete = free > 2 * Number(wholeHome)
    cpSync(home, backup, { recursive: true, filter: source => complete || source !== join(home, 'runtimes') })
    const runtimes = join(home, 'runtimes')
    execFileSync('chmod', ['-R', 'u+rwX', runtimes])
    execFileSync('mv', [runtimes, join(home, 'runtimes.broken')])
    if (existsSync(join(home, 'staging'))) execFileSync('mv', [join(home, 'staging'), join(home, 'staging.broken')])
    const installed = await npx(['--version'])
    expect(installed.status === 0 && installed.stdout.includes(R5), `step 4 did not install ${R5}: [${String(installed.status)}] ${excerpt(installed)}`)
    const started = await run('delorun', [])
    expect(started.status === 0 && await running() === R5, `Delorun does not start after the by-hand steps: ${excerpt(started)}`)
    expect(existsSync(MARKER), 'the person\'s file is gone')
    execFileSync('chmod', ['-R', 'u+rwX', join(home, 'runtimes.broken')])
    rmSync(join(home, 'runtimes.broken'), { recursive: true, force: true })
    return `npx installed ${R5}, started, data kept; the backup ${complete ? 'copied the whole home' : 'left out runtimes/ for lack of disk space'}`
  })
} finally {
  // Stops the home process this run started, on success, failure and --keep alike.
  await run('delorun', ['stop'])
  await server.stop()
  await log.close()
}
const failed = results.filter(result => !result.ok)
say(`\nrehearsal: ${String(results.length - failed.length)} of ${String(results.length)} scenarios passed; log ${logFile}`)
for (const result of results) say(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id}  ${result.title}`)
if (options.keep === true) {
  say(`kept ${work}; remove it with: chmod -R u+w '${work}' && rm -rf '${work}'`)
} else {
  execFileSync('chmod', ['-R', 'u+rwX', work])
  rmSync(work, { recursive: true, force: true, maxRetries: 3 })
}
process.exit(failed.length === 0 ? 0 : 1)
