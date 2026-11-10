/**
 * The private directory lies where no confined command can write, a turn whose directory a confined command could
 * write records nothing, and the Host's copies refuse links, named pipes, and entries it did not create.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as WorkspaceChanges from '../src/index.ts'
import { changes, endTurn, git, mutate, scratchDir, settle, startTurn, toolCall } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A directory under the home, outside every temporary root a sandbox grants. */
async function homeDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(homedir(), prefix)))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function repository(): Promise<string> {
  const cwd = await realpath(await scratchDir('dsh-workspace-changes-private-', cleanups))
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'one\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

async function boot(extra: (ctx: Context) => Promise<void>, config: Partial<WorkspaceChanges.Config> = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem)
  await extra(ctx)
  await ctx.plugin(WorkspaceChanges, config as WorkspaceChanges.Config)
  return ctx
}

/** One turn whose command appends `line` to `a.txt`. */
async function turn(ctx: Context, session: Session, number: number, cwd: string, line: string): Promise<void> {
  startTurn(session, number)
  await settle(ctx, session)
  await writeFile(join(cwd, 'a.txt'), `${readFileSync(join(cwd, 'a.txt'), 'utf8')}${line}\n`)
  toolCall(session, number, 'bash', { command: 'x' })
  endTurn(session, number)
  await settle(ctx, session)
}

/** Every regular file under a directory. */
function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map(entry => join(directory, entry))
    .filter(path => statSync(path, { throwIfNoEntry: false })?.isFile() === true)
}

/** Confined runners this Host may provide, each forced on its own. */
const dialects: Array<{ name: string; platform: NodeJS.Platform; internals: LocalSandboxProvider['internals'] }> = [
  { name: 'bwrap', platform: 'linux', internals: { chain: ['bwrap'] } },
  { name: 'Landlock', platform: 'linux', internals: { chain: ['landlock'] } },
  { name: 'Seatbelt', platform: 'darwin', internals: {} },
]

describe('the private directory under a real sandbox', { timeout: 120_000 }, () => {
  for (const dialect of dialects) {
    it(`${dialect.name}: a command confined under the Session's workspace-write policy cannot create or replace an entry in it`, async (context) => {
      if (process.platform !== dialect.platform) context.skip(`${dialect.name} runs only on ${dialect.platform}`)
      const cwd = await repository()
      const cache = await homeDir('.dsh-workspace-changes-cache-')
      // The default location, read from the cache directory variable the plugin resolves at load.
      vi.stubEnv('XDG_CACHE_HOME', cache)
      const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: cwd }
      const ctx = await boot(async (ctx) => {
        await ctx.plugin(LocalSandboxProvider, {})
        ;(ctx.sandbox as LocalSandboxProvider).internals = dialect.internals
        ctx.provide('sandboxPolicy', { resolve: () => policy } as never)
      })
      const confined = async (script: string) => {
        const wrapped = await ctx.sandbox.confine(['/bin/sh', '-c', script], policy)
        return spawnSync(wrapped.argv[0] as string, wrapped.argv.slice(1), { cwd, timeout: 30_000, encoding: 'utf8' })
      }
      const unusable = await confined('true').then(
        result => result.status === 0 ? undefined : `${dialect.name} cannot confine a command on this host: ${String(result.error ?? result.stderr).trim()}`,
        (error: unknown) => `${dialect.name} is unavailable on this host: ${String(error)}`,
      )
      if (unusable !== undefined) context.skip(unusable)
      const warn = vi.spyOn(ctx.logger, 'warn')
      const session = ctx.sessions.create(SessionId(`private-${dialect.name}`), { meta: { cwd } })
      await turn(ctx, session, 1, cwd, 'two')
      expect(warn.mock.calls).toEqual([])
      const [directory, ...others] = await readdir(join(cache, 'dsh-workspace-changes'))
      expect(others).toEqual([])
      const privateDir = join(cache, 'dsh-workspace-changes', directory!)
      const before = filesUnder(privateDir).sort()
      // The confined command tries to add a marker beside the snapshot objects, and to swap the objects directory for a link.
      const attempt = await confined([
        `printf marker > '${privateDir}/marker.txt'`,
        `printf marker > '${privateDir}/objects/marker.txt'`,
        `mv '${privateDir}/objects' '${privateDir}/moved'`,
        `ln -s '${cwd}' '${privateDir}/captures'`,
        'true',
      ].join('; '))
      expect(attempt.status).toBe(0)
      expect(existsSync(join(privateDir, 'marker.txt'))).toBe(false)
      expect(existsSync(join(privateDir, 'objects', 'marker.txt'))).toBe(false)
      expect(existsSync(join(privateDir, 'moved'))).toBe(false)
      expect(existsSync(join(privateDir, 'captures'))).toBe(false)
      expect(filesUnder(privateDir).sort()).toEqual(before)
      // The workspace itself stays writable, so the denial is the directory's location and not a broken sandbox.
      expect((await confined(`printf marker > '${cwd}/written.txt'`)).status).toBe(0)
      expect(readFileSync(join(cwd, 'written.txt'), 'utf8')).toBe('marker')
      await turn(ctx, session, 2, cwd, 'three')
      expect(changes(ctx, session).map(summary => summary.turn)).toEqual([1, 2])
    })
  }
})

/** A sandbox that runs every command unconfined and records each policy, with a Session policy the test can change. */
function fakeSandbox(policy: { current: SandboxPolicy | { mode: 'danger-full-access'; workspaceRoot: string } }, onConfine: (policy: SandboxPolicy) => void = () => undefined) {
  return (ctx: Context): Promise<void> => {
    ctx.provide('sandbox', { confine: (argv: readonly string[], confinedPolicy: SandboxPolicy) => {
      onConfine(confinedPolicy)
      return Promise.resolve({ argv, runnerFailureRules: [] })
    } } as never)
    ctx.provide('sandboxPolicy', { resolve: () => policy.current } as never)
    return Promise.resolve()
  }
}

describe('a private directory a confined command could write', { timeout: 60_000 }, () => {
  it('records nothing for a turn whose private directory lies inside a root the Session\'s commands can write, and warns', async () => {
    const cwd = await repository()
    const policy = { current: { mode: 'workspace-write', workspaceRoot: cwd } as SandboxPolicy }
    const ctx = await boot(fakeSandbox(policy), { scratchRoot: join(cwd, '.scratch') })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = ctx.sessions.create(SessionId('exposed'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n')
    toolCall(session, 1, 'bash', { command: 'x' })
    await mutate(ctx, session, 1, 'write', { file_path: 'b.txt', content: 'b\n' }, 'b.txt', () => writeFile(join(cwd, 'b.txt'), 'b\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(ctx, session)).toEqual([])
    const messages = warn.mock.calls.map(call => String(call[0]))
    // The turn-start snapshot refused the directory; the file tool's capture found no file and stored nothing.
    expect(messages).toEqual([expect.stringMatching(/overlaps .*which this Session's confined commands can write/)])
    expect(readdirSync(join(cwd, '.scratch'), { recursive: true })).toEqual([expect.stringMatching(/^session-/)])
    // The same directory is used once the Session's commands can no longer write it.
    policy.current = { mode: 'read-only', workspaceRoot: cwd }
    await turn(ctx, session, 2, cwd, 'three')
    expect(changes(ctx, session).map(summary => summary.turn)).toEqual([2])
  })

  it('checks nothing where the Session\'s commands already run with the Host\'s authority', async () => {
    const cwd = await repository()
    const policy = { current: { mode: 'danger-full-access', workspaceRoot: cwd } as const }
    const ctx = await boot(fakeSandbox(policy), { scratchRoot: join(cwd, '.scratch') })
    const session = ctx.sessions.create(SessionId('unconfined'), { meta: { cwd } })
    await turn(ctx, session, 1, cwd, 'two')
    expect(changes(ctx, session).map(summary => summary.files.map(file => file.path))).toEqual([['a.txt']])
  })
})

describe.skipIf(process.platform === 'win32')('the Host\'s copies into the private directory', { timeout: 60_000 }, () => {
  it('refuses a link planted at the repository index and never reads its target into the private directory', async () => {
    const cwd = await repository()
    // A harmless second repository whose index names a marker file.
    const marker = `marker-${process.pid}-${Date.now()}.txt`
    const other = await scratchDir('dsh-workspace-changes-marker-', cleanups)
    git(other, 'init', '-q', '-b', 'main')
    await writeFile(join(other, marker), 'marker\n')
    git(other, 'add', '-A')
    await rm(join(cwd, '.git', 'index'))
    await symlink(join(other, '.git', 'index'), join(cwd, '.git', 'index'))
    const scratchRoot = await scratchDir('dsh-workspace-changes-scratch-', cleanups)
    let markerSeen = false
    let commands = 0
    const ctx = await boot(fakeSandbox({ current: { mode: 'read-only', workspaceRoot: cwd } }, () => {
      commands += 1
      for (const file of filesUnder(scratchRoot)) if (readFileSync(file).includes(marker)) markerSeen = true
    }), { scratchRoot })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = ctx.sessions.create(SessionId('planted-index'), { meta: { cwd } })
    await turn(ctx, session, 1, cwd, 'two')
    expect(commands).toBeGreaterThan(0)
    expect(markerSeen).toBe(false)
    expect(changes(ctx, session)).toEqual([])
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining('ELOOP')])
  })

  it('captures a named pipe a file tool names without waiting for a writer', async () => {
    const cwd = await realpath(await scratchDir('dsh-workspace-changes-fifo-', cleanups))
    const pipe = join(cwd, 'pipe')
    execFileSync('mkfifo', [pipe])
    // A capture blocked on the pipe would hold a thread-pool slot until a writer appears; open one so it can finish.
    cleanups.push(async () => {
      try {
        closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK))
      } catch (error: unknown) {
        // ENXIO: no reader is waiting on the pipe, so nothing is blocked.
        void error
      }
    })
    const ctx = await boot(() => Promise.resolve(), { scratchRoot: await scratchDir('dsh-workspace-changes-scratch-', cleanups) })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const session = ctx.sessions.create(SessionId('fifo'), { meta: { cwd } })
    startTurn(session, 1)
    await settle(ctx, session)
    const captured = mutate(ctx, session, 1, 'write', { file_path: 'pipe', content: 'x' }, 'pipe', () => Promise.resolve())
    const outcome = await Promise.race([
      captured.then(() => 'captured'),
      new Promise(resolve => setTimeout(() => { resolve('blocked') }, 10_000)),
    ])
    expect(outcome).toBe('captured')
    expect(warn.mock.calls).toEqual([])
    await mutate(ctx, session, 1, 'write', { file_path: 'b.txt', content: 'b\n' }, 'b.txt', () => writeFile(join(cwd, 'b.txt'), 'b\n'))
    endTurn(session, 1)
    await settle(ctx, session)
    expect(changes(ctx, session).map(summary => summary.files.map(file => file.path))).toEqual([['b.txt']])
  })
})
