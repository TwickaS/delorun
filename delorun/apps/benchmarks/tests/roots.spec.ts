import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertThrowaway, canonical, childEnvironment, createRoot, RealHomeRefusal, realHomes, removeTree } from '../src/harness/roots.ts'

const made: string[] = []
afterEach(() => {
  for (const path of made.splice(0)) removeTree(path)
})

/** A directory that stands in for the person's real home. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'delorun-bench-spec-home-'))
  made.push(home)
  return canonical(home)
}

describe('throwaway roots', () => {
  it('refuses the real home itself', () => {
    const home = fakeHome()
    expect(() => { assertThrowaway(home, [home]) }).toThrow(RealHomeRefusal)
  })

  it('refuses a directory that contains the real home', () => {
    const home = fakeHome()
    expect(() => { assertThrowaway(join(home, '..'), [home]) }).toThrow('contains the real home')
  })

  it('refuses a directory inside the real home\'s .delorun or .dsh, also before it exists', () => {
    const home = fakeHome()
    expect(() => { assertThrowaway(join(home, '.delorun'), [home]) }).toThrow('inside the real home\'s .delorun')
    expect(() => { assertThrowaway(join(home, '.dsh', 'sessions'), [home]) }).toThrow('inside the real home\'s .dsh')
  })

  it('refuses the real home reached through a symbolic link', () => {
    const home = fakeHome()
    const other = mkdtempSync(join(tmpdir(), 'delorun-bench-spec-link-'))
    made.push(other)
    symlinkSync(home, join(other, 'link'))
    expect(() => { assertThrowaway(join(other, 'link'), [home]) }).toThrow(RealHomeRefusal)
  })

  it('accepts a directory beside the real home and one below it outside .delorun and .dsh', () => {
    const home = fakeHome()
    expect(() => { assertThrowaway(join(home, 'mnt', 'clones'), [home]) }).not.toThrow()
    expect(() => { assertThrowaway(join(tmpdir(), 'elsewhere'), [home]) }).not.toThrow()
  })

  it('creates a root with home and tmp, and removes it with its read-only content', () => {
    const base = mkdtempSync(join(tmpdir(), 'delorun-bench-spec-base-'))
    made.push(base)
    const root = createRoot(base, [])
    expect(root.home).toBe(join(root.path, 'home'))
    expect(root.delorunHome).toBe(join(root.path, 'home', '.delorun'))
    expect(statSync(root.tmp).isDirectory()).toBe(true)
    const locked = join(root.home, 'runtime')
    mkdirSync(locked)
    writeFileSync(join(locked, 'file'), 'x')
    chmodSync(locked, 0o555)
    root.dispose()
    expect(existsSync(root.path)).toBe(false)
  })

  it('refuses a root inside the real home\'s .delorun and leaves nothing behind', () => {
    const home = fakeHome()
    mkdirSync(join(home, '.delorun'))
    expect(() => createRoot(join(home, '.delorun'), [home])).toThrow(RealHomeRefusal)
    expect(readdirSync(join(home, '.delorun'))).toEqual([])
  })

  it('removes nothing when asked to remove a tree that does not exist', () => {
    expect(() => { removeTree(join(tmpdir(), 'delorun-bench-spec-absent-tree')) }).not.toThrow()
  })

  it('builds a child environment from nothing but the root, the path and the extras', () => {
    const base = mkdtempSync(join(tmpdir(), 'delorun-bench-spec-base-'))
    made.push(base)
    const root = createRoot(base, [])
    expect(childEnvironment(root, ['/opt/node/bin'], { EXTRA: '1' })).toEqual({ HOME: root.home, TMPDIR: root.tmp, PATH: '/opt/node/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', EXTRA: '1' })
    expect(childEnvironment(root, [])).not.toHaveProperty('USER')
    rmSync(root.path, { recursive: true })
  })

  it('reads the real homes from the environment and the account, without duplicates', () => {
    const homes = realHomes({ HOME: '' })
    expect(homes.length).toBeGreaterThan(0)
    expect(new Set(homes).size).toBe(homes.length)
  })
})

describe('copying a home', () => {
  it('hard-links the runtimes, copies everything else, and removing the copy leaves the template\'s files as they were', async () => {
    const { copyHome } = await import('../src/fixtures/home.ts')
    const base = mkdtempSync(join(tmpdir(), 'delorun-bench-spec-base-'))
    made.push(base)
    const template = createRoot(base, [])
    const runtime = join(template.delorunHome, 'runtimes', '0.1.0')
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'file'), 'runtime')
    chmodSync(join(runtime, 'file'), 0o444)
    chmodSync(runtime, 0o555)
    mkdirSync(join(template.delorunHome, 'sessions'))
    writeFileSync(join(template.delorunHome, 'sessions', 'chat'), 'chat')
    writeFileSync(join(template.home, '.profile'), 'shell')
    chmodSync(template.delorunHome, 0o700)
    const copy = createRoot(base, [])
    copyHome(template, copy)
    expect(statSync(join(copy.delorunHome, 'runtimes', '0.1.0', 'file')).ino).toBe(statSync(join(runtime, 'file')).ino)
    expect(statSync(join(copy.delorunHome, 'sessions', 'chat')).ino).not.toBe(statSync(join(template.delorunHome, 'sessions', 'chat')).ino)
    expect(statSync(join(copy.home, '.profile')).isFile()).toBe(true)
    expect(statSync(copy.delorunHome).mode & 0o777).toBe(0o700)
    copy.dispose()
    expect(existsSync(copy.path)).toBe(false)
    expect(statSync(join(runtime, 'file')).mode & 0o777).toBe(0o444)
    template.dispose()
  })
})
