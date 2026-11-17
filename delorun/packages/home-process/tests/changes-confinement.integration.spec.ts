/**
 * Contract C21 requirement 3 and fundamental F16 under the product's confinement, beside C19's confinement spec of the
 * home process, which configures the CLI profile's sandbox: what stops a model from lowering the
 * protection setting is the sandbox's home-write rule, not the terminal check. A model's own terminal tool gives its
 * commands a real pseudo-terminal, so `attestTerminal` passes for them; here `script` gives `delorun changes protection
 * off` that pseudo-terminal and answers its question.
 *
 * Through upstream's sandbox provider, configured as the home process configures the CLI profile's (the home protected
 * with C1's read exemptions), each dialect this host runs is tested with protection on: the confined command fails and
 * leaves `changes/protection.json` at `on`, and a confined direct write to `changes/` fails, the harness's writable copy
 * and records under `changes/harness/` included, while the same command without
 * confinement, the person's own full access, lowers the setting. A workspace that contains the home shows the rule
 * alone: with the home protected the provider refuses to confine a command there, and without it the same command in
 * the same pseudo-terminal lowers the setting. Homes live under `/var/tmp`, because upstream's profiles replace `/tmp`
 * with a private one that would hide a home there whether or not the dialect expresses C1's rule.
 */
import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { launcherPath } from '@deepseek-ai/node-addon-system/landlock-run'
import { READ_EXEMPTIONS } from '@delorun/contract-home-layout'
import { ensureHomeTree } from '@delorun/home'

/** `delorun` run from source, as `delorun/apps/cli`'s own specs run it. */
const BIN = join(import.meta.dirname, '../../../apps/cli/src/bin.ts')

/** What `delorun changes` says when its standard input or output is not a terminal. */
const NOT_AT_TERMINAL = 'This needs you at your computer: run it in a terminal.'

/**
 * @param home - the Delorun home.
 * @returns the protection record's path under it (contract C21).
 */
function protectionPath(home: string): string {
  return join(home, 'changes', 'protection.json')
}

/**
 * Turn protection on, writing the record `delorun changes protection on` writes: 0600 under a 0700 `changes/`.
 * @param home - the Delorun home.
 */
function protectOn(home: string): void {
  mkdirSync(join(home, 'changes'), { recursive: true, mode: 0o700 })
  chmodSync(join(home, 'changes'), 0o700)
  writeFileSync(protectionPath(home), `${JSON.stringify({ schema: 'delorun.changes-protection/1', level: 'on', setAt: new Date().toISOString() })}\n`, { mode: 0o600 })
}

/**
 * @param home - the Delorun home.
 * @returns the level its protection record holds.
 */
function levelOf(home: string): unknown {
  return (JSON.parse(readFileSync(protectionPath(home), 'utf8')) as { level?: unknown }).level
}
const TSX_LOADER = import.meta.resolve('tsx/esm')

/** The prompt of each question `delorun changes protection off` asks. */
const ANSWER_PROMPT = '[y/N]'

/** How many questions `delorun changes protection off` asks before it lowers the setting. */
const QUESTIONS = 2
const PROFILE = 'default'

/** Where the specs' homes are created: outside the OS temporary directory, which upstream's profiles replace. */
const OUTSIDE_TMP = '/var/tmp'

/** Writes one file and prints `ok` or the error code. */
const WRITE = `try { require('node:fs').mkdirSync(require('node:path').dirname(process.argv[1]), { recursive: true }); require('node:fs').writeFileSync(process.argv[1], '{}'); console.log('ok') } catch (error) { console.log(error.code || 'error') }`

const execFileAsync = promisify(execFile)

const scriptUsable = spawnSync('script', ['-qec', 'true', '/dev/null'], { stdio: 'ignore', timeout: 5_000 }).status === 0
const bwrapUsable = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--', 'true'], { stdio: 'ignore', timeout: 5_000 }).status === 0
const landlockProbe = spawnSync(launcherPath(), ['--probe'], { encoding: 'utf8', timeout: 5_000 })
const landlockUsable = landlockProbe.status === 0
const NOT_RUN = (reason: string): string => ` (not run on this host: ${reason})`
const SCRIPT_NOTE = scriptUsable ? '' : NOT_RUN('util-linux script, which gives a command a pseudo-terminal, is not usable here')
const LANDLOCK_NOTE = landlockUsable ? '' : NOT_RUN(`upstream's landlock-run launcher is not usable here: ${landlockProbe.error?.message ?? String(landlockProbe.stderr).trim()}`)

let base: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (base !== undefined) rmSync(base, { recursive: true, force: true })
  base = undefined
})

/**
 * A Delorun home with the CLI profile set up, an OS home and a workspace beside it.
 * @returns the paths.
 */
async function setUp(): Promise<{ readonly home: string, readonly osHome: string, readonly workspace: string }> {
  mkdirSync(OUTSIDE_TMP, { recursive: true })
  base = realpathSync(mkdtempSync(join(OUTSIDE_TMP, 'dcc-')))
  const home = join(base, 'home')
  await ensureHomeTree(home, PROFILE)
  mkdirSync(join(home, 'profiles', PROFILE), { recursive: true })
  writeFileSync(join(home, 'profiles', PROFILE, 'package.json'), '{"name":"dsh-profile-default","private":true}\n')
  const osHome = join(base, 'os-home')
  const workspace = join(base, 'workspace')
  mkdirSync(osHome)
  mkdirSync(workspace)
  return { home, osHome, workspace }
}

/**
 * A provider confined to one dialect, configured as the home process configures the CLI profile's.
 * @param dialect - bwrap, or Landlock with bwrap's probe forced off.
 * @param home - the Delorun home.
 * @returns the provider.
 */
async function provider(dialect: 'bwrap' | 'landlock', home: string | undefined): Promise<LocalSandboxProvider> {
  await ctx?.fiber.dispose()
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, home === undefined ? {} : { protectedHome: home, protectedHomeReadable: [...READ_EXEMPTIONS], deniedSockets: [] })
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = dialect === 'bwrap' ? { probeLandlock: () => 'unusable' } : { probeBwrap: () => false }
  return sandbox
}

/**
 * @param sandbox - the provider.
 * @param workspace - the workspace the command may write.
 * @returns the argv prefix that confines a command.
 */
async function confinedPrefix(sandbox: LocalSandboxProvider, workspace: string): Promise<string[]> {
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
  const confined = await sandbox.confine(['--'], policy)
  // confine() appends the given argv after its own `--`; the prefix is everything before that argv.
  return confined.argv.slice(0, -1)
}

/** What a command did. */
interface Ran {
  readonly status: number
  readonly output: string
}

/**
 * Run `delorun changes protection off` inside a pseudo-terminal that `script` opens, answering `y` to both of its questions.
 * @param prefix - the confinement, or nothing for the person's own full access.
 * @param paths - the homes and the workspace.
 * @returns its exit status and what the pseudo-terminal showed.
 */
async function lowerProtection(prefix: readonly string[], paths: { readonly home: string, readonly osHome: string, readonly workspace: string }): Promise<Ran> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DSH_|DELORUN_|NODE_PATH$|DEEPSEEK_API_KEY$)/.test(name)))
  const command = [process.execPath, '--import', TSX_LOADER, BIN, 'changes', 'protection', 'off'].map(word => `'${word}'`).join(' ')
  const argv = [...prefix, 'script', '-qec', command, '/dev/null']
  const child = execFileAsync(argv[0]!, argv.slice(1), { cwd: paths.workspace, env: { ...inherited, HOME: paths.osHome, DELORUN_HOME: paths.home, DSH_HOME: join(paths.osHome, '.dsh') }, encoding: 'utf8', timeout: 60_000 })
  // Each answer is typed once its question shows, as a person types it: the first read would take a second line typed early.
  let shown = ''
  let answered = 0
  child.child.stdout?.on('data', (chunk: string) => {
    shown += chunk
    const asked = shown.split(ANSWER_PROMPT).length - 1
    for (; answered < asked && answered < QUESTIONS; answered += 1) child.child.stdin?.write('y\n')
    if (answered === QUESTIONS) child.child.stdin?.end()
  })
  try {
    const { stdout } = await child
    return { status: 0, output: stdout }
  } catch (error) {
    const failed = error as { code?: number, stdout?: string, stderr?: string }
    return { status: typeof failed.code === 'number' ? failed.code : -1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
  }
}

/**
 * Run one confined write attempt.
 * @param prefix - the confinement.
 * @param path - the file to write.
 * @returns `ok` or the error code.
 */
async function attemptWrite(prefix: readonly string[], path: string): Promise<string> {
  const { stdout } = await execFileAsync(prefix[0]!, [...prefix.slice(1), process.execPath, '-e', WRITE, path], { encoding: 'utf8', timeout: 30_000 })
  return stdout.trim()
}

/**
 * The cases each dialect runs.
 * @param dialect - the dialect.
 */
async function confinedCannotLower(dialect: 'bwrap' | 'landlock'): Promise<void> {
  const paths = await setUp()
  protectOn(paths.home)
  const prefix = await confinedPrefix(await provider(dialect, paths.home), paths.workspace)
  const confined = await lowerProtection(prefix, paths)
  expect(confined.status, confined.output).not.toBe(0)
  // The terminal check passed inside the pseudo-terminal: the home-write rule is what refused it.
  expect(confined.output).not.toContain(NOT_AT_TERMINAL)
  expect(levelOf(paths.home)).toBe('on')
  expect(readdirSync(join(paths.home, 'changes'))).toEqual(['protection.json'])
  expect(await attemptWrite(prefix, protectionPath(paths.home))).not.toBe('ok')
  expect(levelOf(paths.home)).toBe('on')
  const object = join(paths.home, 'changes', 'store', 'objects', 'a'.repeat(64))
  expect(await attemptWrite(prefix, object)).not.toBe('ok')
  expect(existsSync(object)).toBe(false)
  // The person's writable copy of the harness and the harness's records are under `changes/` too, so a confined command
  // writes none of them, not even into a copy that exists.
  const copy = join(paths.home, 'changes', 'harness', '1.2.3', 'copy', 'app')
  mkdirSync(copy, { recursive: true, mode: 0o700 })
  for (const target of [join(copy, 'start.js'), join(copy, 'node_modules', 'x.js'), join(paths.home, 'changes', 'harness', '1.2.3', 'approved.json'), join(paths.home, 'changes', 'harness', 'log.json')]) {
    expect(await attemptWrite(prefix, target), target).not.toBe('ok')
    expect(existsSync(target)).toBe(false)
  }
  // The same command with the person's own full access lowers it: full access is the person's own authority.
  const unconfined = await lowerProtection([], paths)
  expect(unconfined.status, unconfined.output).toBe(0)
  expect(unconfined.output).toContain('Protection is off (it was on)')
  expect(levelOf(paths.home)).toBe('off')
  protectOn(paths.home)

  // A workspace containing the home: the home rule refuses to confine there; without it the command lowers the setting.
  const around = { ...paths, workspace: base! }
  await expect(confinedPrefix(await provider(dialect, paths.home), around.workspace)).rejects.toMatchObject({ code: 'HOME_IN_WRITABLE_ROOT' })
  const unprotected = await lowerProtection(await confinedPrefix(await provider(dialect, undefined), around.workspace), around)
  expect(unprotected.output).toContain('Protection is off (it was on)')
  expect(levelOf(paths.home)).toBe('off')
}

describe.skipIf(!scriptUsable || !bwrapUsable)(`F16 under upstream's sandbox provider (bwrap)${SCRIPT_NOTE}${bwrapUsable ? '' : NOT_RUN('bwrap is not usable here')}`, { timeout: 180_000 }, () => {
  it('a confined command inside a pseudo-terminal cannot lower protection', async () => {
    await confinedCannotLower('bwrap')
  })
})

describe.skipIf(!scriptUsable || !landlockUsable)(`F16 under upstream's sandbox provider (Landlock)${SCRIPT_NOTE}${LANDLOCK_NOTE}`, { timeout: 180_000 }, () => {
  it('a confined command inside a pseudo-terminal cannot lower protection under Landlock', async () => {
    await confinedCannotLower('landlock')
  })
})
