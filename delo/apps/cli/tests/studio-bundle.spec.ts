/** A CLI profile that setup created before the studio bundle existed gets it at start, once. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_BUNDLE, STUDIO_BUNDLE } from '@delo/bundle-local/profile'
import type { BundleLinking } from '../src/delo-bundles.ts'
import { addStudioBundle, lacksStudioBundle, profileBundles } from '../src/studio-bundle.ts'

const UPSTREAM = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

let home: string

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'delo-studio-bundle-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/**
 * Write the CLI profile's manifest.
 * @param text - the manifest's text.
 */
function manifest(text: string): void {
  mkdirSync(join(home, 'profiles', 'default'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'default', 'package.json'), text)
}

/**
 * A linking whose resolution supplies nothing, so every Delo bundle is added with `dsh plugin add link:`.
 * @param calls - collects each plugin command's arguments.
 * @returns the linking.
 */
function linking(calls: (readonly string[])[]): BundleLinking {
  return {
    installAnchor: '/install/package.json',
    resolve: () => Promise.resolve({ profile: { layers: [] }, resolution: { entries: [], localPackageNames: [] } } as never),
    runPluginCommand: (_context, args) => { calls.push(args); return Promise.resolve({ exitCode: 0, logPath: '/log' }) },
  }
}

describe('the profile\'s bundle list', () => {
  it('reads the list a manifest names', () => {
    manifest(JSON.stringify({ dsh: { profile: { bundles: [...UPSTREAM, LOCAL_BUNDLE] } } }))
    expect(profileBundles(home, 'default')).toEqual([...UPSTREAM, LOCAL_BUNDLE])
  })

  it('reads none from a missing, malformed or differently built manifest', () => {
    expect(profileBundles(home, 'default')).toBeUndefined()
    for (const text of ['{', 'null', '{"dsh":"x"}', '{"dsh":{"profile":{"bundles":"x"}}}', '{"dsh":{"profile":{"bundles":[1]}}}']) {
      manifest(text)
      expect(profileBundles(home, 'default'), text).toBeUndefined()
    }
  })

  it('lacks the studio bundle only when it lists the local bundle without it', () => {
    expect(lacksStudioBundle([...UPSTREAM, LOCAL_BUNDLE])).toBe(true)
    expect(lacksStudioBundle([...UPSTREAM, LOCAL_BUNDLE, STUDIO_BUNDLE])).toBe(false)
    expect(lacksStudioBundle(UPSTREAM)).toBe(false)
  })
})

describe('adding the studio bundle', () => {
  it('adds it to a profile setup made before it existed, with the operation setup uses', async () => {
    manifest(JSON.stringify({ dsh: { profile: { bundles: [...UPSTREAM, LOCAL_BUNDLE] } } }))
    const calls: (readonly string[])[] = []
    expect(await addStudioBundle(home, 'default', () => Promise.resolve(linking(calls)), () => undefined)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('add')
    expect(calls[0]?.[1]).toMatch(/^link:.*bundle-studio\/$/u)
  })

  it('leaves a profile that lists it, and one Delo\'s setup did not make, without asking for a linking', async () => {
    const make = vi.fn(() => Promise.resolve(linking([])))
    manifest(JSON.stringify({ dsh: { profile: { bundles: [...UPSTREAM, LOCAL_BUNDLE, STUDIO_BUNDLE] } } }))
    expect(await addStudioBundle(home, 'default', make, () => undefined)).toBe(false)
    manifest(JSON.stringify({ dsh: { profile: { bundles: UPSTREAM } } }))
    expect(await addStudioBundle(home, 'default', make, () => undefined)).toBe(false)
    manifest('{')
    expect(await addStudioBundle(home, 'default', make, () => undefined)).toBe(false)
    expect(make).not.toHaveBeenCalled()
  })
})
