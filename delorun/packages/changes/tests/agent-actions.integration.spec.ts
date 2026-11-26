/**
 * The agent's `plugin_manager` actions that ran with protection off: each is recorded in the agent-action log before the
 * tool runs and completed after it, as an applied change decided `unreviewed` with the history version upstream wrote and
 * the one before it, and `log.json` stays as a release without the agent log reads it; undoing one brings back the files
 * plugin management writes as the version before it held them, keeps what the person edited and the safety record's
 * disabled plugins, and refuses when a later change follows or the install or the reload fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { openHistory, writeSafetyRecord } from '@delorun/profile-safety'
import { describe, expect, it, vi } from 'vitest'
import { undoChange } from '../src/actions.ts'
import { beginAgentAction, finishAgentAction, isAgentAction, planAgentAction, undoAgentAction, type AgentCall } from '../src/agent-actions.ts'
import { parseChangeId } from '../src/ids.ts'
import type { PluginOperation } from '../src/install-actions.ts'
import { listChanges } from '../src/actions.ts'
import { newestLeavableChange } from '../src/left-out.ts'
import { readAgentLog, readChangeLog, writeChangeLog } from '../src/records.ts'
import { CHANGE_LOG_SCHEMA, type ChangeEntry, type ChangeId } from '../src/types.ts'
import { fixture, history, NOW, PROFILE, terminal, type Fixture } from './profile-fixture.ts'
import { rejection } from './support.ts'

vi.setConfig({ testTimeout: 60_000 })

/**
 * @param fx - the fixture.
 * @returns the context the actions take.
 */
function context(fx: Fixture) {
  return { home: fx.home, profile: PROFILE, profileDir: fx.profileDir, now: () => NOW }
}

/**
 * Save the profile as a version, as upstream's manager saves one after a change.
 * @param fx - the fixture.
 * @param summary - the version's subject.
 * @param by - who made it; the agent in a chat by default.
 * @returns its id.
 */
async function save(fx: Fixture, summary: string, by: 'agent' | 'person' | 'outside' = 'agent'): Promise<string | undefined> {
  return openHistory({ profileDir: fx.profileDir }).record(summary, by === 'agent' ? { kind: 'agent', sessionId: 'chat' } : { kind: by })
}

/**
 * Change the profile as an install does: a dependency in the manifest and a new lockfile.
 * @param fx - the fixture.
 * @param name - the dependency.
 */
function addDependency(fx: Fixture, name: string): void {
  const path = join(fx.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies[name] = '^2.0.0'
  writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(fx.profileDir, 'pnpm-lock.yaml'), `${readFileSync(join(fx.profileDir, 'pnpm-lock.yaml'), 'utf8')}# ${name}\n`)
}

/**
 * Run an agent action the way the tool listeners do: plan, record before, change the profile, save the version, finish.
 * @param fx - the fixture.
 * @param call - what the agent called.
 * @param change - the profile change the action makes.
 * @param options - `save: false` for a change whose version could not be saved; `outside` for an edit the manager saves as its own version first.
 * @param options.save - whether the version is saved.
 * @param options.outside - an edit the person made by hand, which the manager saves before the change.
 * @returns the recorded entry, or undefined.
 */
async function ran(fx: Fixture, call: AgentCall, change: () => void | Promise<void>, options: { readonly save?: boolean, readonly outside?: () => void } = {}) {
  const plan = await planAgentAction(context(fx), call)
  const id = await beginAgentAction(context(fx), plan)
  if (options.outside !== undefined) {
    options.outside()
    await save(fx, 'Edited outside plugin management', 'outside')
  }
  await change()
  if (options.save !== false) await save(fx, `agent ${call.action}`)
  return (await finishAgentAction(context(fx), plan, id)).entry
}

/** An operation that succeeds and keeps its arguments. */
function succeeding(): PluginOperation & { readonly calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  return Object.assign(async (args: readonly string[]) => {
    calls.push(args)
    return { exitCode: 0 }
  }, { calls })
}

const RELOADED = async () => ({ ok: true as const })

/** The kinds and fields a `log.json` entry may hold in the release before the agent log, which refuses any other. */
const RELEASE_2_1_KINDS = ['plugin-edit', 'plugin-install', 'plugin-update', 'plugin-remove', 'plugin-off', 'plugin-on', 'harness-edit', 'guard-weakening']
const RELEASE_2_1_ENTRY_FIELDS = ['id', 'kind', 'state', 'subject', 'from', 'to', 'summary', 'createdAt', 'decidedAt', 'decidedFrom', 'decidedOn', 'historyVersion', 'leftOut', 'shownAt', 'lastFailure']

describe('recording an agent action', () => {
  it('records each kind of action as applied and unreviewed with the version it wrote and the one before it', async () => {
    const fx = fixture({ protection: 'off' })
    const start = await save(fx, 'profile before the agent')
    const install = await ran(fx, { action: 'install_bundle', target: 'new-plugin@2.0.0' }, () => addDependency(fx, 'new-plugin'))
    expect(install).toMatchObject({ kind: 'plugin-install', state: 'applied', decidedFrom: 'unreviewed', decidedAt: NOW.toISOString(), historyBefore: start, subject: { plugin: 'new-plugin', spec: 'new-plugin@2.0.0' }, summary: 'The agent ran: install new-plugin@2.0.0' })
    const update = await ran(fx, { action: 'install_bundle', target: 'left-pad@2.0.0' }, () => addDependency(fx, 'left-pad'))
    expect(update).toMatchObject({ kind: 'plugin-update', historyBefore: install!.historyVersion })
    const removal = await ran(fx, { action: 'remove_bundle', target: 'new-plugin' }, () => addDependency(fx, 'gone'))
    expect(removal).toMatchObject({ kind: 'plugin-remove', subject: { plugin: 'new-plugin', spec: 'new-plugin' } })
    const on = await ran(fx, { action: 'set_bundle', target: 'new-plugin', enabled: true }, () => addDependency(fx, 'one'))
    expect(on).toMatchObject({ kind: 'plugin-setting-change', subject: { plugin: 'new-plugin', setting: 'set_bundle' }, summary: 'The agent turned on new-plugin' })
    const off = await ran(fx, { action: 'set_plugin', target: 'new-plugin/entry', enabled: false }, () => addDependency(fx, 'two'))
    expect(off).toMatchObject({ kind: 'plugin-setting-change', subject: { setting: 'set_plugin' }, summary: 'The agent turned off new-plugin/entry' })
    const undo = await ran(fx, { action: 'undo' }, () => addDependency(fx, 'three'))
    expect(undo).toMatchObject({ kind: 'plugin-setting-change', subject: { setting: 'undo' }, summary: 'The agent ran undo on the profile' })
    const refusedRemoval = await ran(fx, { action: 'remove_bundle', target: 'not-a-dependency' }, () => addDependency(fx, 'four'))
    expect(refusedRemoval).toMatchObject({ kind: 'plugin-setting-change', subject: { plugin: 'not-a-dependency', setting: 'remove_bundle' } })
    const log = await readAgentLog(fx.home, PROFILE)
    expect(log.entries).toHaveLength(7)
    expect(log.entries.every(isAgentAction)).toBe(true)
    expect(new Set(log.entries.map(entry => entry.id)).size).toBe(7)
  })

  it('removes the entry written before the action when the action changed nothing', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    expect(await ran(fx, { action: 'set_bundle', target: 'p', enabled: false }, () => undefined)).toBeUndefined()
    expect((await readAgentLog(fx.home, PROFILE)).entries).toEqual([])
  })

  it('gives a repeated action a new entry each time', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const first = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => addDependency(fx, 'a'))
    const second = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => addDependency(fx, 'b'))
    expect(second!.id).not.toBe(first!.id)
  })
})

describe('the agent-action log beside log.json', () => {
  it('leaves log.json byte for byte as it was, with only what the release before the agent log reads', async () => {
    const fx = fixture({ protection: 'off' })
    const person: ChangeEntry = { id: 'c00000000ff' as ChangeId, kind: 'plugin-install', state: 'pending', subject: { plugin: 'asked', spec: 'asked' }, summary: 'The agent asks to install asked', createdAt: NOW.toISOString() }
    await writeChangeLog(fx.home, PROFILE, { schema: CHANGE_LOG_SCHEMA, entries: [person] })
    const path = join(fx.home, 'changes', 'profiles', PROFILE, 'log.json')
    const before = readFileSync(path, 'utf8')
    await save(fx, 'profile before the agent')
    await ran(fx, { action: 'install_bundle', target: 'new-plugin@2.0.0' }, () => addDependency(fx, 'new-plugin'))
    await ran(fx, { action: 'set_bundle', target: 'new-plugin', enabled: true }, () => addDependency(fx, 'one'))
    expect(readFileSync(path, 'utf8')).toBe(before)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, unknown>[] }
    for (const entry of raw.entries) {
      expect(RELEASE_2_1_KINDS).toContain(entry.kind)
      for (const field of Object.keys(entry)) expect(RELEASE_2_1_ENTRY_FIELDS).toContain(field)
    }
    expect((await readAgentLog(fx.home, PROFILE)).entries.map(entry => entry.kind)).toEqual(['plugin-install', 'plugin-setting-change'])
  })

  it('is listed and shown with the change log\'s entries, and undone by id', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const entry = await ran(fx, { action: 'install_bundle', target: 'new-plugin@2.0.0' }, () => addDependency(fx, 'new-plugin'))
    expect((await listChanges(context(fx))).entries).toEqual([entry])
  })

  it('fails loud for Changes when it is corrupt, and never for what a start reads', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    mkdirSync(join(fx.home, 'changes', 'profiles', PROFILE), { recursive: true, mode: 0o700 })
    writeFileSync(join(fx.home, 'changes', 'profiles', PROFILE, 'agent-log.json'), '{"schema":"delorun.changes-agent-log/1","entries":[{"id":"c0000000001"}]}\n', { mode: 0o600 })
    expect((await readChangeLog(fx.home, PROFILE)).entries).toEqual([])
    await rejection(readAgentLog(fx.home, PROFILE), 'RECORD_UNREADABLE')
    await rejection(listChanges(context(fx)), 'RECORD_UNREADABLE')
    await rejection(planAgentAction(context(fx), { action: 'install_bundle', target: 'new-plugin' }), 'RECORD_UNREADABLE')
    expect(await newestLeavableChange(context(fx))).toBeUndefined()
  })

  it('refuses an entry kind or field the log has not declared', async () => {
    const fx = fixture({ protection: 'off' })
    mkdirSync(join(fx.home, 'changes', 'profiles', PROFILE), { recursive: true, mode: 0o700 })
    const path = join(fx.home, 'changes', 'profiles', PROFILE, 'agent-log.json')
    const entry = { id: 'c0000000001', kind: 'plugin-setting-change', state: 'applied', subject: {}, summary: 's', createdAt: NOW.toISOString() }
    writeFileSync(path, `${JSON.stringify({ schema: 'delorun.changes-agent-log/1', entries: [{ ...entry, extra: 1 }] })}\n`, { mode: 0o600 })
    await rejection(readAgentLog(fx.home, PROFILE), 'RECORD_UNREADABLE')
    writeFileSync(path, `${JSON.stringify({ schema: 'delorun.changes-agent-log/2', entries: [entry] })}\n`, { mode: 0o600 })
    await rejection(readAgentLog(fx.home, PROFILE), 'RECORD_UNREADABLE')
    writeFileSync(path, `${JSON.stringify({ schema: 'delorun.changes-agent-log/1', entries: [{ ...entry, kind: 'plugin-setting-change', historyBefore: 'a'.repeat(40) }] })}\n`, { mode: 0o600 })
    expect((await readAgentLog(fx.home, PROFILE)).entries).toHaveLength(1)
  })
})

describe('what is recorded around the tool', () => {
  it('writes the entry before the action runs, saying Delorun has not seen how it ended', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const plan = await planAgentAction(context(fx), { action: 'install_bundle', target: 'new-plugin@2.0.0' })
    await beginAgentAction(context(fx), plan)
    const [entry] = (await readAgentLog(fx.home, PROFILE)).entries
    expect(entry).toMatchObject({ kind: 'plugin-install', state: 'applied', decidedFrom: 'unreviewed' })
    expect(entry!.summary).toBe('The agent ran: install new-plugin@2.0.0; Delorun did not see how it ended, so check what it changed with delorun changes list and delorun recover')
    expect(entry!.historyVersion).toBeUndefined()
    await rejection(undoAgentAction(context(fx), entry!.id, terminal(), { reload: RELOADED, run: succeeding() }), 'NOT_ALLOWED')
  })

  it('keeps an action whose version could not be saved, and says so', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const plan = await planAgentAction(context(fx), { action: 'configure', target: 'new-plugin' })
    const id = await beginAgentAction(context(fx), plan)
    addDependency(fx, 'new-plugin')
    const finished = await finishAgentAction(context(fx), plan, id)
    expect(finished.unsaved).toBe(true)
    expect(finished.entry).toMatchObject({ id, summary: 'The agent ran configure on new-plugin' })
    expect(finished.entry!.historyVersion).toBeUndefined()
  })

  it('does not tell which version is whose when two actions wrote versions at once', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const plan = await planAgentAction(context(fx), { action: 'install_bundle', target: 'a-plugin' })
    const id = await beginAgentAction(context(fx), plan)
    addDependency(fx, 'a-plugin')
    await save(fx, 'one chat')
    addDependency(fx, 'b-plugin')
    await save(fx, 'another chat')
    const finished = await finishAgentAction(context(fx), plan, id)
    expect(finished).toMatchObject({ unsaved: false, entry: { id } })
    expect(finished.entry!.historyVersion).toBeUndefined()
  })

  it('records no version before it when the person\'s own change lies between', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const plan = await planAgentAction(context(fx), { action: 'install_bundle', target: 'a-plugin' })
    const id = await beginAgentAction(context(fx), plan)
    addDependency(fx, 'by-the-person')
    await save(fx, 'Saved by you', 'person')
    addDependency(fx, 'a-plugin')
    await save(fx, 'agent install')
    const finished = await finishAgentAction(context(fx), plan, id)
    expect(finished.entry!.historyVersion).toBeDefined()
    expect(finished.entry!.historyBefore).toBeUndefined()
  })

  it('refuses to finish an entry that is gone', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const plan = await planAgentAction(context(fx), { action: 'install_bundle', target: 'a-plugin' })
    await rejection(finishAgentAction(context(fx), plan, parseChangeId('c0000000000')!), 'UNKNOWN_CHANGE')
  })

  it('quotes a target that is not a package name on one line and cuts it', async () => {
    const fx = fixture({ protection: 'off' })
    const plan = await planAgentAction(context(fx), { action: 'configure', target: `line one\nline two ${'x'.repeat(100)}` })
    expect(plan.summary).toBe(`The agent ran configure on "line one line two ${'x'.repeat(42)}…"`)
  })
})

describe('what an undo of an agent action leaves alone', () => {
  it('keeps an edit the person made by hand before the action', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent', 'person')
    const entry = await ran(fx, { action: 'install_bundle', target: 'new-plugin@2.0.0' }, () => addDependency(fx, 'new-plugin'), { outside: () => addDependency(fx, 'by-hand') })
    expect(entry!.historyBefore).toBeDefined()
    await undoAgentAction(context(fx), entry!.id, terminal(), { reload: RELOADED, run: succeeding() })
    expect(Object.keys(JSON.parse(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')).dependencies)).toEqual(['left-pad', 'by-hand'])
  })

  it('keeps the home patch the person edited since, and the profile\'s copy of it', async () => {
    const fx = fixture({ protection: 'off' })
    writeFileSync(join(fx.profileDir, 'home-cordis.patch.yml'), '# old home patch\n')
    writeFileSync(join(fx.home, 'cordis.patch.yml'), '# old home patch\n')
    await save(fx, 'profile before the agent', 'person')
    const entry = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => addDependency(fx, 'new-plugin'))
    writeFileSync(join(fx.home, 'cordis.patch.yml'), '# edited since\n')
    await undoAgentAction(context(fx), entry!.id, terminal(), { reload: RELOADED, run: succeeding() })
    expect(readFileSync(join(fx.home, 'cordis.patch.yml'), 'utf8')).toBe('# edited since\n')
    expect(readFileSync(join(fx.profileDir, 'home-cordis.patch.yml'), 'utf8')).toBe('# old home patch\n')
  })

  it('keeps a plugin the safety record keeps disabled disabled', async () => {
    const fx = fixture({ protection: 'off' })
    const path = join(fx.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    manifest.dsh.profile.bundles = ['revoked-bundle', 'good-bundle']
    writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
    await save(fx, 'profile before the agent', 'person')
    const entry = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => {
      addDependency(fx, 'new-plugin')
      const revoked = JSON.parse(readFileSync(path, 'utf8')) as typeof manifest
      revoked.dsh.profile.bundles = ['good-bundle']
      writeFileSync(path, `${JSON.stringify(revoked, undefined, 2)}\n`)
    })
    await writeSafetyRecord(fx.profileDir, { schema: 'delorun.profile-safety/1', ejected: [], disabled: [{ name: 'revoked-bundle', version: '1.0.0', reason: 'revoked', message: 'revoked for a reason' }] })
    await undoAgentAction(context(fx), entry!.id, terminal(), { reload: RELOADED, run: succeeding() })
    expect((JSON.parse(readFileSync(path, 'utf8')) as typeof manifest).dsh.profile.bundles).toEqual(['good-bundle'])
  })

  it('waits for the profile write lock', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const entry = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => addDependency(fx, 'new-plugin'))
    const before = readFileSync(join(fx.profileDir, 'package.json'), 'utf8')
    // Another task holds the lock: the undo runs outside its call chain, where the lock is not reentrant, so it waits and fails.
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered = (): void => {}
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const holder = withFileLock(join(fx.profileDir, 'package.json'), async () => { entered(); await gate })
    await inside
    await expect(undoAgentAction({ ...context(fx), lockWaitMs: 50 }, entry!.id, terminal(), { reload: RELOADED, run: succeeding() })).rejects.toThrow()
    release()
    await holder
    expect(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')).toBe(before)
  })
})

describe('undoAgentAction', () => {
  it('brings the version before the action back, installs its dependencies, records a version and reloads', async () => {
    const fx = fixture({ protection: 'off' })
    const lockBefore = readFileSync(join(fx.profileDir, 'pnpm-lock.yaml'), 'utf8')
    await save(fx, 'profile before the agent')
    const entry = await ran(fx, { action: 'install_bundle', target: 'new-plugin@2.0.0' }, () => addDependency(fx, 'new-plugin'))
    const run = succeeding()
    const reload = vi.fn(RELOADED)
    const result = await undoAgentAction(context(fx), entry!.id, terminal(), { reload, run })
    expect(readFileSync(join(fx.profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(lockBefore)
    expect(JSON.parse(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')).dependencies).toEqual({ 'left-pad': '^1.3.0' })
    expect(run.calls).toEqual([['install', '--ignore-scripts'], ['rebuild', '--pending']])
    expect(reload).toHaveBeenCalledTimes(1)
    expect(result.reload).toEqual({ kind: 'reloaded' })
    expect(result.entry).toMatchObject({ id: entry!.id, state: 'undone', decidedFrom: 'terminal' })
    expect((await history(fx))[0]).toBe(`Undid: ${entry!.summary}`)
    expect((await readAgentLog(fx.home, PROFILE)).entries).toEqual([result.entry])
  })

  it('is what undoChange does for such an entry, and needs the plugin operation', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const entry = await ran(fx, { action: 'set_bundle', target: 'new-plugin', enabled: true }, () => addDependency(fx, 'x'))
    await rejection(undoChange(context(fx), entry!.id, terminal(), { reload: RELOADED }), 'NOT_ALLOWED')
    const run = succeeding()
    const undone = await undoChange(context(fx), entry!.id, terminal(), { reload: RELOADED, run })
    expect(undone.entry.state).toBe('undone')
  })

  it('refuses once a later change of the profile follows, and an action already undone', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const first = await ran(fx, { action: 'install_bundle', target: 'a-plugin' }, () => addDependency(fx, 'a-plugin'))
    await ran(fx, { action: 'install_bundle', target: 'b-plugin' }, () => addDependency(fx, 'b-plugin'))
    const before = readFileSync(join(fx.profileDir, 'package.json'), 'utf8')
    await rejection(undoAgentAction(context(fx), first!.id, terminal(), { reload: RELOADED, run: succeeding() }), 'NOT_ALLOWED')
    expect(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')).toBe(before)
    const log = await readAgentLog(fx.home, PROFILE)
    await undoAgentAction(context(fx), log.entries[1]!.id, terminal(), { reload: RELOADED, run: succeeding() })
    await undoAgentAction(context(fx), first!.id, terminal(), { reload: RELOADED, run: succeeding() })
    await rejection(undoAgentAction(context(fx), first!.id, terminal(), { reload: RELOADED, run: succeeding() }), 'NOT_ALLOWED')
  })

  it('refuses an action with no earlier version, an id the log does not hold and a change that is not the agent\'s', async () => {
    const fx = fixture({ protection: 'off' })
    const entry = await ran(fx, { action: 'install_bundle', target: 'a-plugin' }, () => addDependency(fx, 'a-plugin'))
    expect(entry!.historyBefore).toBeUndefined()
    await rejection(undoAgentAction(context(fx), entry!.id, terminal(), { reload: RELOADED, run: succeeding() }), 'NOT_ALLOWED')
    await rejection(undoAgentAction(context(fx), parseChangeId('c0000000000')!, terminal(), { reload: RELOADED, run: succeeding() }), 'UNKNOWN_CHANGE')
  })

  it('puts the files back and keeps the change applied when the install fails', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const entry = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => addDependency(fx, 'new-plugin'))
    const after = readFileSync(join(fx.profileDir, 'package.json'), 'utf8')
    const failing: PluginOperation = vi.fn(async () => ({ exitCode: 1, failure: 'pnpm said no' }))
    await rejection(undoAgentAction(context(fx), entry!.id, terminal(), { reload: RELOADED, run: failing }), 'OPERATION_FAILED')
    expect(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')).toBe(after)
    expect((await readAgentLog(fx.home, PROFILE)).entries).toEqual([entry])
  })

  it('goes back and keeps the change applied with the failure when the Host fails to load the undo', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const entry = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => addDependency(fx, 'new-plugin'))
    const after = readFileSync(join(fx.profileDir, 'package.json'), 'utf8')
    const reload = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'a plugin failed to start' })
      .mockResolvedValueOnce({ ok: true })
    const result = await undoAgentAction(context(fx), entry!.id, terminal(), { reload, run: succeeding() })
    expect(result.reload).toMatchObject({ kind: 'went-back', failure: 'a plugin failed to start', again: { ok: true } })
    expect(result.entry).toMatchObject({ id: entry!.id, state: 'applied', lastFailure: { failure: 'a plugin failed to start' } })
    expect(readFileSync(join(fx.profileDir, 'package.json'), 'utf8')).toBe(after)
  })

  it('reports Delorun not running when no Host answers the reload', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const entry = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => addDependency(fx, 'new-plugin'))
    const result = await undoAgentAction(context(fx), entry!.id, terminal(), { reload: async () => undefined, run: succeeding() })
    expect(result.reload).toEqual({ kind: 'not-running' })
  })
})
