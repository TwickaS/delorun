/**
 * Safe mode: the start that leaves third-party bundles and their rows out without touching the profile. The specs show
 * the parts of a profile a person added — the rows, the settings, the ejected plugin and the bundle order — are exactly
 * as they were while safe mode is on and after it ends.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfileSafetyError } from '../src/errors.ts'
import { enterSafeMode, exitSafeMode, readSafeMode, SAFE_MODE_FILENAME, safeModePath, startInSafeMode } from '../src/safe-mode.ts'
import { emptyRecord, fixture, inventoryOf, readTree } from './support.ts'

const INSTALLATION_BUNDLES = ['@deepseek-ai/dsh-base', '@delorun/bundle-local']

describe('safe mode', () => {
  it('starts without third-party bundles and their rows, and writes nothing inside the profile', async () => {
    const profile = fixture({
      bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle', '@delorun/bundle-local'],
      profilePatch: [
        { id: 'product-analytics', disabled: true },
        { insert: [{ id: 'own-row', name: '@me/own-bundle', config: { level: 'strict' } }] },
      ],
      record: { ...emptyRecord(), ejected: [{ name: '@me/old', kind: 'plugin', reason: 'it crashed', at: '2026-01-01T00:00:00.000Z' }] },
    })
    try {
      const before = readTree(profile.profileDir)
      const plan = startInSafeMode({ inventory: inventoryOf(profile), installationBundles: INSTALLATION_BUNDLES })
      expect(plan.bundles).toEqual(['@deepseek-ai/dsh-base', '@delorun/bundle-local'])
      expect(plan.skipped).toEqual(['@me/own-bundle'])
      expect(plan.skippedRows).toEqual(['own-row'])
      const marker = await enterSafeMode({ homeDir: profile.homeDir, profile: 'default', reason: 'a plugin broke the start', skipped: plan.skipped, now: new Date('2026-01-02T00:00:00.000Z') })
      expect(marker.since).toBe('2026-01-02T00:00:00.000Z')
      expect(readSafeMode(profile.homeDir, 'default')).toEqual(marker)
      expect(safeModePath(profile.homeDir, 'default')).toContain('run/default/safe-mode.json')
      // The profile is exactly as the person left it: safe mode is a start, not an edit.
      expect(readTree(profile.profileDir)).toEqual(before)
    } finally {
      profile.remove()
    }
  })

  it('keeps every row, setting and ejection while it is on, so ending it changes nothing back', async () => {
    const profile = fixture({
      bundles: ['@me/own-bundle'],
      profilePatch: [{ insert: [{ id: 'own-row', name: '@me/own-bundle' }] }],
      homePatch: [{ id: 'ui-settings', config: { theme: 'dark' } }],
      record: { ...emptyRecord(), ejected: [{ name: '@me/old', kind: 'bundle', reason: 'it crashed', at: '2026-01-01T00:00:00.000Z' }] },
    })
    try {
      const before = inventoryOf(profile)
      await enterSafeMode({ homeDir: profile.homeDir, profile: 'default', reason: 'testing', skipped: ['@me/own-bundle'] })
      expect(inventoryOf(profile)).toEqual(before)
      expect(await exitSafeMode({ homeDir: profile.homeDir, profile: 'default' })).toBe(true)
      expect(readSafeMode(profile.homeDir, 'default')).toBeUndefined()
      expect(inventoryOf(profile)).toEqual(before)
      expect(await exitSafeMode({ homeDir: profile.homeDir, profile: 'default' })).toBe(false)
    } finally {
      profile.remove()
    }
  })

  it('refuses a marker it cannot read, so the next start cannot mistake a damaged home for a normal one', () => {
    const profile = fixture()
    try {
      mkdirSync(dirname(safeModePath(profile.homeDir, 'default')), { recursive: true })
      writeFileSync(safeModePath(profile.homeDir, 'default'), 'not json')
      expect(() => readSafeMode(profile.homeDir, 'default')).toThrow(ProfileSafetyError)
      try {
        readSafeMode(profile.homeDir, 'default')
      } catch (error) {
        expect((error as ProfileSafetyError).code).toBe('SAFE_MODE_UNREADABLE')
        expect((error as ProfileSafetyError).path).toBe(safeModePath(profile.homeDir, 'default'))
        expect((error as ProfileSafetyError).message).toContain(SAFE_MODE_FILENAME)
      }
    } finally {
      profile.remove()
    }
  })
})
