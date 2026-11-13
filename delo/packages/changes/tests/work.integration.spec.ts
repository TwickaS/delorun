/**
 * Work sessions (contract C21, "Work sessions"): starting one loads the folder's content live for at most its length, a
 * failed load goes back to the content that last loaded, `done` approves exactly the version it showed as one history
 * entry, ending one without the person approves nothing, and only a person at their computer starts or ends one.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { finishWork, listChanges, startWork, type ChangesContext, type ReloadHost, type ReloadOutcome } from '../src/actions.ts'
import { enforceApprovedContent, startNotice } from '../src/enforce.ts'
import { changeId } from '../src/ids.ts'
import * as barrel from '../src/index.ts'
import { activeDirectory, changesDirectory, profileChangesDirectory, versionsDirectory } from '../src/paths.ts'
import { readActiveRecord, readApproved, readChangeLog, readWorkSession, writeActiveRecord, type AtComputer } from '../src/records.ts'
import { finishWorkWithoutPerson } from '../src/stop.ts'
import { storeFolder } from '../src/store.ts'
import type { ContentVersion } from '../src/types.ts'
import { loadWorkSession, reviewWork, shortVersion, WORK_SESSION_MAX_MINUTES, workFinishedLine, workSessionExpired, type WorkFinished } from '../src/work.ts'
import { readWorkFailure, workFailurePath, writeWorkFailure } from '../src/work-record.ts'
import { folder, history, linkAs, migrated, NOW, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'
import { rejection } from './support.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 120_000 })

const OK: ReloadOutcome = { ok: true }

/** The length of the sessions these specs open, so that the fixed clock {@link NOW} stays inside each of them. */
const MINUTES = WORK_SESSION_MAX_MINUTES

/**
 * @param error - what the Host reports.
 * @returns a failed reload.
 */
function failing(error: string): ReloadOutcome {
  return { ok: false, error }
}

/**
 * @param fx - the fixture.
 * @returns the context every call in these specs runs with.
 */
function contextOf(fx: Fixture): ChangesContext {
  return { home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW, lockWaitMs: 5_000 }
}

/**
 * A reload that answers each call with the next outcome.
 * @param outcomes - the answers, in order; undefined means Delo is not running.
 * @returns the reload, the number of calls, and the session length `startWork` takes.
 */
function reloads(...outcomes: (ReloadOutcome | undefined)[]): { readonly reload: ReloadHost, readonly calls: () => number, readonly minutes: number } {
  const answers = [...outcomes]
  let calls = 0
  return {
    reload: async () => {
      calls += 1
      return Promise.resolve(answers.shift())
    },
    calls: () => calls,
    minutes: MINUTES,
  }
}

/**
 * End the session on `plug` at the person's word, approving what the folder holds now, as `done` shows it.
 * @param ctx - the profile.
 * @param host - the Host's reload.
 * @returns what `done` did.
 */
async function done(ctx: ChangesContext, host: { readonly reload: ReloadHost }): ReturnType<typeof finishWork> {
  const { folder: shown } = await reviewWork(ctx, 'plug')
  return finishWork(ctx, 'plug', terminal(), { reload: host.reload, approve: shown })
}

/**
 * @param result - what `done` did.
 * @returns it as an ended session.
 */
function ended(result: Awaited<ReturnType<typeof finishWork>>): WorkFinished {
  if (result.kind !== 'ended') throw new Error(`the session did not end: ${result.load.failure}`)
  return result
}

/**
 * Edit the plugin's folder and return its content, stored.
 * @param fx - the fixture.
 * @param source - the folder.
 * @param body - the new text of its `index.js`.
 * @returns the folder's content.
 */
async function edit(fx: Fixture, source: string, body: string): Promise<ContentVersion> {
  writeFileSync(join(source, 'index.js'), body)
  return (await storeFolder(fx.home, source)).version
}

/**
 * @param fx - the fixture.
 * @returns what the plugin's active directory and `active.json` hold.
 */
async function active(fx: Fixture): Promise<{ readonly index: string, readonly record: unknown }> {
  return {
    index: readFileSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'index.js'), 'utf8'),
    record: (await readActiveRecord(fx.home, PROFILE)).plugins.plug,
  }
}

/**
 * Everything starting or ending a session could write.
 * @param fx - the fixture.
 * @returns the snapshot.
 */
function written(fx: Fixture): string {
  const records = profileChangesDirectory(fx.home, PROFILE)
  return ['active.json', 'log.json', 'work-session.json'].map(name => existsSync(join(records, name)) ? readFileSync(join(records, name), 'utf8') : '').join('')
    + readFileSync(join(fx.profileDir, 'package.json'), 'utf8')
    + readFileSync(join(activeDirectory(fx.home, PROFILE, 'plug'), 'index.js'), 'utf8')
}

describe('a remote session and the model cannot start or end a work session', () => {
  it('refuses a missing, a forged and a look-alike proof before anything is read or written', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    const host = reloads(OK)
    const before = written(fx)
    const stored = readdirSync(versionsDirectory(fx.home))
    for (const proof of [undefined as never, { kind: 'terminal' } as AtComputer, Object.freeze({ kind: 'terminal' }) as AtComputer]) {
      await rejection(startWork(ctx, 'plug', proof, host), 'NOT_AT_COMPUTER')
      await rejection(finishWork(ctx, 'plug', proof, { ...host, approve: undefined }), 'NOT_AT_COMPUTER')
    }
    expect(written(fx)).toBe(before)
    expect(readdirSync(versionsDirectory(fx.home))).toEqual(stored)
    expect(host.calls()).toBe(0)
  })

  it('refuses a forged proof for ending an open session, which stays open', async () => {
    const { fx, approved } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const host = reloads(OK)
    await rejection(finishWork(ctx, 'plug', { kind: 'terminal' } as AtComputer, { ...host, approve: approved }), 'NOT_AT_COMPUTER')
    expect((await readWorkSession(fx.home, PROFILE))?.plugin).toBe('plug')
    expect(host.calls()).toBe(0)
  })

  it('exports the end without a person only from @delo/changes/stop', () => {
    expect(Object.keys(barrel)).toEqual(expect.arrayContaining(['startWork', 'finishWork', 'reviewWork', 'loadWorkSession']))
    for (const name of ['finishWorkWithoutPerson', 'beginWork', 'endWork', 'endWorkWithoutPerson']) expect(Object.keys(barrel)).not.toContain(name)
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> }
    expect(manifest.exports).toMatchObject({ '.': './src/index.ts', './stop': './src/stop.ts' })
  })
})

describe('starting a work session', () => {
  it('loads the folder\'s content at once and notes it as the content that last loaded', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    await writeWorkFailure(fx.home, PROFILE, { plugin: 'plug', at: NOW.toISOString(), error: 'an earlier session failed' })
    const version = await edit(fx, source, 'export default "two"\n')
    const host = reloads(OK)
    const started = await startWork(ctx, 'plug', terminal(), host)
    expect(started.load).toEqual({ kind: 'loaded', plugin: 'plug', version })
    expect(started.session).toMatchObject({ plugin: 'plug', source, from: approved, startedFrom: 'terminal', lastLoaded: version })
    expect(await readWorkSession(fx.home, PROFILE)).toEqual(started.session)
    expect(await active(fx)).toEqual({ index: 'export default "two"\n', record: { version, kind: 'work-session' } })
    expect(host.calls()).toBe(1)
    expect(existsSync(workFailurePath(fx.home, PROFILE))).toBe(false)
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
  })

  it('goes back to the approved content when the folder fails to load, and the session stays open', async () => {
    const { fx, source, approved } = await migrated()
    const version = await edit(fx, source, 'throw new Error("broken")\n')
    const host = reloads(failing('plug threw'), OK)
    const started = await startWork(contextOf(fx), 'plug', terminal(), host)
    expect(started.load).toEqual({ kind: 'went-back', plugin: 'plug', version, back: approved, failure: 'plug threw', again: OK })
    expect(started.session).toMatchObject({ lastFailed: version })
    expect(started.session.lastLoaded).toBeUndefined()
    expect(await active(fx)).toEqual({ index: 'export default "one"\n', record: { version: approved, kind: 'approved' } })
    expect(await readWorkFailure(fx.home, PROFILE)).toEqual({ schema: 'delo.changes-work/1', plugin: 'plug', at: NOW.toISOString(), error: 'plug threw' })
    expect(host.calls()).toBe(2)
  })

  it('refuses while Delo is not running, leaving no session and the approved content', async () => {
    const { fx, source, approved } = await migrated()
    await edit(fx, source, 'export default "two"\n')
    const before = await active(fx)
    const error = await rejection(startWork(contextOf(fx), 'plug', terminal(), reloads(undefined)), 'NOT_ALLOWED')
    expect(error.detail).toBe('Delo is not running for the profile default, so nothing would load live. Start it with delorun start, then run delorun changes work plug.')
    expect(await readWorkSession(fx.home, PROFILE)).toBeUndefined()
    expect(await active(fx)).toEqual(before)
    expect(before.record).toEqual({ version: approved, kind: 'approved' })
    await writeActiveRecord(fx.home, PROFILE, { schema: 'delo.changes-active/1', plugins: {} })
    await rejection(startWork(contextOf(fx), 'plug', terminal(), reloads(undefined)), 'NOT_ALLOWED')
    expect((await readActiveRecord(fx.home, PROFILE)).plugins).toEqual({})
    expect(readdirSync(activeDirectory(fx.home, PROFILE, 'plug'))).toEqual([])
  })

  it('refuses a plugin without approved content, one it does not know, one whose folder is gone, and a second session', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    linkAs(fx, 'other', folder(fx, 'other'))
    await start(fx)
    await rejection(startWork(ctx, 'other', terminal(), reloads(OK)), 'NOT_LINKED')
    await rejection(startWork(ctx, 'left-pad', terminal(), reloads(OK)), 'NOT_LINKED')
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    await rejection(startWork(ctx, 'plug', terminal(), reloads(OK)), 'WORK_SESSION_OPEN')
    await done(ctx, reloads(OK))
    rmSync(source, { recursive: true })
    const gone = await rejection(startWork(ctx, 'plug', terminal(), reloads(OK)), 'NOT_LINKED')
    expect(gone.detail).toContain('is gone')
  })
})

describe('loading the open session\'s folder', () => {
  it('loads new content, goes back to the content that last loaded, and leaves content that failed alone', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    expect(await loadWorkSession(ctx, reloads(OK).reload)).toEqual({ kind: 'none' })
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    expect(await loadWorkSession(ctx, reloads(OK).reload)).toEqual({ kind: 'unchanged', plugin: 'plug' })
    const two = await edit(fx, source, 'export default "two"\n')
    expect(await loadWorkSession(ctx, reloads(OK).reload)).toEqual({ kind: 'loaded', plugin: 'plug', version: two })
    const broken = await edit(fx, source, 'throw new Error("broken")\n')
    const host = reloads(failing('plug threw'), failing('plug threw again'))
    expect(await loadWorkSession(ctx, host.reload)).toEqual({ kind: 'went-back', plugin: 'plug', version: broken, back: two, failure: 'plug threw', again: failing('plug threw again') })
    expect(await active(fx)).toEqual({ index: 'export default "two"\n', record: { version: two, kind: 'work-session' } })
    expect(await loadWorkSession(ctx, reloads(OK).reload)).toEqual({ kind: 'unchanged', plugin: 'plug' })
    const after = reloads(failing('still broken'), undefined)
    const three = await edit(fx, source, 'export default "three"\n')
    expect(await loadWorkSession(ctx, after.reload)).toEqual({ kind: 'went-back', plugin: 'plug', version: three, back: two, failure: 'still broken' })
    rmSync(source, { recursive: true })
    expect(await loadWorkSession(ctx, reloads(OK).reload)).toEqual({ kind: 'folder-gone', plugin: 'plug' })
  })

  it('loads content when active.json records none for the plugin, and leaves it for the next start when Delo is not running', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    await writeActiveRecord(fx.home, PROFILE, { schema: 'delo.changes-active/1', plugins: {} })
    const two = await edit(fx, source, 'export default "two"\n')
    expect(await loadWorkSession(ctx, reloads(undefined).reload)).toEqual({ kind: 'not-running', plugin: 'plug', version: two })
    expect(await active(fx)).toEqual({ index: 'export default "two"\n', record: { version: two, kind: 'work-session' } })
  })
})

describe('done approves exactly the version it showed', () => {
  it('approves the version it showed, records the whole difference since the session began once, and closes the session', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    const historyBefore = await history(fx)
    const started = await startWork(ctx, 'plug', terminal(), reloads(OK))
    await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    const three = await edit(fx, source, 'export default "three"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    const review = await reviewWork(ctx, 'plug')
    expect(review).toMatchObject({ session: { plugin: 'plug', from: approved }, folder: three, change: { kind: 'plugin-edit', from: approved, to: three, files: [{ path: 'index.js', status: 'modified' }] }, failedToLoad: false })
    const host = reloads(OK)
    const finished = ended(await finishWork(ctx, 'plug', terminal(), { reload: host.reload, approve: review.folder }))
    expect(host.calls()).toBe(0)
    const subject = { plugin: 'plug', source }
    const summary = `Work on plug: ${approved.slice(0, 7)} → ${three.slice(0, 7)}`
    expect(finished).toEqual({
      kind: 'ended',
      plugin: 'plug',
      source,
      from: approved,
      ended: 'done',
      approved: three,
      folder: three,
      entry: { id: changeId('plugin-edit', subject, approved, three), kind: 'plugin-edit', state: 'applied', subject, from: approved, to: three, summary, createdAt: started.session.startedAt, decidedAt: NOW.toISOString(), decidedFrom: 'terminal', historyVersion: expect.any(String) },
    })
    expect(await history(fx)).toEqual([summary, ...historyBefore])
    expect((await readChangeLog(fx.home, PROFILE)).entries.at(-1)).toEqual(finished.entry)
    expect((await readApproved(fx.profileDir)).plugins.plug).toEqual({ source, version: three, approvedAt: NOW.toISOString() })
    expect(await active(fx)).toEqual({ index: 'export default "three"\n', record: { version: three, kind: 'approved' } })
    expect(await readWorkSession(fx.home, PROFILE)).toBeUndefined()
    expect((await listChanges(ctx)).pending).toEqual([])
    expect(workFinishedLine(finished)).toBe(`Version ${shortVersion(three)} is now the approved version of plug (${finished.entry!.id}).`)
  })

  it('refuses with CHANGED_SINCE_REVIEW when the folder changed after the display, approves nothing and keeps the session open', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const two = await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    const historyBefore = await history(fx)
    expect((await reviewWork(ctx, 'plug')).folder).toBe(two)
    await edit(fx, source, 'export default "three"\n')
    const host = reloads(OK)
    await rejection(finishWork(ctx, 'plug', terminal(), { reload: host.reload, approve: two }), 'CHANGED_SINCE_REVIEW')
    rmSync(source, { recursive: true })
    await rejection(finishWork(ctx, 'plug', terminal(), { reload: host.reload, approve: two }), 'CHANGED_SINCE_REVIEW')
    expect(host.calls()).toBe(0)
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
    expect(await history(fx)).toEqual(historyBefore)
    expect((await readChangeLog(fx.home, PROFILE)).entries.filter(entry => entry.kind === 'plugin-edit')).toEqual([])
    expect((await readWorkSession(fx.home, PROFILE))?.plugin).toBe('plug')
    expect(await reviewWork(ctx, 'plug')).toEqual({ session: await readWorkSession(fx.home, PROFILE), failedToLoad: false })
    await edit(fx, folder(fx, 'plug'), 'export default "four"\n')
    await rejection(finishWork(ctx, 'plug', terminal(), { reload: host.reload, approve: undefined }), 'CHANGED_SINCE_REVIEW')
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
  })

  it('loads the version it showed first when the Host does not run it yet', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const two = await edit(fx, source, 'export default "two"\n')
    const host = reloads(OK)
    const finished = ended(await done(ctx, host))
    expect(finished.load).toEqual({ kind: 'loaded', plugin: 'plug', version: two })
    expect(finished.approved).toBe(two)
    expect(host.calls()).toBe(1)
  })

  it('approves nothing and keeps the session open when the version it showed fails to load, and approves it once it loads', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const two = await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    const broken = await edit(fx, source, 'throw new Error("broken")\n')
    const historyBefore = await history(fx)
    const failed = await done(ctx, reloads(failing('plug threw'), OK))
    expect(failed).toEqual({ kind: 'went-back', plugin: 'plug', load: { kind: 'went-back', plugin: 'plug', version: broken, back: two, failure: 'plug threw', again: OK } })
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
    expect(await history(fx)).toEqual(historyBefore)
    expect(await active(fx)).toEqual({ index: 'export default "two"\n', record: { version: two, kind: 'work-session' } })
    expect(await readWorkFailure(fx.home, PROFILE)).toMatchObject({ plugin: 'plug', error: 'plug threw' })
    expect(await reviewWork(ctx, 'plug')).toMatchObject({ folder: broken, failedToLoad: true })
    const finished = ended(await done(ctx, reloads(OK)))
    expect(finished).toMatchObject({ approved: broken, load: { kind: 'loaded' } })
    expect(existsSync(workFailurePath(fx.home, PROFILE))).toBe(false)
  })

  it('keeps the approved version when the folder holds it or is gone, putting it back when the Host ran another', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    expect(await reviewWork(ctx, 'plug')).toMatchObject({ folder: approved, failedToLoad: false })
    expect((await reviewWork(ctx, 'plug')).change).toBeUndefined()
    const unchanged = ended(await done(ctx, reloads(OK)))
    expect(unchanged).toEqual({ kind: 'ended', plugin: 'plug', source, from: approved, ended: 'done', approved, folder: approved })
    expect(workFinishedLine(unchanged)).toBe(`plug keeps its approved version (${shortVersion(approved)}); its folder holds no change.`)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    rmSync(source, { recursive: true })
    const host = reloads(OK)
    const gone = ended(await done(ctx, host))
    expect(gone).toMatchObject({ approved, load: { kind: 'loaded', version: approved } })
    expect(gone.folder).toBeUndefined()
    expect(gone.entry).toBeUndefined()
    expect(host.calls()).toBe(1)
    expect(await active(fx)).toEqual({ index: 'export default "one"\n', record: { version: approved, kind: 'approved' } })
    expect(workFinishedLine(gone)).toBe(`The folder of plug is gone; plug keeps its approved version (${shortVersion(approved)}).`)
  })

  it('approves the version it showed when Delo is not running, and refuses a plugin without an open session', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    await rejection(reviewWork(ctx, 'plug'), 'NO_WORK_SESSION')
    await rejection(finishWork(ctx, 'plug', terminal(), { ...reloads(OK), approve: undefined }), 'NO_WORK_SESSION')
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    await rejection(finishWork(ctx, 'other', terminal(), { ...reloads(OK), approve: undefined }), 'NO_WORK_SESSION')
    const two = await edit(fx, source, 'export default "two"\n')
    expect(ended(await done(ctx, reloads(undefined)))).toMatchObject({ approved: two, load: { kind: 'not-running' } })
  })
})

describe('ending a work session without the person approves nothing new', () => {
  it('Delo stopping keeps the version the session started from, and the folder\'s state waits for review', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    expect(await finishWorkWithoutPerson(ctx, 'stopped')).toBeUndefined()
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const two = await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    const historyBefore = await history(fx)
    const finished = await finishWorkWithoutPerson(ctx, 'stopped')
    expect(finished).toEqual({ kind: 'ended', plugin: 'plug', source, from: approved, ended: 'stopped', approved })
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
    expect(await history(fx)).toEqual(historyBefore)
    expect(await active(fx)).toEqual({ index: 'export default "one"\n', record: { version: approved, kind: 'approved' } })
    expect((await listChanges(ctx)).pending).toMatchObject([{ kind: 'plugin-edit', from: approved, to: two }])
    expect(await readWorkSession(fx.home, PROFILE)).toBeUndefined()
    expect(workFinishedLine(finished!)).toBe(`Nothing was approved: plug keeps the version it had when the session started (${shortVersion(approved)}), and what its folder holds waits for your review: delorun changes list`)
  })

  it('keeps the version the session started from when the folder\'s newest content failed to load, and forgets the failure', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    await edit(fx, source, 'throw new Error("broken")\n')
    await loadWorkSession(ctx, reloads(failing('plug threw'), OK).reload)
    expect(await finishWorkWithoutPerson(ctx, 'stopped')).toMatchObject({ approved, ended: 'stopped' })
    expect(existsSync(workFailurePath(fx.home, PROFILE))).toBe(false)
    expect(existsSync(changesDirectory(fx.home))).toBe(true)
  })

  it('a session past its end keeps the version it started from, and the running Host goes back to it', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    const { session } = await startWork(ctx, 'plug', terminal(), reloads(OK))
    await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    const notYet = reloads(OK)
    expect(await finishWorkWithoutPerson({ ...ctx, now: () => new Date(Date.parse(session.endsAt) - 1) }, 'expired', notYet.reload)).toBeUndefined()
    expect(notYet.calls()).toBe(0)
    const host = reloads(OK)
    const finished = await finishWorkWithoutPerson({ ...ctx, now: () => new Date(session.endsAt) }, 'expired', host.reload)
    expect(finished).toEqual({ kind: 'ended', plugin: 'plug', source, from: approved, ended: 'expired', approved, reload: OK })
    expect(host.calls()).toBe(1)
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
    expect(await active(fx)).toEqual({ index: 'export default "one"\n', record: { version: approved, kind: 'approved' } })
    expect(await readWorkSession(fx.home, PROFILE)).toBeUndefined()
    expect((await readChangeLog(fx.home, PROFILE)).entries.filter(entry => entry.kind === 'plugin-edit')).toEqual([])
  })
})

describe('a work session ends at its bound', () => {
  it('records its end and loads nothing once the end passed', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    const { session } = await startWork(ctx, 'plug', terminal(), { ...reloads(OK), minutes: 30 })
    expect(Date.parse(session.endsAt) - Date.parse(session.startedAt)).toBe(30 * 60_000)
    expect(workSessionExpired({ now: () => new Date(session.startedAt) }, session)).toBe(false)
    expect(workSessionExpired({}, { endsAt: new Date(Date.now() - 1).toISOString() })).toBe(true)
    await edit(fx, source, 'export default "two"\n')
    const late = { ...ctx, now: () => new Date(session.endsAt) }
    const host = reloads(OK)
    expect(await loadWorkSession(late, host.reload)).toEqual({ kind: 'expired', plugin: 'plug', endsAt: session.endsAt })
    expect(host.calls()).toBe(0)
    expect((await active(fx)).index).toBe('export default "one"\n')
  })

  it('a start after a work session\'s end loads nothing from the folder', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    const { session } = await startWork(ctx, 'plug', terminal(), reloads(OK))
    const two = await edit(fx, source, 'export default "two"\n')
    // A start that does not end open sessions first, as `delorun headless` starts, at the session's end time.
    const changes = await enforceApprovedContent({ home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => new Date(session.endsAt) })
    expect(await active(fx)).toEqual({ index: 'export default "one"\n', record: { version: approved, kind: 'approved' } })
    expect(await readWorkSession(fx.home, PROFILE)).toBeUndefined()
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(approved)
    expect(changes.workSession).toBeUndefined()
    expect(changes.workEnded).toEqual({ kind: 'ended', plugin: 'plug', source, from: approved, ended: 'expired', approved })
    expect(changes.pending).toEqual([{ id: changeId('plugin-edit', { plugin: 'plug', source }, approved, two), plugin: 'plug', kind: 'plugin-edit' }])
    expect(startNotice(changes).split('\n')[0]).toBe(`Your work session on plug ended at its time limit. ${workFinishedLine(changes.workEnded!)}`)
  })

  it('refuses a length outside 1 to the maximum before anything is read or written', async () => {
    const { fx } = await migrated()
    const ctx = contextOf(fx)
    const before = written(fx)
    for (const minutes of [0, WORK_SESSION_MAX_MINUTES + 1, 1.5]) {
      const host = { ...reloads(OK), minutes }
      const error = await rejection(startWork(ctx, 'plug', terminal(), host), 'NOT_ALLOWED')
      expect(error.detail).toBe(`A work session lasts from 1 to ${String(WORK_SESSION_MAX_MINUTES)} minutes, so ${String(minutes)} minutes is not allowed.`)
      expect(host.calls()).toBe(0)
    }
    expect(written(fx)).toBe(before)
    expect((await startWork(ctx, 'plug', terminal(), { ...reloads(OK), minutes: 1 })).session.plugin).toBe('plug')
  })
})
