import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { applyChange, changeProtection, discardChange, listChanges, showChange, turnOff, turnOn, undoChange, type ChangesContext, type ReloadHost, type ReloadOutcome } from '../src/actions.ts'
import { EMPTY_CONTENT_VERSION } from '../src/enforce.ts'
import { changeId } from '../src/ids.ts'
import { activeDirectory, changesDirectory } from '../src/paths.ts'
import { openWorkSession, readActiveRecord, readApproved, readChangeLog, readProtection, writeApproved, writeChangeLog, type AtComputer } from '../src/records.ts'
import { holdsVersion } from '../src/store.ts'
import type { ChangeId, PluginChange } from '../src/types.ts'
import { fixture, folder, history, linkAs, migrated, NOW, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'
import { rejection } from './support.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

/**
 * @param fx - the fixture.
 * @returns the context every action in these specs runs with.
 */
function contextOf(fx: Fixture): ChangesContext {
  return { home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW, lockWaitMs: 5_000 }
}

/**
 * A reload that answers each call with the next outcome.
 * @param outcomes - the answers, in order; undefined means Delorun is not running.
 * @returns the reload and its calls.
 */
function reloads(...outcomes: (ReloadOutcome | undefined)[]): { readonly reload: ReloadHost, readonly calls: () => number } {
  const answers = [...outcomes]
  let calls = 0
  return {
    reload: async () => {
      calls += 1
      return Promise.resolve(answers.shift())
    },
    calls: () => calls,
  }
}

const OK: ReloadOutcome = { ok: true }

/**
 * Edit the plugin's folder.
 * @param source - the folder.
 * @param body - the new text of its `index.js`.
 */
function edit(source: string, body: string): void {
  writeFileSync(join(source, 'index.js'), body)
}

/**
 * @param ctx - the context.
 * @returns the only change waiting for review.
 */
async function onlyPending(ctx: ChangesContext): Promise<PluginChange> {
  const { pending } = await listChanges(ctx)
  expect(pending).toHaveLength(1)
  return pending[0]!
}

/**
 * @param fx - the fixture.
 * @returns the profile manifest's bundle list.
 */
function bundles(fx: Fixture): unknown {
  return (JSON.parse(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }).dsh?.profile?.bundles
}

/**
 * Set the profile manifest's bundle list, as upstream's plugin manager writes it.
 * @param fx - the fixture.
 * @param list - the list.
 */
function setBundles(fx: Fixture, list: readonly string[]): void {
  const path = join(fx.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  writeFileSync(path, `${JSON.stringify({ ...manifest, dsh: { profile: { bundles: list } } }, undefined, 2)}\n`)
}

/**
 * Everything an action could write: the profile's manifest and the change log, as text.
 * @param fx - the fixture.
 * @returns the snapshot.
 */
function written(fx: Fixture): string {
  const log = join(changesDirectory(fx.home), 'profiles', PROFILE, 'log.json')
  return readFileSync(join(fx.profileDir, 'package.json'), 'utf8') + (existsSync(log) ? readFileSync(log, 'utf8') : '')
}

describe('listing and showing changes', () => {
  it('lists a folder edit as waiting for review, the decided changes newest first, the protection setting and the work session', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    expect(await listChanges(ctx)).toMatchObject({ protection: 'on', pending: [], missing: [], entries: [{ kind: 'plugin-install', state: 'applied', decidedFrom: 'upgrade' }] })
    edit(source, 'export default "two"\n')
    const change = await onlyPending(ctx)
    expect(change).toMatchObject({ kind: 'plugin-edit', plugin: 'plug', source, from: approved, files: [{ path: 'index.js', status: 'modified' }] })
    expect(change.id).toBe(changeId('plugin-edit', { plugin: 'plug', source }, approved, change.to))
    expect(await showChange(ctx, change.id)).toEqual({ kind: 'pending', change })
    const upgrade = (await readChangeLog(fx.home, PROFILE)).entries[0]!
    expect(await showChange(ctx, upgrade.id)).toEqual({ kind: 'logged', entry: upgrade })

    await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved, minutes: 60 }, terminal())
    expect((await listChanges(ctx)).workSession).toEqual({ plugin: 'plug', startedAt: expect.any(String), endsAt: expect.any(String) })
  })

  it('lists a plugin linked after the first start as an install waiting for review, and reports a folder that is gone', async () => {
    const { fx, source } = await migrated()
    const other = folder(fx, 'other')
    linkAs(fx, 'other', other)
    await start(fx)
    const ctx = contextOf(fx)
    const change = await onlyPending(ctx)
    expect(change).toMatchObject({ kind: 'plugin-install', plugin: 'other', source: other })
    expect(change.from).toBeUndefined()
    rmSync(source, { recursive: true })
    expect((await listChanges(ctx)).missing).toEqual([{ plugin: 'plug', source }])
  })

  it('leaves out a plugin linked to its active directory whose folder no record names, and a link no start has moved yet', async () => {
    const fx = fixture()
    await start(fx)
    linkAs(fx, 'stray', activeDirectory(fx.home, PROFILE, 'stray'))
    linkAs(fx, 'unmoved', folder(fx, 'unmoved'))
    expect((await listChanges(contextOf(fx))).pending).toEqual([])
  })

  it('refuses the id of an install whose folder changed twice since the start recorded it', async () => {
    const { fx } = await migrated()
    const other = folder(fx, 'other')
    linkAs(fx, 'other', other)
    await start(fx)
    const ctx = contextOf(fx)
    edit(other, 'export default "two"\n')
    const shown = await onlyPending(ctx)
    edit(other, 'export default "three"\n')
    await rejection(showChange(ctx, shown.id), 'CHANGED_SINCE_REVIEW')
  })

  it('refuses an id whose folder changed after it was shown, and an id no change has', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const shown = await onlyPending(ctx)
    edit(source, 'export default "three"\n')
    await onlyPending(ctx)
    await rejection(showChange(ctx, shown.id), 'CHANGED_SINCE_REVIEW')
    await rejection(showChange(ctx, 'c0000000000' as ChangeId), 'UNKNOWN_CHANGE')
    await rejection(showChange(contextOf(fixture()), 'c0000000000' as ChangeId), 'UNKNOWN_CHANGE')
  })

  it('refuses the id of a pending install whose folder changed since the start recorded it', async () => {
    const { fx } = await migrated()
    const other = folder(fx, 'other')
    linkAs(fx, 'other', other)
    await start(fx)
    const recorded = (await readChangeLog(fx.home, PROFILE)).entries.find(entry => entry.state === 'pending')!
    edit(other, 'export default "changed"\n')
    await rejection(showChange(contextOf(fx), recorded.id), 'CHANGED_SINCE_REVIEW')
  })
})

describe('applying a change', () => {
  it('approves exactly the content shown, loads it, records one history version and reloads the Host', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const change = await onlyPending(ctx)
    const host = reloads(OK)
    const result = await applyChange(ctx, change.id, terminal(), host)
    expect(result).toMatchObject({ reload: { kind: 'reloaded' }, historyVersion: expect.stringMatching(/^[0-9a-f]{40}$/), entry: { id: change.id, kind: 'plugin-edit', state: 'applied', decidedFrom: 'terminal', to: change.to, decidedAt: NOW.toISOString() } })
    expect(result.entry.historyVersion).toBe(result.historyVersion)
    expect(host.calls()).toBe(1)
    expect((await readApproved(fx.profileDir)).plugins.plug).toEqual({ source, version: change.to, approvedAt: NOW.toISOString() })
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), change.to)).toBe(true)
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug).toEqual({ version: change.to, kind: 'approved' })
    expect((await history(fx))[0]).toBe(`Applied: plug: changes in ${source}`)
    expect((await listChanges(ctx)).pending).toEqual([])
    await rejection(applyChange(ctx, change.id, terminal(), host), 'NOT_ALLOWED')
  })

  it('applies an install with Delorun not running and says the next start loads it', async () => {
    const { fx } = await migrated()
    const other = folder(fx, 'other')
    linkAs(fx, 'other', other)
    await start(fx)
    const ctx: ChangesContext = { home: fx.home, profile: PROFILE, profileDir: fx.profileDir }
    const change = await onlyPending(ctx)
    const result = await applyChange(ctx, change.id, terminal(), reloads(undefined))
    expect(result.reload).toEqual({ kind: 'not-running' })
    expect(result.entry.createdAt).toBe(NOW.toISOString())
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'other'), change.to)).toBe(true)
  })

  it('refuses a change whose folder changed after it was shown, and writes nothing', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const shown = await onlyPending(ctx)
    edit(source, 'export default "three"\n')
    const before = written(fx)
    const host = reloads(OK)
    await rejection(applyChange(ctx, shown.id, terminal(), host), 'CHANGED_SINCE_REVIEW')
    expect(written(fx)).toBe(before)
    expect(host.calls()).toBe(0)
  })

  it('goes back when the Host fails to load it: the previous version again, two history versions, and the change pending with the failure', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "broken"\n')
    const change = await onlyPending(ctx)
    const host = reloads({ ok: false, error: 'SyntaxError in index.js' }, OK)
    const result = await applyChange(ctx, change.id, terminal(), host)
    expect(result.reload).toEqual({ kind: 'went-back', failure: 'SyntaxError in index.js', historyVersion: expect.stringMatching(/^[0-9a-f]{40}$/), again: OK })
    expect(result.entry).toEqual({ id: change.id, kind: 'plugin-edit', state: 'pending', subject: { plugin: 'plug', source }, from: approved, to: change.to, summary: `plug: changes in ${source}`, createdAt: NOW.toISOString(), lastFailure: { at: NOW.toISOString(), failure: 'SyntaxError in index.js' } })
    expect(host.calls()).toBe(2)
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug).toEqual({ version: approved, kind: 'approved' })
    expect((await history(fx)).slice(0, 2)).toEqual([`Went back: plug: changes in ${source} failed to load`, `Applied: plug: changes in ${source}`])
    const listed = await onlyPending(ctx)
    expect(listed).toMatchObject({ id: change.id, lastFailure: { failure: 'SyntaxError in index.js' } })
    expect(await showChange(ctx, change.id)).toEqual({ kind: 'pending', change: listed })

    const second = await applyChange(ctx, change.id, terminal(), reloads(OK))
    expect(second.entry.lastFailure).toBeUndefined()
    expect(second.entry.state).toBe('applied')
  })

  it('goes back from a failed install to an empty active directory, and reports a Host gone after the failure', async () => {
    const { fx } = await migrated()
    const other = folder(fx, 'other')
    linkAs(fx, 'other', other)
    await start(fx)
    const ctx = contextOf(fx)
    const change = await onlyPending(ctx)
    const result = await applyChange(ctx, change.id, terminal(), reloads({ ok: false, error: 'boom' }, undefined))
    expect(result.reload).toEqual({ kind: 'went-back', failure: 'boom', historyVersion: expect.any(String) })
    expect((await readApproved(fx.profileDir)).plugins.other).toBeUndefined()
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'other'), EMPTY_CONTENT_VERSION)).toBe(true)
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.other).toBeUndefined()
  })

  it('refuses a plugin Delorun is working on', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const change = await onlyPending(ctx)
    await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved, minutes: 60 }, terminal())
    await rejection(applyChange(ctx, change.id, terminal(), reloads(OK)), 'NOT_ALLOWED')
  })

  it('records no history version when the profile history has nothing new', async () => {
    const { fx, source } = await migrated()
    edit(source, 'export default "two"\n')
    const ctx: ChangesContext = { ...contextOf(fx), history: { record: async () => Promise.resolve(undefined) } }
    const change = await onlyPending(ctx)
    const result = await applyChange(ctx, change.id, terminal(), reloads(OK))
    expect(result.historyVersion).toBeUndefined()
    expect(result.entry.historyVersion).toBeUndefined()
  })
})

describe('discarding a change', () => {
  it('hides the change while the folder holds that content, never writes the folder, and shows the next edit again', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const change = await onlyPending(ctx)
    const entry = await discardChange(ctx, change.id, terminal())
    expect(entry).toMatchObject({ id: change.id, state: 'discarded', decidedFrom: 'terminal', to: change.to })
    expect(readFileSync(join(source, 'index.js'), 'utf8')).toBe('export default "two"\n')
    expect((await listChanges(ctx)).pending).toEqual([])
    expect(await showChange(ctx, change.id)).toEqual({ kind: 'logged', entry })
    await rejection(discardChange(ctx, change.id, terminal()), 'NOT_ALLOWED')
    edit(source, 'export default "three"\n')
    expect((await onlyPending(ctx)).id).not.toBe(change.id)
  })

  it('applies a discarded change whose content the folder still holds', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const change = await onlyPending(ctx)
    await discardChange(ctx, change.id, terminal())
    expect((await applyChange(ctx, change.id, terminal(), reloads(OK))).entry.state).toBe('applied')
  })

  it('discards a pending install the start recorded, keeping when it was first recorded', async () => {
    const { fx } = await migrated()
    linkAs(fx, 'other', folder(fx, 'other'))
    await start(fx)
    const ctx: ChangesContext = { ...contextOf(fx), now: () => new Date('2026-11-11T00:00:00.000Z') }
    const change = await onlyPending(ctx)
    expect(await discardChange(ctx, change.id, terminal())).toMatchObject({ state: 'discarded', createdAt: NOW.toISOString(), decidedAt: '2026-11-11T00:00:00.000Z' })
  })

  it('refuses an applied change', async () => {
    const { fx } = await migrated()
    const upgrade = (await readChangeLog(fx.home, PROFILE)).entries[0]!
    await rejection(discardChange(contextOf(fx), upgrade.id, terminal()), 'NOT_ALLOWED')
  })
})

describe('undoing a change', () => {
  it('puts the approved content back to what it was before the change', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const change = await onlyPending(ctx)
    await applyChange(ctx, change.id, terminal(), reloads(OK))
    const result = await undoChange(ctx, change.id, terminal(), reloads(OK))
    expect(result).toMatchObject({ reload: { kind: 'reloaded' }, entry: { id: change.id, state: 'undone', decidedFrom: 'terminal' } })
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), approved)).toBe(true)
    expect((await history(fx))[0]).toBe(`Undid: plug: changes in ${source}`)
    expect((await onlyPending(ctx)).id).toBe(change.id)
    await rejection(undoChange(ctx, change.id, terminal(), reloads(OK)), 'NOT_ALLOWED')
  })

  it('undoes the approval at upgrade: the plugin loads nothing and waits for review again', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    const upgrade = (await readChangeLog(fx.home, PROFILE)).entries[0]!
    await undoChange(ctx, upgrade.id, terminal(), reloads(undefined))
    expect((await readApproved(fx.profileDir)).plugins.plug).toBeUndefined()
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), EMPTY_CONTENT_VERSION)).toBe(true)
    expect(await onlyPending(ctx)).toMatchObject({ kind: 'plugin-install', plugin: 'plug', source })
  })

  it('keeps the change applied with the failure when the Host fails to load the undo', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const change = await onlyPending(ctx)
    await applyChange(ctx, change.id, terminal(), reloads(OK))
    const result = await undoChange(ctx, change.id, terminal(), reloads({ ok: false, error: 'boom' }, OK))
    expect(result.entry).toMatchObject({ state: 'applied', lastFailure: { failure: 'boom' } })
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(change.to)
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), change.to)).toBe(true)
    expect((await history(fx))[0]).toBe(`Went back: undoing plug: changes in ${source} failed to load`)
    expect((await undoChange(ctx, change.id, terminal(), reloads(OK))).entry.lastFailure).toBeUndefined()
  })

  it('refuses to undo a change of a kind that is undone another way', async () => {
    const { fx } = await migrated()
    const log = await readChangeLog(fx.home, PROFILE)
    const kinds = ['plugin-update', 'plugin-remove', 'harness-edit'] as const
    const entries = kinds.map((kind, index) => ({ id: `c00000000a${String(index)}` as ChangeId, kind, state: 'applied' as const, subject: { plugin: 'plug' }, summary: kind, createdAt: NOW.toISOString() }))
    await writeChangeLog(fx.home, PROFILE, { ...log, entries: [...log.entries, ...entries] })
    for (const entry of entries) await rejection(undoChange(contextOf(fx), entry.id, terminal(), reloads(OK)), 'NOT_ALLOWED')
  })

  it('refuses a change a later change of the same plugin replaced, a plugin with no approval, an unknown id, a protection change and a plugin Delorun is working on', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    const upgrade = (await readChangeLog(fx.home, PROFILE)).entries[0]!
    edit(source, 'export default "two"\n')
    await applyChange(ctx, (await onlyPending(ctx)).id, terminal(), reloads(OK))
    await rejection(undoChange(ctx, upgrade.id, terminal(), reloads(OK)), 'NOT_ALLOWED')
    await rejection(undoChange(ctx, 'c0000000000' as ChangeId, terminal(), reloads(OK)), 'UNKNOWN_CHANGE')
    const weakening = await changeProtection(ctx, 'off', terminal())
    await rejection(undoChange(ctx, weakening.entry!.id, terminal(), reloads(OK)), 'NOT_ALLOWED')
    await openWorkSession(fx.home, PROFILE, { plugin: 'plug', source, from: approved, minutes: 60 }, terminal())
    await rejection(undoChange(ctx, upgrade.id, terminal(), reloads(OK)), 'NOT_ALLOWED')
    await writeApproved(fx.profileDir, { schema: 'delorun.changes-approved/1', plugins: {} })
    rmSync(join(changesDirectory(fx.home), 'profiles', PROFILE, 'work-session.json'))
    await rejection(undoChange(ctx, upgrade.id, terminal(), reloads(OK)), 'NOT_ALLOWED')
  })
})

describe('turning one plugin off and on', () => {
  it('turns a plugin off by its name leaving the bundle list, keeping the others in order, and on again at the end', async () => {
    const { fx } = await migrated()
    setBundles(fx, ['first', 'plug', 'last'])
    const ctx = contextOf(fx)
    const before = readFileSync(join(fx.profileDir, 'package.json'), 'utf8')
    const off = await turnOff(ctx, 'plug', terminal(), reloads(OK))
    expect(off).toMatchObject({ reload: { kind: 'reloaded' }, entry: { kind: 'plugin-off', state: 'applied', subject: { plugin: 'plug' }, summary: 'Turned off plug' } })
    expect(bundles(fx)).toEqual(['first', 'last'])
    const after = JSON.parse(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect({ ...after, dsh: undefined }).toEqual({ ...JSON.parse(before) as Record<string, unknown>, dsh: undefined })
    expect((await history(fx))[0]).toBe('Turned off plug')
    expect((await listChanges(ctx)).entries[0]).toEqual(off.entry)
    const on = await turnOn(ctx, 'plug', terminal(), reloads(OK))
    expect(on.entry).toMatchObject({ kind: 'plugin-on', state: 'applied' })
    expect(bundles(fx)).toEqual(['first', 'last', 'plug'])
  })

  it('undoes a plugin turned off by turning it on, and the other way round', async () => {
    const { fx } = await migrated()
    setBundles(fx, ['plug', 'other'])
    const ctx = contextOf(fx)
    const off = await turnOff(ctx, 'plug', terminal(), reloads(OK))
    const undone = await undoChange(ctx, off.entry.id, terminal(), reloads(OK))
    expect(undone.entry).toMatchObject({ id: off.entry.id, state: 'undone' })
    expect(bundles(fx)).toEqual(['other', 'plug'])
    expect((await history(fx))[0]).toBe('Undid: Turned off plug')
    const on = await turnOn(ctx, 'left-pad', terminal(), reloads(OK))
    await undoChange(ctx, on.entry.id, terminal(), reloads(OK))
    expect(bundles(fx)).toEqual(['other', 'plug'])
  })

  it('goes back to the bundle list when the Host fails to load it, and turns it off again when the change is applied', async () => {
    const { fx } = await migrated()
    setBundles(fx, ['plug'])
    const ctx = contextOf(fx)
    const off = await turnOff(ctx, 'plug', terminal(), reloads({ ok: false, error: 'boom' }, OK))
    expect(off.entry).toMatchObject({ state: 'pending', lastFailure: { failure: 'boom' } })
    expect(bundles(fx)).toEqual(['plug'])
    const listing = await listChanges(ctx)
    expect(listing.entries[0]).toEqual(off.entry)
    const again = await applyChange(ctx, off.entry.id, terminal(), reloads(OK))
    expect(again.entry).toMatchObject({ kind: 'plugin-off', state: 'applied' })
    expect(again.entry.lastFailure).toBeUndefined()
    expect(bundles(fx)).toEqual([])
  })

  it('discards a plugin turned off that failed to load', async () => {
    const { fx } = await migrated()
    setBundles(fx, ['plug'])
    const ctx = contextOf(fx)
    const off = await turnOff(ctx, 'plug', terminal(), reloads({ ok: false, error: 'boom' }, OK))
    const entry = await discardChange(ctx, off.entry.id, terminal())
    expect(entry).toMatchObject({ state: 'discarded', decidedFrom: 'terminal' })
    expect(entry.lastFailure).toBeUndefined()
  })

  it('keeps an undo of a plugin turned off applied with the failure when the Host fails to load it', async () => {
    const { fx } = await migrated()
    setBundles(fx, ['plug'])
    const ctx = contextOf(fx)
    const off = await turnOff(ctx, 'plug', terminal(), reloads(OK))
    const undo = await undoChange(ctx, off.entry.id, terminal(), reloads({ ok: false, error: 'boom' }, OK))
    expect(undo.entry).toMatchObject({ state: 'applied', lastFailure: { failure: 'boom' } })
    expect(bundles(fx)).toEqual([])
  })

  it("refuses Delorun's own bundle, a plugin not in the profile, one on already and one not on", async () => {
    const { fx } = await migrated()
    setBundles(fx, ['@delorun/bundle-local', 'plug'])
    const ctx = contextOf(fx)
    const before = written(fx)
    await rejection(turnOff(ctx, '@delorun/bundle-local', terminal(), reloads(OK)), 'NOT_ALLOWED')
    await rejection(turnOn(ctx, '@delorun/bundle-local', terminal(), reloads(OK)), 'NOT_ALLOWED')
    await rejection(turnOn(ctx, 'nowhere', terminal(), reloads(OK)), 'NOT_ALLOWED')
    await rejection(turnOn(ctx, 'plug', terminal(), reloads(OK)), 'NOT_ALLOWED')
    await rejection(turnOff(ctx, 'left-pad', terminal(), reloads(OK)), 'NOT_ALLOWED')
    expect(written(fx)).toBe(before)
  })

  it('writes the bundle list into a manifest that has none, and refuses one that is not a list of names', async () => {
    const { fx } = await migrated()
    const path = join(fx.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, `${JSON.stringify({ ...manifest, dsh: undefined }, undefined, 2)}\n`)
    const ctx = contextOf(fx)
    await turnOn(ctx, 'plug', terminal(), reloads(OK))
    expect(bundles(fx)).toEqual(['plug'])
    writeFileSync(path, `${JSON.stringify({ ...manifest, dsh: { profile: { bundles: 'plug' } } }, undefined, 2)}\n`)
    await rejection(turnOff(ctx, 'plug', terminal(), reloads(OK)), 'RECORD_UNREADABLE')
    writeFileSync(path, `${JSON.stringify({ ...manifest, dsh: { profile: { bundles: [1] } } }, undefined, 2)}\n`)
    await rejection(turnOff(ctx, 'plug', terminal(), reloads(OK)), 'RECORD_UNREADABLE')
  })
})

describe('the protection setting', () => {
  it('logs turning it off as a change and turning it on as none', async () => {
    const { fx } = await migrated()
    const ctx = contextOf(fx)
    const lowered = await changeProtection(ctx, 'off', terminal())
    expect(lowered).toMatchObject({ before: 'on', level: 'off', entry: { kind: 'guard-weakening', state: 'applied', subject: { setting: 'protection' }, summary: 'Protection turned off: changes load without review', decidedFrom: 'terminal' } })
    expect(await readProtection(fx.home)).toBe('off')
    expect((await listChanges(ctx)).entries[0]).toEqual(lowered.entry)
    expect(await changeProtection(ctx, 'on', terminal())).toEqual({ before: 'off', level: 'on' })
  })
})

describe('the changes actions refuse a proof the attest functions did not issue', () => {
  it('refuses a look-alike proof for every action and writes nothing', async () => {
    const { fx, source } = await migrated()
    setBundles(fx, ['plug'])
    const ctx = contextOf(fx)
    edit(source, 'export default "two"\n')
    const change = await onlyPending(ctx)
    const upgrade = (await readChangeLog(fx.home, PROFILE)).entries[0]!
    const forged = { kind: 'terminal' } as AtComputer
    const host = reloads(OK)
    const before = written(fx)
    await rejection(applyChange(ctx, change.id, forged, host), 'NOT_AT_COMPUTER')
    await rejection(discardChange(ctx, change.id, forged), 'NOT_AT_COMPUTER')
    await rejection(undoChange(ctx, upgrade.id, forged, host), 'NOT_AT_COMPUTER')
    await rejection(turnOff(ctx, 'plug', forged, host), 'NOT_AT_COMPUTER')
    await rejection(turnOn(ctx, 'left-pad', forged, host), 'NOT_AT_COMPUTER')
    await rejection(changeProtection(ctx, 'off', forged), 'NOT_AT_COMPUTER')
    expect(written(fx)).toBe(before)
    expect(await readProtection(fx.home)).toBe('on')
    expect(host.calls()).toBe(0)
  })
})
