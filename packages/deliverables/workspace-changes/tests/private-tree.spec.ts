/**
 * The private directory is checked by device and inode before every use, so a directory in it, the directory itself
 * or the scratch root replaced by a link is refused instead of followed; and it must lie outside every root any live
 * Session's confined commands can write, not only the recorded Session's.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CaptureStore } from '../src/capture.ts'
import { everyConfinedWritableRoot, protectedReadOf } from '../src/confinement.ts'
import { PrivateTree, processAlive, removeStaleDirectories } from '../src/files.ts'
import * as WorkspaceChanges from '../src/index.ts'
import { TurnRecorder } from '../src/recorder.ts'
import { changes, endTurn, git, settle, startTurn, toolCall } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function directory(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A file to capture, holding `text`. */
async function source(text: string): Promise<string> {
  const path = join(await directory('dsh-tree-source-'), 'file.txt')
  await writeFile(path, text)
  return path
}

describe('a private tree', () => {
  it('refuses a directory in it that was replaced by a link, and writes nothing through the link', async () => {
    const tree = await PrivateTree.create(join(await directory('dsh-tree-root-'), 'root'))
    const store = new CaptureStore(() => Promise.resolve(tree))
    expect(await store.capture(await source('first\n'), 1024)).toMatchObject({ kind: 'file' })
    const elsewhere = await directory('dsh-tree-elsewhere-')
    await rename(join(tree.path, 'captures'), join(tree.path, 'moved-away'))
    await symlink(elsewhere, join(tree.path, 'captures'))
    await expect(tree.verify()).rejects.toThrow('was replaced after it was created')
    await expect(store.capture(await source('second\n'), 1024)).rejects.toThrow('was replaced')
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('refuses the private directory or the scratch root replaced by a link, and removes nothing through it', async () => {
    const base = await directory('dsh-tree-root-')
    const tree = await PrivateTree.create(join(base, 'root'))
    const elsewhere = await directory('dsh-tree-elsewhere-')
    await writeFile(join(elsewhere, 'marker'), 'kept')
    await rename(tree.path, join(base, 'moved-session'))
    await symlink(elsewhere, tree.path)
    await expect(tree.remove(tree.path)).rejects.toThrow('was replaced')
    expect(readFileSync(join(elsewhere, 'marker'), 'utf8')).toBe('kept')

    const second = await PrivateTree.create(join(base, 'second-root'))
    const copy = join(base, 'copy-of-root')
    await mkdir(join(copy, second.path.slice(second.root.length + 1)), { recursive: true })
    await rename(second.root, join(base, 'moved-root'))
    await symlink(copy, second.root)
    await expect(second.verify()).rejects.toThrow('was replaced')
  })

  it('forgets a temporary directory once removed, and keeps verifying the rest', async () => {
    const tree = await PrivateTree.create(join(await directory('dsh-tree-root-'), 'root'))
    const temporary = await tree.temporary('index-')
    await tree.remove(temporary)
    expect(existsSync(temporary)).toBe(false)
    await expect(tree.verify()).resolves.toBeUndefined()
  })
})

describe('the writable roots a private directory must avoid', () => {
  it('are the union over every live Session, not only the recorded one', () => {
    const roots: Record<string, string[]> = { a: ['/a', '/tmp'], b: ['/b', '/tmp'], c: ['/c'] }
    const session = (id: string): Session => ({ id }) as never
    const stored = [session('a'), session('b')]
    const ctx = {
      get: (name: string) => name === 'sessions'
        ? { list: () => stored }
        : { resolve: ({ session: s }: { session: { id: string } }) => ({ mode: 'workspace-write', workspaceRoot: roots[s.id]![0] }) },
    } as never
    expect(everyConfinedWritableRoot(ctx, [session('c')]).filter(root => ['/a', '/b', '/c'].includes(root)).sort()).toEqual(['/a', '/b', '/c'])
    const none = { get: () => undefined } as never
    expect(everyConfinedWritableRoot(none, [session('c')])).toEqual([])
  })
})

async function repository(): Promise<string> {
  const cwd = await directory('dsh-tree-repo-')
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'one\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

describe('a turn whose private directory another Session could write', () => {
  it('records nothing while another live Session\'s writable root contains the scratch root, and records once it is gone', { timeout: 60_000 }, async () => {
    const cwd = await repository()
    // Outside every temporary root, as a person's cache folder is.
    const cache = await realpath(await mkdtemp(join(homedir(), '.dsh-tree-cache-')))
    cleanups.push(() => rm(cache, { recursive: true, force: true }))
    const scratchRoot = join(cache, 'dsh-workspace-changes')
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem)
    // Each Session's commands write their own working directory; no sandbox wraps git here.
    ctx.provide('sandboxPolicy', { resolve: ({ session }: { session: Session }) => ({ mode: 'workspace-write', workspaceRoot: session.header.cwd }) } as never)
    ctx.provide('sandbox', { confine: (argv: readonly string[]) => Promise.resolve({ argv, runnerFailureRules: [] }) } as never)
    await ctx.plugin(WorkspaceChanges, { scratchRoot } as WorkspaceChanges.Config)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const other = ctx.sessions.create(SessionId('other'), { meta: { cwd: cache } })
    const recorded = ctx.sessions.create(SessionId('recorded'), { meta: { cwd } })
    startTurn(recorded, 1)
    await settle(ctx, recorded)
    await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n')
    toolCall(recorded, 1, 'bash', { command: 'x' })
    endTurn(recorded, 1)
    await settle(ctx, recorded)
    expect(changes(ctx, recorded)).toEqual([])
    expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toContain('a live Session\'s confined commands can write')
    ctx.emit('session/disposed', other)
    vi.spyOn(ctx.sessions, 'list').mockReturnValue([recorded])
    startTurn(recorded, 2)
    await settle(ctx, recorded)
    await writeFile(join(cwd, 'a.txt'), 'one\ntwo\nthree\n')
    toolCall(recorded, 2, 'bash', { command: 'x' })
    endTurn(recorded, 2)
    await settle(ctx, recorded)
    expect(changes(ctx, recorded).map(summary => summary.files.map(file => file.path))).toEqual([['a.txt']])
  })
})

describe('stale private directories', () => {
  it('removes the directories of Host processes no longer running, and leaves this process\'s, a running one\'s, links and other entries', async () => {
    const root = await directory('dsh-tree-stale-')
    for (const name of ['session-999999991-aaaaaa', 'session-999999992-bbbbbb', `session-${process.pid}-cccccc`, 'unrelated']) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'copy'), 'x')
    }
    const elsewhere = await directory('dsh-tree-elsewhere-')
    await writeFile(join(elsewhere, 'marker'), 'kept')
    await symlink(elsewhere, join(root, 'session-999999993-dddddd'))
    const removed = await removeStaleDirectories(root, () => [], pid => pid === 999999992)
    expect(removed).toEqual([join(root, 'session-999999991-aaaaaa')])
    expect(readdirSync(root).sort()).toEqual(['session-999999992-bbbbbb', 'session-999999993-dddddd', `session-${process.pid}-cccccc`, 'unrelated'].sort())
    expect(readFileSync(join(elsewhere, 'marker'), 'utf8')).toBe('kept')
    expect(await removeStaleDirectories(join(root, 'missing'), () => [])).toEqual([])
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(999999991)).toBe(false)
  })
  it('removes nothing when the scratch root is a link, belongs to another user, or overlaps a live Session\'s writable root', async () => {
    const parent = await directory('dsh-tree-stale-root-')
    const real = join(parent, 'real')
    await mkdir(real)
    await mkdir(join(real, 'session-999999991-aaaaaa'))
    const stale = (): boolean => existsSync(join(real, 'session-999999991-aaaaaa'))
    const linked = join(parent, 'linked')
    await symlink(real, linked)
    await expect(removeStaleDirectories(linked, () => [], () => false)).rejects.toThrow(`scratch root ${linked} is not a directory`)
    expect(stale()).toBe(true)
    await expect(removeStaleDirectories(real, () => [parent], () => false)).rejects.toThrow(`overlaps ${parent}, which a live Session's confined commands can write`)
    expect(stale()).toBe(true)
    await expect(removeStaleDirectories(parent, () => [real], () => false)).rejects.toThrow(`overlaps ${real}`)
    expect(stale()).toBe(true)
    if (process.getuid !== undefined) {
      vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1)
      await expect(removeStaleDirectories(real, () => [], () => false)).rejects.toThrow('belongs to another user')
      expect(stale()).toBe(true)
      vi.restoreAllMocks()
    }
    expect(await removeStaleDirectories(real, () => [join(parent, 'elsewhere')], () => false)).toEqual([join(real, 'session-999999991-aaaaaa')])
    expect(stale()).toBe(false)
  })
})

describe('a file the sandbox protects from the Session', () => {
  it('is not captured, so no copy of it lands in the private directory', async () => {
    const protectedFile = await source('secret\n')
    const ctx = {
      get: (name: string) => name === 'sandbox'
        ? { protectedReads: { roots: [join(protectedFile, '..')], readable: [] } }
        : { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/w' }) },
    } as never
    const check = protectedReadOf(ctx, { id: 'protected' } as never)
    expect(check(protectedFile)).toBe(true)
    expect(check(join(tmpdir(), 'elsewhere.txt'))).toBe(false)
    const fullAccess = { get: (name: string) => name === 'sandbox' ? { protectedReads: { roots: ['/'], readable: [] } } : { resolve: () => ({ mode: 'danger-full-access' }) } } as never
    expect(protectedReadOf(fullAccess, { id: 'f' } as never)('/anything')).toBe(false)
    expect(protectedReadOf({ get: () => undefined } as never, { id: 'n' } as never)('/anything')).toBe(false)
  })
})

describe('cleanup that cannot be trusted', () => {
  it('leaves a private directory replaced by a link in place at disposal and warns, and refuses an unreadable scratch root', async () => {
    const cwd = await repository()
    const scratchRoot = join(await directory('dsh-tree-root-'), 'root')
    const elsewhere = await directory('dsh-tree-elsewhere-')
    await writeFile(join(elsewhere, 'marker'), 'kept')
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('dispose'), { meta: { cwd } })
    const warnings: string[] = []
    const recorder = new TurnRecorder(session, cwd, {
      git: Promise.resolve(null), scratchRoot, writableRoots: () => [], protectedRead: () => false,
      maxFiles: 10, maxFileBytes: 1024, diffTimeoutMs: 100, warn: (message) => { warnings.push(message) },
    })
    recorder.start(1)
    recorder.capture(await source('copied\n'))
    await recorder.settled()
    const [session1] = readdirSync(scratchRoot)
    await rename(join(scratchRoot, session1!), join(scratchRoot, 'moved'))
    await symlink(elsewhere, join(scratchRoot, session1!))
    await recorder.dispose()
    expect(readFileSync(join(elsewhere, 'marker'), 'utf8')).toBe('kept')
    expect(warnings.join('\n')).toContain('was replaced')

    const blocked = join(await directory('dsh-tree-blocked-'), 'file')
    await writeFile(blocked, '')
    await expect(removeStaleDirectories(blocked, () => [])).rejects.toThrow('is not a directory')
    await expect(removeStaleDirectories(join(blocked, 'below'), () => [])).rejects.toThrow('ENOTDIR')
    const unusable = new TurnRecorder(session, cwd, { ...{
      git: Promise.resolve(null), writableRoots: () => [], protectedRead: () => false,
      maxFiles: 10, maxFileBytes: 1024, diffTimeoutMs: 100, warn: () => undefined,
    }, scratchRoot: blocked })
    unusable.start(1)
    unusable.capture(await source('never\n'))
    await unusable.settled()
    await expect(unusable.dispose()).resolves.toBeUndefined()
  })

  it('warns at load when stale directories cannot be listed', async () => {
    const blocked = join(await directory('dsh-tree-blocked-'), 'file')
    await writeFile(blocked, '')
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(WorkspaceChanges, { scratchRoot: blocked } as WorkspaceChanges.Config)
    await vi.waitFor(() => { expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toContain('workspace-changes:') })
  })

  it('leaves stale directories in place at load and warns while a live Session\'s writable root contains the scratch root', async () => {
    const cache = await directory('dsh-tree-load-')
    const scratchRoot = join(cache, 'dsh-workspace-changes')
    await mkdir(join(scratchRoot, 'session-999999991-aaaaaa'), { recursive: true })
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem)
    ctx.provide('sandboxPolicy', { resolve: ({ session }: { session: Session }) => ({ mode: 'workspace-write', workspaceRoot: session.header.cwd }) } as never)
    ctx.provide('sandbox', { confine: (argv: readonly string[]) => Promise.resolve({ argv, runnerFailureRules: [] }) } as never)
    ctx.sessions.create(SessionId('writer'), { meta: { cwd: cache } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(WorkspaceChanges, { scratchRoot } as WorkspaceChanges.Config)
    await vi.waitFor(() => { expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toContain('stale private directories are left in place') })
    expect(existsSync(join(scratchRoot, 'session-999999991-aaaaaa'))).toBe(true)
  })
})
