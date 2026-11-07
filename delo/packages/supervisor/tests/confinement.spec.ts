/**
 * C9's `supervisor-connect-denied` and `supervisor-landlock`: what a confined native workspace command can do with
 * the supervisor's socket, the start token and the Docker endpoint the supervisor resolves.
 *
 * - Through upstream's sandbox provider, configured with C1's protected home, its read exemptions and the denied
 *   sockets, each dialect this host runs is tested as the product confines commands. Each case first shows that a
 *   confined command cannot read a fixture under the home, as C1's own probes decide a rule's state.
 * - With C1's bwrap mechanism applied by hand (an empty tmpfs over the home), the spec shows the supervisor's half:
 *   its socket and its token file lie where that mechanism hides them, so the command can neither connect nor read
 *   the token, while the same command without the mechanism can do both.
 */
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { launcherPath } from '@deepseek-ai/node-addon-system/landlock-run'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDockerContext, startTokenFile } from '../src/index.ts'
import { PROFILE, startSupervisor, tempHome, type RunningSupervisor, type TempHome } from './support.ts'

/** What the confined command reports: whether it read the token, whether it connected, and the response line. */
interface Attempt {
  readonly read: string
  readonly connect: string
  readonly response?: { readonly ok: boolean, readonly error?: string }
}

/**
 * The workspace command: it tries to read the start token and to send a request with whatever it read. It prints
 * only the outcome of each step, never the token.
 */
const ATTEMPT = `
const fs = require('node:fs'), net = require('node:net')
const [socket, tokenFile] = process.argv.slice(1)
let token, read = 'ok'
try { token = fs.readFileSync(tokenFile, 'utf8').trim() } catch (error) { read = error.code || 'error' }
const connection = net.connect(socket)
let text = ''
connection.on('connect', () => { connection.write(JSON.stringify({ v: 1, token, op: 'workspace.list' }) + '\\n') })
connection.on('data', chunk => { text += chunk })
connection.on('error', error => { console.log(JSON.stringify({ read, connect: error.code || 'error' })) ; process.exit(0) })
connection.on('close', () => { if (text !== '') console.log(JSON.stringify({ read, connect: 'ok', response: JSON.parse(text.split('\\n')[0]) })) })
`

/** Reads one file and prints `ok` or the error code. */
const READ = `try { require('node:fs').readFileSync(process.argv[1]); console.log('ok') } catch (error) { console.log(error.code || 'error') }`

/** Connects to one Unix socket and prints `ok` or the error code. */
const CONNECT = `const c = require('node:net').connect(process.argv[1]); c.on('connect', () => { console.log('ok'); process.exit(0) }); c.on('error', error => { console.log(error.code || 'error'); process.exit(0) })`

let temp: TempHome | undefined
let running: RunningSupervisor | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await running?.stop()
  running = undefined
  temp?.remove()
  temp = undefined
})

/**
 * Where the specs' homes are created: a short fixed base outside the OS temporary directory, which upstream's
 * profiles replace with a private `/tmp` and so would hide a home there whether or not the dialect expresses C1's
 * rule. It is short so the socket path stays within C1's limit in any checkout.
 */
const OUTSIDE_TMP = '/var/tmp'

async function setUp(): Promise<{ readonly home: string, readonly socket: string, readonly tokenFile: string, readonly workspace: string, readonly fixture: string }> {
  temp = await tempHome(OUTSIDE_TMP)
  running = await startSupervisor(temp.home)
  const workspace = join(temp.outside, 'workspace')
  mkdirSync(workspace)
  const fixture = join(temp.home, 'secrets', 'probe-fixture')
  writeFileSync(fixture, 'fixture\n', { mode: 0o600 })
  return { home: temp.home, socket: running.supervisor.socketPath, tokenFile: startTokenFile(temp.home, PROFILE), workspace, fixture }
}

/**
 * Run a command without blocking this process, whose event loop serves the in-process supervisor.
 * @param argv - the command.
 * @returns its standard output, trimmed.
 */
async function run(argv: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(argv[0] ?? '', argv.slice(1), { encoding: 'utf8', timeout: 30_000 })
  return stdout.trim()
}

async function attempt(prefix: readonly string[], socket: string, tokenFile: string): Promise<Attempt> {
  return JSON.parse(await run([...prefix, process.execPath, '-e', ATTEMPT, socket, tokenFile])) as Attempt
}

const execFileAsync = promisify(execFile)
const bwrapUsable = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--', 'true'], { stdio: 'ignore' }).status === 0
const landlockProbe = spawnSync(launcherPath(), ['--probe'], { encoding: 'utf8', timeout: 5_000 })
const landlockUsable = landlockProbe.status === 0
const LANDLOCK_NOTE = landlockUsable ? '' : ` (not run on this host: upstream's landlock-run launcher is not usable here: ${landlockProbe.error?.message ?? String(landlockProbe.stderr).trim()})`

/**
 * A provider confined to one dialect, configured as C1 states: the home protected with its read exemptions, and the
 * supervisor's socket and the given Docker socket paths denied.
 * @param dialect - bwrap, or Landlock with bwrap's probe forced off.
 * @param home - the Delo home.
 * @param socket - the supervisor's socket.
 * @param dockerSockets - Docker socket paths to deny.
 * @returns the provider.
 */
async function provider(dialect: 'bwrap' | 'landlock', home: string, socket: string, dockerSockets: readonly string[] = []): Promise<LocalSandboxProvider> {
  await ctx?.fiber.dispose()
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, { protectedHome: home, protectedHomeReadable: [...READ_EXEMPTIONS], deniedSockets: [socket, ...dockerSockets] })
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = dialect === 'bwrap' ? { probeLandlock: () => 'unusable' } : { probeBwrap: () => false }
  return sandbox
}

async function confinedPrefix(sandbox: LocalSandboxProvider, workspace: string): Promise<string[]> {
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
  const confined = await sandbox.confine(['--'], policy)
  // confine() appends the given argv after its own `--`; the prefix is everything before that argv.
  return confined.argv.slice(0, -1)
}

describe('supervisor-connect-denied: C1\'s bwrap mechanism over the supervisor\'s socket and token', () => {
  it.skipIf(!bwrapUsable)('a command under an empty tmpfs over the home can neither connect to the socket nor read the token', async () => {
    const { home, socket, tokenFile } = await setUp()
    const base = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent']
    expect(await attempt([...base, '--tmpfs', home, '--'], socket, tokenFile)).toEqual({ read: 'ENOENT', connect: 'ENOENT' })
    // The same command without the mechanism reads the token and is served: the mechanism, not chance, denies it.
    expect(await attempt([...base, '--'], socket, tokenFile)).toEqual({ read: 'ok', connect: 'ok', response: expect.objectContaining({ ok: false, error: 'DOCKER_UNAVAILABLE' }) })
  })
})

describe('supervisor-connect-denied through upstream\'s sandbox provider (bwrap)', () => {
  it.skipIf(!bwrapUsable)('a confined workspace command cannot connect to the supervisor socket or read the start token', async () => {
    const { home, socket, tokenFile, workspace, fixture } = await setUp()
    const prefix = await confinedPrefix(await provider('bwrap', home, socket), workspace)
    expect(prefix[0]).toBe('bwrap')
    expect(await run([...prefix, process.execPath, '-e', READ, fixture])).not.toBe('ok')
    const result = await attempt(prefix, socket, tokenFile)
    expect(result.read).not.toBe('ok')
    expect(result.connect).not.toBe('ok')
  })

  it.skipIf(!bwrapUsable)('a confined workspace command cannot connect to the Docker endpoint the supervisor resolves', async (test) => {
    const { home, socket, workspace } = await setUp()
    const context = await resolveDockerContext(process.env)
    const path = context.endpoint.path
    if (context.endpoint.kind !== 'unix' || path === undefined || !existsSync(path)) {
      test.skip(`not run: the active Docker context's endpoint is not a Unix socket on this host (${context.host})`)
      return
    }
    if (await run([process.execPath, '-e', CONNECT, path]) !== 'ok') {
      test.skip(`not run: an unconfined connect to ${path} fails on this host`)
      return
    }
    const dockerSockets = [...new Set([path, realpathSync.native(path)])]
    const prefix = await confinedPrefix(await provider('bwrap', home, socket, dockerSockets), workspace)
    for (const spelling of dockerSockets) expect(await run([...prefix, process.execPath, '-e', CONNECT, spelling])).not.toBe('ok')
    // The same provider without the Docker socket denied connects: the denial, not the host, refuses it.
    const open = await confinedPrefix(await provider('bwrap', home, socket), workspace)
    expect(await run([...open, process.execPath, '-e', CONNECT, path])).toBe('ok')
  })
})

describe('supervisor-landlock through upstream\'s sandbox provider', () => {
  it.skipIf(!landlockUsable)(`a confined workspace command connects to the socket, cannot read the token and is refused UNAUTHENTICATED${LANDLOCK_NOTE}`, async () => {
    const { home, socket, tokenFile, workspace, fixture } = await setUp()
    const prefix = await confinedPrefix(await provider('landlock', home, socket), workspace)
    expect(await run([...prefix, process.execPath, '-e', READ, fixture])).not.toBe('ok')
    expect(await attempt(prefix, socket, tokenFile)).toEqual({ read: 'EACCES', connect: 'ok', response: { ok: false, error: 'UNAUTHENTICATED' } })
  })
})
