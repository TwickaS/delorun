/**
 * `delorun recover`: the status it reports, the rollback and restore it carries out, and the two safe-mode actions.
 * The command reads the profile's record and history, so every spec here states what the person sees and what changed.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfileSafetyError } from '../src/errors.ts'
import { readSafeMode, safeModePath } from '../src/safe-mode.ts'
import { openHistory, recordSnapshot } from '../src/snapshot.ts'
import { recover, recoverTarget } from '../src/recover.ts'
import { emptyRecord, fixture, readTree } from './support.ts'

/** Whether git can run here, which the profile history needs. */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch (_error) {
    return false
  }
})()

describe.skipIf(!hasGit)('recover', () => {
  it('reports a profile that has not been updated, with its versions and its safe mode state', async () => {
    const profile = fixture({ profilePatch: [{ insert: [{ id: 'person-tools', name: '@me/tools-plugin' }] }] })
    try {
      const report = await recover({ profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default', action: { kind: 'status' } })
      expect(report.action).toBe('status')
      expect(report.lines[0]).toBe('This profile has not been through a Delorun update yet.')
      expect(report.lines).toContain('Safe mode is off.')
      expect(report.lines.some(line => line.includes('no version yet'))).toBe(true)
    } finally {
      profile.remove()
    }
  })

  it('reports the failed update the record holds, with its snapshot and the plugins it kept disabled', async () => {
    const profile = fixture({
      record: {
        ...emptyRecord(),
        disabled: [{ name: '@me/revoked', version: '1.0.0', reason: 'revoked-package', message: 'it shipped a credential' }],
        update: { from: '1.0.0', to: '1.0.1', at: '2026-01-04T00:00:00.000Z', state: 'failed', failure: 'H2-host-ready', snapshot: 'abc123' },
      },
    })
    try {
      const report = await recover({ profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default', action: { kind: 'status' } })
      expect(report.lastUpdate?.state).toBe('failed')
      expect(report.lines[0]).toBe('The last update, from Delorun 1.0.0 to Delorun 1.0.1, ended failed: H2-host-ready.')
      expect(report.lines).toContain('Its snapshot is profile version abc123.')
      expect(report.lines.some(line => line.includes('@me/revoked (it shipped a credential)'))).toBe(true)
    } finally {
      profile.remove()
    }
  })

  it.each([
    ['committed', 'committed.'],
    ['rolled-back', 'was rolled back.'],
    ['applying', 'has not committed: it is applying, or it stopped before it committed.'],
  ])('reports an update the record holds as %s in the person\'s words', async (state, words) => {
    const profile = fixture({ record: { ...emptyRecord(), update: { from: '1.0.0', to: '1.0.1', at: '2026-01-04T00:00:00.000Z', state, snapshot: 'abc123' } } })
    try {
      const report = await recover({ profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default', action: { kind: 'status' } })
      expect(report.lines[0]).toBe(`The last update, from Delorun 1.0.0 to Delorun 1.0.1, ${words}`)
      expect(report.lines[0]).not.toContain('ended')
    } finally {
      profile.remove()
    }
  })

  it('rolls back to the snapshot an update took, and says what it changed', async () => {
    const profile = fixture({
      bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle'],
      profilePatch: [{ insert: [{ id: 'person-tools', name: '@me/tools-plugin' }] }],
    })
    try {
      const before = readTree(profile.root)
      const history = openHistory({ profileDir: profile.profileDir })
      const snapshot = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      writeFileSync(join(profile.profileDir, 'cordis.patch.yml'), '[]\n')
      const report = await recover({ profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default', action: { kind: 'rollback' } })
      expect(report.action).toBe('rollback')
      expect(report.plan?.version).toBe(snapshot)
      expect(report.lines[0]).toBe('Rolled back: these profile files change: cordis.patch.yml.')
      expect(readTree(profile.root)).toEqual(before)
    } finally {
      profile.remove()
    }
  })

  it('restores the version it is asked for', async () => {
    const profile = fixture({ profilePatch: [{ insert: [{ id: 'person-tools', name: '@me/tools-plugin' }] }] })
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const snapshot = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      writeFileSync(join(profile.profileDir, 'cordis.patch.yml'), '[]\n')
      const report = await recover({ profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default', action: { kind: 'restore', version: snapshot } })
      expect(report.action).toBe('restore')
      expect(readTree(profile.profileDir)['cordis.patch.yml']).toContain('@me/tools-plugin')
      expect(await recoverTarget(profile.profileDir)).toBe(snapshot)
    } finally {
      profile.remove()
    }
  })

  it('refuses a restore and a rollback while another process holds the profile\'s writer lock, changing nothing', async () => {
    const profile = fixture({ profilePatch: [{ insert: [{ id: 'person-tools', name: '@me/tools-plugin' }] }] })
    try {
      const snapshot = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
      })
      writeFileSync(join(profile.profileDir, 'cordis.patch.yml'), '[]\n')
      // A live holder: this process's own pid, which the lock never takes over.
      writeFileSync(join(profile.profileDir, 'package.json.lock'), `${process.pid}\n`)
      const before = readTree(profile.profileDir)
      for (const action of [{ kind: 'restore', version: snapshot }, { kind: 'rollback', version: snapshot }] as const) {
        const failure = await recover({ profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default', action, lockWaitMs: 50 }).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(ProfileSafetyError)
        expect((failure as ProfileSafetyError).code).toBe(action.kind === 'restore' ? 'RESTORE_REFUSED' : 'RECOVER_REFUSED')
        expect((failure as ProfileSafetyError).refused).toBe(true)
        expect(readTree(profile.profileDir)).toEqual(before)
      }
    } finally {
      profile.remove()
    }
  })

  it('refuses safe mode without the installation\'s bundle list, which it cannot guess', async () => {
    const profile = fixture()
    try {
      const failure = await recover({ profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default', action: { kind: 'safe-mode', reason: 'x' } }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ProfileSafetyError)
      expect((failure as ProfileSafetyError).code).toBe('RECOVER_REFUSED')
      expect(readSafeMode(profile.homeDir, 'default')).toBeUndefined()
    } finally {
      profile.remove()
    }
  })

  it('starts safe mode with the third-party bundles left out, then ends it', async () => {
    const profile = fixture({ bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle'] })
    try {
      const started = await recover({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        profile: 'default',
        action: { kind: 'safe-mode', reason: 'a plugin broke the start' },
        installationBundles: ['@deepseek-ai/dsh-base', '@delo/bundle-local'],
        now: new Date('2026-01-05T00:00:00.000Z'),
      })
      expect(started.skipped).toEqual(['@me/own-bundle'])
      expect(started.lines[1]).toContain('leaves out @me/own-bundle')
      expect(readSafeMode(profile.homeDir, 'default')?.skipped).toEqual(['@me/own-bundle'])
      expect(safeModePath(profile.homeDir, 'default')).toContain('safe-mode.json')
      const ended = await recover({ profileDir: profile.profileDir, homeDir: profile.homeDir, profile: 'default', action: { kind: 'exit-safe-mode' } })
      expect(ended.lines).toEqual(['Safe mode is off; the next start loads the whole profile again.'])
      expect(readSafeMode(profile.homeDir, 'default')).toBeUndefined()
    } finally {
      profile.remove()
    }
  })
})
