/**
 * Specs of the permission store and the workspace key: the file's protected
 * path, its format's round trip, the refusals that make a store count for
 * nothing, the synchronous read and the file identity a Host compares before a
 * decision, the lock that keeps two processes' changes from overwriting each
 * other, and the canonical key that makes one directory one workspace.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { currentHolder, randomLockId } from '@delo/home'
import {
  defaultPresetOf,
  fullAccessGranted,
  parsePermissionStore,
  permissionStorePath,
  readPermissionStore,
  serializePermissionStore,
  FULL_ACCESS_PRESET,
  SAFER_PRESET,
  writePermissionStore,
  PermissionStoreError,
  permissionStoreIdentity,
  readPermissionStoreSync,
  withPermissionStoreLock,
} from '../src/store.ts'
import { NO_WORKSPACE, workspaceKey } from '../src/workspace.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A temporary directory the specs own.
 * @returns its path.
 */
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'delo-permission-store-'))
  roots.push(root)
  return root
}

describe('the store path', () => {
  it('sits under the home\'s protected state, in this package\'s own directory', () => {
    expect(permissionStorePath('/home/person/.delo')).toBe('/home/person/.delo/secrets/permission-defaults/workspaces.json')
  })
})

describe('the store format', () => {
  it('round-trips the entries, sorted by workspace key, with a trailing newline', () => {
    const entries = new Map([
      ['/work/zeta', { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 2 }],
      ['/work/alpha', { preset: SAFER_PRESET, fullAccessGrantedAt: null }],
    ])
    const text = serializePermissionStore(entries)
    expect(text).toBe(`${JSON.stringify({
      v: 1,
      workspaces: {
        '/work/alpha': { preset: 'workspace-write', fullAccessGrantedAt: null },
        '/work/zeta': { preset: 'danger-full-access', fullAccessGrantedAt: 2 },
      },
    }, null, 2)}\n`)
    const parsed = parsePermissionStore(text)
    expect(parsed.get('/work/alpha')).toEqual({ preset: SAFER_PRESET, fullAccessGrantedAt: null })
    expect(parsed.get('/work/zeta')).toEqual({ preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 2 })
  })

  it('refuses a document that is not this version\'s format', () => {
    for (const [text, problem] of [
      ['{', 'no JSON document'],
      ['[]', 'not a JSON object'],
      [JSON.stringify({ v: 2, workspaces: {} }), 'the store\'s version is 2, not 1'],
      [JSON.stringify({ v: 1, workspaces: {}, extra: true }), 'the store sets extra'],
      [JSON.stringify({ v: 1, workspaces: [] }), 'the store does not hold a workspaces object'],
      [JSON.stringify({ v: 1, workspaces: { '': { preset: 'workspace-write', fullAccessGrantedAt: null } } }), 'an entry with an empty workspace key'],
      [JSON.stringify({ v: 1, workspaces: { '/w': { preset: 'workspace-write', fullAccessGrantedAt: null, extra: 1 } } }), 'the permission of the workspace "/w" sets extra'],
      [JSON.stringify({ v: 1, workspaces: { '/w': { preset: 'read-only', fullAccessGrantedAt: null } } }), 'the permission of the workspace "/w" does not hold the preset'],
      [JSON.stringify({ v: 1, workspaces: { '/w': { preset: 'workspace-write', fullAccessGrantedAt: 'now' } } }), 'the permission of the workspace "/w" does not hold a number grant time or null'],
      [JSON.stringify({ v: 1, workspaces: { '/w': 'workspace-write' } }), 'the permission of the workspace "/w" is not an object'],
    ] as const) {
      expect(() => parsePermissionStore(text), text).toThrow(PermissionStoreError)
      expect(() => parsePermissionStore(text), text).toThrow(problem)
    }
  })
})

describe('the store file', () => {
  it('reads as absent while no store exists, which records no workspace', async () => {
    const path = permissionStorePath(join(temporary(), 'home'))
    expect(await readPermissionStore(path)).toEqual({ kind: 'absent' })
  })

  it('writes a protected file in a private directory and reads it back', async () => {
    const home = join(temporary(), 'home')
    mkdirSync(home, { recursive: true })
    const path = permissionStorePath(home)
    const entries = new Map([['/work/app', { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 7 }]])
    await writePermissionStore(path, entries)
    expect(statSync(join(home, 'secrets', 'permission-defaults')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(await readPermissionStore(path)).toEqual({ kind: 'readable', entries })
  })

  it('refuses a store whose mode is laxer than a protected file\'s', async () => {
    const home = join(temporary(), 'home')
    mkdirSync(home, { recursive: true })
    const path = permissionStorePath(home)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, serializePermissionStore(new Map()), { mode: 0o644 })
    chmodSync(path, 0o644)
    const read = await readPermissionStore(path)
    expect(read.kind).toBe('refused')
    expect(read.kind === 'refused' ? read.problem : '').toContain('0600')
  })

  it('refuses a store that is a symbolic link, and one that is not this version\'s format', async () => {
    const home = join(temporary(), 'home')
    mkdirSync(home, { recursive: true })
    const path = permissionStorePath(home)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    const target = join(home, 'planted.json')
    writeFileSync(target, serializePermissionStore(new Map()), { mode: 0o600 })
    symlinkSync(target, path)
    const linked = await readPermissionStore(path)
    expect(linked.kind).toBe('refused')
    rmSync(path)
    writeFileSync(path, '{"v":1,"workspaces":{"x":{"preset":"read-only"}}}', { mode: 0o600 })
    const wrong = await readPermissionStore(path)
    expect(wrong.kind).toBe('refused')
    expect(wrong.kind === 'refused' ? wrong.problem : '').toContain('does not hold the preset')
  })
})

describe('the entries', () => {
  const entries = new Map([
    ['/work/full', { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 1 }],
    ['/work/safer', { preset: SAFER_PRESET, fullAccessGrantedAt: 2 }],
  ])

  it('answers a workspace with no entry with the safer preset and no grant', () => {
    expect(defaultPresetOf(entries, '/work/new')).toBe(SAFER_PRESET)
    expect(fullAccessGranted(entries, '/work/new')).toBe(false)
    expect(fullAccessGranted(entries, NO_WORKSPACE)).toBe(false)
  })

  it('answers a recorded workspace with its preset and its grant', () => {
    expect(defaultPresetOf(entries, '/work/full')).toBe(FULL_ACCESS_PRESET)
    expect(fullAccessGranted(entries, '/work/full')).toBe(true)
    expect(defaultPresetOf(entries, '/work/safer')).toBe(SAFER_PRESET)
    expect(fullAccessGranted(entries, '/work/safer')).toBe(true)
  })
})

describe('the workspace key', () => {
  it('canonicalizes trailing slashes, dot segments and symbolic links to one key', () => {
    const root = temporary()
    const workspace = join(root, 'app')
    mkdirSync(workspace)
    symlinkSync(workspace, join(root, 'alias'))
    expect(workspaceKey(workspace)).toBe(workspaceKey(`${workspace}/`))
    expect(workspaceKey(join(workspace, '..', 'app'))).toBe(workspaceKey(workspace))
    expect(workspaceKey(join(root, 'alias'))).toBe(workspaceKey(workspace))
  })

  it('names no workspace for a blank directory, and keeps the spelling of one that is gone', () => {
    expect(workspaceKey('')).toBe(NO_WORKSPACE)
    expect(workspaceKey('   ')).toBe(NO_WORKSPACE)
    expect(workspaceKey(join(homedir(), 'gone-workspace'))).toBe(join(homedir(), 'gone-workspace'))
  })
})

describe('the store read again by a decision that cannot wait', () => {
  it('names a changed file by a new identity, and reads it synchronously as the asynchronous read does', async () => {
    const path = permissionStorePath(temporary())
    expect(permissionStoreIdentity(path)).toBe('absent')
    expect(readPermissionStoreSync(path)).toEqual({ kind: 'absent' })
    await writePermissionStore(path, new Map([['/work', { preset: SAFER_PRESET, fullAccessGrantedAt: null }]]))
    const first = permissionStoreIdentity(path)
    expect(readPermissionStoreSync(path)).toEqual(await readPermissionStore(path))
    await writePermissionStore(path, new Map([['/work', { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 1 }]]))
    expect(permissionStoreIdentity(path)).not.toBe(first)
    expect(readPermissionStoreSync(path)).toMatchObject({ kind: 'readable', entries: new Map([['/work', { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 1 }]]) })
  })

  it('refuses synchronously what the protected-file rule refuses, and another format', async () => {
    const root = temporary()
    const path = permissionStorePath(root)
    await writePermissionStore(path, new Map())
    chmodSync(path, 0o644)
    expect(readPermissionStoreSync(path)).toMatchObject({ kind: 'refused', problem: expect.stringContaining('0644') })
    chmodSync(path, 0o600)
    writeFileSync(path, '{ not json', { mode: 0o600 })
    expect(readPermissionStoreSync(path)).toEqual({ kind: 'refused', problem: 'the store holds no JSON document' })
    rmSync(path)
    symlinkSync(join(root, 'elsewhere.json'), path)
    expect(readPermissionStoreSync(path)).toMatchObject({ kind: 'refused' })
    // A path below a regular file cannot be examined, and has an identity of its own.
    writeFileSync(join(root, 'file'), '')
    expect(permissionStoreIdentity(join(root, 'file', 'below'))).toBe('unexaminable:ENOTDIR')
  })
})

describe('the store lock', () => {
  it('keeps two concurrent read-check-write changes from overwriting each other', async () => {
    const path = permissionStorePath(temporary())
    const addOne = (workspace: string) => withPermissionStoreLock(path, async () => {
      const read = await readPermissionStore(path)
      const entries = new Map(read.kind === 'readable' ? read.entries : [])
      // Without the lock the other change would read the same file here and one write would be lost.
      await new Promise(resolve => setTimeout(resolve, 20))
      entries.set(workspace, { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 1 })
      await writePermissionStore(path, entries)
    })
    await Promise.all([addOne('/a'), addOne('/b')])
    const read = await readPermissionStore(path)
    expect(read.kind === 'readable' ? [...read.entries.keys()].sort() : []).toEqual(['/a', '/b'])
    expect(() => statSync(`${path}.lock`)).toThrow()
  })

  it('refuses a change while a live process holds the lock past the wait, and replaces a dead holder\'s lock', async () => {
    const path = permissionStorePath(temporary())
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(`${path}.lock`, JSON.stringify({ v: 1, ...currentHolder(), id: randomLockId() }), { mode: 0o600 })
    await expect(withPermissionStoreLock(path, async () => 'changed', 30)).rejects.toThrow(`process ${String(process.pid)} has been changing the permission store`)
    // A process id that no running process has.
    writeFileSync(`${path}.lock`, JSON.stringify({ v: 1, pid: 2 ** 22 + 7, id: randomLockId() }), { mode: 0o600 })
    await expect(withPermissionStoreLock(path, async () => 'changed', 1000)).resolves.toBe('changed')
  })
})
