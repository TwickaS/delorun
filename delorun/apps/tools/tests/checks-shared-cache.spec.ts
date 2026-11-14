/**
 * The machine-wide pass store against temporary directories: where it lives, which directories it refuses, entries that
 * do not serve a check, writes that fail without failing the run, and the expiry of old entries.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENTRY_LIFETIME_MS, openSharedStore, SHARED_CACHE_ENV, sharedCacheDir, type StoreOwner } from '../src/checks/shared-cache.ts'

const KEY = 'a'.repeat(64)
const OTHER_KEY = 'b'.repeat(64)
const temporary: string[] = []

/**
 * A fresh temporary directory, removed after the test.
 * @returns the directory.
 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'delorun-shared-cache-'))
  temporary.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    if (existsSync(dir)) chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The owner a store is opened for: a repository root elsewhere, this user and a fixed clock.
 * @param now - the clock's time in milliseconds.
 * @returns the owner.
 */
function owner(now = Date.now()): StoreOwner {
  return { root: tempDir(), uid: process.getuid?.() ?? 0, now: () => now }
}

describe('sharedCacheDir', () => {
  it('takes DELORUN_CHECKS_SHARED_CACHE, then an absolute XDG_CACHE_HOME, then ~/.cache, each with delorun/checks', () => {
    expect(sharedCacheDir({ [SHARED_CACHE_ENV]: '/var/cache/x/../passes' }, '/home/u')).toBe('/var/cache/passes')
    expect(sharedCacheDir({ XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe('/xdg/delorun/checks')
    expect(sharedCacheDir({ XDG_CACHE_HOME: 'relative', [SHARED_CACHE_ENV]: '' }, '/home/u')).toBe('/home/u/.cache/delorun/checks')
    expect(sharedCacheDir({}, '/home/u')).toBe('/home/u/.cache/delorun/checks')
  })

  it('refuses a relative DELORUN_CHECKS_SHARED_CACHE', () => {
    expect(() => sharedCacheDir({ [SHARED_CACHE_ENV]: 'cache' })).toThrow('DELORUN_CHECKS_SHARED_CACHE must be an absolute path, got cache')
  })
})

describe('openSharedStore', () => {
  it('creates its directory with mode 0700 and stores each pass as a 0600 file named by its key', () => {
    const dir = join(tempDir(), 'nested', 'checks')
    const store = openSharedStore(dir, owner())
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(store.store('gates:licence', KEY)).toBeUndefined()
    const entry = join(dir, 'passes', 'aa', `${KEY}.json`)
    expect(statSync(entry).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(entry, 'utf8'))).toEqual({ v: 1, id: 'gates:licence', key: KEY })
    expect(readdirSync(join(dir, 'passes', 'aa'))).toEqual([`${KEY}.json`])
    expect(store.has('gates:licence', KEY)).toBe(true)
  })

  it('serves a pass that another worktree\'s run stored, and only under its own key and check id', () => {
    const dir = tempDir()
    openSharedStore(dir, owner()).store('jsdoc', KEY)
    const other = openSharedStore(dir, owner())
    expect(other.has('jsdoc', KEY)).toBe(true)
    expect(other.has('jsdoc', OTHER_KEY)).toBe(false)
    expect(other.has('gates:docs', KEY)).toBe(false)
  })

  it('leaves one whole entry when two runs store the same key', () => {
    const dir = tempDir()
    const first = openSharedStore(dir, owner())
    const second = openSharedStore(dir, owner())
    first.store('jsdoc', KEY)
    second.store('jsdoc', KEY)
    expect(readdirSync(join(dir, 'passes', 'aa'))).toEqual([`${KEY}.json`])
    expect(first.has('jsdoc', KEY)).toBe(true)
  })

  it.each([
    ['not JSON', '{"v":1,'],
    ['another version', JSON.stringify({ v: 2, id: 'jsdoc', key: KEY })],
    ['another key inside', JSON.stringify({ v: 1, id: 'jsdoc', key: OTHER_KEY })],
    ['extra fields', JSON.stringify({ v: 1, id: 'jsdoc', key: KEY, passed: true })],
  ])('treats an entry that is %s as no pass', (_name, text) => {
    const dir = tempDir()
    mkdirSync(join(dir, 'passes', 'aa'), { recursive: true })
    writeFileSync(join(dir, 'passes', 'aa', `${KEY}.json`), text)
    chmodSync(dir, 0o700)
    expect(openSharedStore(dir, owner()).has('jsdoc', KEY)).toBe(false)
  })

  it('refuses a directory inside the repository, the repository itself, and accepts a sibling whose name starts with two dots', () => {
    const root = tempDir()
    const at = (): StoreOwner => ({ root, uid: process.getuid?.() ?? 0, now: () => 0 })
    expect(() => openSharedStore(join(root, 'node_modules', '.cache'), at())).toThrow(/lies inside the repository; set DELORUN_CHECKS_SHARED_CACHE/)
    expect(() => openSharedStore(root, at())).toThrow(/lies inside the repository/)
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
    expect(() => openSharedStore(join(root, '..store'), at())).toThrow(/lies inside the repository/)
    const sibling = `${root}..store`
    temporary.push(sibling)
    expect(openSharedStore(sibling, at()).dir).toBe(sibling)
  })

  it('refuses a directory that other users can reach, until its mode is 0700', () => {
    const dir = tempDir()
    chmodSync(dir, 0o755)
    expect(() => openSharedStore(dir, owner())).toThrow(`has mode 755, which other users can reach; run \`chmod 700 ${dir}\``)
    chmodSync(dir, 0o770)
    expect(() => openSharedStore(dir, owner())).toThrow('has mode 770')
    chmodSync(dir, 0o700)
    expect(openSharedStore(dir, owner()).dir).toBe(dir)
  })

  it('refuses a directory another user owns', () => {
    const dir = tempDir()
    expect(() => openSharedStore(dir, { ...owner(), uid: (process.getuid?.() ?? 0) + 1 })).toThrow(/belongs to user \d+, not to this user/)
  })

  it('refuses a symbolic link in place of the directory', () => {
    const target = tempDir()
    const link = join(tempDir(), 'link')
    symlinkSync(target, link)
    expect(() => openSharedStore(link, owner())).toThrow('is not a directory (a symbolic link is refused)')
  })

  it('reports a write that fails, removes its temporary file, and keeps serving the other entries', () => {
    const dir = tempDir()
    const store = openSharedStore(dir, owner())
    store.store('jsdoc', OTHER_KEY)
    writeFileSync(join(dir, 'passes', 'aa'), 'a file where the shard directory goes')
    expect(store.store('jsdoc', KEY)).toMatch(/EEXIST|ENOTDIR/)
    expect(readdirSync(join(dir, 'passes')).sort()).toEqual(['aa', 'bb'])
    expect(store.has('jsdoc', OTHER_KEY)).toBe(true)
  })

  it('removes the written temporary file when the rename into place fails', () => {
    const dir = tempDir()
    const store = openSharedStore(dir, owner())
    mkdirSync(join(dir, 'passes', 'aa', `${KEY}.json`), { recursive: true })
    expect(store.store('jsdoc', KEY)).toMatch(/EISDIR|ENOTEMPTY|EEXIST/)
    expect(readdirSync(join(dir, 'passes', 'aa'))).toEqual([`${KEY}.json`])
    expect(store.has('jsdoc', KEY)).toBe(false)
  })

  it('removes entries older than their lifetime once a day, and leaves newer ones', () => {
    const dir = tempDir()
    const now = Date.now()
    const store = openSharedStore(dir, owner(now))
    store.store('jsdoc', KEY)
    store.store('jsdoc', OTHER_KEY)
    const old = (now - ENTRY_LIFETIME_MS - 1000) / 1000
    utimesSync(join(dir, 'passes', 'aa', `${KEY}.json`), old, old)
    symlinkSync(join(dir, 'gone'), join(dir, 'passes', 'bb', 'dangling.json'))
    // Pruned within the last day: nothing is removed.
    openSharedStore(dir, owner(now))
    expect(existsSync(join(dir, 'passes', 'aa', `${KEY}.json`))).toBe(true)
    const tomorrow = now + 25 * 60 * 60 * 1000
    const later = openSharedStore(dir, owner(tomorrow))
    expect(later.has('jsdoc', KEY)).toBe(false)
    expect(later.has('jsdoc', OTHER_KEY)).toBe(true)
  })
})
