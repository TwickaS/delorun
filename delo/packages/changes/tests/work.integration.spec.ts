/**
 * Work sessions (contract C21, "Work sessions"): starting one loads the folder's content live, a failed load goes back
 * to the content that last loaded, ending one makes the folder's state the approved version as one history entry, and
 * only a person at their computer starts or ends one; Delo stopping ends it without a person.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { finishWork, listChanges, startWork, type ChangesContext, type ReloadHost, type ReloadOutcome } from '../src/actions.ts'
import { changeId } from '../src/ids.ts'
import * as barrel from '../src/index.ts'
import { activeDirectory, changesDirectory, profileChangesDirectory, versionsDirectory } from '../src/paths.ts'
import { attestStudio, readActiveRecord, readApproved, readChangeLog, readWorkSession, writeActiveRecord, type AtComputer } from '../src/records.ts'
import { finishWorkWithoutPerson } from '../src/stop.ts'
import { holdsVersion, storeFolder } from '../src/store.ts'
import type { ContentVersion } from '../src/types.ts'
import { loadWorkSession, workFinishedLine, type WorkFinished } from '../src/work.ts'
import { readWorkFailure, workFailurePath, writeWorkFailure } from '../src/work-record.ts'
import { folder, history, linkAs, migrated, NOW, PROFILE, start, terminal, type Fixture } from './profile-fixture.ts'
import { rejection } from './support.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 120_000 })

const OK: ReloadOutcome = { ok: true }

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
 * @returns the options of an action and the number of calls.
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
  it('refuses a missing, a forged and a look-alike studio proof before anything is read or written', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    const host = reloads(OK)
    const before = written(fx)
    const stored = readdirSync(versionsDirectory(fx.home))
    for (const proof of [undefined as never, { kind: 'terminal' } as AtComputer, Object.freeze({ kind: 'studio' }) as AtComputer]) {
      await rejection(startWork(ctx, 'plug', proof, host), 'NOT_AT_COMPUTER')
      await rejection(finishWork(ctx, 'plug', proof, host), 'NOT_AT_COMPUTER')
    }
    expect(() => attestStudio({ loopback: true, credential: true, remoteSession: true })).toThrow(expect.objectContaining({ code: 'NOT_AT_COMPUTER' }))
    expect(written(fx)).toBe(before)
    expect(readdirSync(versionsDirectory(fx.home))).toEqual(stored)
    expect(host.calls()).toBe(0)
  })

  it('refuses a forged proof for ending an open session, which stays open', async () => {
    const { fx } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const host = reloads(OK)
    await rejection(finishWork(ctx, 'plug', { kind: 'studio' } as AtComputer, host), 'NOT_AT_COMPUTER')
    expect((await readWorkSession(fx.home, PROFILE))?.plugin).toBe('plug')
    expect(host.calls()).toBe(0)
  })

  it('accepts the studio on this computer, and records where the session started', async () => {
    const { fx } = await migrated()
    const started = await startWork(contextOf(fx), 'plug', attestStudio({ loopback: true, credential: true, remoteSession: false }), reloads(OK))
    expect(started.session.startedFrom).toBe('studio')
  })

  it('exports the end without a person only from @delo/changes/stop', () => {
    expect(Object.keys(barrel)).toEqual(expect.arrayContaining(['startWork', 'finishWork', 'loadWorkSession']))
    for (const name of ['finishWorkWithoutPerson', 'beginWork', 'endWork']) expect(Object.keys(barrel)).not.toContain(name)
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
    await finishWork(ctx, 'plug', terminal(), reloads(OK))
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

describe('done makes the folder\'s state the approved version as one history entry', () => {
  it('approves what the folder holds, records the whole difference since the session began once, and closes the session', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    const historyBefore = await history(fx)
    const started = await startWork(ctx, 'plug', terminal(), reloads(OK))
    await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    const three = await edit(fx, source, 'export default "three"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    const host = reloads(OK)
    const finished = await finishWork(ctx, 'plug', terminal(), host)
    expect(host.calls()).toBe(0)
    const subject = { plugin: 'plug', source }
    const summary = `Work on plug: ${approved.slice(0, 7)} → ${three.slice(0, 7)}`
    expect(finished).toEqual({
      plugin: 'plug',
      source,
      from: approved,
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
    expect(workFinishedLine(finished)).toBe(`The folder's content is now the approved version of plug (${finished.entry!.id}).`)
  })

  it('loads content the Host has not loaded yet first', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const two = await edit(fx, source, 'export default "two"\n')
    const host = reloads(OK)
    const finished = await finishWork(ctx, 'plug', terminal(), host)
    expect(finished.load).toEqual({ kind: 'loaded', plugin: 'plug', version: two })
    expect(finished.approved).toBe(two)
    expect(host.calls()).toBe(1)
  })

  it('approves the content that last loaded when the folder\'s newest content failed to load, and says so', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const two = await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    const broken = await edit(fx, source, 'throw new Error("broken")\n')
    await loadWorkSession(ctx, reloads(failing('plug threw'), OK).reload)
    const host = reloads(OK)
    const finished = await finishWork(ctx, 'plug', terminal(), host)
    expect(host.calls()).toBe(0)
    expect(finished).toMatchObject({ approved: two, folder: broken, kept: 'failed-to-load' })
    expect((await readApproved(fx.profileDir)).plugins.plug?.version).toBe(two)
    expect(await readWorkFailure(fx.home, PROFILE)).toMatchObject({ plugin: 'plug', error: 'plug threw' })
    expect(workFinishedLine(finished)).toBe('The newest content of plug\'s folder failed to load, so the content that last loaded is now the approved version of plug.')
  })

  it('keeps the approved content when the last load before the end fails and nothing else loaded, recording no change', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const historyBefore = await history(fx)
    const broken = await edit(fx, source, 'throw new Error("broken")\n')
    const finished = await finishWork(ctx, 'plug', terminal(), reloads(failing('plug threw'), OK))
    expect(finished).toMatchObject({ approved, folder: broken, kept: 'failed-to-load', load: { kind: 'went-back' } })
    expect(finished.entry).toBeUndefined()
    expect(await history(fx)).toEqual(historyBefore)
    expect(await active(fx)).toEqual({ index: 'export default "one"\n', record: { version: approved, kind: 'approved' } })
  })

  it('keeps the approved content when the folder failed to load when the session started and nothing loaded since', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    const broken = await edit(fx, source, 'throw new Error("broken")\n')
    await startWork(ctx, 'plug', terminal(), reloads(failing('plug threw'), OK))
    const finished = await finishWork(ctx, 'plug', terminal(), reloads(OK))
    expect(finished).toMatchObject({ approved, folder: broken, kept: 'failed-to-load' })
    expect(finished.entry).toBeUndefined()
  })

  it('approves the content that last loaded when the folder is gone, and records nothing when nothing changed', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const unchanged = await finishWork(ctx, 'plug', terminal(), reloads(OK))
    expect(unchanged).toEqual({ plugin: 'plug', source, from: approved, approved, folder: approved })
    expect(workFinishedLine(unchanged)).toBe('plug runs its approved version; its folder holds no change.')
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    const two = await edit(fx, source, 'export default "two"\n')
    await loadWorkSession(ctx, reloads(OK).reload)
    rmSync(source, { recursive: true })
    const gone = await finishWork(ctx, 'plug', terminal(), reloads(OK))
    expect(gone).toMatchObject({ approved: two, kept: 'folder-gone' })
    expect(gone.folder).toBeUndefined()
    expect(workFinishedLine(gone)).toBe('The folder of plug is gone, so the content that last loaded is now the approved version of plug.')
  })

  it('approves the folder\'s content when Delo is not running, and refuses a plugin without an open session', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    await rejection(finishWork(ctx, 'plug', terminal(), reloads(OK)), 'NO_WORK_SESSION')
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    await rejection(finishWork(ctx, 'other', terminal(), reloads(OK)), 'NO_WORK_SESSION')
    const two = await edit(fx, source, 'export default "two"\n')
    const finished = await finishWork(ctx, 'plug', terminal(), reloads(undefined))
    expect(finished).toMatchObject({ approved: two, load: { kind: 'not-running' } })
  })
})

describe('Delo stopping ends the work session', () => {
  it('approves what the folder holds without a person, decided where the session started, and loads nothing', async () => {
    const { fx, source } = await migrated()
    const ctx = contextOf(fx)
    expect(await finishWorkWithoutPerson(ctx)).toBeUndefined()
    await startWork(ctx, 'plug', attestStudio({ loopback: true, credential: true, remoteSession: false }), reloads(OK))
    const two = await edit(fx, source, 'export default "two"\n')
    const finished: WorkFinished | undefined = await finishWorkWithoutPerson(ctx)
    expect(finished).toMatchObject({ approved: two, entry: { kind: 'plugin-edit', state: 'applied', to: two, decidedFrom: 'studio' } })
    expect(finished?.load).toBeUndefined()
    expect(await readWorkSession(fx.home, PROFILE)).toBeUndefined()
    expect(await holdsVersion(activeDirectory(fx.home, PROFILE, 'plug'), two)).toBe(true)
  })

  it('approves the content that last loaded when the folder\'s newest content failed to load', async () => {
    const { fx, source, approved } = await migrated()
    const ctx = contextOf(fx)
    await startWork(ctx, 'plug', terminal(), reloads(OK))
    await edit(fx, source, 'throw new Error("broken")\n')
    await loadWorkSession(ctx, reloads(failing('plug threw'), OK).reload)
    expect(await finishWorkWithoutPerson(ctx)).toMatchObject({ approved, kept: 'failed-to-load' })
    expect(existsSync(changesDirectory(fx.home))).toBe(true)
  })
})
