/**
 * The inventory the carry check compares: the rows the person's two patch layers add, the settings they wrote for rows
 * some bundle declares, the local plugins they installed from this machine, their bundle order, and the ejections the
 * profile's record holds. Each case states the profile file it reads, so a spec fails when a reader stops seeing it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLocalSpec, readInventory } from '../src/inventory.ts'
import { ProfileSafetyError } from '../src/errors.ts'
import { isTrackedFile, PROFILE_SAFETY_FILES } from '../src/files.ts'
import { emptyRecord, fixture, inventoryOf } from './support.ts'

describe('readInventory', () => {
  it('reads the bundle list, the rows both layers add and the settings the person wrote', () => {
    const profile = fixture({
      bundles: ['@deepseek-ai/dsh-base', '@delorun/bundle-local'],
      profilePatch: [
        { id: 'session-log-deepseek', config: { enabled: false } },
        { id: 'person-workspace', disabled: true },
        { insert: [{ id: 'person-tools', name: '@me/tools-plugin', config: { verbose: true } }] },
      ],
      homePatch: [{ insert: [{ name: '@me/home-plugin' }] }],
    })
    try {
      const inventory = inventoryOf(profile)
      expect(inventory.bundles).toEqual(['@deepseek-ai/dsh-base', '@delorun/bundle-local'])
      expect(inventory.rows).toEqual([
        { id: 'person-tools', name: '@me/tools-plugin', layer: 'profile-patch', disabled: false },
        { name: '@me/home-plugin', layer: 'home-patch', disabled: false },
      ])
      expect(inventory.configurations).toEqual([
        { rowId: 'session-log-deepseek', layer: 'profile-patch', keys: ['config'], value: '{"config":{"enabled":false}}' },
        { rowId: 'person-workspace', layer: 'profile-patch', keys: ['disabled'], value: '{"disabled":true}' },
      ])
    } finally {
      profile.remove()
    }
  })

  it('reads a local plugin and whether the bundle list also selects it', () => {
    const profile = fixture({
      dependencies: { '@me/local': 'file:../local', '@me/bundle': 'link:../bundle-of-mine', 'semver': '^7.8.5' },
      bundles: ['@deepseek-ai/dsh-base', '@me/bundle'],
    })
    try {
      expect(inventoryOf(profile).localPlugins).toEqual([
        { name: '@me/local', spec: 'file:../local', selected: false },
        { name: '@me/bundle', spec: 'link:../bundle-of-mine', selected: true },
      ])
    } finally {
      profile.remove()
    }
  })

  it('reads the ejections the profile record holds', () => {
    const profile = fixture({
      record: { ...emptyRecord(), ejected: [{ name: '@me/old', kind: 'bundle', reason: 'it crashed', at: '2026-01-01T00:00:00.000Z' }] },
    })
    try {
      expect(inventoryOf(profile).ejected).toEqual(['@me/old'])
    } finally {
      profile.remove()
    }
  })

  it('reads a profile with neither layer and no home patch as empty, not as a failure', () => {
    const profile = fixture()
    try {
      const inventory = readInventory({ profileDir: profile.profileDir })
      expect(inventory.rows).toEqual([])
      expect(inventory.configurations).toEqual([])
      expect(inventory.ejected).toEqual([])
    } finally {
      profile.remove()
    }
  })

  it('refuses a profile whose manifest is not JSON, naming the file', () => {
    const profile = fixture()
    try {
      writeFileSync(join(profile.profileDir, 'package.json'), '{ not json')
      expect(() => inventoryOf(profile)).toThrow(ProfileSafetyError)
      try {
        inventoryOf(profile)
      } catch (error) {
        expect(error).toBeInstanceOf(ProfileSafetyError)
        expect((error as ProfileSafetyError).code).toBe('PROFILE_UNREADABLE')
        expect((error as ProfileSafetyError).path).toBe(join(profile.profileDir, 'package.json'))
      }
    } finally {
      profile.remove()
    }
  })

  it('refuses a patch layer that is not a list of entries', () => {
    const profile = fixture()
    try {
      writeFileSync(join(profile.profileDir, 'cordis.patch.yml'), 'plugins: {}\n')
      expect(() => inventoryOf(profile)).toThrow(/PROFILE_UNREADABLE/)
    } finally {
      profile.remove()
    }
  })

  it('refuses an inserted row that names no plugin', () => {
    const profile = fixture({ profilePatch: [{ insert: [{ id: 'anonymous' }] }] })
    try {
      expect(() => inventoryOf(profile)).toThrow(/declares no plugin name/)
    } finally {
      profile.remove()
    }
  })

  it('refuses a bundle list that is not a list of names', () => {
    const profile = fixture()
    try {
      writeFileSync(join(profile.profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: 'web' } } }))
      expect(() => inventoryOf(profile)).toThrow(/not a list of package names/)
    } finally {
      profile.remove()
    }
  })

  it('refuses a home patch that does not exist under a home that holds none, and reads one that does', () => {
    const profile = fixture({ homePatch: [{ id: 'ui-settings', config: { theme: 'dark' } }] })
    try {
      mkdirSync(join(profile.homeDir, 'run'), { recursive: true })
      expect(inventoryOf(profile).configurations).toEqual([
        { rowId: 'ui-settings', layer: 'home-patch', keys: ['config'], value: '{"config":{"theme":"dark"}}' },
      ])
    } finally {
      profile.remove()
    }
  })
})

describe('isLocalSpec', () => {
  it('holds for the specs that name a directory on this machine and for none that names a registry', () => {
    expect(['file:../a', 'link:../b', 'workspace:*', 'portal:../c', './d', '../e', '/f'].map(isLocalSpec)).toEqual([true, true, true, true, true, true, true])
    expect(['^1.2.3', 'latest', 'npm:@scope/pkg@1.0.0'].map(isLocalSpec)).toEqual([false, false, false])
  })
})

describe('the history extension', () => {
  it('holds upstream\'s five files and adds the Delorun axis, the record, the home patch and the report', () => {
    expect(PROFILE_SAFETY_FILES).toEqual([
      'package.json',
      'pnpm-lock.yaml',
      'cordis.patch.yml',
      'pnpm-workspace.yaml',
      'compatibility.json',
      'delorun-compatibility.json',
      'delorun-safety.json',
      'home-cordis.patch.yml',
      'delorun-update-report.json',
    ])
    expect(isTrackedFile('cordis.patch.yml')).toBe(true)
    expect(isTrackedFile('node_modules/left-pad/index.js')).toBe(false)
  })
})
