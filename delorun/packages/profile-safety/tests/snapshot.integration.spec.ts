/**
 * The snapshot an update takes before it changes anything, and the rollback that brings it back. The specs run against
 * the profile's real git-backed history, which is the extension under test: the version holds upstream's five files and
 * Delorun's own — the home patch, the report and the record.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { ProfileSafetyError } from '../src/errors.ts'
import {
  HOME_PATCH_COPY_FILENAME,
  PROFILE_MANIFEST_FILENAME,
  PROFILE_PATCH_FILENAME,
  SAFETY_RECORD_FILENAME,
  UPDATE_REPORT_FILENAME,
} from '../src/files.ts'
import { PROFILE_FILES, ProfileHistory } from '@deepseek-ai/dsh-plugin-manager/history'
import { secretFieldAdmission } from '../src/secrets.ts'
import { currentFiles, historyGitProblem, openHistory, recordSnapshot, rollbackToSnapshot } from '../src/snapshot.ts'
import { fixture, readTree, report, rowItem, text } from './support.ts'

/** Whether git can run here, which the profile history needs. */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch (_error) {
    return false
  }
})()

describe('historyGitProblem', () => {
  it.skipIf(!hasGit)('finds nothing wrong with a git that runs', async () => {
    expect(await historyGitProblem({})).toBeUndefined()
  })

  it('names a git command that is not on PATH', async () => {
    expect(await historyGitProblem({ git: 'delorun-no-such-git' })).toBe('no delorun-no-such-git command is on PATH')
  })

  it('names a git command that fails', async () => {
    expect(await historyGitProblem({ git: 'false' })).toMatch(/^false --version failed: /u)
  })
})

describe.skipIf(!hasGit)('recordSnapshot', () => {
  it('writes one version holding the person\'s files, the home patch, the report and the record', async () => {
    const profile = fixture({
      profilePatch: [{ insert: [{ id: 'person-tools', name: '@me/tools-plugin' }] }],
      homePatch: [{ id: 'ui-settings', config: { theme: 'dark' } }],
      workspace: 'allowBuilds:\n  native: true\n',
    })
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const snapshot = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        report: report([rowItem('person-tools')]),
        history,
      })
      const files = await history.filesAt(snapshot)
      expect(files.get(PROFILE_MANIFEST_FILENAME)).toContain('@delorun/bundle-local')
      expect(files.get(PROFILE_PATCH_FILENAME)).toContain('@me/tools-plugin')
      expect(files.get(HOME_PATCH_COPY_FILENAME)).toContain('"theme":"dark"')
      expect(files.get(UPDATE_REPORT_FILENAME)).toContain('delorun.update-report/3')
      expect(files.get(HOME_PATCH_COPY_FILENAME)).toBe(text(join(profile.homeDir, 'cordis.patch.yml')))
      const [latest] = await history.list(1)
      expect(latest?.summary).toBe('Before update to Delorun 1.0.1')
      expect(latest?.changedBy).toEqual({ kind: 'person' })
    } finally {
      profile.remove()
    }
  })

  it('returns the latest version when the profile has not changed since it, so an update still has one to go back to', async () => {
    const profile = fixture()
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const first = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      const second = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.2',
        changedBy: { kind: 'person' },
        history,
      })
      expect(second).toBe(first)
      expect(await history.list(10)).toHaveLength(1)
    } finally {
      profile.remove()
    }
  })

  it('refuses with SNAPSHOT_FAILED when the history cannot be written, so no update may proceed', async () => {
    const profile = fixture()
    try {
      const failure = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        git: 'git-that-is-not-installed',
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ProfileSafetyError)
      expect((failure as ProfileSafetyError).code).toBe('SNAPSHOT_FAILED')
      expect((failure as ProfileSafetyError).refused).toBe(false)
    } finally {
      profile.remove()
    }
  })

  it('refuses a snapshot whose home patch holds a secret value, puts its copy back, and keeps the value out of the next plugin change\'s version', async () => {
    const profile = fixture({ homePatch: [{ id: 'web-deepseek-api', config: { apiKeyEnv: 'MY_SEARCH_KEY' } }] })
    try {
      const schema = z.object({ apiKey: z.string().role('secret'), apiKeyEnv: z.string().role('credential-ref') })
      const admit = secretFieldAdmission(row => row.id === 'web-deepseek-api' ? [schema] : [])
      const delorun = openHistory({ profileDir: profile.profileDir, admit })
      const request = { profileDir: profile.profileDir, homeDir: profile.homeDir, summary: 'Before update to Delorun 1.0.1', changedBy: { kind: 'person' as const }, history: delorun }
      const first = await recordSnapshot(request)
      const copy = text(join(profile.profileDir, HOME_PATCH_COPY_FILENAME))
      // The key, edited into the home patch by hand.
      writeFileSync(join(profile.homeDir, 'cordis.patch.yml'), JSON.stringify([{ id: 'web-deepseek-api', config: { apiKey: 'sk-home-secret' } }]))
      const failure = await recordSnapshot({ ...request, summary: 'Before update to Delorun 1.0.2' }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ProfileSafetyError)
      expect((failure as ProfileSafetyError).code).toBe('SNAPSHOT_FAILED')
      expect((failure as ProfileSafetyError).detail).toContain('home-cordis.patch.yml holds a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead)')
      expect((failure as ProfileSafetyError).detail).not.toContain('sk-home-secret')
      expect(text(join(profile.profileDir, HOME_PATCH_COPY_FILENAME))).toBe(copy)
      // The next plugin change, saved by the plugin manager's own five-file history.
      const plugins = new ProfileHistory(profile.profileDir, PROFILE_FILES, 'git', 30_000, admit)
      const manifest = JSON.parse(text(join(profile.profileDir, PROFILE_MANIFEST_FILENAME))) as { dependencies: Record<string, string> }
      writeFileSync(join(profile.profileDir, PROFILE_MANIFEST_FILENAME), `${JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, '@me/next': '1.0.0' } }, undefined, 2)}\n`)
      const next = await plugins.record('Installed @me/next', { kind: 'person' })
      expect((await plugins.list(10)).map(version => version.id)).toEqual([next, first])
      expect(execFileSync('git', ['--git-dir', join(profile.profileDir, '.plugin-manager', 'history'), 'log', '--all', '-p'], { encoding: 'utf8', timeout: 30_000 })).not.toContain('sk-home-secret')
    } finally {
      profile.remove()
    }
  })

  it('records a profile whose home has no patch, which holds no home-patch copy', async () => {
    const profile = fixture()
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const snapshot = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      expect((await history.filesAt(snapshot)).get(HOME_PATCH_COPY_FILENAME)).toBeUndefined()
    } finally {
      profile.remove()
    }
  })
})

describe.skipIf(!hasGit)('rollbackToSnapshot', () => {
  it('brings back every file the update changed, the home patch included, and nothing outside the profile', async () => {
    const profile = fixture({
      bundles: ['@deepseek-ai/dsh-base', '@me/own-bundle'],
      profilePatch: [{ id: 'session-log-deepseek', config: { enabled: false } }, { insert: [{ id: 'person-tools', name: '@me/tools-plugin' }] }],
      homePatch: [{ id: 'ui-settings', config: { theme: 'dark' } }],
    })
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const snapshot = await recordSnapshot({
        profileDir: profile.profileDir,
        homeDir: profile.homeDir,
        summary: 'Before update to Delorun 1.0.1',
        changedBy: { kind: 'person' },
        history,
      })
      const before = readTree(profile.root)
      // An update rewrites the bundle list and the person's patch, and puts the home patch back as the target ships it.
      writeFileSync(join(profile.profileDir, PROFILE_MANIFEST_FILENAME), JSON.stringify({
        name: 'dsh-profile-default', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      }, undefined, 2) + '\n')
      writeFileSync(join(profile.profileDir, PROFILE_PATCH_FILENAME), '[]\n')
      writeFileSync(join(profile.homeDir, 'cordis.patch.yml'), '[]\n')
      const plan = await rollbackToSnapshot({ profileDir: profile.profileDir, homeDir: profile.homeDir })
      expect(plan.version).toBe(snapshot)
      expect(plan.writes).toContain(PROFILE_PATCH_FILENAME)
      expect(plan.writes).toContain(PROFILE_MANIFEST_FILENAME)
      expect(plan.homePatchWritten).toBe(true)
      expect(readTree(profile.root)).toEqual(before)
      expect(currentFiles(profile.profileDir).get(SAFETY_RECORD_FILENAME)).toBeUndefined()
    } finally {
      profile.remove()
    }
  })

  it('refuses a rollback on a profile whose history holds no version', async () => {
    const profile = fixture()
    try {
      const failure = await rollbackToSnapshot({ profileDir: profile.profileDir, homeDir: profile.homeDir }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ProfileSafetyError)
      expect((failure as ProfileSafetyError).code).toBe('RECOVER_REFUSED')
      expect((failure as ProfileSafetyError).message).toContain('no version to roll back to')
    } finally {
      profile.remove()
    }
  })
})
