/**
 * The profile history as the studio's Versions pane uses it: the listing with what made each version and the one the
 * profile matches, a saved version, and a switch that saves the current setup first and can be switched back.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isProfileSafetyError } from '../src/errors.ts'
import { openHistory, recordSnapshot } from '../src/snapshot.ts'
import {
  listProfileVersions, MAX_VERSION_NAME, originOf, saveProfileVersion, savedSummary, switchToVersion,
} from '../src/versions.ts'
import { fixture, readTree } from './support.ts'

const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch (_error) {
    return false
  }
})()

/** Add a plugin to the profile's manifest, the way a person's edit changes the setup. */
function addPlugin(profileDir: string, name: string): void {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-default',
    private: true,
    dependencies: { [name]: '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@delorun/bundle-local'] } },
  }, undefined, 2) + '\n')
}

describe('version names', () => {
  it('keeps a name on one line, within the limit', () => {
    expect(savedSummary()).toBe('Saved by you')
    expect(savedSummary('  \n  ')).toBe('Saved by you')
    expect(savedSummary('Work\n  setup\u0007')).toBe('Saved by you: Work setup')
    expect(savedSummary('x'.repeat(200))).toBe(`Saved by you: ${'x'.repeat(MAX_VERSION_NAME)}`)
  })

  it('reads the origin back from the summary', () => {
    expect(originOf('Saved by you: Work')).toEqual({ origin: 'saved', name: 'Work' })
    expect(originOf('Saved by you')).toEqual({ origin: 'saved' })
    expect(originOf('Before switching to Work')).toEqual({ origin: 'switch' })
    expect(originOf('Before update to Delorun 1.0.1')).toEqual({ origin: 'update' })
    expect(originOf('Install @me/alpha')).toEqual({ origin: 'other' })
  })
})

describe.skipIf(!hasGit)('the Versions listing', () => {
  it('is empty before the first version', async () => {
    const profile = fixture()
    try {
      expect(await listProfileVersions({ profileDir: profile.profileDir, homeDir: profile.homeDir })).toEqual({ versions: [], unsaved: false })
    } finally {
      profile.remove()
    }
  })

  it('lists newest first with the origin and marks the version the profile matches', async () => {
    const profile = fixture()
    const request = { profileDir: profile.profileDir, homeDir: profile.homeDir }
    try {
      await recordSnapshot({ ...request, summary: 'Before update to Delorun 1.0.1', changedBy: { kind: 'person' } })
      addPlugin(profile.profileDir, '@me/alpha')
      const saved = await saveProfileVersion({ ...request, name: 'With alpha' })
      expect(saved.created).toBe(true)
      const listing = await listProfileVersions(request)
      expect(listing.versions.map(version => [version.origin, version.name, version.current])).toEqual([
        ['saved', 'With alpha', true],
        ['update', undefined, false],
      ])
      expect(listing.unsaved).toBe(false)
      addPlugin(profile.profileDir, '@me/beta')
      const edited = await listProfileVersions(request)
      expect(edited.versions.some(version => version.current)).toBe(false)
      expect(edited.unsaved).toBe(true)
    } finally {
      profile.remove()
    }
  })
})

describe.skipIf(!hasGit)('saving a version', () => {
  it('reports a save of an unchanged setup as not new', async () => {
    const profile = fixture()
    const request = { profileDir: profile.profileDir, homeDir: profile.homeDir }
    try {
      const first = await saveProfileVersion(request)
      const second = await saveProfileVersion({ ...request, name: 'Again' })
      expect(first.created).toBe(true)
      expect(second).toEqual({ id: first.id, created: false })
      expect((await openHistory(request).list(10))).toHaveLength(1)
    } finally {
      profile.remove()
    }
  })

  it('refuses, writing no version, when the admission refuses the setup', async () => {
    const profile = fixture()
    const request = { profileDir: profile.profileDir, homeDir: profile.homeDir }
    try {
      const refused = await saveProfileVersion({ ...request, admit: () => 'holds a secret' }).catch((error: unknown) => error)
      expect(isProfileSafetyError(refused) && refused.code).toBe('SNAPSHOT_FAILED')
      expect(await openHistory(request).list(10)).toEqual([])
    } finally {
      profile.remove()
    }
  })
})

describe.skipIf(!hasGit)('switching to a version', () => {
  it('saves the current setup first, brings the version back, and switches back to the saved setup', async () => {
    const profile = fixture()
    const request = { profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default' }
    try {
      const original = await saveProfileVersion({ ...request, name: 'Original' })
      addPlugin(profile.profileDir, '@me/alpha')
      const tryingIt = readTree(profile.profileDir)['package.json']
      const report = await switchToVersion({ ...request, version: original.id })
      expect(report.saved).toBeDefined()
      expect(report.plan?.changes.plugins).toEqual([{ name: '@me/alpha', from: '1.0.0' }])
      expect(readTree(profile.profileDir)['package.json']).not.toBe(tryingIt)

      const listing = await listProfileVersions(request)
      expect(listing.versions[0]).toMatchObject({ id: report.saved, origin: 'switch', current: false, summary: 'Before switching to Original' })
      expect(listing.versions.find(version => version.id === original.id)?.current).toBe(true)

      await switchToVersion({ ...request, version: report.saved! })
      expect(readTree(profile.profileDir)['package.json']).toBe(tryingIt)
    } finally {
      profile.remove()
    }
  })

  it('saves nothing new when the setup already matches the latest version', async () => {
    const profile = fixture()
    const request = { profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default' }
    try {
      const only = await saveProfileVersion(request)
      const report = await switchToVersion({ ...request, version: only.id })
      expect(report.saved).toBeUndefined()
      expect(await openHistory(request).list(10)).toHaveLength(1)
    } finally {
      profile.remove()
    }
  })

  it('refuses a version the history does not hold, changing nothing', async () => {
    const profile = fixture()
    const request = { profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default' }
    try {
      await saveProfileVersion(request)
      addPlugin(profile.profileDir, '@me/alpha')
      const before = readTree(profile.root)
      const refused = await switchToVersion({ ...request, version: 'f'.repeat(40) as never }).catch((error: unknown) => error)
      expect(isProfileSafetyError(refused) && refused.code).toBe('RESTORE_REFUSED')
      expect(readTree(profile.root)).toEqual(before)
    } finally {
      profile.remove()
    }
  })

  it('writes neither the save nor the restore when the admission refuses the save', async () => {
    const profile = fixture()
    const request = { profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default' }
    try {
      const original = await saveProfileVersion(request)
      addPlugin(profile.profileDir, '@me/alpha')
      const before = readTree(profile.profileDir)['package.json']
      const refused = await switchToVersion({ ...request, version: original.id, admit: () => 'holds a secret' }).catch((error: unknown) => error)
      expect(isProfileSafetyError(refused) && refused.code).toBe('SNAPSHOT_FAILED')
      expect(readTree(profile.profileDir)['package.json']).toBe(before)
    } finally {
      profile.remove()
    }
  })
})
