/** A Session's repository git commands run in the sandbox the Session's own commands run in. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError, type SandboxExecutionPolicy, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs } from '@deepseek-ai/dsh-sandbox-local/src/profiles.ts'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { gitPolicy, sessionConfinement } from '../src/confinement.ts'
import { GitRunner, type GitConfinement } from '../src/git.ts'
import * as WorkspaceChanges from '../src/index.ts'
import { changes, endTurn, git, scratchDir, settle, startTurn, toolCall } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const signal = new AbortController().signal
const session = { id: SessionId('s') } as Session

describe('gitPolicy', () => {
  const base: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: '/w', additionalWritableRoots: ['/extra'], sessionId: SessionId('s') }

  it('gives a command that writes nothing beside the repository the Session\'s own policy', () => {
    expect(gitPolicy({ ...base, mode: 'workspace-write' }, [])).toEqual(base)
    expect(gitPolicy({ mode: 'read-only', workspaceRoot: '/w' }, [])).toEqual({ mode: 'read-only', workspaceRoot: '/w' })
  })

  it('adds the private directory beside a workspace-write Session\'s writable roots', () => {
    expect(gitPolicy({ ...base, mode: 'workspace-write' }, ['/scratch'])).toEqual({ ...base, additionalWritableRoots: ['/extra', '/scratch'] })
    expect(gitPolicy({ mode: 'workspace-write', workspaceRoot: '/w' }, ['/scratch'])).toEqual({
      mode: 'workspace-write', workspaceRoot: '/w', additionalWritableRoots: ['/scratch'],
    })
  })

  it('lets a read-only Session\'s command write the private directory and nothing in the repository', () => {
    expect(gitPolicy({ ...base, mode: 'read-only' }, ['/scratch'])).toEqual({ mode: 'workspace-write', workspaceRoot: '/scratch', sessionId: SessionId('s') })
    expect(gitPolicy({ mode: 'read-only', workspaceRoot: '/w' }, ['/scratch', '/more'])).toEqual({
      mode: 'workspace-write', workspaceRoot: '/scratch', additionalWritableRoots: ['/more'],
    })
  })
})

/** A context that answers `get` from the given services. */
function services(entries: { sandbox?: unknown; sandboxPolicy?: unknown }): Context {
  return { get: (name: 'sandbox' | 'sandboxPolicy') => entries[name] } as never
}

describe('sessionConfinement', () => {
  const rules = [{ fatalSignatures: ['runner:'] }]

  it('leaves commands unconfined where the Session\'s commands run unconfined', async () => {
    const confine = vi.fn()
    const resolve = vi.fn(() => ({ mode: 'danger-full-access', workspaceRoot: '/w' }))
    expect(await sessionConfinement(services({ sandboxPolicy: { resolve } }), session)(['git'], [], signal)).toBeUndefined()
    expect(await sessionConfinement(services({ sandbox: { confine } }), session)(['git'], [], signal)).toBeUndefined()
    expect(await sessionConfinement(services({ sandbox: { confine }, sandboxPolicy: { resolve } }), session)(['git'], [], signal)).toBeUndefined()
    expect(resolve).toHaveBeenCalledWith({ session })
    expect(confine).not.toHaveBeenCalled()
  })

  it('wraps each command under the Session\'s policy resolved when the command starts', async () => {
    const confine = vi.fn((argv: readonly string[], _policy: SandboxPolicy) => Promise.resolve({ argv: ['runner', ...argv], runnerFailureRules: rules }))
    const resolve = vi.fn(() => ({ mode: 'workspace-write', workspaceRoot: '/w' }))
    const confinement = sessionConfinement(services({ sandbox: { confine }, sandboxPolicy: { resolve } }), session)
    expect(await confinement(['git', 'add'], ['/scratch'], signal)).toEqual({ argv: ['runner', 'git', 'add'], mode: 'workspace-write', runnerFailureRules: rules })
    expect(confine).toHaveBeenCalledWith(['git', 'add'], { mode: 'workspace-write', workspaceRoot: '/w', additionalWritableRoots: ['/scratch'] }, signal)
    resolve.mockReturnValue({ mode: 'read-only', workspaceRoot: '/w' })
    expect(await confinement(['git', 'rev-parse'], [], signal)).toMatchObject({ mode: 'read-only' })
  })

  it('rejects a command when the Session\'s policy is confined but no sandbox service is mounted', async () => {
    for (const mode of ['workspace-write', 'read-only']) {
      const confinement = sessionConfinement(services({ sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: '/w' }) } }), session)
      await expect(confinement(['git'], [], signal)).rejects.toBeInstanceOf(SandboxUnavailableError)
    }
  })

  it('rejects a command the sandbox cannot confine instead of running it unconfined', async () => {
    const refused = new SandboxUnavailableError('workspace-write')
    const confinement = sessionConfinement(services({
      sandbox: { confine: () => Promise.reject(refused) },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/w' }) },
    }), session)
    await expect(confinement(['git'], [], signal)).rejects.toBe(refused)
  })
})

async function runner(confinement: GitConfinement): Promise<GitRunner> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return new GitRunner(ctx.subprocess, await ctx.subprocess.resolveExecutable('git'), { timeoutMs: 30_000, outputMaxBytes: 1024 * 1024 }).confinedBy(confinement)
}

describe.skipIf(process.platform === 'win32')('a confined GitRunner', () => {
  it('spawns the wrapped argv and passes the private directory to the wrapper', async () => {
    const cwd = await scratchDir('dsh-git-confined-', cleanups)
    const calls: Array<{ argv: readonly string[]; writes: readonly string[] }> = []
    const command = await runner((argv, writes) => {
      calls.push({ argv, writes })
      return Promise.resolve({ argv: ['/bin/sh', '-c', 'echo wrapped "$@"', 'sh', ...argv.slice(1)], mode: 'workspace-write', runnerFailureRules: [] })
    })
    const result = await command.run(['status'], { cwd, writes: ['/scratch'], signal })
    expect(result.stdout.trim()).toBe('wrapped status')
    expect(calls).toEqual([{ argv: [expect.stringMatching(/git$/), 'status'], writes: ['/scratch'] }])
  })

  it('reports a confinement that failed before git ran as an unavailable sandbox, and a git failure as a result', async () => {
    const cwd = await scratchDir('dsh-git-confined-', cleanups)
    const failing = (stderr: string) => runner(() => Promise.resolve({
      argv: ['/bin/sh', '-c', `echo '${stderr}' >&2; exit 1`], mode: 'read-only', runnerFailureRules: [{ fatalSignatures: ['runner: cannot'] }],
    }))
    await expect((await failing('runner: cannot set up namespaces')).run(['status'], { cwd, signal })).rejects.toThrow(SandboxUnavailableError)
    expect(await (await failing('fatal: not a git repository')).run(['status'], { cwd, signal })).toMatchObject({ exitCode: 1, stderr: 'fatal: not a git repository\n' })
  })
})

async function repository(): Promise<string> {
  const cwd = await scratchDir('dsh-workspace-changes-confined-', cleanups)
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'one\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

async function boot(extra: (ctx: Context) => Promise<void>) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem)
  await extra(ctx)
  // Outside the temporary roots a workspace-write Session's commands can write.
  const scratchRoot = await realpath(await mkdtemp(join(homedir(), '.dsh-workspace-changes-scratch-')))
  cleanups.push(() => rm(scratchRoot, { recursive: true, force: true }))
  await ctx.plugin(WorkspaceChanges, { scratchRoot } as WorkspaceChanges.Config)
  return ctx
}

/** One turn whose command changes `a.txt`. */
async function turn(ctx: Context, cwd: string, id: string): Promise<Session> {
  const created = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  startTurn(created, 1)
  await settle(ctx, created)
  await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n')
  toolCall(created, 1, 'bash', { command: 'x' })
  endTurn(created, 1)
  await settle(ctx, created)
  return created
}

// Each turn runs about ten git commands.
describe('workspace-changes under a Session\'s sandbox', { timeout: 60_000 }, () => {
  it('confines every git command over the repository under the Session\'s policy plus its private directory', async () => {
    const cwd = await repository()
    const policies: SandboxPolicy[] = []
    let mode = 'workspace-write'
    const ctx = await boot((ctx) => {
      ctx.provide('sandbox', { confine: (argv: readonly string[], policy: SandboxPolicy) => {
        policies.push(policy)
        return Promise.resolve({ argv, runnerFailureRules: [] })
      } } as never)
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode, workspaceRoot: cwd }) } as never)
      return Promise.resolve()
    })
    const recorded = await turn(ctx, cwd, 'confined')
    expect(changes(ctx, recorded).map(summary => summary.files.map(file => file.path))).toEqual([['a.txt']])
    const [locate, ...rest] = policies
    expect(locate).toEqual({ mode: 'workspace-write', workspaceRoot: cwd })
    expect(rest.length).toBeGreaterThan(4)
    for (const policy of rest) {
      expect(policy).toMatchObject({ mode: 'workspace-write', workspaceRoot: cwd, additionalWritableRoots: [expect.stringMatching(/dsh-workspace-changes-scratch-.*session-/)] })
    }
    policies.length = 0
    mode = 'danger-full-access'
    await turn(ctx, cwd, 'unconfined')
    expect(policies).toEqual([])
  })

  it('records nothing for a turn whose git commands the sandbox cannot confine', async () => {
    const cwd = await repository()
    const ctx = await boot((ctx) => {
      ctx.provide('sandbox', { confine: () => Promise.reject(new SandboxUnavailableError('workspace-write')) } as never)
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd }) } as never)
      return Promise.resolve()
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const recorded = await turn(ctx, cwd, 'refused')
    expect(changes(ctx, recorded)).toEqual([])
    expect(warn.mock.calls.map(call => String(call[0])).filter(message => message.startsWith('workspace-changes:'))).toHaveLength(1)
  })
})

const bwrapUsable = process.platform === 'linux'
  && spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' }).status === 0

describe.skipIf(!bwrapUsable)('workspace-changes under a real bwrap sandbox', { timeout: 60_000 }, () => {
  it('summarizes a turn from confined git commands', async () => {
    const cwd = await realpath(await repository())
    const ctx = await boot(async (ctx) => {
      await ctx.plugin(LocalSandboxProvider, {})
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd }) } as never)
    })
    const confine = vi.spyOn(ctx.sandbox, 'confine')
    const recorded = await turn(ctx, cwd, 'bwrap')
    expect(changes(ctx, recorded)).toMatchObject([{ total: 1, added: 1, deleted: 0, files: [{ path: 'a.txt' }] }])
    expect(confine.mock.calls.length).toBeGreaterThan(4)
    expect(await ctx.workspaceChanges.diff(recorded.id, recorded.snapshotEvents().filter(event => event.type === 'workspace/changes').at(-1)!.seq, 0, signal))
      .toMatchObject({ kind: 'text', hunks: [{ lines: [' one', '+two'] }] })
  })
})
