/**
 * The Setup versions service over a real profile history in a temporary home: list, save, compare, and switch with the
 * save before it, and the refusals that leave the profile as it was.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// Relative: this package depends on Changes only through plugin-changes, which re-exports the restore hook alone.
import { readChangeLog, writeChangeLog } from '../../changes/src/records.ts'
import { recordImportReviews } from '../../changes/src/setup-transfer/import-reviews.ts'
import { CHANGE_LOG_SCHEMA, type ChangeEntry, type ChangeId } from '../../changes/src/types.ts'
import { ProfileVersions, VersionsError, type VersionsWhere } from '../src/profile-versions.ts'

const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch (_error) {
    return false
  }
})()

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A temporary home with one profile and a service over it. */
function setup(admit?: VersionsWhere['admit']): { service: ProfileVersions, profileDir: string, manifest: () => string, install: (name: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'delorun-profile-versions-'))
  roots.push(root)
  const homeDir = join(root, 'home')
  const profileDir = join(homeDir, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  const install = (name: string): void => {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-default', private: true, dependencies: { [name]: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, undefined, 2) + '\n')
  }
  install('@me/alpha')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  const service = new ProfileVersions(() => ({ profile: 'default', profileDir, homeDir, ...admit === undefined ? {} : { admit } }))
  return { service, profileDir, manifest: () => readFileSync(join(profileDir, 'package.json'), 'utf8'), install }
}

describe.skipIf(!hasGit)('the Setup versions service', () => {
  it('lists nothing before the first version, then the saved setup as the current one', async () => {
    const { service } = setup()
    expect(await service.list()).toEqual({ versions: [], unsaved: false })
    const saved = await service.save('Alpha only')
    expect(saved.created).toBe(true)
    const listing = await service.list()
    expect(listing.versions).toMatchObject([{ id: saved.id, origin: 'saved', name: 'Alpha only', current: true }])
  })

  it('discards the code review a setup import created when the profile goes back to the version saved before it', async () => {
    const { service, profileDir } = setup()
    const home = join(profileDir, '..', '..')
    const ctx = { home, profile: 'default', profileDir }
    const { id } = await service.save('Before importing a setup')
    const review = 'c0123456789' as ChangeId
    await writeChangeLog(home, 'default', { schema: CHANGE_LOG_SCHEMA, entries: [{ id: review, kind: 'plugin-install', state: 'pending', subject: { plugin: 'plug', source: 'folder' }, summary: 'Review plug', createdAt: '2026-11-16T10:00:00.000Z' } as ChangeEntry] })
    await recordImportReviews(ctx, id, [review])
    await service.switch(id)
    const log = await readChangeLog(home, 'default')
    expect(log.entries.find(entry => entry.id === review)?.state).toBe('discarded')
  })

  it('compares a version with the profile in the history\'s words, writing nothing', async () => {
    const { service, manifest, install } = setup()
    const { id } = await service.save(undefined)
    install('@me/beta')
    const before = manifest()
    const changes = await service.changes(id)
    expect(changes.same).toBe(false)
    expect(changes.plugins).toEqual([{ name: '@me/alpha', to: '1.0.0' }, { name: '@me/beta', from: '1.0.0' }])
    expect(manifest()).toBe(before)
    expect((await service.changes(id)).same).toBe(false)
  })

  it('reports no difference for the version the profile matches', async () => {
    const { service } = setup()
    const { id } = await service.save(undefined)
    expect((await service.changes(id)).same).toBe(true)
  })

  it('saves the current setup before it switches, says a restart is needed, and switches back', async () => {
    const { service, manifest, install } = setup()
    const original = await service.save('Original')
    install('@me/beta')
    const trying = manifest()
    const switched = await service.switch(original.id)
    expect(switched.saved).toBeDefined()
    expect(switched.restartNeeded).toBe(true)
    expect(manifest()).not.toBe(trying)
    const listing = await service.list()
    expect(listing.versions[0]).toMatchObject({ id: switched.saved, origin: 'switch', current: false })
    expect(listing.versions.find(version => version.id === original.id)).toMatchObject({ current: true })

    const back = await service.switch(switched.saved!)
    expect(back.restartNeeded).toBe(true)
    expect(manifest()).toBe(trying)
  })

  it('needs no restart and saves nothing when the profile already matches', async () => {
    const { service } = setup()
    const { id } = await service.save(undefined)
    const switched = await service.switch(id)
    expect(switched).toMatchObject({ restartNeeded: false })
    expect(switched.saved).toBeUndefined()
  })

  it('refuses a malformed or unknown version id, changing nothing', async () => {
    const { service, manifest, install } = setup()
    await service.save(undefined)
    install('@me/beta')
    const before = manifest()
    await expect(service.switch('nonsense')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(service.switch('e'.repeat(40))).rejects.toMatchObject({ code: 'UNKNOWN_VERSION' })
    await expect(service.changes('e'.repeat(40))).rejects.toBeInstanceOf(VersionsError)
    expect(manifest()).toBe(before)
  })

  it('refuses to save, and to switch, when the history\'s admission refuses the current setup', async () => {
    let refuse = false
    const { service, manifest, install } = setup(() => refuse ? 'a settings file holds a secret value' : undefined)
    const { id } = await service.save(undefined)
    install('@me/beta')
    const before = manifest()
    refuse = true
    await expect(service.save('Beta')).rejects.toMatchObject({ code: 'SAVE_REFUSED', message: expect.stringContaining('secret value') })
    await expect(service.switch(id)).rejects.toMatchObject({ code: 'SWITCH_REFUSED' })
    expect(manifest()).toBe(before)
    expect((await service.list()).versions).toHaveLength(1)
  })

  it('brings a settings value back when the profile switches to a version, after the value changed again', async () => {
    const { service, profileDir } = setup()
    const patch = join(profileDir, 'cordis.patch.yml')
    // A settings value as the configuration editor saves it: the row's config in the profile patch.
    writeFileSync(patch, '- id: probe\n  config:\n    count: 5\n')
    const { id } = await service.save('Count is five')
    writeFileSync(patch, '- id: probe\n  config:\n    count: 9\n')
    expect(readFileSync(patch, 'utf8')).toContain('count: 9')
    expect(await service.changes(id)).toMatchObject({ patchChanged: true, same: false })
    await service.switch(id)
    expect(readFileSync(patch, 'utf8')).toContain('count: 5')
    expect(readFileSync(patch, 'utf8')).not.toContain('count: 9')
  })

  it('saves no version whose settings file holds a secret value, so a restore point never holds one', async () => {
    const secret = 'sk-a-secret-in-a-settings-file'
    const { service, profileDir } = setup((files) => {
      const text = files.get('cordis.patch.yml')
      return text !== undefined && text.includes(secret) ? 'a settings file holds a secret value' : undefined
    })
    const patch = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patch, `- id: probe\n  config:\n    apiKey: ${secret}\n`)
    await expect(service.save('With a key')).rejects.toMatchObject({ code: 'SAVE_REFUSED', message: expect.stringContaining('secret value') })
    expect((await service.list()).versions).toEqual([])
    expect(execFileSync('git', ['--git-dir', join(profileDir, '.plugin-manager', 'history'), 'log', '--all', '-p'], { encoding: 'utf8', timeout: 30_000 })).not.toContain(secret)
  })

  it('answers a Host without a profile with NO_PROFILE', async () => {
    const service = new ProfileVersions(() => undefined)
    await expect(service.list()).rejects.toMatchObject({ code: 'NO_PROFILE' })
  })

  it('answers a history git cannot read with one sentence, not git\'s output', async () => {
    const { service, profileDir } = setup()
    await service.save(undefined)
    writeFileSync(join(profileDir, '.plugin-manager', 'history', 'HEAD'), 'garbage')
    const listing = await service.list()
    expect(listing.versions).toEqual([])
    expect(listing.problem).toMatch(/could not be read/)
    expect(listing.problem).not.toContain(profileDir)
  })
})
