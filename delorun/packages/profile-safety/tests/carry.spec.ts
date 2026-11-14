/**
 * The carry check: an update may change what it names in its report, and may not change anything else. Each spec here
 * is a refusal that must fire, or a change that must be carried, so removing the check it covers makes that spec fail.
 */
import { describe, expect, it } from 'vitest'
import { assertCarriable, planCarry } from '../src/carry.ts'
import { ProfileSafetyError } from '../src/errors.ts'
import type { ProfileInventory } from '../src/inventory.ts'
import { bundleItem, fixture, inventoryOf, pluginItem, report, rowItem, variant } from './support.ts'

/** An inventory of a profile that has one row, one setting, one local plugin and a bundle order. */
function personProfile(): ProfileInventory {
  return {
    bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle', '@delorun/bundle-local'],
    rows: [{ id: 'person-tools', name: '@me/tools-plugin', layer: 'profile-patch', disabled: false }],
    configurations: [{ rowId: 'session-log-deepseek', layer: 'profile-patch', keys: ['config'], value: '{"config":{"enabled":false}}' }],
    localPlugins: [{ name: '@me/tools-plugin', spec: 'file:../tools', selected: false }],
    ejected: [],
  }
}

describe('planCarry', () => {
  it('carries a target that leaves every row, setting, local plugin and the bundle order as they were', () => {
    const before = personProfile()
    const plan = planCarry(before, personProfile())
    expect(plan.changes).toEqual([])
    expect(plan.refusals).toEqual([])
    expect(plan.carried).toBe(true)
  })

  it('refuses a row the target would drop without naming it', () => {
    const plan = planCarry(personProfile(), variant(personProfile(), { rows: [] }))
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['ROW_NOT_CARRIED'])
    expect(plan.refusals[0]?.subjects).toEqual([{ kind: 'row', name: 'person-tools', layer: 'profile-patch' }])
    expect(plan.changes[0]).toMatchObject({ kind: 'row', subject: 'person-tools', effect: 'removed', named: false })
  })

  it('carries that row when the update report names it, because the person sees it before it applies', () => {
    const plan = planCarry(personProfile(), variant(personProfile(), { rows: [] }), { report: report([rowItem('person-tools')]) })
    expect(plan.refusals).toEqual([])
    expect(plan.changes).toEqual([{ kind: 'row', subject: 'person-tools', effect: 'removed', named: true }])
  })

  it('refuses a setting the target would drop without naming its row', () => {
    const plan = planCarry(personProfile(), variant(personProfile(), { configurations: [] }))
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['CONFIGURATION_NOT_CARRIED'])
  })

  it('refuses a setting whose value the target would change', () => {
    const changed = variant(personProfile(), {
      configurations: [{ rowId: 'session-log-deepseek', layer: 'profile-patch', keys: ['config'], value: '{"config":{"enabled":true}}' }],
    })
    const plan = planCarry(personProfile(), changed)
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['CONFIGURATION_NOT_CARRIED'])
    expect(plan.changes[0]).toMatchObject({ kind: 'configuration', subject: 'session-log-deepseek', effect: 'changed' })
  })

  it('carries a dropped setting when the report names its row', () => {
    const plan = planCarry(personProfile(), variant(personProfile(), { configurations: [] }), { report: report([rowItem('session-log-deepseek')]) })
    expect(plan.refusals).toEqual([])
    expect(plan.changes).toEqual([{ kind: 'configuration', subject: 'session-log-deepseek', effect: 'removed', named: true }])
  })

  it('refuses a local plugin the target would drop without naming it', () => {
    const plan = planCarry(personProfile(), variant(personProfile(), { localPlugins: [] }))
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['LOCAL_PLUGIN_NOT_CARRIED'])
    expect(plan.refusals[0]?.message).toContain('file:../tools')
  })

  it('carries a local plugin the update report names as disabled', () => {
    const plan = planCarry(personProfile(), variant(personProfile(), { localPlugins: [] }), { report: report([pluginItem('@me/tools-plugin')]) })
    expect(plan.refusals).toEqual([])
    expect(plan.changes[0]).toMatchObject({ kind: 'local-plugin', subject: '@me/tools-plugin', named: true })
  })

  it('refuses a local plugin whose spec the target would change', () => {
    const moved = variant(personProfile(), { localPlugins: [{ name: '@me/tools-plugin', spec: 'file:../../elsewhere', selected: false }] })
    expect(planCarry(personProfile(), moved).refusals.map(refusal => refusal.code)).toEqual(['LOCAL_PLUGIN_NOT_CARRIED'])
  })

  it('refuses a bundle list the target would reorder', () => {
    const reordered = variant(personProfile(), { bundles: ['@me/own-bundle', '@deepseek-ai/dsh-base', '@delorun/bundle-local'] })
    const plan = planCarry(personProfile(), reordered)
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['BUNDLE_LIST_NOT_CARRIED'])
    expect(plan.refusals[0]?.subjects).toEqual([{ kind: 'bundle-list', name: 'dsh.profile.bundles' }])
  })

  it('refuses a bundle the target would add back to the person\'s list', () => {
    const restored = variant(personProfile(), { bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle', '@delorun/bundle-local', '@delorun/bundle-studio'] })
    const plan = planCarry(personProfile(), restored)
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['BUNDLE_LIST_NOT_CARRIED'])
    expect(plan.refusals[0]?.message).toContain('@delorun/bundle-studio')
  })

  it('carries a bundle the target retires when the report names it', () => {
    const dropped = variant(personProfile(), { bundles: ['@deepseek-ai/dsh-base', '@delorun/bundle-local'] })
    const plan = planCarry(personProfile(), dropped, { report: report([bundleItem('@me/own-bundle')]) })
    expect(plan.refusals).toEqual([])
    expect(plan.changes).toEqual([{ kind: 'bundle', subject: '@me/own-bundle', effect: 'removed', named: true }])
  })

  it('refuses a bundle the target retires without naming it', () => {
    const dropped = variant(personProfile(), { bundles: ['@deepseek-ai/dsh-base', '@delorun/bundle-local'] })
    expect(planCarry(personProfile(), dropped).refusals.map(refusal => refusal.code)).toEqual(['BUNDLE_LIST_NOT_CARRIED'])
  })

  it('refuses a target that puts back a plugin the person ejected', () => {
    const before = variant(personProfile(), { ejected: ['@me/own-bundle'] })
    const plan = planCarry(before, personProfile())
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['EJECTED_PLUGIN_REINSTATED'])
    expect(plan.refusals[0]?.subjects).toEqual([{ kind: 'bundle', name: '@me/own-bundle' }])
  })

  it('refuses a row the target would add to the person\'s patch', () => {
    const added = variant(personProfile(), {
      rows: [
        ...personProfile().rows,
        { id: 'update-inserted', name: '@me/surprise', layer: 'profile-patch', disabled: false },
      ],
    })
    const plan = planCarry(personProfile(), added)
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['UNNAMED_CHANGE'])
    expect(plan.refusals[0]?.subjects).toEqual([{ kind: 'row', name: 'update-inserted', layer: 'profile-patch' }])
  })

  it('refuses settings the target would write into the person\'s patch', () => {
    const added = variant(personProfile(), {
      configurations: [
        ...personProfile().configurations,
        { rowId: 'ui-settings', layer: 'profile-patch', keys: ['config'], value: '{"config":{"theme":"dark"}}' },
      ],
    })
    expect(planCarry(personProfile(), added).refusals.map(refusal => refusal.code)).toEqual(['UNNAMED_CHANGE'])
  })

  it('refuses a local plugin the target would install from this machine', () => {
    const added = variant(personProfile(), {
      localPlugins: [...personProfile().localPlugins, { name: '@me/other', spec: 'file:../other', selected: false }],
    })
    expect(planCarry(personProfile(), added).refusals.map(refusal => refusal.code)).toEqual(['UNNAMED_CHANGE'])
  })

  it('carries a row the person disabled and the target keeps disabled', () => {
    const before = variant(personProfile(), { rows: [{ id: 'person-tools', name: '@me/tools-plugin', layer: 'profile-patch', disabled: true }] })
    const plan = planCarry(before, before)
    expect(plan.changes).toEqual([])
    expect(plan.carried).toBe(true)
  })

  it('refuses a target that would enable a row the person disabled', () => {
    const before = variant(personProfile(), { rows: [{ id: 'person-tools', name: '@me/tools-plugin', layer: 'profile-patch', disabled: true }] })
    const plan = planCarry(before, personProfile())
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['ROW_NOT_CARRIED'])
    expect(plan.changes).toEqual([{ kind: 'row', subject: 'person-tools', effect: 'changed', named: false, detail: 'the row the person disabled would load again' }])
  })

  it('compares a row without an id by its plugin name and layer', () => {
    const before = variant(personProfile(), { rows: [{ name: '@me/no-id', layer: 'home-patch', disabled: false }] })
    expect(planCarry(before, before).carried).toBe(true)
    const moved = variant(personProfile(), { rows: [{ name: '@me/no-id', layer: 'profile-patch', disabled: false }] })
    const plan = planCarry(before, moved)
    expect(plan.refusals.map(refusal => refusal.code)).toEqual(['ROW_NOT_CARRIED', 'UNNAMED_CHANGE'])
  })
})

describe('assertCarriable', () => {
  it('throws the first refusal\'s code with every subject and remedy, naming nothing that was written', () => {
    const profile = fixture()
    try {
      const plan = planCarry(personProfile(), variant(personProfile(), { rows: [], configurations: [] }))
      expect(() => { assertCarriable(plan, profile.profileDir) }).toThrow(ProfileSafetyError)
      try {
        assertCarriable(plan, profile.profileDir)
      } catch (error) {
        const refusal = error as ProfileSafetyError
        expect(refusal.code).toBe('ROW_NOT_CARRIED')
        expect(refusal.path).toBe(profile.profileDir)
        expect(refusal.subjects).toEqual([
          { kind: 'row', name: 'person-tools', layer: 'profile-patch' },
          { kind: 'configuration', name: 'session-log-deepseek', layer: 'profile-patch' },
        ])
        expect(refusal.remedies).toEqual(['skip-update', 'keep'])
        expect(refusal.message).toContain('ROW_NOT_CARRIED')
        expect(refusal.message).toContain('session-log-deepseek')
        expect(refusal.refused).toBe(true)
      }
    } finally {
      profile.remove()
    }
  })

  it('returns for a plan that carries, so an update proceeds', () => {
    const profile = fixture()
    try {
      expect(() => { assertCarriable(planCarry(personProfile(), personProfile()), profile.profileDir) }).not.toThrow()
    } finally {
      profile.remove()
    }
  })
})

describe('a profile read from disk', () => {
  it('carries a target that leaves every file it read as it was', () => {
    const profile = fixture({
      bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle'],
      dependencies: { '@me/tools-plugin': 'file:../tools' },
      profilePatch: [{ id: 'session-log-deepseek', config: { enabled: false } }, { insert: [{ id: 'person-tools', name: '@me/tools-plugin' }] }],
    })
    try {
      const before = inventoryOf(profile)
      const plan = planCarry(before, inventoryOf(profile))
      expect(plan.carried).toBe(true)
      expect(plan.changes).toEqual([])
    } finally {
      profile.remove()
    }
  })
})
