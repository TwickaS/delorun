/**
 * The home patch in a profile history version: a value set in the home patch is brought back by a restore, and a
 * version that holds no copy restores no home patch. These read a real git history, so this file is an integration spec.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_PATCH_FILENAME } from '../src/files.ts'
import { ProfileHomePatch, readHomePatch } from '../src/home-patch.ts'
import { openHistory, planRestore, recordSnapshot } from '../src/snapshot.ts'
import { fixture } from './support.ts'

/** Whether git can run here, which the profile history needs. */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch (_error) {
    return false
  }
})()

describe.skipIf(!hasGit)('the home patch in a version', () => {
  it('brings back a value set in the home patch when the version is restored', async () => {
    const profile = fixture({ homePatch: [{ id: 'a', config: { n: 1 } }] })
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const version = await recordSnapshot({ profileDir: profile.profileDir, homeDir: profile.homeDir, summary: 'Before the change', changedBy: { kind: 'person' }, history })
      writeFileSync(join(profile.homeDir, HOME_PATCH_FILENAME), '[{"id":"a","config":{"n":2}}]\n')
      const plan = await planRestore({ profileDir: profile.profileDir, homeDir: profile.homeDir, version, history })
      expect(plan.homePatchWritten).toBe(true)
      const service = new ProfileHomePatch(() => ({ profileDir: profile.profileDir, homeDir: profile.homeDir, history: () => history }))
      expect(await service.differs(version)).toBe(true)
      expect(await service.restore(version)).toBe(true)
      expect(readHomePatch(profile.homeDir)).toBe('[{"id":"a","config":{"n":1}}]\n')
      // The home now matches the version, so a second restore writes nothing.
      expect(await service.differs(version)).toBe(false)
      expect(await service.restore(version)).toBe(false)
    } finally {
      profile.remove()
    }
  })

  it('restores no home patch for a version that holds no copy, leaving the home as it is', async () => {
    const profile = fixture()
    try {
      const history = openHistory({ profileDir: profile.profileDir })
      const version = await recordSnapshot({ profileDir: profile.profileDir, homeDir: profile.homeDir, summary: 'Before the change', changedBy: { kind: 'person' }, history })
      writeFileSync(join(profile.homeDir, HOME_PATCH_FILENAME), '[{"id":"a","config":{"n":2}}]\n')
      const service = new ProfileHomePatch(() => ({ profileDir: profile.profileDir, homeDir: profile.homeDir, history: () => history }))
      expect(await service.differs(version)).toBe(false)
      expect(await service.restore(version)).toBe(false)
      expect(readHomePatch(profile.homeDir)).toBe('[{"id":"a","config":{"n":2}}]\n')
    } finally {
      profile.remove()
    }
  })
})
