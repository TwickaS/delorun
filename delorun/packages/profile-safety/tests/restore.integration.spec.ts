/**
 * Undo and restore, as contract C3 states them: the approval list names every plugin, build decision and exemption that
 * changes before a file is written, a revoked plugin version comes back disabled with its reason, and a version that
 * cannot be brought back the way the person asked is refused with the profile unchanged. The first two specs are C3's
 * denial tests `c03-restore-lists-changes` and `c03-restore-revoked-stays-disabled`.
 */
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfileSafetyError } from '../src/errors.ts'
import { readSafetyRecord } from '../src/record.ts'
import { applyRestore, openHistory, planRestore, recordSnapshot } from '../src/snapshot.ts'
import { fixture, readTree } from './support.ts'

/** Whether git can run here, which the profile history needs. */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch (_error) {
    return false
  }
})()

/** A profile with a plugin, a build decision, an exemption and a bundle, which the specs then change. */
function beforeFixture(): ReturnType<typeof fixture> {
  return fixture({
    bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle'],
    dependencies: { '@me/alpha': '1.0.0', '@me/beta': '2.0.0' },
    workspace: 'packages:\n  - .\n\nallowBuilds:\n  native-alpha: set this to true or false\n  native-beta: false\n',
    compatibility: JSON.stringify({ '@me/alpha@1.0.0': ['0.2.2'] }),
    delorunCompatibility: JSON.stringify({}),
  })
}

/** The change a spec makes between the version and the profile. */
function changeProfile(profileDir: string): void {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-default',
    private: true,
    dependencies: { '@me/beta': '2.0.0', '@me/gamma': '3.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle'] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nallowBuilds:\n  native-alpha: true\n  native-beta: false\n')
  writeFileSync(join(profileDir, 'compatibility.json'), JSON.stringify({}))
  writeFileSync(join(profileDir, 'delorun-compatibility.json'), JSON.stringify({ '@delorun/plugin@1.2.3': ['1.0.0'] }))
}

describe.skipIf(!hasGit)('c03-restore-lists-changes', () => {
  it('lists the plugins, the build decision and the exemptions a version brings back, before any file changes', async () => {
    const profile = beforeFixture()
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const version = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      changeProfile(profile.profileDir)
      const before = readTree(profile.root)
      const plan = await planRestore({ profileDir: profile.profileDir, homeDir: profile.homeDir, version, history })
      expect(plan.changes.plugins).toEqual([
        { name: '@me/alpha', to: '1.0.0' },
        { name: '@me/gamma', from: '3.0.0' },
      ])
      expect(plan.changes.builds).toEqual([{ key: 'native-alpha', from: true, to: 'pending' }])
      expect(plan.changes.exemptions).toEqual([
        { axis: 'dsh', key: '@me/alpha@1.0.0', version: '0.2.2', change: 'added' },
        { axis: 'delorun', key: '@delorun/plugin@1.2.3', version: '1.0.0', change: 'removed' },
      ])
      expect(plan.writes).toEqual(expect.arrayContaining(['package.json', 'pnpm-workspace.yaml', 'compatibility.json', 'delorun-compatibility.json']))
      expect(plan.lockfileChanged).toBe(false)
      // The prompt is a plan: the profile is byte-identical until the person approves it.
      expect(readTree(profile.root)).toEqual(before)
    } finally {
      profile.remove()
    }
  })

  it('writes exactly the files the plan listed when it applies', async () => {
    const profile = beforeFixture()
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const version = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      changeProfile(profile.profileDir)
      const plan = await planRestore({ profileDir: profile.profileDir, homeDir: profile.homeDir, version, history })
      await applyRestore(plan, { profileDir: profile.profileDir, homeDir: profile.homeDir, version, history })
      const restored = await history.filesAt(version)
      expect(readTree(profile.profileDir)['package.json']).toBe(restored.get('package.json'))
      expect(readTree(profile.profileDir)['compatibility.json']).toBe(restored.get('compatibility.json'))
      expect(readTree(profile.profileDir)['delorun-compatibility.json']).toBe(restored.get('delorun-compatibility.json'))
    } finally {
      profile.remove()
    }
  })
})

describe.skipIf(!hasGit)('c03-restore-keeps-delorun-state', () => {
  it('keeps the exemptions, safety record and update report a version does not hold instead of removing them', async () => {
    const profile = fixture({ bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle'] })
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const version = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      const later = {
        'delorun-compatibility.json': JSON.stringify({ '@delorun/plugin@1.2.3': ['1.0.0'] }),
        'delorun-safety.json': JSON.stringify({ schema: 'delorun.profile-safety/1', ejected: [], disabled: [] }),
        'delorun-update-report.json': JSON.stringify({ schema: 'delorun.update-report/2' }),
      }
      for (const [name, text] of Object.entries(later)) writeFileSync(join(profile.profileDir, name), text)
      changeProfile(profile.profileDir)
      writeFileSync(join(profile.profileDir, 'delorun-compatibility.json'), later['delorun-compatibility.json'])
      const plan = await planRestore({ profileDir: profile.profileDir, homeDir: profile.homeDir, version, history })
      for (const name of Object.keys(later)) expect(plan.writes).not.toContain(name)
      await applyRestore(plan, { profileDir: profile.profileDir, homeDir: profile.homeDir, version, history })
      const after = readTree(profile.profileDir)
      for (const [name, text] of Object.entries(later)) expect(after[name]).toBe(text)
      expect(after['package.json']).toBe((await history.filesAt(version)).get('package.json'))
    } finally {
      profile.remove()
    }
  })
})

describe.skipIf(!hasGit)('c03-restore-removes-removed-delorun-state', () => {
  it('removes a Delorun state file again when the version restored was written after the file was removed', async () => {
    const profile = fixture({ delorunCompatibility: JSON.stringify({ '@delorun/plugin@1.2.3': ['1.0.0'] }) })
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      await recordSnapshot({ profileDir: profile.profileDir, homeDir: profile.homeDir, summary: 'With exemptions', changedBy: { kind: 'person' }, history })
      rmSync(join(profile.profileDir, 'delorun-compatibility.json'))
      const removed = await recordSnapshot({ profileDir: profile.profileDir, homeDir: profile.homeDir, summary: 'Without exemptions', changedBy: { kind: 'person' }, history })
      writeFileSync(join(profile.profileDir, 'delorun-compatibility.json'), JSON.stringify({ '@delorun/plugin@2.0.0': ['1.0.0'] }))
      const plan = await planRestore({ profileDir: profile.profileDir, homeDir: profile.homeDir, version: removed, history })
      expect(plan.writes).toContain('delorun-compatibility.json')
      await applyRestore(plan, { profileDir: profile.profileDir, homeDir: profile.homeDir, version: removed, history })
      expect(readTree(profile.profileDir)['delorun-compatibility.json']).toBeUndefined()
    } finally {
      profile.remove()
    }
  })
})

describe.skipIf(!hasGit)('c03-restore-revoked-stays-disabled', () => {
  it('brings a revoked bundle back without selecting it, and a revoked plugin with its row disabled and its reason recorded', async () => {
    const profile = fixture({
      bundles: ['@deepseek-ai/dsh-base', '@me/revoked-bundle'],
      dependencies: { '@me/revoked-plugin': '1.0.0' },
      profilePatch: [
        { insert: [{ id: 'revoked-row', name: '@me/revoked-plugin', config: { verbose: true } }] },
        { insert: [{ id: 'kept-row', name: '@me/kept-plugin' }] },
      ],
    })
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const version = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      writeFileSync(join(profile.profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-default', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      }, undefined, 2) + '\n')
      writeFileSync(join(profile.profileDir, 'cordis.patch.yml'), '[]\n')
      const revoked = [
        { name: '@me/revoked-bundle', version: '1.0.0', reason: 'revoked-package', message: 'it shipped a credential' },
        { name: '@me/revoked-plugin', version: '1.0.0', reason: 'revoked-package', message: 'it shipped a credential' },
      ]
      const plan = await planRestore({ profileDir: profile.profileDir, homeDir: profile.homeDir, version, history, revoked })
      expect(plan.disabled).toEqual([
        { name: '@me/revoked-bundle', version: '1.0.0', reason: 'revoked-package', message: 'it shipped a credential' },
        { name: '@me/revoked-plugin', version: '1.0.0', reason: 'revoked-package', message: 'it shipped a credential' },
      ])
      await applyRestore(plan, { profileDir: profile.profileDir, homeDir: profile.homeDir, version, history, revoked })
      const manifest = JSON.parse(readTree(profile.profileDir)['package.json'] ?? '{}') as { dsh?: { profile?: { bundles?: string[] } } }
      expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
      const patch = readTree(profile.profileDir)['cordis.patch.yml'] ?? ''
      expect(patch).toContain('@me/kept-plugin')
      expect(patch).toContain('@me/revoked-plugin')
      expect(patch).toContain('disabled: true')
      const record = readSafetyRecord(profile.profileDir)
      expect(record.disabled.map(entry => `${entry.name} ${entry.message}`)).toEqual([
        '@me/revoked-bundle it shipped a credential',
        '@me/revoked-plugin it shipped a credential',
      ])
    } finally {
      profile.remove()
    }
  })

  it('refuses a version whose revoked row has no id, because a restore cannot disable exactly that row', async () => {
    const profile = fixture({
      dependencies: { '@me/revoked-plugin': '1.0.0' },
      profilePatch: [{ insert: [{ name: '@me/revoked-plugin' }] }],
    })
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const version = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      writeFileSync(join(profile.profileDir, 'cordis.patch.yml'), '[]\n')
      const before = readTree(profile.root)
      const revoked = [{ name: '@me/revoked-plugin', version: '1.0.0', reason: 'revoked-package', message: 'revoked' }]
      const failure = await planRestore({ profileDir: profile.profileDir, homeDir: profile.homeDir, version, history, revoked }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ProfileSafetyError)
      expect((failure as ProfileSafetyError).code).toBe('RESTORE_REFUSED')
      expect((failure as ProfileSafetyError).message).toContain('give the row an id')
      expect(readTree(profile.root)).toEqual(before)
    } finally {
      profile.remove()
    }
  })
})
