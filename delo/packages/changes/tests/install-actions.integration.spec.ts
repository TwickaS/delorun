/**
 * The agent's plugin requests: recording one changes nothing the profile runs and keeps one entry per waiting request;
 * applying one needs the person at their computer, runs upstream's plugin operation with the spec, records one history
 * version, and for a folder links the plugin to its active directory and leaves the folder's content waiting for review.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { applyChange, discardChange, listChanges, showChange, undoChange } from '../src/actions.ts'
import { activeDirectory } from '../src/paths.ts'
import { applyInstallChange, isPluginRequest, recordPluginRequest, type PluginOperation } from '../src/install-actions.ts'
import { readApproved, readChangeLog, withEntry, writeChangeLog } from '../src/records.ts'
import type { ChangeId } from '../src/types.ts'
import { fixture, folder, history, linkAs, migrated, NOW, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'
import { rejection } from './support.ts'

// The cases write real files and git histories; on a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

/**
 * @param fx - the fixture.
 * @returns the context the actions take.
 */
function context(fx: Fixture) {
  return { home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW }
}

/**
 * @param fx - the fixture.
 * @returns the manifest, the lockfile and the profile's `node_modules` listing.
 */
function profileFiles(fx: Fixture): string[] {
  return [
    readFileSync(join(fx.profileDir, 'package.json'), 'utf8'),
    readFileSync(join(fx.profileDir, 'pnpm-lock.yaml'), 'utf8'),
    existsSync(join(fx.profileDir, 'node_modules')) ? readdirSync(join(fx.profileDir, 'node_modules')).join(',') : '',
  ]
}

/** An operation that succeeds and records its arguments. */
function succeeding(): PluginOperation & { readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  return Object.assign(async (args: readonly string[]) => {
    calls.push(args)
    return { exitCode: 0, logPath: '/logs/op.log' }
  }, { calls })
}

const NOT_RUNNING = async () => undefined

describe('recordPluginRequest', () => {
  it('records an install, an update and a removal as pending, and changes nothing the profile runs', async () => {
    const fx = fixture()
    const before = profileFiles(fx)
    const install = await recordPluginRequest(context(fx), { action: 'install', spec: ' new-plugin@2.0.0 ' })
    expect(install).toMatchObject({ kind: 'plugin-install', state: 'pending', subject: { plugin: 'new-plugin', spec: 'new-plugin@2.0.0' }, summary: 'The agent asks to install new-plugin@2.0.0', createdAt: NOW.toISOString() })
    const update = await recordPluginRequest(context(fx), { action: 'install', spec: 'left-pad@2.0.0' })
    expect(update).toMatchObject({ kind: 'plugin-update', subject: { plugin: 'left-pad', spec: 'left-pad@2.0.0' }, summary: 'The agent asks to move left-pad to left-pad@2.0.0' })
    const remove = await recordPluginRequest(context(fx), { action: 'remove', spec: 'left-pad' })
    expect(remove).toMatchObject({ kind: 'plugin-remove', subject: { plugin: 'left-pad', spec: 'left-pad' }, summary: 'The agent asks to remove left-pad' })
    const folderSpec = await recordPluginRequest(context(fx), { action: 'install', spec: `link:${fx.root}/plug` })
    expect(folderSpec).toMatchObject({ kind: 'plugin-install', subject: { spec: `link:${fx.root}/plug` } })
    expect(folderSpec.subject.plugin).toBeUndefined()
    expect((await readChangeLog(fx.home, PROFILE)).entries.map(entry => entry.id)).toEqual([install.id, update.id, remove.id, folderSpec.id])
    expect(profileFiles(fx)).toEqual(before)
    expect(await history(fx)).toEqual([])
    expect([install, update, remove, folderSpec].every(isPluginRequest)).toBe(true)
  })

  it('keeps one entry for a request that is still waiting, and gives a decided one\'s repeat a new id', async () => {
    const fx = fixture()
    const first = await recordPluginRequest(context(fx), { action: 'install', spec: 'new-plugin' })
    expect(await recordPluginRequest(context(fx), { action: 'install', spec: 'new-plugin' })).toEqual(first)
    const log = await readChangeLog(fx.home, PROFILE)
    await writeChangeLog(fx.home, PROFILE, withEntry(log, { ...first, state: 'discarded' }))
    const again = await recordPluginRequest(context(fx), { action: 'install', spec: 'new-plugin' })
    expect(again.id).not.toBe(first.id)
    expect((await readChangeLog(fx.home, PROFILE)).entries.map(entry => [entry.id, entry.state])).toEqual([[first.id, 'discarded'], [again.id, 'pending']])
  })

  it('refuses a spec pnpm would not accept and a removal of no dependency, and records nothing', async () => {
    const fx = fixture()
    expect((await rejection(recordPluginRequest(context(fx), { action: 'install', spec: './relative' }), 'INVALID_REQUEST')).message).toBe('./relative is not a plugin spec this profile can install: a local path must be absolute.')
    expect((await rejection(recordPluginRequest(context(fx), { action: 'install', spec: 'git+https://' }), 'INVALID_REQUEST')).message).toContain('git+https:// is not a plugin spec this profile can install: TypeError')
    expect((await rejection(recordPluginRequest(context(fx), { action: 'remove', spec: 'absent' }), 'INVALID_REQUEST')).message).toBe('absent is not a plugin of this profile, so there is nothing to remove.')
    expect((await readChangeLog(fx.home, PROFILE)).entries).toEqual([])
  })

  it('reads every dependency section, and a manifest without one', async () => {
    const fx = fixture()
    writeFileSync(join(fx.profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: 'not an object', devDependencies: { 'dev-plugin': '1.0.0' } }))
    expect(await recordPluginRequest(context(fx), { action: 'install', spec: 'dev-plugin@2.0.0' })).toMatchObject({ kind: 'plugin-update' })
  })
})

describe('applyInstallChange', () => {
  it('needs the person at their computer', async () => {
    const fx = fixture()
    const entry = await recordPluginRequest(context(fx), { action: 'install', spec: 'new-plugin' })
    const run = succeeding()
    await rejection(applyInstallChange(context(fx), entry.id, { kind: 'terminal' } as never, { reload: NOT_RUNNING, run }), 'NOT_AT_COMPUTER')
    expect(run.calls).toEqual([])
  })

  it('refuses an unknown id, a change that is no plugin request, and one that is not pending', async () => {
    const { fx } = await migrated()
    const options = { reload: NOT_RUNNING, run: succeeding() }
    await rejection(applyInstallChange(context(fx), 'c0000000000' as ChangeId, terminal(), options), 'UNKNOWN_CHANGE')
    const upgraded = (await readChangeLog(fx.home, PROFILE)).entries[0]!
    expect((await rejection(applyInstallChange(context(fx), upgraded.id, terminal(), options), 'NOT_ALLOWED')).message).toBe(`Change ${upgraded.id} is not a plugin install, update or removal the agent asked for.`)
    const entry = await recordPluginRequest(context(fx), { action: 'install', spec: 'new-plugin' })
    await writeChangeLog(fx.home, PROFILE, withEntry(await readChangeLog(fx.home, PROFILE), { ...entry, state: 'discarded' }))
    expect((await rejection(applyInstallChange(context(fx), entry.id, terminal(), options), 'NOT_ALLOWED')).message).toBe(`Change ${entry.id} is discarded, so it cannot be applied.`)
    expect(options.run.calls).toEqual([])
  })

  it('runs upstream\'s operation with the spec, records a history version and reports the reload', async () => {
    const fx = fixture()
    const install = await recordPluginRequest(context(fx), { action: 'install', spec: 'new-plugin@2.0.0' })
    const run = succeeding()
    const result = await applyInstallChange(context(fx), install.id, terminal(), { reload: async () => ({ ok: true }), run })
    expect(run.calls).toEqual([['add', 'new-plugin@2.0.0']])
    expect(result).toMatchObject({ entry: { id: install.id, state: 'applied', decidedAt: NOW.toISOString(), decidedFrom: 'terminal' }, reload: { kind: 'reloaded' } })
    expect(result.historyVersion).toMatch(/^[0-9a-f]{40}$/)
    expect(result.entry.historyVersion).toBe(result.historyVersion)
    expect(result.folderChange).toBeUndefined()
    expect(await history(fx)).toEqual([`Applied ${install.id}: The agent asks to install new-plugin@2.0.0`])
    expect((await readChangeLog(fx.home, PROFILE)).entries).toEqual([result.entry])

    const update = await recordPluginRequest(context(fx), { action: 'install', spec: 'left-pad@2.0.0' })
    expect((await applyInstallChange(context(fx), update.id, terminal(), { reload: NOT_RUNNING, run })).reload).toEqual({ kind: 'not-running' })
    expect(run.calls.at(-1)).toEqual(['add', 'left-pad@2.0.0'])
    const remove = await recordPluginRequest(context(fx), { action: 'remove', spec: 'left-pad' })
    expect((await applyInstallChange(context(fx), remove.id, terminal(), { reload: async () => ({ ok: false, error: 'boom' }), run })).reload).toEqual({ kind: 'failed', failure: 'boom' })
    expect(run.calls.at(-1)).toEqual(['remove', 'left-pad'])
  })

  it('leaves the request pending with the failure when the operation fails, and clears it when a retry succeeds', async () => {
    const fx = fixture()
    const entry = await recordPluginRequest(context(fx), { action: 'install', spec: 'new-plugin' })
    const failing: PluginOperation = async () => ({ exitCode: 1, logPath: '/logs/failed.log' })
    const error = await rejection(applyInstallChange(context(fx), entry.id, terminal(), { reload: NOT_RUNNING, run: failing }), 'OPERATION_FAILED')
    expect(error.message).toBe(`Change ${entry.id} was not applied: the plugin operation exited 1; diagnostics: /logs/failed.log`)
    expect((await readChangeLog(fx.home, PROFILE)).entries).toEqual([{ ...entry, lastFailure: { at: NOW.toISOString(), failure: 'the plugin operation exited 1; diagnostics: /logs/failed.log' } }])
    expect(await history(fx)).toEqual([])
    const retried = await applyInstallChange(context(fx), entry.id, terminal(), { reload: NOT_RUNNING, run: succeeding() })
    expect(retried.entry.lastFailure).toBeUndefined()
  })

  it('removes a removed plugin\'s approval, so linking it again waits for review', async () => {
    const { fx } = await migrated()
    const remove = await recordPluginRequest(context(fx), { action: 'remove', spec: 'plug' })
    await applyInstallChange(context(fx), remove.id, terminal(), { reload: NOT_RUNNING, run: succeeding() })
    expect((await readApproved(fx.profileDir)).plugins).toEqual({})
    const other = await recordPluginRequest(context(fx), { action: 'remove', spec: 'left-pad' })
    await applyInstallChange(context(fx), other.id, terminal(), { reload: NOT_RUNNING, run: succeeding() })
    expect((await readApproved(fx.profileDir)).plugins).toEqual({})
  })

  it('links a folder to its active directory, which holds nothing, and leaves the folder\'s content waiting for review', async () => {
    const fx = fixture()
    const source = folder(fx, 'plug')
    const entry = await recordPluginRequest(context(fx), { action: 'install', spec: `link:${source}` })
    const run = succeeding()
    const result = await applyInstallChange(context(fx), entry.id, terminal(), { reload: NOT_RUNNING, run })
    const active = activeDirectory(fx.home, PROFILE, 'plug')
    // The operation names the active directory, never the folder, so nothing from the folder can load before review.
    expect(run.calls).toEqual([['add', `plug@link:${active}`]])
    expect(readdirSync(active)).toEqual([])
    const log = await readChangeLog(fx.home, PROFILE)
    const waiting = log.entries.find(candidate => candidate.id === result.folderChange)
    expect(waiting).toMatchObject({ kind: 'plugin-install', state: 'pending', subject: { plugin: 'plug', source }, summary: `plug from ${source} waits for your review` })
    expect(isPluginRequest(waiting!)).toBe(false)
    expect(log.entries.map(candidate => candidate.state)).toEqual(['applied', 'pending'])

    // As upstream's operation would have linked it, a start keeps the plugin's active directory and its waiting change.
    linkAs(fx, 'plug', active)
    expect((await start(fx)).pending).toEqual([{ id: result.folderChange, plugin: 'plug', kind: 'plugin-install' }])
    expect(readdirSync(active)).toEqual([])

    // A second request for the same folder while its content waits adds no second waiting change.
    const again = await recordPluginRequest(context(fx), { action: 'install', spec: source })
    const second = await applyInstallChange(context(fx), again.id, terminal(), { reload: NOT_RUNNING, run })
    expect(second.folderChange).toBe(result.folderChange)
    expect((await readChangeLog(fx.home, PROFILE)).entries.filter(candidate => candidate.id === result.folderChange)).toHaveLength(1)
  })

  it('links an approved plugin\'s folder to its active directory without another waiting change', async () => {
    const { fx, source } = await migrated()
    const entry = await recordPluginRequest(context(fx), { action: 'install', spec: source })
    const run = succeeding()
    const result = await applyInstallChange(context(fx), entry.id, terminal(), { reload: NOT_RUNNING, run })
    expect(run.calls).toEqual([['add', `plug@link:${activeDirectory(fx.home, PROFILE, 'plug')}`]])
    expect(result.folderChange).toBeUndefined()
    expect(readdirSync(activeDirectory(fx.home, PROFILE, 'plug')).sort()).toEqual(['index.js', 'package.json'])
  })

  it('refuses a folder without a valid package name, and passes a path that is no folder to the operation', async () => {
    const fx = fixture()
    const bare = join(fx.root, 'bare')
    const unnamed = folder(fx, 'unnamed')
    writeFileSync(join(unnamed, 'package.json'), '{"name":"Not A Name"}')
    const options = { reload: NOT_RUNNING, run: succeeding() }
    const nothing = await recordPluginRequest(context(fx), { action: 'install', spec: `link:${bare}` })
    const missing = folder(fx, 'missing')
    writeFileSync(join(missing, 'package.json'), 'not json')
    const unreadable = await recordPluginRequest(context(fx), { action: 'install', spec: `link:${missing}` })
    expect((await rejection(applyInstallChange(context(fx), unreadable.id, terminal(), options), 'INVALID_REQUEST')).message).toContain(`The folder ${missing} has no readable package.json`)
    const invalid = await recordPluginRequest(context(fx), { action: 'install', spec: unnamed })
    expect((await rejection(applyInstallChange(context(fx), invalid.id, terminal(), options), 'INVALID_REQUEST')).message).toBe(`The package.json in ${unnamed} names no valid package.`)
    expect(options.run.calls).toEqual([])
    await applyInstallChange(context(fx), nothing.id, terminal(), options)
    expect(options.run.calls).toEqual([['add', `link:${bare}`]])
  })
})

describe('the agent\'s plugin requests among the other changes', () => {
  it('lists a waiting request apart from the decided changes, shows it as logged, and discards it', async () => {
    const { fx } = await migrated()
    const request = await recordPluginRequest(context(fx), { action: 'install', spec: 'new-plugin' })
    const listing = await listChanges(context(fx))
    expect(listing.requests).toEqual([request])
    expect(listing.entries.map(entry => entry.id)).not.toContain(request.id)
    expect(await showChange(context(fx), request.id)).toEqual({ kind: 'logged', entry: request })
    await discardChange(context(fx), request.id, terminal())
    expect((await listChanges(context(fx))).requests).toEqual([])
  })

  it('a request naming a linked plugin does not move where its folder is read from', async () => {
    const { fx, source } = await migrated()
    const log = await readChangeLog(fx.home, PROFILE)
    const other = folder(fx, 'other')
    await writeChangeLog(fx.home, PROFILE, withEntry(log, { id: 'c1111111111' as ChangeId, kind: 'plugin-install', state: 'pending', subject: { plugin: 'other', source: other }, summary: 'other', createdAt: NOW.toISOString() }))
    // Recorded before the plugin is linked, so it is an install that names the plugin and no folder, and the newest one.
    expect(await recordPluginRequest(context(fx), { action: 'install', spec: 'other@2.0.0' })).toMatchObject({ kind: 'plugin-install', subject: { plugin: 'other' } })
    linkAs(fx, 'other', activeDirectory(fx.home, PROFILE, 'other'))
    const listing = await listChanges(context(fx))
    expect(listing.pending.map(change => [change.plugin, change.source])).toEqual([['other', other]])
    expect(source).toBe(join(fx.root, 'plug'))
  })

  it('applyChange and undoChange leave a request to applyInstallChange', async () => {
    const fx = fixture()
    const request = await recordPluginRequest(context(fx), { action: 'install', spec: 'new-plugin' })
    expect((await rejection(applyChange(context(fx), request.id, terminal(), { reload: NOT_RUNNING }), 'NOT_ALLOWED')).message).toBe(`Change ${request.id} installs, updates or removes a plugin the agent asked for; applyInstallChange applies it.`)
    await applyInstallChange(context(fx), request.id, terminal(), { reload: NOT_RUNNING, run: succeeding() })
    expect((await rejection(undoChange(context(fx), request.id, terminal(), { reload: NOT_RUNNING }), 'NOT_ALLOWED')).message).toBe(`Change ${request.id} cannot be undone here: The agent asks to install new-plugin. Restore the profile version before it with delorun recover.`)
  })
})
