/**
 * Eject: a plugin leaves the profile's bundle list and dependencies while every row and setting the person wrote for it
 * stays, and the record says it was ejected so an update cannot put it back. These are the specs of the property the
 * acceptance names: an ejected plugin survives an update, a rollback and safe mode.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planCarry } from '../src/carry.ts'
import { DELORUN_BUNDLE, ejectPlugin } from '../src/eject.ts'
import { ProfileSafetyError } from '../src/errors.ts'
import { readSafetyRecord } from '../src/record.ts'
import { fixture, inventoryOf, readTree, variant } from './support.ts'

describe('ejectPlugin', () => {
  it('takes a bundle out of the manifest and leaves every row, setting and the bundle order around it', async () => {
    const profile = fixture({
      bundles: ['@delorun/bundle-local', '@me/own-bundle', '@deepseek-ai/dsh-base'],
      dependencies: { '@me/own-bundle': 'file:../own' },
      profilePatch: [
        { insert: [{ id: 'own-row', name: '@me/own-bundle', config: { level: 'strict' } }] },
        { id: 'own-row', config: { extra: true } },
      ],
    })
    try {
      const patchBefore = readTree(profile.profileDir)['cordis.patch.yml']
      const result = await ejectPlugin({ profileDir: profile.profileDir, name: '@me/own-bundle', reason: 'it kept crashing the start', now: new Date('2026-01-03T00:00:00.000Z') })
      expect(result.kind).toBe('bundle')
      expect(result.manifestChanged).toBe(true)
      expect(result.keptRows).toEqual(['own-row'])
      const inventory = inventoryOf(profile)
      expect(inventory.bundles).toEqual(['@delorun/bundle-local', '@deepseek-ai/dsh-base'])
      expect(inventory.localPlugins).toEqual([])
      expect(inventory.ejected).toEqual(['@me/own-bundle'])
      expect(readTree(profile.profileDir)['cordis.patch.yml']).toBe(patchBefore)
      expect(readSafetyRecord(profile.profileDir).ejected).toEqual([
        { name: '@me/own-bundle', kind: 'bundle', reason: 'it kept crashing the start', at: '2026-01-03T00:00:00.000Z' },
      ])
    } finally {
      profile.remove()
    }
  })

  it('takes a plugin dependency out while the profile keeps selecting nothing else', async () => {
    const profile = fixture({ dependencies: { '@me/tools': 'link:../tools' } })
    try {
      const result = await ejectPlugin({ profileDir: profile.profileDir, name: '@me/tools', reason: 'I do not use it' })
      expect(result.kind).toBe('plugin')
      expect(inventoryOf(profile).localPlugins).toEqual([])
      expect(inventoryOf(profile).ejected).toEqual(['@me/tools'])
    } finally {
      profile.remove()
    }
  })

  it('refuses to eject Delorun\'s own bundle, because the privacy defaults hold only while it loads', async () => {
    const profile = fixture({ bundles: ['@deepseek-ai/dsh-base', DELORUN_BUNDLE] })
    try {
      const before = readTree(profile.profileDir)
      const failure = await ejectPlugin({ profileDir: profile.profileDir, name: DELORUN_BUNDLE, reason: 'no reason matters' }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ProfileSafetyError)
      expect((failure as ProfileSafetyError).code).toBe('EJECT_REFUSED')
      expect((failure as ProfileSafetyError).message).toContain('cannot be ejected')
      expect(readTree(profile.profileDir)).toEqual(before)
    } finally {
      profile.remove()
    }
  })

  it('refuses a package the profile neither selects nor depends on', async () => {
    const profile = fixture()
    try {
      const failure = await ejectPlugin({ profileDir: profile.profileDir, name: '@me/not-here', reason: 'x' }).catch((error: unknown) => error)
      expect((failure as ProfileSafetyError).code).toBe('EJECT_REFUSED')
      expect((failure as ProfileSafetyError).message).toContain('nothing to eject')
    } finally {
      profile.remove()
    }
  })

  it('leaves an ejected plugin ejected when an update carries the profile, and refuses one that puts it back', async () => {
    const profile = fixture({
      bundles: ['@delorun/bundle-local', '@me/own-bundle'],
      profilePatch: [{ insert: [{ id: 'own-row', name: '@me/own-bundle' }] }],
    })
    try {
      await ejectPlugin({ profileDir: profile.profileDir, name: '@me/own-bundle', reason: 'it crashed the start' })
      const before = inventoryOf(profile)
      expect(planCarry(before, inventoryOf(profile)).carried).toBe(true)
      const reinstated = variant(before, { bundles: ['@delorun/bundle-local', '@me/own-bundle'] })
      // Putting the bundle back is both the ejection undone and an addition the person did not ask for.
      expect(planCarry(before, reinstated).refusals.map(refusal => refusal.code)).toEqual(['EJECTED_PLUGIN_REINSTATED', 'BUNDLE_LIST_NOT_CARRIED'])
    } finally {
      profile.remove()
    }
  })

  it('refuses a profile whose manifest is not JSON, and leaves it as it was', async () => {
    const profile = fixture()
    try {
      writeFileSync(join(profile.profileDir, 'package.json'), '{ not json')
      const failure = await ejectPlugin({ profileDir: profile.profileDir, name: '@me/anything', reason: 'x' }).catch((error: unknown) => error)
      expect((failure as ProfileSafetyError).code).toBe('PROFILE_UNREADABLE')
    } finally {
      profile.remove()
    }
  })
})
