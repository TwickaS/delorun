/**
 * A start that fails right after a change leaves that change out: only the change log is written, every later start
 * holds the content from before the change until the person applies it again or undoes it, and the invariants accept
 * only what such a change leaves.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { beginAgentAction, planAgentAction } from '../src/agent-actions.ts'
import { applyChange, listChanges, turnOn, undoChange, type ChangesContext, type ReloadHost, type ReloadOutcome } from '../src/actions.ts'
import { EMPTY_CONTENT_VERSION, startNotice } from '../src/enforce.ts'
import { checkLoadedContent } from '../src/invariants.ts'
import {
  boundedFailure,
  FAILURE_LIMIT_BYTES,
  lastLeftOut,
  leavableIn,
  leaveOutNewestChange,
  leftOutContent,
  leftOutFact,
  leftOutWords,
  leftOutNow,
  newestLeavableChange,
  SECOND_FAILURE_LINE,
} from '../src/left-out.ts'
import { activeDirectory, profileChangesDirectory } from '../src/paths.ts'
import { readActiveRecord, readApproved, readChangeLog, writeActiveRecord, writeChangeLog } from '../src/records.ts'
import { leftOutFacts } from '../src/status.ts'
import { holdsVersion } from '../src/store.ts'
import { ACTIVE_RECORD_SCHEMA, CHANGE_LOG_SCHEMA, type ActiveRecord, type ChangeEntry, type ChangeId, type ContentVersion } from '../src/types.ts'
import { approvedVersion, history, migrated, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'
import { rejection, writeFiles } from './support.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

/** The time of the change the person applies, after the fixture's start. */
const APPLIED_AT = new Date('2026-11-10T11:00:00.000Z')

/** The time of the failed start. */
const FAILED_AT = new Date('2026-11-10T12:00:00.000Z')

/**
 * @param fx - the fixture.
 * @param at - the clock.
 * @returns the context of an action.
 */
function contextOf(fx: Fixture, at = APPLIED_AT): ChangesContext {
  return { home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => at, lockWaitMs: 5_000 }
}

/**
 * @param outcome - the Host's answer; undefined when Delorun is not running.
 * @returns a reload that answers it and counts its calls.
 */
function answering(outcome: ReloadOutcome | undefined): { readonly reload: ReloadHost, readonly calls: () => number } {
  let calls = 0
  return { reload: async () => { calls += 1; return Promise.resolve(outcome) }, calls: () => calls }
}

/**
 * A profile whose `plug` the fixture's first start approved as `one`, then whose folder edit to `two` the person
 * applied.
 * @returns the fixture, the folder, the approved version before and the applied change.
 */
async function appliedEdit(): Promise<{ fx: Fixture, source: string, before: ContentVersion, change: ChangeEntry }> {
  const { fx, source, approved: before } = await migrated()
  writeFileSync(join(source, 'index.js'), 'export default "two"\n')
  const ctx = contextOf(fx)
  const [pending] = (await listChanges(ctx)).pending
  const { entry } = await applyChange(ctx, pending!.id, terminal(), { reload: answering(undefined).reload })
  return { fx, source, before, change: entry }
}

/**
 * @param fx - the fixture.
 * @returns the text the plugin's active directory holds in `index.js`, or undefined when it holds nothing.
 */
function activeText(fx: Fixture): string | undefined {
  const path = join(activeDirectory(fx.home, PROFILE, 'plug'), 'index.js')
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * Every file of the profile directory with its bytes' hash, and every link with its target, without the history's
 * object store's timestamps: what a profile write would change.
 * @param fx - the fixture.
 * @returns one line per entry, sorted.
 */
function profileBytes(fx: Fixture): string[] {
  const lines: string[] = []
  const walk = (path: string): void => {
    const stats = lstatSync(path)
    const name = relative(fx.profileDir, path)
    if (stats.isSymbolicLink()) lines.push(`${name} -> ${readlinkSync(path)}`)
    else if (stats.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry))
    else lines.push(`${name} ${createHash('sha256').update(readFileSync(path)).digest('hex')} ${String(stats.mtimeMs)}`)
  }
  walk(fx.profileDir)
  return lines.sort()
}

describe('leaving a change out after a failed start', () => {
  it('a left-out change stays out at the next start until applied or undone', async () => {
    const { fx, before, change } = await appliedEdit()
    expect(activeText(fx)).toBe('export default "two"\n')
    const left = await leaveOutNewestChange(contextOf(fx, FAILED_AT), 'SyntaxError: Unexpected token in plug/index.js')
    expect(left).toMatchObject({ id: change.id, state: 'left-out-at-start', decidedAt: FAILED_AT.toISOString(), decidedFrom: 'start', leftOut: { at: FAILED_AT.toISOString(), failure: 'SyntaxError: Unexpected token in plug/index.js' } })
    for (const _ of [1, 2]) {
      const started = await start(fx)
      expect(activeText(fx)).toBe('export default "one"\n')
      expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug).toEqual({ version: before, kind: 'left-out' })
      expect(started.leftOut).toEqual([{ id: change.id, plugin: 'plug', kind: 'plugin-edit', at: FAILED_AT.toISOString(), failure: 'SyntaxError: Unexpected token in plug/index.js' }])
      expect(startNotice(started)).toContain(`Delorun did not start with your latest change to plug (${change.id}): SyntaxError: Unexpected token in plug/index.js.\nIt starts without it now; your files are unchanged.\nTo try it again: delorun changes apply ${change.id}. To undo it: delorun changes undo ${change.id}.\n`)
      expect(await checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).toEqual([])
    }
    expect(await leftOutFacts(fx.home, PROFILE)).toEqual([expect.objectContaining({ id: change.id, plugin: 'plug' })])
    // The approved record still names the change's content: the profile's files hold it.
    expect(await approvedVersion(fx, 'plug')).toBe(change.to)

    const undone = await undoChange(contextOf(fx), change.id, terminal(), { reload: answering(undefined).reload })
    expect(undone.entry).toMatchObject({ id: change.id, state: 'undone' })
    expect(await approvedVersion(fx, 'plug')).toBe(before)
    const after = await start(fx)
    expect(after.leftOut).toBeUndefined()
    expect(activeText(fx)).toBe('export default "one"\n')
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug).toEqual({ version: before, kind: 'approved' })
  })

  it('applying a left-out change loads it again', async () => {
    const { fx, before, change } = await appliedEdit()
    await leaveOutNewestChange(contextOf(fx, FAILED_AT), 'boom')
    await start(fx)
    expect((await listChanges(contextOf(fx))).leftOut).toEqual([expect.objectContaining({ id: change.id, state: 'left-out-at-start' })])

    // A reload that fails again keeps it out, with the failure.
    const failing = answering({ ok: false, error: 'still broken' })
    const again = await applyChange(contextOf(fx), change.id, terminal(), { reload: failing.reload })
    expect(again.reload).toMatchObject({ kind: 'went-back', failure: 'still broken' })
    expect(again.entry).toMatchObject({ state: 'left-out-at-start', lastFailure: { failure: 'still broken' } })
    expect(activeText(fx)).toBe('export default "one"\n')
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug).toEqual({ version: before, kind: 'left-out' })

    const loading = answering({ ok: true })
    const applied = await applyChange(contextOf(fx), change.id, terminal(), { reload: loading.reload })
    expect(loading.calls()).toBe(1)
    expect(applied.reload).toEqual({ kind: 'reloaded' })
    expect(applied.entry).toMatchObject({ id: change.id, state: 'applied', decidedFrom: 'terminal' })
    expect(applied.entry.leftOut).toBeUndefined()
    expect(applied.entry.lastFailure).toBeUndefined()
    expect(activeText(fx)).toBe('export default "two"\n')
    expect((await readActiveRecord(fx.home, PROFILE)).plugins.plug).toEqual({ version: change.to, kind: 'approved' })
    expect((await listChanges(contextOf(fx))).leftOut).toEqual([])
    await start(fx)
    expect(activeText(fx)).toBe('export default "two"\n')
  })

  it('the retry writes nothing to the profile', async () => {
    const { fx } = await appliedEdit()
    writeFiles(fx.profileDir, { 'cordis.patch.yml': '[]\n' })
    const bytes = profileBytes(fx)
    const versions = await history(fx)
    await leaveOutNewestChange(contextOf(fx, FAILED_AT), 'boom')
    await start(fx)
    await start(fx)
    expect(profileBytes(fx)).toEqual(bytes)
    expect(await history(fx)).toEqual(versions)
  })

  it('leaves out a change that installed a plugin or turned it on, which then loads nothing, and undoes either', async () => {
    const { fx, source } = await migrated()
    // Turned off by hand, then on with Changes.
    const path = join(fx.profileDir, 'package.json')
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')) as object, dsh: { profile: { bundles: [] } } }, undefined, 2)}\n`)
    const on = await turnOn(contextOf(fx), 'plug', terminal(), { reload: answering(undefined).reload })
    const left = await leaveOutNewestChange(contextOf(fx, FAILED_AT), 'boom')
    expect(left?.id).toBe(on.entry.id)
    expect(leftOutContent(left!)).toEqual({ kind: 'left-out' })
    await start(fx)
    expect(activeText(fx)).toBeUndefined()
    expect(await holdsVersion(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), EMPTY_CONTENT_VERSION)).toBe(true)
    expect(await checkLoadedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir })).toEqual([])
    expect(await leftOutFacts(fx.home, PROFILE)).toEqual([expect.objectContaining({ id: on.entry.id, kind: 'plugin-on' })])
    const undone = await undoChange(contextOf(fx), on.entry.id, terminal(), { reload: answering({ ok: true }).reload })
    expect(undone.entry.state).toBe('undone')
    await start(fx)
    expect(activeText(fx)).toBe('export default "one"\n')
    expect(source).toBeDefined()
  })

  it('applies a left-out turn-on again, and refuses a left-out change whose content is no longer the approved one', async () => {
    const { fx } = await migrated()
    const path = join(fx.profileDir, 'package.json')
    writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')) as object, dsh: { profile: { bundles: [] } } }, undefined, 2)}\n`)
    const on = await turnOn(contextOf(fx), 'plug', terminal(), { reload: answering(undefined).reload })
    await leaveOutNewestChange(contextOf(fx, FAILED_AT), 'boom')
    await start(fx)
    const applied = await applyChange(contextOf(fx), on.entry.id, terminal(), { reload: answering(undefined).reload })
    expect(applied.entry).toMatchObject({ state: 'applied' })
    expect(activeText(fx)).toBe('export default "one"\n')

    const { fx: other, source, change } = await appliedEdit()
    await leaveOutNewestChange(contextOf(other, FAILED_AT), 'boom')
    // The folder moved on too, so the change's id names only the logged change.
    writeFileSync(join(source, 'index.js'), 'export default "three"\n')
    const log = await readChangeLog(other.home, PROFILE)
    // The approved record moved on, as a restored history version moves it.
    const approved = await readApproved(other.profileDir)
    const manifest = JSON.parse(readFileSync(join(other.profileDir, 'package.json'), 'utf8')) as { delorun: { changes: { plugins: Record<string, { version: string }> } } }
    manifest.delorun.changes.plugins.plug!.version = change.from!
    writeFileSync(join(other.profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    expect((await listChanges(contextOf(other))).leftOut).toEqual([])
    expect((await rejection(applyChange(contextOf(other), change.id, terminal(), { reload: answering(undefined).reload }), 'NOT_ALLOWED')).detail).toContain('no longer has what change')
    expect(log.entries.at(-1)?.state).toBe('left-out-at-start')
    expect(approved.plugins.plug?.version).toBe(change.to)
  })
})

describe('which change a failed start leaves out', () => {
  it('the newest change a person applied to a plugin linked to its active directory, whose approved content it is', async () => {
    const { fx, change } = await appliedEdit()
    expect(await newestLeavableChange(contextOf(fx))).toEqual(change)
  })

  it('nothing when the newest change is an agent action, and not an older approved change', async () => {
    const { fx, change } = await appliedEdit()
    expect(await newestLeavableChange(contextOf(fx))).toEqual(change)
    const later = contextOf(fx, FAILED_AT)
    await beginAgentAction(later, await planAgentAction(later, { action: 'install_bundle', target: 'new-plugin' }))
    expect(await newestLeavableChange(contextOf(fx))).toBeUndefined()
    expect(await leaveOutNewestChange(later, 'boom')).toBeUndefined()
    expect((await readChangeLog(fx.home, PROFILE)).entries.at(-1)).toEqual(change)
  })

  it('nothing after an approval at upgrade, a change already left out, an undone change or a change of another kind', async () => {
    const { fx } = await migrated()
    // Only the approval at upgrade is decided.
    expect(await newestLeavableChange(contextOf(fx))).toBeUndefined()
    expect(await leaveOutNewestChange(contextOf(fx), 'boom')).toBeUndefined()
    const { fx: edited } = await appliedEdit()
    await leaveOutNewestChange(contextOf(edited, FAILED_AT), 'boom')
    // A second failure leaves out nothing more.
    expect(await newestLeavableChange(contextOf(edited))).toBeUndefined()
  })

  it('decides from the records alone: kind, plugin, link, active content and approval', () => {
    const v1 = brandString<ContentVersion>('a'.repeat(64))
    const v2 = brandString<ContentVersion>('b'.repeat(64))
    const base: ChangeEntry = { id: brandString<ChangeId>('c0000000001'), kind: 'plugin-edit', state: 'applied', subject: { plugin: 'plug', source: '/src/plug' }, from: v1, to: v2, summary: 'plug', createdAt: '2026-11-10T10:00:00Z', decidedAt: '2026-11-10T11:00:00Z', decidedFrom: 'terminal' }
    const records = (entries: readonly ChangeEntry[], active: ActiveRecord['plugins'] = { plug: { version: v2, kind: 'approved' } }, approved = v2, linked = ['plug']): Parameters<typeof leavableIn>[0] => ({
      log: { schema: CHANGE_LOG_SCHEMA, entries },
      approved: { schema: 'delorun.changes-approved/1', plugins: { plug: { source: '/src/plug', version: approved, approvedAt: '2026-11-10T11:00:00Z' } } },
      active: { schema: ACTIVE_RECORD_SCHEMA, plugins: active },
      linked: new Set(linked),
    })
    expect(leavableIn(records([base]))).toBe(base)
    // The later entry in the log wins a tie; a newer undecided entry is not a decision.
    const tie = { ...base, id: brandString<ChangeId>('c0000000002') }
    const { decidedAt: _decidedAt, ...undecided } = base
    expect(leavableIn(records([base, tie, { ...undecided, id: brandString<ChangeId>('c0000000003'), state: 'pending' }]))).toBe(tie)
    expect(leavableIn(records([base, { ...base, id: brandString<ChangeId>('c0000000004'), state: 'discarded', decidedAt: '2026-11-10T12:00:00Z' }]))).toBe(base)
    // A decision listed later but made earlier is not the newest.
    expect(leavableIn(records([base, { ...base, id: brandString<ChangeId>('c0000000006'), state: 'undone', decidedAt: '2026-11-10T10:30:00Z' }]))).toBe(base)
    expect(leavableIn(records([base, { ...base, id: brandString<ChangeId>('c0000000005'), state: 'undone', decidedAt: '2026-11-10T12:00:00Z' }]))).toBeUndefined()
    expect(leavableIn(records([{ ...base, kind: 'plugin-off' }]))).toBeUndefined()
    expect(leavableIn(records([{ ...base, decidedFrom: 'upgrade' }]))).toBeUndefined()
    expect(leavableIn(records([{ ...base, subject: { setting: 'protection' } }]))).toBeUndefined()
    expect(leavableIn(records([base], undefined, v2, []))).toBeUndefined()
    expect(leavableIn(records([base], {}))).toBeUndefined()
    expect(leavableIn(records([base], { plug: { version: v2, kind: 'work-session' } }))).toBeUndefined()
    expect(leavableIn(records([base], { plug: { version: v1, kind: 'approved' } }))).toBeUndefined()
    expect(leavableIn(records([base], undefined, v1))).toBeUndefined()
    const { to: _to, ...withoutTo } = base
    expect(leavableIn(records([withoutTo]))).toBeUndefined()
    const { from: _from, ...plain } = withoutTo
    const on: ChangeEntry = { ...plain, kind: 'plugin-on' }
    expect(leavableIn(records([on], { plug: { version: v1, kind: 'approved' } }))).toBe(on)
  })
})

describe('what a change left out names and keeps', () => {
  it('keeps at most 2 KiB of the failure, cut at a character', () => {
    expect(boundedFailure('short')).toBe('short')
    const long = 'é'.repeat(FAILURE_LIMIT_BYTES)
    const kept = boundedFailure(long)
    expect(Buffer.byteLength(kept)).toBe(FAILURE_LIMIT_BYTES)
    expect(kept).toBe('é'.repeat(FAILURE_LIMIT_BYTES / 2))
    expect(Buffer.byteLength(boundedFailure(`x${long}`))).toBe(FAILURE_LIMIT_BYTES - 1)
  })

  it('names the plugin, the change, the failure in one line, and how to apply or undo it', () => {
    const fact = { id: brandString<ChangeId>('c0123456789'), plugin: 'plug', failure: 'Error: boom.\n    at load (index.js:1)' }
    expect(leftOutWords(fact)).toBe('Delorun did not start with your latest change to plug (c0123456789): Error: boom. at load (index.js:1).\nIt starts without it now; your files are unchanged.\nTo try it again: delorun changes apply c0123456789. To undo it: delorun changes undo c0123456789.')
    expect(leftOutWords({ ...fact, failure: 'x'.repeat(500) })).toContain(`${'x'.repeat(200)}….\nIt starts`)
    expect(SECOND_FAILURE_LINE).toBe('Delorun did not start again. Start without third-party plugins: delorun recover safe-mode, then delorun start.')
  })

  it('reads a fact from an entry without its failure record, and only the left-out content that a change left out', () => {
    const v1 = brandString<ContentVersion>('a'.repeat(64))
    const entry: ChangeEntry = { id: brandString<ChangeId>('c0000000001'), kind: 'plugin-edit', state: 'left-out-at-start', subject: {}, from: v1, summary: 's', createdAt: '2026-11-10T10:00:00Z' }
    expect(leftOutFact(entry)).toEqual({ id: entry.id, plugin: '', kind: 'plugin-edit', at: '2026-11-10T10:00:00Z', failure: '' })
    expect(leftOutFact({ ...entry, decidedAt: '2026-11-10T11:00:00Z' }).at).toBe('2026-11-10T11:00:00Z')
    const log = { schema: CHANGE_LOG_SCHEMA, entries: [{ ...entry, subject: { plugin: 'plug' }, decidedAt: '2026-11-10T11:00:00Z' }] } as const
    expect(leftOutNow(log, { schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { version: v1, kind: 'left-out' }, other: { kind: 'left-out' }, third: { version: v1, kind: 'approved' } } })).toEqual([expect.objectContaining({ plugin: 'plug' })])
  })

  it('names the change the newest failed start left out, or none', async () => {
    const { fx, change } = await appliedEdit()
    expect(await lastLeftOut(fx.home, PROFILE)).toBeUndefined()
    await leaveOutNewestChange(contextOf(fx, FAILED_AT), 'boom')
    expect(await lastLeftOut(fx.home, PROFILE)).toMatchObject({ id: change.id, plugin: 'plug', failure: 'boom' })
  })
})

describe('the records of content left out', () => {
  it('reads left-out content with or without a version, and refuses any other content without one', async () => {
    const { fx, approved: before } = await migrated()
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { kind: 'left-out' }, other: { version: before, kind: 'left-out' } } })
    expect((await readActiveRecord(fx.home, PROFILE)).plugins).toEqual({ plug: { kind: 'left-out' }, other: { version: before, kind: 'left-out' } })
    writeFileSync(join(profileChangesDirectory(fx.home, PROFILE), 'active.json'), `${JSON.stringify({ schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { kind: 'approved' } } })}\n`, { mode: 0o600 })
    expect((await rejection(readActiveRecord(fx.home, PROFILE), 'RECORD_UNREADABLE')).detail).toContain('version is missing')
    writeFileSync(join(profileChangesDirectory(fx.home, PROFILE), 'active.json'), `${JSON.stringify({ schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { version: before, kind: 'skipped' } } })}\n`, { mode: 0o600 })
    expect((await rejection(readActiveRecord(fx.home, PROFILE), 'RECORD_UNREADABLE')).detail).toContain('approved, work-session, left-out')
  })

  it('refuses left-out content with protection on that no change left out of the plugin holds, and accepts holding nothing', async () => {
    const { fx, before, change } = await appliedEdit()
    const request = { home: fx.home, profile: PROFILE, profileDir: fx.profileDir }
    // The active directory holds the content from before the change, recorded as left out, with no change left out.
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { version: before, kind: 'left-out' } } })
    const { materialize } = await import('../src/store.ts')
    await materialize(fx.home, before, activeDirectory(fx.home, PROFILE, 'plug'))
    expect(await checkLoadedContent(request)).toEqual([`plug holds version ${before} as left out of a failed start, and no change left out of it that stays out holds that version.`])
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { version: change.to!, kind: 'approved' } } })
    await leaveOutNewestChange(contextOf(fx, FAILED_AT), 'boom')
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { version: before, kind: 'left-out' } } })
    expect(await checkLoadedContent(request)).toEqual([])
    // A left-out change whose `to` is no longer approved holds nothing back.
    const log = await readChangeLog(fx.home, PROFILE)
    await writeChangeLog(fx.home, PROFILE, { ...log, entries: log.entries.map(entry => entry.id === change.id ? { ...entry, to: before } : entry) })
    expect(await checkLoadedContent(request)).toHaveLength(1)
    // Holding nothing loads nothing, whatever the log says.
    const { holdContent } = await import('../src/enforce.ts')
    await holdContent(fx.home, activeDirectory(fx.home, PROFILE, 'plug'), undefined)
    await writeActiveRecord(fx.home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { kind: 'left-out' } } })
    expect(await checkLoadedContent(request)).toEqual([])
    writeFileSync(join(profileChangesDirectory(fx.home, PROFILE), 'log.json'), 'not json', { mode: 0o600 })
    expect((await checkLoadedContent(request)).join('\n')).toContain('The change log cannot be read')
  })
})
