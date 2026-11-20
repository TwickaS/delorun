/**
 * The agent's `plugin_manager` actions that ran with protection off: each that changed the profile is recorded as an
 * applied change decided `unreviewed`, with the history version upstream wrote and the one before it; undoing one brings
 * the version before it back with the history restore, installs that dependency set, and refuses when a later change
 * follows or the install or the reload fails.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { undoChange } from '../src/actions.ts'
import { isAgentAction, planAgentAction, recordAgentAction, undoAgentAction, type AgentCall } from '../src/agent-actions.ts'
import { parseChangeId } from '../src/ids.ts'
import type { PluginOperation } from '../src/install-actions.ts'
import { readChangeLog } from '../src/records.ts'
import { fixture, history, NOW, PROFILE, terminal, type Fixture } from './profile-fixture.ts'
import { rejection } from './support.ts'
import { openHistory } from '@delorun/profile-safety'

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
 * @returns its id.
 */
async function save(fx: Fixture, summary: string): Promise<string | undefined> {
  return openHistory({ profileDir: fx.profileDir }).record(summary, { kind: 'agent', sessionId: 'chat' })
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
 * Run an agent action the way the tool listener does: plan, change the profile, save the version, record.
 * @param fx - the fixture.
 * @param call - what the agent called.
 * @param change - the profile change the action makes.
 * @returns the recorded entry, or undefined.
 */
async function ran(fx: Fixture, call: AgentCall, change: () => void | Promise<void>) {
  const plan = await planAgentAction(context(fx), call)
  await change()
  await save(fx, `agent ${call.action}`)
  return recordAgentAction(context(fx), plan)
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

describe('recordAgentAction', () => {
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
    const log = await readChangeLog(fx.home, PROFILE)
    expect(log.entries).toHaveLength(7)
    expect(log.entries.every(isAgentAction)).toBe(true)
    expect(new Set(log.entries.map(entry => entry.id)).size).toBe(7)
  })

  it('records nothing when the profile history did not move', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    expect(await ran(fx, { action: 'set_bundle', target: 'p', enabled: false }, () => undefined)).toBeUndefined()
    expect((await readChangeLog(fx.home, PROFILE)).entries).toEqual([])
  })

  it('gives a repeated action a new entry each time', async () => {
    const fx = fixture({ protection: 'off' })
    await save(fx, 'profile before the agent')
    const first = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => addDependency(fx, 'a'))
    const second = await ran(fx, { action: 'install_bundle', target: 'new-plugin' }, () => addDependency(fx, 'b'))
    expect(second!.id).not.toBe(first!.id)
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
    expect((await readChangeLog(fx.home, PROFILE)).entries).toEqual([result.entry])
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
    const log = await readChangeLog(fx.home, PROFILE)
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
    expect((await readChangeLog(fx.home, PROFILE)).entries).toEqual([entry])
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
