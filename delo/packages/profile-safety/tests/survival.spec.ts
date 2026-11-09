/**
 * The acceptance of WP3.6: a profile with a bundle the person removed, a bundle order they changed, a row they disabled
 * and a plugin they ejected goes through an update, a rollback and safe mode with all four as they were. The update half
 * is the carry check against the target's prediction; the rollback half restores the snapshot byte for byte; the safe
 * mode half starts without third-party bundles and writes nothing in the profile.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planCarry } from '../src/carry.ts'
import { readInventory } from '../src/inventory.ts'
import { readSafetyRecord } from '../src/record.ts'
import { enterSafeMode, exitSafeMode, startInSafeMode } from '../src/safe-mode.ts'
import { openHistory, recordSnapshot, rollbackToSnapshot } from '../src/snapshot.ts'
import { bundleItem, emptyRecord, fixture, inventoryOf, readTree, report, rowItem, variant, type Fixture } from './support.ts'

/** Whether git can run here, which the profile history needs. */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch (_error) {
    return false
  }
})()

/** The bundles the installation itself ships, which the profile below edited. */
const INSTALLATION_BUNDLES = ['@deepseek-ai/dsh-base', '@delo/bundle-local']

/**
 * A profile the person shaped: upstream's base bundle removed, the order changed, a row turned off and a plugin ejected.
 * @returns the fixture.
 */
function shapedProfile(): Fixture {
  return fixture({
    bundles: ['@delo/bundle-local', '@me/own-bundle'],
    dependencies: { '@me/own-bundle': 'file:../own' },
    profilePatch: [
      { id: 'product-analytics', disabled: true },
      { insert: [{ id: 'own-row', name: '@me/own-bundle', config: { level: 'strict' } }] },
    ],
    homePatch: [{ id: 'ui-settings', config: { theme: 'dark' } }],
    record: {
      ...emptyRecord(),
      ejected: [{ name: '@me/ejected-plugin', kind: 'plugin', reason: 'it crashed the start', at: '2026-01-06T00:00:00.000Z' }],
    },
  })
}

describe('a shaped profile survives an update', () => {
  it('carries when the target leaves the removed bundle, the order, the disabled row and the ejection alone', () => {
    const profile = shapedProfile()
    try {
      const before = inventoryOf(profile)
      expect(before.bundles).toEqual(['@delo/bundle-local', '@me/own-bundle'])
      expect(before.rows).toEqual([{ id: 'own-row', name: '@me/own-bundle', layer: 'profile-patch', disabled: false }])
      expect(before.configurations.map(configuration => configuration.rowId)).toEqual(['product-analytics', 'ui-settings'])
      expect(before.ejected).toEqual(['@me/ejected-plugin'])
      const plan = planCarry(before, readInventory({ profileDir: profile.profileDir, homeDir: profile.homeDir }))
      expect(plan).toEqual({ changes: [], refusals: [], carried: true })
    } finally {
      profile.remove()
    }
  })

  it('refuses a target that would put the removed bundle back, reorder the list, enable the row or reinstate the ejection', () => {
    const profile = shapedProfile()
    try {
      const before = inventoryOf(profile)
      const template = variant(before, { bundles: ['@deepseek-ai/dsh-base', '@delo/bundle-local', '@me/own-bundle'] })
      const plan = planCarry(before, template)
      expect(plan.carried).toBe(false)
      // The base bundle comes back, which is an addition no report item can name.
      expect(plan.refusals.map(refusal => refusal.code)).toEqual(['BUNDLE_LIST_NOT_CARRIED'])
      expect(plan.refusals[0]?.message).toContain('@deepseek-ai/dsh-base')
      const reordered = variant(before, { bundles: ['@me/own-bundle', '@delo/bundle-local'] })
      expect(planCarry(before, reordered).refusals.map(refusal => refusal.message)).toEqual([
        'The profile\'s bundle list would be reordered, and the person chose that order because each bundle patches the ones before it.',
      ])
    } finally {
      profile.remove()
    }
  })

  it('carries a target that retires a bundle when the report names it, and still refuses a re-ejected plugin', () => {
    const profile = shapedProfile()
    try {
      const before = inventoryOf(profile)
      const retired = variant(before, { bundles: ['@delo/bundle-local'] })
      expect(planCarry(before, retired, { report: report([bundleItem('@me/own-bundle')]) }).carried).toBe(true)
      const reinstated = variant(before, { bundles: [...before.bundles, '@me/ejected-plugin'] })
      expect(planCarry(before, reinstated).refusals.map(refusal => refusal.code)).toEqual(['EJECTED_PLUGIN_REINSTATED', 'BUNDLE_LIST_NOT_CARRIED'])
    } finally {
      profile.remove()
    }
  })

  it('keeps the disabled row and the ejection while a target disables the row\'s plugin by name', () => {
    const profile = shapedProfile()
    try {
      const before = inventoryOf(profile)
      const plan = planCarry(before, before, { report: report([rowItem('product-analytics'), rowItem('own-row')]) })
      expect(plan.carried).toBe(true)
      expect(plan.changes).toEqual([])
    } finally {
      profile.remove()
    }
  })
})

describe.skipIf(!hasGit)('a shaped profile survives a rollback', () => {
  it('comes back byte for byte after an update rewrites its files', async () => {
    const profile = shapedProfile()
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delo 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      const before = readTree(profile.root)
      writeFileSync(join(profile.profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-default',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...INSTALLATION_BUNDLES] } },
      }, undefined, 2) + '\n')
      writeFileSync(join(profile.profileDir, 'cordis.patch.yml'), '[]\n')
      writeFileSync(join(profile.homeDir, 'cordis.patch.yml'), '[]\n')
      await rollbackToSnapshot({ profileDir: profile.profileDir, homeDir: profile.homeDir, history })
      expect(readTree(profile.root)).toEqual(before)
      expect(readSafetyRecord(profile.profileDir).ejected.map(entry => entry.name)).toEqual(['@me/ejected-plugin'])
      expect(inventoryOf(profile).rows).toEqual([{ id: 'own-row', name: '@me/own-bundle', layer: 'profile-patch', disabled: false }])
    } finally {
      profile.remove()
    }
  })
})

describe('a shaped profile survives safe mode', () => {
  it('starts without the third-party bundle and writes nothing in the profile, then comes back unchanged', async () => {
    const profile = shapedProfile()
    try {
      const profileBefore = readTree(profile.profileDir)
      const inventoryBefore = inventoryOf(profile)
      const plan = startInSafeMode({ inventory: inventoryBefore, installationBundles: INSTALLATION_BUNDLES })
      expect(plan.bundles).toEqual(['@delo/bundle-local'])
      expect(plan.skipped).toEqual(['@me/own-bundle'])
      expect(plan.skippedRows).toEqual(['own-row'])
      await enterSafeMode({ homeDir: profile.homeDir, profile: 'default', reason: 'a plugin broke the start', skipped: plan.skipped })
      expect(readTree(profile.profileDir)).toEqual(profileBefore)
      expect(readInventory({ profileDir: profile.profileDir, homeDir: profile.homeDir })).toEqual(inventoryBefore)
      await exitSafeMode({ homeDir: profile.homeDir, profile: 'default' })
      expect(readTree(profile.profileDir)).toEqual(profileBefore)
      expect(readSafetyRecord(profile.profileDir).ejected.map(entry => entry.name)).toEqual(['@me/ejected-plugin'])
    } finally {
      profile.remove()
    }
  })
})
