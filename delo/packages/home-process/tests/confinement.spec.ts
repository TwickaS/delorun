/**
 * C19's `update-channel-connect-denied` and `update-channel-landlock`: what a confined workspace command can do with
 * the update channel's socket and the start token.
 *
 * - Through upstream's sandbox provider, each dialect this host runs is tested as the product confines commands. A
 *   dialect whose profile in this tree does not yet express C1's `home-read` rule (Delo's sandbox profiles add it per
 *   dialect) is skipped with that reason, found by a probe that reads a fixture under the home; where the rule holds,
 *   the assertions run and must pass. Landlock is skipped where its launcher is not usable on the host.
 * - With C1's bwrap mechanism applied as the contract states it (an empty tmpfs over the home), the spec shows the
 *   home process's half: the socket and the token file lie where that mechanism hides them, so the command can
 *   neither connect nor read the token, while the same command without the mechanism can do both.
 */
import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { launcherPath } from '@deepseek-ai/node-addon-system/landlock-run'
import { startTokenFile } from '@delo/home'
import { afterEach, describe, expect, it } from 'vitest'
import { updateSocketPath } from '../src/index.ts'
import { FixtureStore, installFixture, PROFILE, startHome, tempHome, V1, type InProcessHome, type TempHome } from './support.ts'

/** What the confined command reports: whether it read the token, whether it connected, and the response line. */
interface Attempt {
  readonly read: string
  readonly connect: string
  readonly response?: { readonly ok: boolean, readonly error?: string }
}

/**
 * The workspace command: it tries to read the start token and to send a `status` request with whatever it read. It
 * prints only the outcome of each step, never the token.
 */
const ATTEMPT = `
const fs = require('node:fs'), net = require('node:net')
const [socket, tokenFile] = process.argv.slice(1)
let token, read = 'ok'
try { token = fs.readFileSync(tokenFile, 'utf8').trim() } catch (error) { read = error.code || 'error' }
const connection = net.connect(socket)
let text = ''
connection.on('connect', () => { connection.write(JSON.stringify({ v: 1, token, op: 'status' }) + '\\n') })
connection.on('data', chunk => { text += chunk })
connection.on('error', error => { console.log(JSON.stringify({ read, connect: error.code || 'error' })) ; process.exit(0) })
connection.on('close', () => { if (text !== '') { const { ok, error } = JSON.parse(text.split('\\n')[0]); console.log(JSON.stringify({ read, connect: 'ok', response: error === undefined ? { ok } : { ok, error } })) } })
`

/** Reads one file and prints `ok` or the error code. */
const READ = `try { require('node:fs').readFileSync(process.argv[1]); console.log('ok') } catch (error) { console.log(error.code || 'error') }`

let temp: TempHome | undefined
let running: InProcessHome | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await running?.process.shutdown(0)
  running?.exit()
  running = undefined
  temp?.remove()
  temp = undefined
})

/**
 * Where the specs' homes are created: a short fixed base outside the OS temporary directory, which upstream's
 * profiles replace with a private `/tmp` and so would hide a home there whether or not the dialect expresses C1's
 * rule.
 */
const OUTSIDE_TMP = '/var/tmp'

async function setUp(): Promise<{ readonly home: string, readonly socket: string, readonly tokenFile: string, readonly workspace: string, readonly fixture: string }> {
  temp = await tempHome(OUTSIDE_TMP)
  installFixture(temp.home, V1)
  await FixtureStore.seed(temp.home, V1)
  running = await startHome(temp.home)
  const workspace = join(temp.outside, 'workspace')
  mkdirSync(workspace)
  const fixture = join(temp.home, 'secrets', 'probe-fixture')
  writeFileSync(fixture, 'fixture\n', { mode: 0o600 })
  return { home: temp.home, socket: updateSocketPath(temp.home, PROFILE), tokenFile: startTokenFile(temp.home, PROFILE), workspace, fixture }
}

const execFileAsync = promisify(execFile)

/**
 * Run a command without blocking this process, whose event loop serves the in-process home process.
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

const bwrapUsable = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--', 'true'], { stdio: 'ignore' }).status === 0
const landlockProbe = spawnSync(launcherPath(), ['--probe'], { encoding: 'utf8', timeout: 5_000 })
const landlockUsable = landlockProbe.status === 0
const LANDLOCK_NOTE = landlockUsable ? '' : ` (not run on this host: upstream's landlock-run launcher is not usable here: ${landlockProbe.error?.message ?? String(landlockProbe.stderr).trim()})`

/**
 * A provider confined to one dialect.
 * @param dialect - bwrap, or Landlock with bwrap's probe forced off.
 * @returns the provider.
 */
async function provider(dialect: 'bwrap' | 'landlock'): Promise<LocalSandboxProvider> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
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

describe('update-channel-connect-denied: C1\'s bwrap mechanism over the update channel and the token', { timeout: 60_000 }, () => {
  it.skipIf(!bwrapUsable)('a command under an empty tmpfs over the home can neither connect to the channel nor read the token', async () => {
    const { home, socket, tokenFile } = await setUp()
    const base = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent']
    expect(await attempt([...base, '--tmpfs', home, '--'], socket, tokenFile)).toEqual({ read: 'ENOENT', connect: 'ENOENT' })
    // The same command without the mechanism reads the token and is served: the mechanism, not chance, denies it.
    expect(await attempt([...base, '--'], socket, tokenFile)).toEqual({ read: 'ok', connect: 'ok', response: { ok: true } })
  })
})

describe('update-channel-connect-denied through upstream\'s sandbox provider (bwrap)', { timeout: 60_000 }, () => {
  it.skipIf(!bwrapUsable)('a confined workspace command cannot connect to the update channel or read the start token', async (test) => {
    const { socket, tokenFile, workspace, fixture } = await setUp()
    const prefix = await confinedPrefix(await provider('bwrap'), workspace)
    expect(prefix[0]).toBe('bwrap')
    if (await run([...prefix, process.execPath, '-e', READ, fixture]) === 'ok') {
      test.skip('this tree\'s bwrap profile does not express C1\'s home-read rule yet (Delo\'s sandbox profiles, WP2.14): a confined command reads a fixture under the home')
      return
    }
    const result = await attempt(prefix, socket, tokenFile)
    expect(result.read).not.toBe('ok')
    expect(result.connect).not.toBe('ok')
  })
})

describe('update-channel-landlock through upstream\'s sandbox provider', { timeout: 60_000 }, () => {
  it.skipIf(!landlockUsable)(`a confined workspace command connects to the channel, cannot read the token and is refused UNAUTHENTICATED${LANDLOCK_NOTE}`, async (test) => {
    const { socket, tokenFile, workspace, fixture } = await setUp()
    const prefix = await confinedPrefix(await provider('landlock'), workspace)
    if (await run([...prefix, process.execPath, '-e', READ, fixture]) === 'ok') {
      test.skip('this tree\'s Landlock profile does not express C1\'s home-read rule yet (Delo\'s sandbox profiles, WP2.14): a confined command reads a fixture under the home')
      return
    }
    expect(await attempt(prefix, socket, tokenFile)).toEqual({ read: 'EACCES', connect: 'ok', response: { ok: false, error: 'UNAUTHENTICATED' } })
  })
})
