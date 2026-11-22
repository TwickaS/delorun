/**
 * Plugin packs a profile links but the home lacks: which are found, that the step fetches them before the Host boots
 * with the install display's speed and time left, and that a pack it cannot fetch carries on with the remedy instead of
 * being skipped.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InstallRenderer, type InstallerProgress } from '@delorun/install'
import type { PreStartContext } from '../src/pre-start.ts'
import { fetchPacksShown, missingProfilePacks, profilePacksStep } from '../src/profile-packs.ts'
import { profileDirectory } from '../src/profile.ts'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'delorun-profile-packs-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function profileLinks(links: Record<string, string>): void {
  mkdirSync(profileDirectory(home, 'default'), { recursive: true })
  writeFileSync(join(profileDirectory(home, 'default'), 'package.json'), JSON.stringify({ dependencies: links }))
}
const folder = (release: string, name: string): string => join(home, 'packs', release, name, 'package')

function start(lines: string[], stored = true): PreStartContext {
  return {
    home, profile: 'default', kind: 'cli', successor: false,
    output: { stdout: (text) => { lines.push(text) }, stderr: () => undefined },
    ...stored ? { storedRuntime: { version: '0.1.0' as never, check: () => Promise.resolve() } } : {},
  }
}

describe('the packs a profile links but the home lacks', () => {
  it('finds a link into the running release\'s pack folder whose folder is missing, and nothing else', async () => {
    mkdirSync(folder('current', 'present'), { recursive: true })
    profileLinks({
      a: `link:${folder('current', '@delorun__bundle-browser')}`,
      b: `link:${folder('current', 'present')}`,
      c: `link:${folder('0.0.9', 'other-release')}`,
      d: 'link:/somewhere/else/plugin',
      e: '^1.0.0',
    })
    expect(await missingProfilePacks(home, 'default')).toEqual(['@delorun__bundle-browser'])
  })

  it('finds none for a profile without a manifest', async () => {
    expect(await missingProfilePacks(home, 'default')).toEqual([])
  })
})

describe('the profile-packs step', () => {
  it('fetches the missing packs and says which', async () => {
    profileLinks({ a: `link:${folder('current', '@delorun__bundle-browser')}` })
    const lines: string[] = []
    const fetched: string[][] = []
    await profilePacksStep((_context, folders) => { fetched.push([...folders]); return Promise.resolve() })(start(lines))
    expect(fetched).toEqual([['@delorun__bundle-browser']])
    expect(lines.join('')).toContain('@delorun/bundle-browser')
  })

  it('fetches nothing when no pack is missing, or when the start runs no stored runtime', async () => {
    const never = (): Promise<void> => Promise.reject(new Error('must not fetch'))
    await profilePacksStep(never)(start([]))
    profileLinks({ a: `link:${folder('current', 'x')}` })
    await profilePacksStep(never)(start([], false))
  })

  it('carries on with one line naming the reason and the remedy when a missing pack cannot be fetched', async () => {
    profileLinks({ a: `link:${folder('current', 'x')}` })
    const errors: string[] = []
    const context = { ...start([]), output: { stdout: () => undefined, stderr: (text: string) => { errors.push(text) } } }
    await expect(profilePacksStep(() => Promise.reject(new Error('x needs a connection')))(context)).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/x needs a connection[\s\S]*delorun recover packs/u)
  })
})

describe('the pack fetch display', () => {
  const NAME = '@delorun/bundle-browser'
  const TOTAL = 40_000_000

  it('reports each pack\'s download and install to the install display, bytes against the pack\'s size', async () => {
    const events: InstallerProgress[] = []
    const ends: string[] = []
    await fetchPacksShown(['@delorun__bundle-browser'], {
      entry: (folder) => ({ name: folder.replace('__', '/'), bytes: TOTAL }),
      fetch: (_name, onBytes) => { onBytes(10_000_000); onBytes(TOTAL); return Promise.resolve('fetched') },
      install: (fetched) => { expect(fetched).toBe('fetched'); return Promise.resolve() },
    }, { handle: (event) => { events.push(event) }, fail: () => { ends.push('fail') }, close: () => { ends.push('close') } })
    expect(events).toEqual([
      { step: 'pack-downloading', name: NAME, bytes: TOTAL },
      { step: 'pack-bytes', name: NAME, received: 10_000_000, total: TOTAL },
      { step: 'pack-bytes', name: NAME, received: TOTAL, total: TOTAL },
      { step: 'pack-installing', name: NAME, bytes: TOTAL },
      { step: 'pack-installed', name: NAME },
    ])
    expect(ends).toEqual(['close'])
  })

  it('shows the speed and the time left on a terminal while a pack downloads', async () => {
    let time = 0
    let frame: (() => void) | undefined
    const out: string[] = []
    const display = new InstallRenderer({ write: (text) => { out.push(text) }, terminal: true, columns: () => 100, now: () => time, every: (fn) => { frame = fn; return () => { frame = undefined } } })
    let shown = ''
    await fetchPacksShown(['@delorun__bundle-browser'], {
      entry: () => ({ name: NAME, bytes: TOTAL }),
      fetch: (_name, onBytes) => {
        time += 2000
        onBytes(10_000_000)
        frame?.()
        shown = out.join('')
        return Promise.resolve(undefined)
      },
      install: () => Promise.resolve(),
    }, display)
    expect(shown).toContain('10.0 / 40.0 MB  5.0 MB/s  ~6.0s left')
  })

  it('shows the failure and stops at a pack the release does not publish', async () => {
    const ends: string[] = []
    const fetched: string[] = []
    await expect(fetchPacksShown(['a', 'b'], {
      entry: (folder) => { if (folder === 'b') throw new Error('release 0.1.0 publishes no plugin pack b'); return { name: folder, bytes: 1 } },
      fetch: (name) => { fetched.push(name); return Promise.resolve(undefined) },
      install: () => Promise.resolve(),
    }, { handle: () => undefined, fail: () => { ends.push('fail') }, close: () => { ends.push('close') } })).rejects.toThrow('publishes no plugin pack b')
    expect(fetched).toEqual(['a'])
    expect(ends).toEqual(['fail'])
  })
})
