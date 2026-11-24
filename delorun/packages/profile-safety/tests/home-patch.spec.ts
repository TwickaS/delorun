/**
 * The home patch's half of a profile version, without a history: the mirror that writes the profile's copy before a
 * version is saved, the write that puts a version's home patch back, and the service's behaviour without a profile.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_PATCH_FILENAME } from '../src/files.ts'
import { mirrorHomePatch, ProfileHomePatch, readHomePatch, readHomePatchCopy, restoreHomePatchCopy, writeHomePatch } from '../src/home-patch.ts'
import { fixture } from './support.ts'

describe('the home patch as a version holds it', () => {
  it('mirrors the home patch into the profile, and removes the copy when the home has none', async () => {
    const profile = fixture()
    try {
      expect(await mirrorHomePatch(profile.profileDir, profile.homeDir)).toBeUndefined()
      expect(readHomePatchCopy(profile.profileDir)).toBeUndefined()
      writeFileSync(join(profile.homeDir, HOME_PATCH_FILENAME), '[{"id":"a","config":{"n":1}}]\n')
      expect(await mirrorHomePatch(profile.profileDir, profile.homeDir)).toBeUndefined()
      expect(readHomePatchCopy(profile.profileDir)).toBe('[{"id":"a","config":{"n":1}}]\n')
      // A second mirror returns what the profile held, so a refused version can put it back.
      writeFileSync(join(profile.homeDir, HOME_PATCH_FILENAME), '[{"id":"a","config":{"n":2}}]\n')
      expect(await mirrorHomePatch(profile.profileDir, profile.homeDir)).toBe('[{"id":"a","config":{"n":1}}]\n')
      await restoreHomePatchCopy(profile.profileDir, '[{"id":"a","config":{"n":1}}]\n')
      expect(readHomePatchCopy(profile.profileDir)).toBe('[{"id":"a","config":{"n":1}}]\n')
      rmSync(join(profile.homeDir, HOME_PATCH_FILENAME))
      await mirrorHomePatch(profile.profileDir, profile.homeDir)
      expect(readHomePatchCopy(profile.profileDir)).toBeUndefined()
    } finally {
      profile.remove()
    }
  })

  it('writes the home patch at mode 0600 and reads it back', async () => {
    const profile = fixture()
    try {
      await writeHomePatch(profile.homeDir, '[{"id":"a","config":{"n":3}}]\n')
      expect(readHomePatch(profile.homeDir)).toBe('[{"id":"a","config":{"n":3}}]\n')
      expect(readFileSync(join(profile.homeDir, HOME_PATCH_FILENAME), 'utf8')).toBe('[{"id":"a","config":{"n":3}}]\n')
    } finally {
      profile.remove()
    }
  })

  it('does nothing without a profile, so a Host started without one keeps its home', async () => {
    const service = new ProfileHomePatch(() => undefined)
    expect(await service.mirror()).toBeUndefined()
    await expect(service.restoreCopy(undefined)).resolves.toBeUndefined()
    expect(await service.differs('0'.repeat(40) as never)).toBe(false)
    expect(await service.restore('0'.repeat(40) as never)).toBe(false)
  })
})
