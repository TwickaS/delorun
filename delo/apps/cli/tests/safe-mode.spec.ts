/**
 * The start half of safe mode: a home with a safe-mode marker boots the profile without its third-party bundles and
 * without the person's rows for them, edits no profile file, and prints what it left out. A home without a marker boots
 * the profile upstream loaded, unchanged.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Profile, ProfileLayer } from '@deepseek-ai/dsh-app-boot'
import type { ResolvedProfileRuntime } from '@deepseek-ai/dsh/profile-boot'
import { enterSafeMode, safeModePath } from '@delo/profile-safety'
import { overlayPath, removeSafeModeOverlay, SAFE_MODE_PATCH_FILENAME, safeModeNotice, safeModeStart } from '../src/safe-mode.ts'

let root: string
let home: string
let profileDir: string

/** A layer that contributes no patches, which the profile loader's shape still requires. */
function layer(packageName: string): ProfileLayer {
  return { packageName, packageDir: join(home, 'profiles', 'default', 'node_modules', packageName), patchPaths: [], patches: [] }
}

/**
 * The profile upstream's loader returns for the fixture, with the layers given.
 * @param bundles - the bundle names to resolve as layers.
 * @returns the resolved profile and installation anchor.
 */
function resolved(bundles: readonly string[]): ResolvedProfileRuntime {
  const profile: Profile = {
    name: 'default',
    dir: profileDir,
    layers: bundles.map(layer),
    patchPath: join(profileDir, 'cordis.patch.yml'),
    patches: [],
    skippedBundles: [],
  }
  return { profile, installAnchor: join(root, 'package.json') }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delorun-safe-mode-'))
  home = join(root, 'home')
  profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-default',
    private: true,
    dependencies: { '@me/own-bundle': 'file:../own' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@delo/bundle-local', '@me/own-bundle'] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), JSON.stringify([
    { insert: [{ id: 'own-row', name: '@me/own-bundle', config: { level: 'strict' } }] },
    { insert: [{ id: 'base-row', name: '@deepseek-ai/dsh-base' }] },
  ]) + '\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('safeModeStart', () => {
  it('boots the profile upstream loaded when the home is not in safe mode', () => {
    const profile = resolved(['@deepseek-ai/dsh-base', '@delo/bundle-local', '@me/own-bundle'])
    expect(safeModeStart({ home, profile: 'default', resolvedProfile: profile })).toBeUndefined()
  })

  it('leaves out the third-party layer and disables its rows through an overlay, editing no profile file', async () => {
    const patchBefore = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    await enterSafeMode({ homeDir: home, profile: 'default', reason: 'a plugin broke the start', skipped: ['@me/own-bundle'] })
    const profile = resolved(['@deepseek-ai/dsh-base', '@delo/bundle-local', '@me/own-bundle'])
    const start = safeModeStart({ home, profile: 'default', resolvedProfile: profile })
    expect(start?.skipped).toEqual(['@me/own-bundle'])
    expect(start?.resolvedProfile.profile.layers.map(entry => entry.packageName)).toEqual(['@deepseek-ai/dsh-base', '@delo/bundle-local'])
    const overlay = join(home, 'run', 'default', SAFE_MODE_PATCH_FILENAME)
    expect(start?.patchFiles).toEqual([overlay])
    expect(JSON.parse(readFileSync(overlay, 'utf8'))).toEqual([{ id: 'own-row', disabled: true }])
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect(safeModeNotice(start!)).toContain('Delo starts in safe mode: it leaves out @me/own-bundle.')
    expect(existsSync(safeModePath(home, 'default'))).toBe(true)
  })

  it('writes the overlay under the run directory and removes it when safe mode ends', async () => {
    await enterSafeMode({ homeDir: home, profile: 'default', reason: 'a plugin broke the start', skipped: ['@me/own-bundle'] })
    const start = safeModeStart({ home, profile: 'default', resolvedProfile: resolved(['@deepseek-ai/dsh-base', '@delo/bundle-local', '@me/own-bundle']) })
    expect(existsSync(overlayPath(home, 'default'))).toBe(true)
    expect(start?.patchFiles).toEqual([overlayPath(home, 'default')])
    removeSafeModeOverlay(home, 'default')
    expect(existsSync(overlayPath(home, 'default'))).toBe(false)
  })

  it('adds no overlay when the person has no row for a third-party bundle', async () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
    await enterSafeMode({ homeDir: home, profile: 'default', reason: 'a plugin broke the start', skipped: ['@me/own-bundle'] })
    const start = safeModeStart({ home, profile: 'default', resolvedProfile: resolved(['@deepseek-ai/dsh-base', '@delo/bundle-local', '@me/own-bundle']) })
    expect(start?.patchFiles).toEqual([])
    expect(start?.skipped).toEqual(['@me/own-bundle'])
    expect(safeModeNotice(start!)).toContain('leaves out @me/own-bundle')
  })
})
