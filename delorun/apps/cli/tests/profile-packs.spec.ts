/**
 * Plugin packs a profile links but the home lacks: which are found, that the step fetches them before the Host boots,
 * and that a pack it cannot fetch carries on with the remedy instead of being skipped.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PreStartContext } from '../src/pre-start.ts'
import { missingProfilePacks, profilePacksStep } from '../src/profile-packs.ts'
import { profileDirectory } from '../src/profile.ts'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'delorun-profile-packs-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

function profileLinks(links: Record<string, string>): void {
  mkdirSync(profileDirectory(home, 'default'), { recursive: true })
  writeFileSync(join(profileDirectory(home, 'default'), 'package.json'), JSON.stringify({ dependencies: links }))
}
const folder = (version: string, name: string): string => join(home, 'packs', version, name, 'package')

function start(lines: string[], stored = true): PreStartContext {
  return {
    home, profile: 'default', kind: 'cli', successor: false,
    output: { stdout: (text) => { lines.push(text) }, stderr: () => undefined },
    ...stored ? { storedRuntime: { version: '0.1.0' as never, check: () => Promise.resolve() } } : {},
  }
}

describe('the packs a profile links but the home lacks', () => {
  it('finds a link into the running release\'s pack folder whose folder is missing, and nothing else', async () => {
    mkdirSync(folder('0.1.0', 'present'), { recursive: true })
    profileLinks({
      a: `link:${folder('0.1.0', '@delorun__bundle-browser')}`,
      b: `link:${folder('0.1.0', 'present')}`,
      c: `link:${folder('0.0.9', 'other-release')}`,
      d: 'link:/somewhere/else/plugin',
      e: '^1.0.0',
    })
    expect(await missingProfilePacks(home, 'default', '0.1.0')).toEqual(['@delorun__bundle-browser'])
  })

  it('finds none for a profile without a manifest', async () => {
    expect(await missingProfilePacks(home, 'default', '0.1.0')).toEqual([])
  })
})

describe('the profile-packs step', () => {
  it('fetches the missing packs and says which', async () => {
    profileLinks({ a: `link:${folder('0.1.0', '@delorun__bundle-browser')}` })
    const lines: string[] = []
    const fetched: string[][] = []
    await profilePacksStep((_context, folders) => { fetched.push([...folders]); return Promise.resolve() })(start(lines))
    expect(fetched).toEqual([['@delorun__bundle-browser']])
    expect(lines.join('')).toContain('@delorun/bundle-browser')
  })

  it('fetches nothing when no pack is missing, or when the start runs no stored runtime', async () => {
    const never = (): Promise<void> => Promise.reject(new Error('must not fetch'))
    await profilePacksStep(never)(start([]))
    profileLinks({ a: `link:${folder('0.1.0', 'x')}` })
    await profilePacksStep(never)(start([], false))
  })

  it('carries on with one line naming the reason and the remedy when a missing pack cannot be fetched', async () => {
    profileLinks({ a: `link:${folder('0.1.0', 'x')}` })
    const errors: string[] = []
    const context = { ...start([]), output: { stdout: () => undefined, stderr: (text: string) => { errors.push(text) } } }
    await expect(profilePacksStep(() => Promise.reject(new Error('x needs a connection')))(context)).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/x needs a connection[\s\S]*delorun recover packs/u)
  })
})
