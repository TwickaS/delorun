/**
 * Agent controls use the same manager methods as the Web and bound inventory reads. The cases outside the switch block
 * run with both C16 switches off, as the parity composition does, and keep upstream's assertions.
 */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type PluginManager from '../src/index.ts'
import type { BundleInfo, ProfileVersionId, ProfileVersionPreview } from '../src/types.ts'
import * as tool from '../src/tools.ts'

const NO_CHANGES = { plugins: [], bundles: [], builds: [], exemptions: [], patchChanged: false, homePatchChanged: false, unreadable: [] }

function resultText(result: ToolExecutionResult): string {
  if (typeof result.value !== 'string') throw new Error('Expected a serialized manager result')
  return result.value
}

async function fixture(mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'danger-full-access', approval?: 'ask' | 'never', config: tool.Config = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const stock = {
    listPlugins: vi.fn(async () => Array.from({ length: 30 }, (_, i) => ({ entryId: `include:${i}`, enabled: true }))),
    listBundles: vi.fn(async () => [{ name: 'bundle', enabled: true }]),
    setPluginEnabled: vi.fn(async () => ({ changed: true, application: 'applied' })),
    setBundleEnabled: vi.fn(async () => ({ changed: true, application: 'applied' })),
    installBundle: vi.fn(async () => ({ changed: true, application: 'restart-required' })),
    removeBundle: vi.fn(async () => ({ changed: false, application: 'failed' })),
    listVersionExemptions: vi.fn(() => ({ exemptions: { 'example@1.2.3': ['0.1.7-alpha.1'] }, warnings: [] })),
    setVersionExemption: vi.fn(async () => ({ changed: true, application: 'applied' })),
  }
  // The history methods only the switched-on tool calls.
  const history = {
    undo: vi.fn(async () => ({ changed: false, application: 'failed', error: { code: 'nothing-to-undo' } })),
    restore: vi.fn(async () => ({ changed: false, application: 'failed', error: { code: 'unknown-version' } })),
    history: vi.fn(async () => ({ available: true, versions: [] })),
    listHistory: vi.fn(async () => ({ available: true, versions: [{ id: 'a'.repeat(40), at: 0, summary: 'Turned off include:1', changedBy: { kind: 'person' } }] })),
    previewUndo: vi.fn(async (): Promise<ProfileVersionPreview> => ({ ok: true, version: { version: brandString<ProfileVersionId>('a'.repeat(40)), summary: 'Turned off include:1' }, changes: NO_CHANGES })),
    previewRestore: vi.fn(async (): Promise<ProfileVersionPreview> => ({ ok: true, version: { version: brandString<ProfileVersionId>('b'.repeat(40)), summary: 'Installed bundle' }, changes: NO_CHANGES })),
  }
  const manager = { ...stock, ...history }
  ctx.provide('pluginManager', manager as unknown as PluginManager)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode })
  if (approval !== undefined) await ctx.plugin(ApprovalService, { policy: approval })
  const fiber = await ctx.plugin(tool, config)
  const call = (args: unknown, agent?: Agent, signal = new AbortController().signal) => executeToolFixture(ctx, { name: 'plugin_manager', arguments: args,
    ...agent === undefined ? {} : { agent },
    callId: ToolCallId('manager-call'), signal })
  return { ctx, manager: stock, history, call, fiber }
}

it.each(['read-only', 'workspace-write'] as const)('denies every management action in %s before accessing the manager', async (mode) => {
  const { call, manager } = await fixture(mode)
  for (const action of ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'list_version_exemptions', 'set_version_exemption']) {
    const result = await call({ action, target: 'bundle', enabled: true })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires approval, but no approval service is composed')
  }
  for (const method of Object.values(manager)) expect(method).not.toHaveBeenCalled()
})

it('preserves selected bundle load errors in the agent list result', async () => {
  const { manager, call } = await fixture()
  const bundles = [{
    name: 'bundle', enabled: true,
    error: { code: 'operation-error', diagnostic: 'bundle patch is unreadable' }, rows: [], overrides: [],
  }]
  manager.listBundles.mockResolvedValue(bundles)
  expect(JSON.parse(resultText(await call({ action: 'list_bundles' })))).toMatchInlineSnapshot(`
    {
      "entries": [
        {
          "enabled": true,
          "error": {
            "code": "operation-error",
            "diagnostic": "bundle patch is unreadable",
          },
          "name": "bundle",
          "overrides": [],
          "rows": [],
        },
      ],
      "nextOffset": null,
      "total": 1,
    }
  `)
})

it('exposes an absent Official bundle installation target without display metadata', async () => {
  const { manager, call } = await fixture()
  const offered: BundleInfo = {
    name: '@deepseek-ai/dsh-subagent-codex', official: true, availability: 'missing',
    installed: false, enabled: false, optional: false, removable: false, rows: [], overrides: [],
    installTarget: { spec: '@deepseek-ai/dsh-subagent-codex@1.2.3', version: '1.2.3' },
    meta: { title: 'Codex subagent' },
  }
  manager.listBundles.mockResolvedValue([offered])
  expect(JSON.parse(resultText(await call({ action: 'list_bundles' })))).toMatchInlineSnapshot(`
    {
      "entries": [
        {
          "availability": "missing",
          "enabled": false,
          "installTarget": {
            "spec": "@deepseek-ai/dsh-subagent-codex@1.2.3",
            "version": "1.2.3",
          },
          "installed": false,
          "name": "@deepseek-ai/dsh-subagent-codex",
          "official": true,
          "optional": false,
          "overrides": [],
          "removable": false,
          "rows": [],
        },
      ],
      "nextOffset": null,
      "total": 1,
    }
  `)
})

it('checks the calling session on each execution, including after permission is revoked', async () => {
  const { call, manager } = await fixture()
  const id = SessionId('manager-permissions')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  const agent = { session } as unknown as Agent
  setSandboxMode(session, 'workspace-write')
  expect((await call({ action: 'list_plugins' }, agent)).isError).toBe(true)
  expect(manager.listPlugins).not.toHaveBeenCalled()
  setSandboxMode(session, 'danger-full-access')
  expect((await call({ action: 'list_plugins' }, agent)).isError).toBe(false)
  setSandboxMode(session, 'read-only')
  expect((await call({ action: 'list_plugins' }, agent)).isError).toBe(true)
  expect(manager.listPlugins).toHaveBeenCalledTimes(1)
})

function activeAgent(): Agent {
  const id = SessionId('manager-approval')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  session.append('turn/start', { turn: 1 })
  return { session } as unknown as Agent
}

it.each(['read-only', 'workspace-write'] as const)('approves each action once in %s without changing session permissions', async (mode) => {
  const { ctx, call, manager } = await fixture(mode, 'ask')
  const agent = activeAgent()
  const prompted = vi.fn(async () => 'allowed-once' as const)
  const dispose = ctx.on('approval/request', prompted)
  for (const action of ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'list_version_exemptions', 'set_version_exemption']) {
    expect((await call({ action, target: 'bundle@1.0.0', enabled: true, runtimeVersion: '0.1.7-alpha.1', acceptRisk: true }, agent)).isError).toBe(false)
  }
  expect(prompted).toHaveBeenCalledTimes(8)
  for (const method of Object.values(manager)) expect(method).toHaveBeenCalledTimes(1)
  expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe(mode)
  const audit = agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
  expect(audit).toHaveLength(16)
  expect(audit[0]).toMatchObject({ type: 'approval/asked', data: {
    toolName: 'plugin_manager', callId: 'manager-call',
  } })
  const request = audit[0]
  if (request?.type !== 'approval/asked') throw new Error('Expected an approval request')
  expect(request.data.reason).toContain('"action":"list_plugins"')
  expect(audit[1]).toMatchObject({ type: 'approval/decided', data: { outcome: 'allowed-once' } })
  dispose()
  expect((await call({ action: 'list_plugins' }, agent)).isError).toBe(true)
  expect(manager.listPlugins).toHaveBeenCalledTimes(1)
})

it.each(['rejected', 'cancelled', 'unavailable'] as const)('does not mutate the profile when approval is %s', async (outcome) => {
  const { ctx, call, manager } = await fixture('workspace-write', 'ask')
  ctx.on('approval/request', async () => outcome)
  const agent = activeAgent()
  expect((await call({ action: 'install_bundle', target: 'bundle' }, agent)).isError).toBe(true)
  expect(manager.installBundle).not.toHaveBeenCalled()
  expect(agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')
    .map(event => event.data.outcome)).toEqual([outcome])
})

it('rejects never policy without prompting and keeps full-access calls prompt-free', async () => {
  const { ctx, call, manager } = await fixture('workspace-write', 'never')
  const prompted = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', prompted, { prepend: true })
  const agent = activeAgent()
  expect((await call({ action: 'set_plugin', target: 'include:demo', enabled: true }, agent)).isError).toBe(true)
  expect(manager.setPluginEnabled).not.toHaveBeenCalled()
  setSandboxMode(agent.session, 'danger-full-access')
  expect((await call({ action: 'set_plugin', target: 'include:demo', enabled: true }, agent)).isError).toBe(false)
  expect(manager.setPluginEnabled).toHaveBeenCalledTimes(1)
  expect(prompted).not.toHaveBeenCalled()
})

it('cancels an approval wait before any manager operation', async () => {
  const { ctx, call, manager } = await fixture('workspace-write', 'ask')
  const asked = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  ctx.on('approval/request', () => { asked.resolve(undefined); return answer.promise })
  const controller = new AbortController()
  const result = call({ action: 'install_bundle', target: 'bundle' }, activeAgent(), controller.signal)
  await asked.promise
  expect(manager.installBundle).not.toHaveBeenCalled()
  controller.abort()
  answer.resolve('allowed-once')
  expect((await result).isError).toBe(true)
  expect(manager.installBundle).not.toHaveBeenCalled()
})

it('does not apply a grant when the call was cancelled before dispatch', async () => {
  const { ctx, call, manager } = await fixture('workspace-write', 'ask')
  const controller = new AbortController()
  vi.spyOn(ctx.approval, 'request').mockImplementation(async () => {
    controller.abort()
    return 'allowed-once'
  })
  expect((await call({ action: 'install_bundle', target: 'bundle' }, activeAgent(), controller.signal)).isError).toBe(true)
  expect(manager.installBundle).not.toHaveBeenCalled()
})

it('paginates inventories with an explicit continuation and total', async () => {
  const { call } = await fixture()
  const first = await call({ action: 'list_plugins' })
  expect(first.isError).toBe(false)
  expect(JSON.stringify(first.content)).toContain('nextOffset')
  expect(JSON.parse(resultText(first))).toMatchObject({ nextOffset: 25, total: 30 })
  const last = await call({ action: 'list_plugins', offset: 25, limit: 10 })
  expect(JSON.parse(resultText(last))).toMatchObject({ nextOffset: null, total: 30 })
  expect(resultText(await call({ action: 'list_bundles' }))).toContain('"name":"bundle"')
})

it('keeps UI translation and listing metadata out of model-facing plugin and bundle lists', async () => {
  const { call, manager } = await fixture()
  const meta = { title: { en: 'Plugin', zh: '插件' }, error: 'UI-only diagnostic' }
  manager.listPlugins.mockImplementationOnce(async () => [{ entryId: 'include:plugin', enabled: true, meta }])
  expect(JSON.parse(resultText(await call({ action: 'list_plugins' })))).toEqual({
    entries: [{ entryId: 'include:plugin', enabled: true }], total: 1, nextOffset: null,
  })
  manager.listBundles.mockImplementationOnce(async () => [{
    name: 'bundle', source: 'bundle@^1.0.0', enabled: true, listedByDefault: false, meta, rows: [{ rowId: 'plugin', moduleName: 'plugin', meta }],
  }])
  expect(JSON.parse(resultText(await call({ action: 'list_bundles' })))).toEqual({
    entries: [{ name: 'bundle', source: 'bundle@^1.0.0', enabled: true, rows: [{ rowId: 'plugin', moduleName: 'plugin' }] }], total: 1, nextOffset: null,
  })
})

it('forwards all mutation actions and renders the returned outcome', async () => {
  const { call, manager } = await fixture()
  await call({ action: 'set_plugin', target: 'include:1', enabled: false })
  expect(manager.setPluginEnabled).toHaveBeenCalledWith('include:1', false)
  await call({ action: 'set_bundle', target: 'bundle', enabled: true })
  expect(manager.setBundleEnabled).toHaveBeenCalledWith('bundle', true)
  await call({ action: 'install_bundle', target: 'bundle' })
  expect(manager.installBundle).toHaveBeenLastCalledWith('bundle', {})
  await call({ action: 'install_bundle', target: 'bundle', enabled: false })
  expect(manager.installBundle).toHaveBeenLastCalledWith('bundle', { enabled: false })
  await call({ action: 'install_bundle', target: 'bundle', approvedBuilds: ['native'] })
  expect(manager.installBundle).toHaveBeenLastCalledWith('bundle', { approvedBuilds: ['native'] })
  await call({ action: 'install_bundle', target: 'bundle', registry: 'https://registry.npmmirror.com/' })
  expect(manager.installBundle).toHaveBeenLastCalledWith('bundle', { registry: 'https://registry.npmmirror.com/' })
  expect(resultText(await call({ action: 'remove_bundle', target: 'bundle' }))).toContain('"application":"failed"')
  expect(manager.removeBundle).toHaveBeenCalledWith('bundle')
})

it.each([
  { action: 'unknown_action' },
  { action: 'list_plugins', offset: -1 },
  { action: 'list_plugins', offset: 0.5 },
  { action: 'list_bundles', limit: 101 },
  { action: 'list_bundles', limit: 0 },
  { action: 'list_bundles', limit: 1.5 },
  { action: 'set_plugin', enabled: true },
  { action: 'set_bundle', target: 'bundle' },
  { action: 'install_bundle' }, { action: 'remove_bundle' },
  { action: 'set_version_exemption', enabled: true, runtimeVersion: '1.0.0' },
  { action: 'set_version_exemption', target: 'plugin@1.0.0', enabled: true },
  { action: 'set_version_exemption', target: 'plugin@1.0.0', runtimeVersion: '1.0.0' },
])('rejects incomplete or unbounded tool inputs: %j', async (args) => {
  const { call } = await fixture()
  expect((await call(args)).isError).toBe(true)
})

it('presents reads and changes distinctly and disposes its registration', async () => {
  const { ctx, fiber } = await fixture()
  const definition = ctx.tools.get('plugin_manager')!
  expect(definition.presentCall?.({ action: 'list_plugins' })).toMatchObject({ kind: 'read' })
  expect(definition.presentCall?.({ action: 'remove_bundle', target: 'bundle' })).toMatchObject({ kind: 'other' })
  await fiber.dispose()
  expect(ctx.tools.get('plugin_manager')).toBeUndefined()
})

it('tells the agent the next step for each change outcome it can act on', async () => {
  const { manager, call } = await fixture()
  const outcome = async (result: object): Promise<unknown> => {
    manager.setBundleEnabled.mockResolvedValueOnce(result as never)
    return (JSON.parse(resultText(await call({ action: 'set_bundle', target: 'bundle', enabled: true }))) as { nextStep?: string }).nextStep
  }
  expect(await outcome({ changed: true, application: 'applied' })).toBeUndefined()
  expect(await outcome({ changed: false, application: 'cancelled' })).toContain('nothing changed')
  expect(await outcome({ changed: true, application: 'overridden' })).toContain('higher-priority layer')
  expect(await outcome({ changed: true, application: 'restart-required', restartReason: 'host-module' }))
    .toBe('Tell the user to restart DSH to apply this change: the change reaches modules DSH itself loaded.')
  expect(await outcome({ changed: true, application: 'restart-required' })).toBe('Tell the user to restart DSH to apply this change.')
  expect(await outcome({ changed: false, application: 'failed', packageResult: { kind: 'build-blocked' } })).toContain('approvedBuilds')
  // A refusal code is more specific than the package manager's failure kind.
  expect(await outcome({ changed: false, application: 'failed', packageResult: { kind: 'network' }, error: { code: 'stale-approval' } }))
    .toContain('without approvedBuilds')
  // A failure kind without its own step falls back to the refusal code.
  expect(await outcome({ changed: false, application: 'failed', packageResult: { kind: 'unknown' }, error: { code: 'operation-error' } }))
    .toContain('Report the diagnostic')
  expect(await outcome({ changed: false, application: 'failed' })).toContain('Report the diagnostic')
  expect(await outcome({ changed: false, application: 'failed', error: { code: 'unsupported-platform' } }))
    .toBe('This bundle cannot run on the current Host platform; ask the user to use a supported Host.')
  // Only a refusal for a module the profile protects carries a diagnostic; upstream's refusal keeps upstream's step.
  expect(await outcome({ changed: false, application: 'failed', error: { code: 'management-required' } }))
    .toBe('This entry belongs to plugin management itself and cannot be changed.')
  expect(await outcome({ changed: false, application: 'failed', error: { code: 'management-required', diagnostic: 'protected by this profile: guard' } }))
    .toContain('a guard the profile protects')
})

const STOCK_DESCRIPTION = 'List plugins or bundles in the current profile, enable or disable them, install a bundle, or remove an installed bundle. Every action requires danger-full-access permission or approval for this call. Approval does not change the session permission mode. Changes affect every session in this profile. List first to obtain exact identifiers. Package installation can execute allowed build scripts. Live profiles apply changes immediately, including upgrades of installed packages; a change result that is not applied carries nextStep, which says what to do or tell the user. Unmet DSH version requirements (engines.dsh, else DSH peer dependencies) block installation and activation. Version exemptions risk crashes and data loss: warn the user and obtain explicit permission for the exact plugin and runtime versions before granting one.'
const STOCK_ACTIONS = ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle', 'list_version_exemptions', 'set_version_exemption']
const WRITE_ACTIONS = ['set_plugin', 'set_bundle', 'configure', 'install_bundle', 'remove_bundle', 'set_version_exemption', 'undo', 'restore']
const READ_ACTIONS = ['list_plugins', 'list_bundles', 'list_version_exemptions', 'history', 'read_config']
const SWITCHED_ON: tool.Config = { readActionsExempt: true, profileHistory: true }

// A configuration editor with one entry whose Config is the given native schema, or none.
const Settings = z.object({ enabled: z.boolean().default(true), limit: z.natural().default(5), token: z.string().role('secret') })
type Fields = Record<string, unknown>
// Its Loader entry id is one the stock manager lists without a read-only reason.
function editor(config: Fields, inherited: Fields, override: Fields, native: unknown = Settings) {
  const entry = { id: 'include:1', options: { id: 'delorun-agent-context', name: '@delorun/plugin-agent-context', config }, fiber: { runtime: { Config: native } } }
  const saved: Array<Record<string, unknown>> = []
  return {
    saved,
    configuration: vi.fn(() => [{ entry, inherited, override }]),
    edit: vi.fn(async (_entry: unknown, change: (current: Fields, inherited: Fields) => Fields) => {
      saved.push(change(structuredClone(config), inherited))
    }),
  }
}

it('keeps upstream\'s description, actions and parameters with both switches off', async () => {
  const { ctx, call, history } = await fixture()
  const definition = ctx.tools.get('plugin_manager')!
  expect(definition.description).toBe(STOCK_DESCRIPTION)
  const schema = definition.parameters as { properties: Record<string, { enum?: string[] }> }
  expect(Object.keys(schema.properties)).toEqual(['action', 'target', 'enabled', 'runtimeVersion', 'acceptRisk', 'approvedBuilds', 'registry', 'offset', 'limit'])
  expect(schema.properties['action']?.enum).toEqual(STOCK_ACTIONS)
  for (const action of ['read_config', 'configure', 'undo', 'history', 'restore']) {
    expect(JSON.stringify((await call({ action, target: 'b'.repeat(40) })).content)).toContain('invalid arguments')
  }
  for (const method of Object.values(history)) expect(method).not.toHaveBeenCalled()
})

it('states the read exemption in the description only with its switch on', async () => {
  const exempt = await fixture('danger-full-access', undefined, { readActionsExempt: true })
  expect(exempt.ctx.tools.get('plugin_manager')!.description).toBe(STOCK_DESCRIPTION.replace(
    'Every action requires danger-full-access permission or approval for this call.',
    'Every change requires danger-full-access permission or approval for this call; listing does not.'))
  const both = await fixture('danger-full-access', undefined, SWITCHED_ON)
  expect(both.ctx.tools.get('plugin_manager')!.description).toContain('Every change requires danger-full-access permission or approval for this call; listing, history and read_config do not.')
  const history = await fixture('danger-full-access', undefined, { profileHistory: true })
  expect(history.ctx.tools.get('plugin_manager')!.description).toContain('Every action requires danger-full-access permission or approval for this call.')
})

it.each(['read-only', 'workspace-write'] as const)('plugin_manager write actions keep the escalation under the read exemption in %s', async (mode) => {
  const { ctx, call, manager, history } = await fixture(mode, undefined, SWITCHED_ON)
  const settings = editor({ enabled: true }, {}, {})
  ctx.provide('configEditor', settings as never)
  for (const action of WRITE_ACTIONS) {
    const result = await call({ action, target: action === 'restore' ? 'b'.repeat(40) : 'delorun-agent-context', enabled: true, runtimeVersion: '0.1.0', config: { enabled: false } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires approval, but no approval service is composed')
  }
  // No write reached the manager or the configuration editor; an undo or a restore read only what its approval lists.
  for (const method of Object.values(manager)) expect(method).not.toHaveBeenCalled()
  for (const method of [history.undo, history.restore, history.history, history.listHistory, settings.edit]) {
    expect(method).not.toHaveBeenCalled()
  }
  for (const action of READ_ACTIONS) expect((await call({ action, target: 'delorun-agent-context' })).isError).toBe(false)
  const reads = [manager.listPlugins, manager.listBundles, manager.listVersionExemptions, history.listHistory]
  expect(reads.map(method => method.mock.calls.length)).toEqual([1, 1, 1, 1])
})

it.each(['read-only', 'workspace-write'] as const)('plugin_manager stock write actions keep the escalation with only the read exemption on, as the Web presets ship it, in %s', async (mode) => {
  const { call, manager } = await fixture(mode, undefined, { readActionsExempt: true })
  for (const action of STOCK_ACTIONS.filter(action => !READ_ACTIONS.includes(action))) {
    const result = await call({ action, target: 'delorun-agent-context', enabled: true, runtimeVersion: '0.1.0' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires approval, but no approval service is composed')
  }
  for (const method of Object.values(manager)) expect(method).not.toHaveBeenCalled()
  for (const action of ['list_plugins', 'list_bundles', 'list_version_exemptions']) {
    expect((await call({ action })).isError).toBe(false)
  }
  const reads = [manager.listPlugins, manager.listBundles, manager.listVersionExemptions]
  expect(reads.map(method => method.mock.calls.length)).toEqual([1, 1, 1])
})

it('escalates the history and settings reads with only the profile_history switch on', async () => {
  const { ctx, call, history } = await fixture('workspace-write', undefined, { profileHistory: true })
  ctx.provide('configEditor', editor({ enabled: true }, {}, {}) as never)
  for (const action of [...READ_ACTIONS, ...WRITE_ACTIONS]) {
    expect(JSON.stringify((await call({ action, target: 'b'.repeat(40), enabled: true, config: { enabled: false } })).content)).toContain('requires approval')
  }
  expect(history.listHistory).not.toHaveBeenCalled()
})

it.each(['read-only', 'workspace-write'] as const)('approves each change once in %s with the read exemption on, and asks nothing for a read', async (mode) => {
  const { ctx, call, manager, history } = await fixture(mode, 'ask', SWITCHED_ON)
  const settings = editor({ enabled: true }, {}, {})
  ctx.provide('configEditor', settings as never)
  const agent = activeAgent()
  const prompted = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', prompted)
  for (const action of [...READ_ACTIONS, ...WRITE_ACTIONS]) {
    expect((await call({ action, target: action === 'read_config' || action === 'configure' ? 'delorun-agent-context' : 'bundle@1.0.0', enabled: true, runtimeVersion: '0.1.7-alpha.1', acceptRisk: true, config: { limit: 6 } }, agent)).isError).toBe(false)
  }
  expect(prompted).toHaveBeenCalledTimes(WRITE_ACTIONS.length)
  // configure reads the plugin list once more, for the entry's protection.
  for (const [name, method] of Object.entries(manager)) expect(method, name).toHaveBeenCalledTimes(name === 'listPlugins' ? 2 : 1)
  for (const method of [history.undo, history.restore, history.listHistory, settings.edit]) expect(method).toHaveBeenCalledTimes(1)
  expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe(mode)
  const reasons = agent.session.snapshotEvents().flatMap(event => event.type === 'approval/asked' ? [event.data.reason] : [])
  expect(reasons).toHaveLength(WRITE_ACTIONS.length)
  WRITE_ACTIONS.forEach((action, index) => { expect(reasons[index]).toContain(`plugin_manager {"action":"${action}"`) })
})

it('plugin_manager history records no version', async () => {
  const { call, history } = await fixture('read-only', undefined, SWITCHED_ON)
  expect(JSON.parse(resultText(await call({ action: 'history' })))).toMatchObject({ available: true, versions: [{ summary: 'Turned off include:1' }] })
  expect(history.listHistory).toHaveBeenLastCalledWith(25)
  await call({ action: 'history', limit: 100 })
  expect(history.listHistory).toHaveBeenLastCalledWith(100)
  // The manager's history, which saves an outside edit as a version first, is never the tool's read.
  expect(history.history).not.toHaveBeenCalled()
  const escalated = await fixture('danger-full-access', undefined, { profileHistory: true })
  await escalated.call({ action: 'history' })
  expect(escalated.history.listHistory).toHaveBeenCalledTimes(1)
  expect(escalated.history.history).not.toHaveBeenCalled()
})

it('lists the plugins, builds and exemptions an undo or a restore changes in its approval', async () => {
  const { ctx, call, history } = await fixture('workspace-write', 'ask', SWITCHED_ON)
  const agent = activeAgent()
  ctx.on('approval/request', async () => 'allowed-once' as const)
  history.previewRestore.mockResolvedValueOnce({ ok: true, version: { version: brandString<ProfileVersionId>('b'.repeat(40)), summary: 'Installed audited' }, changes: {
    plugins: [{ name: 'audited', change: 'added', to: '1.0.0' }, { name: 'extra', change: 'version', from: '2.0.0', to: '1.0.0' }],
    bundles: [{ name: 'audited', selected: true }],
    builds: [{ name: 'audited', to: 'allowed' }, { name: 'native', from: 'allowed', to: 'denied' }],
    exemptions: [{ packageVersion: 'audited@1.0.0', runtimeVersion: '0.2.2', change: 'added' }],
    patchChanged: true, homePatchChanged: false, unreadable: [],
  } })
  expect((await call({ action: 'restore', target: 'b'.repeat(40) }, agent)).isError).toBe(false)
  expect(history.previewRestore).toHaveBeenCalledWith('b'.repeat(40))
  expect((await call({ action: 'undo' }, agent)).isError).toBe(false)
  const reasons = agent.session.snapshotEvents().flatMap(event => event.type === 'approval/asked' ? [event.data.reason] : [])
  expect(reasons[0]).toContain('It puts the profile back as version bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ("Installed audited") and changes plugins: adds audited 1.0.0, puts extra at 1.0.0 (now 2.0.0); bundles: selects audited; build scripts: audited allowed (now no decision), native denied (now allowed); version exemptions: grants audited@1.0.0 on DSH 0.2.2; the profile patch cordis.patch.yml.')
  expect(reasons[1]).toContain('("Turned off include:1") and changes no plugins, builds or exemptions.')
  expect(history.restore).toHaveBeenCalledTimes(1)
  expect(history.undo).toHaveBeenCalledTimes(1)
})

it('asks before an undo whose preview refuses, then returns the refusal without undoing', async () => {
  const { ctx, call, history } = await fixture('workspace-write', 'ask', SWITCHED_ON)
  const agent = activeAgent()
  const prompted = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', prompted)
  history.previewUndo.mockResolvedValueOnce({ ok: false, error: { code: 'history-unavailable', diagnostic: 'git could not run' } })
  const result = JSON.parse(resultText(await call({ action: 'undo' }, agent))) as Record<string, unknown>
  expect(result).toMatchObject({ application: 'failed', changed: false, stage: 'undo', error: { code: 'history-unavailable' } })
  expect(result['nextStep']).toContain('undo and restore are unavailable')
  expect(prompted).toHaveBeenCalledTimes(1)
  expect(agent.session.snapshotEvents().flatMap(event => event.type === 'approval/asked' ? [event.data.reason] : [])[0])
    .toContain('It cannot run: history-unavailable (git could not run); nothing will change.')
  expect(history.undo).not.toHaveBeenCalled()
})

it('reads no preview for an undo or a restore that full access runs without a prompt', async () => {
  const { call, history } = await fixture('danger-full-access', undefined, SWITCHED_ON)
  await call({ action: 'undo' })
  await call({ action: 'restore', target: 'b'.repeat(40) })
  expect(history.previewUndo).not.toHaveBeenCalled()
  expect(history.previewRestore).not.toHaveBeenCalled()
  expect(history.undo).toHaveBeenCalledWith()
  expect(history.restore).toHaveBeenCalledWith('b'.repeat(40))
})

it('describes each kind of change an undo or a restore makes', () => {
  expect(tool.describeChanges({
    plugins: [{ name: 'gone', change: 'removed', from: '1.0.0' }], bundles: [{ name: 'gone', selected: false }], builds: [],
    exemptions: [{ packageVersion: 'gone@1.0.0', runtimeVersion: '0.2.2', change: 'removed' }], patchChanged: false, homePatchChanged: false, unreadable: ['package.json'],
  })).toBe('plugins: removes gone 1.0.0; bundles: deselects gone; version exemptions: revokes gone@1.0.0 on DSH 0.2.2; files it cannot read, whose changes are not listed: package.json')
})

it('refuses a restore without a version before reading a preview or asking', async () => {
  const { ctx, call, history } = await fixture('workspace-write', 'ask', SWITCHED_ON)
  const prompted = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', prompted)
  expect(JSON.stringify((await call({ action: 'restore' }, activeAgent())).content)).toContain('target version id from history is required')
  expect(history.previewRestore).not.toHaveBeenCalled()
  expect(prompted).not.toHaveBeenCalled()
})

it('names a refusal without a diagnostic in the approval of an undo it would end', async () => {
  const { ctx, call, history } = await fixture('workspace-write', 'ask', SWITCHED_ON)
  const agent = activeAgent()
  ctx.on('approval/request', async () => 'allowed-once' as const)
  history.previewUndo.mockResolvedValueOnce({ ok: false, error: { code: 'nothing-to-undo' } })
  expect(JSON.parse(resultText(await call({ action: 'undo' }, agent)))).toMatchObject({ error: { code: 'nothing-to-undo' } })
  expect(agent.session.snapshotEvents().flatMap(event => event.type === 'approval/asked' ? [event.data.reason] : [])[0]).toContain('It cannot run: nothing-to-undo; nothing will change.')
})

describe('with the profile_history and plugin_manager_read_exemption switches on', () => {
  it('forwards the history actions and renders the returned outcome', async () => {
    const { call, history } = await fixture('danger-full-access', undefined, SWITCHED_ON)
    const undone = JSON.parse(resultText(await call({ action: 'undo' }))) as { nextStep?: string }
    expect(undone.nextStep).toBe('The profile\'s history holds no earlier version to go back to.')
    const restored = JSON.parse(resultText(await call({ action: 'restore', target: 'b'.repeat(40) }))) as { nextStep?: string }
    expect(history.restore).toHaveBeenCalledWith('b'.repeat(40))
    expect(restored.nextStep).toBe('Call history and retry with an id it lists.')
  })

  it.each([
    { action: 'history', limit: 0 }, { action: 'history', limit: 101 }, { action: 'history', limit: 1.5 },
    { action: 'restore' }, { action: 'read_config' }, { action: 'configure', target: 'delorun-agent-context' },
  ])('rejects incomplete or unbounded tool inputs: %j', async (args) => {
    const { ctx, call } = await fixture('danger-full-access', undefined, SWITCHED_ON)
    ctx.provide('configEditor', editor({}, {}, {}) as never)
    expect((await call(args)).isError).toBe(true)
  })

  it('presents reads and changes distinctly', async () => {
    const { ctx } = await fixture('danger-full-access', undefined, SWITCHED_ON)
    const definition = ctx.tools.get('plugin_manager')!
    expect(definition.presentCall?.({ action: 'history' })).toMatchObject({ kind: 'read' })
    expect(definition.presentCall?.({ action: 'read_config', target: 'delorun-agent-context' })).toMatchObject({ kind: 'read' })
    expect(definition.presentCall?.({ action: 'restore', target: 'a'.repeat(40) })).toMatchObject({ kind: 'other' })
    expect(definition.presentCall?.({ action: 'configure', target: 'delorun-agent-context' })).toMatchObject({ kind: 'other' })
  })

  it('reads an entry\'s settings with secrets left out, what the bundles give it, and its schema', async () => {
    const { ctx, call } = await fixture('read-only', undefined, SWITCHED_ON)
    ctx.provide('configEditor', editor({ enabled: false, token: 't0ken' }, { enabled: true }, { enabled: false }) as never)
    const read = JSON.parse(resultText(await call({ action: 'read_config', target: 'delorun-agent-context' }))) as Record<string, unknown>
    expect(read).toMatchObject({ patchId: 'delorun-agent-context', name: '@delorun/plugin-agent-context', config: { enabled: false }, inherited: { enabled: true }, overridden: true, secrets: [{ path: ['token'], set: true }] })
    expect(JSON.stringify(read)).not.toContain('t0ken')
    // The projection Config.listConfigs gives: each field also admits a loader expression.
    expect(read.schema).toMatchObject({ $defs: { loaderExpression: { required: ['__jsExpr'] } } })
    expect(JSON.stringify(read.schema)).toContain('"enabled":{"default":true,"anyOf":[{"type":["boolean","null"]}')
  })

  it.each([['no schema', null], ['a function', () => ({})], ['a plain object', { type: 'object' }]])('plugin_manager read_config withholds values of a non-native Config: %s', async (_name, native) => {
    const { ctx, call } = await fixture('read-only', undefined, SWITCHED_ON)
    ctx.provide('configEditor', editor({ apiKey: 's3cret', a: 1 }, { apiKey: 'inherited-s3cret' }, { a: 1 }, native) as never)
    const read = JSON.parse(resultText(await call({ action: 'read_config', target: 'delorun-agent-context' }))) as Record<string, unknown>
    expect(read).toEqual({ patchId: 'delorun-agent-context', name: '@delorun/plugin-agent-context', overridden: true, valuesWithheld: true, schema: null })
    expect(JSON.stringify(read)).not.toContain('s3cret')
  })

  it('reads an entry without settings whose Config is a native schema as an empty object', async () => {
    const { ctx, call } = await fixture('read-only', undefined, SWITCHED_ON)
    ctx.provide('configEditor', { configuration: () => [{ entry: { options: { id: 'bare', name: 'bare-plugin' }, fiber: { runtime: { Config: Settings } } }, inherited: {}, override: {} }] } as never)
    expect(JSON.parse(resultText(await call({ action: 'read_config', target: 'bare' })))).toMatchObject({ config: {}, inherited: {}, overridden: false })
  })

  it('withholds an entry without settings whose Config is not a native schema', async () => {
    const { ctx, call } = await fixture('read-only', undefined, SWITCHED_ON)
    ctx.provide('configEditor', { configuration: () => [{ entry: { options: { id: 'bare', name: 'bare-plugin' } }, inherited: {}, override: {} }] } as never)
    expect(JSON.parse(resultText(await call({ action: 'read_config', target: 'bare' })))).toEqual({ patchId: 'bare', name: 'bare-plugin', overridden: false, valuesWithheld: true, schema: null })
  })

  it('sets fields and puts others back through the configuration editor, listing each change without secrets', async () => {
    const { ctx, call } = await fixture('danger-full-access', undefined, SWITCHED_ON)
    const settings = editor({ enabled: true, limit: 9, old: 'x', token: 't0ken' }, { enabled: true, limit: 5 }, { limit: 9, old: 'x' })
    ctx.provide('configEditor', settings as never)
    const result: unknown = JSON.parse(resultText(await call({ action: 'configure', target: 'delorun-agent-context', config: { enabled: false, extra: 1, token: 'n3w' }, reset: ['limit', 'old', 'unknown'] })))
    expect(settings.saved).toEqual([{ enabled: false, limit: 5, extra: 1, token: 'n3w' }])
    expect(result).toEqual({ patchId: 'delorun-agent-context', changed: [
      { field: 'old', before: 'x', after: null }, { field: 'enabled', before: true, after: false },
      { field: 'limit', before: 9, after: 5 }, { field: 'extra', before: null, after: 1 },
    ] })
  })

  it('names the fields a settings change made without their values when the Config is not a native schema', async () => {
    const { ctx, call } = await fixture('danger-full-access', undefined, SWITCHED_ON)
    ctx.provide('configEditor', editor({ apiKey: 's3cret', a: 1 }, { a: 2 }, { a: 1 }, null) as never)
    const result: unknown = JSON.parse(resultText(await call({ action: 'configure', target: 'delorun-agent-context', config: { apiKey: 'n3w' }, reset: ['a'] })))
    expect(result).toEqual({ patchId: 'delorun-agent-context', valuesWithheld: true, changed: [{ field: 'apiKey' }, { field: 'a' }] })
  })

  it('refuses to change the settings of a protected entry, even in full access, before the configuration editor saves', async () => {
    const { ctx, call, manager } = await fixture('danger-full-access', undefined, SWITCHED_ON)
    const settings = editor({ enabled: true }, {}, {})
    ctx.provide('configEditor', settings as never)
    manager.listPlugins.mockResolvedValue([{ entryId: 'include:1', enabled: true, readOnlyReason: 'management-required' }] as never)
    const result = await call({ action: 'configure', target: 'delorun-agent-context', config: { enabled: false } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('The settings of the entry \\"delorun-agent-context\\" cannot be changed (management-required): plugin management protects this entry')
    expect(settings.edit).not.toHaveBeenCalled()
  })

  it('refuses to change the settings of an entry set_plugin refuses as unaddressable, with set_plugin\'s next step', async () => {
    const { ctx, call, manager } = await fixture('danger-full-access', undefined, SWITCHED_ON)
    const settings = editor({ enabled: true }, {}, {})
    ctx.provide('configEditor', settings as never)
    manager.listPlugins.mockResolvedValue([{ entryId: 'include:1', enabled: true, readOnlyReason: 'unaddressable' }] as never)
    expect(JSON.stringify((await call({ action: 'configure', target: 'delorun-agent-context', config: { enabled: false } })).content))
      .toContain('cannot be changed (unaddressable): This entry has no unique profile patch target')
    expect(settings.edit).not.toHaveBeenCalled()
  })

  it('refuses to change the settings of an entry the plugin list does not list, before the configuration editor saves', async () => {
    const { ctx, call, manager } = await fixture('danger-full-access', undefined, SWITCHED_ON)
    const settings = editor({ enabled: true }, {}, {})
    ctx.provide('configEditor', settings as never)
    manager.listPlugins.mockResolvedValue([])
    expect(JSON.stringify((await call({ action: 'configure', target: 'delorun-agent-context', config: { enabled: false } })).content)).toContain('is not a plugin that list_plugins lists')
    expect(settings.edit).not.toHaveBeenCalled()
  })

  it('refuses without a configuration editor, an entry it does not address, or nothing to change', async () => {
    const { ctx, call } = await fixture('danger-full-access', undefined, SWITCHED_ON)
    const failure = async (args: object): Promise<string> => JSON.stringify((await call(args)).content)
    expect(await failure({ action: 'read_config', target: 'delorun-agent-context' })).toContain('no configuration editor')
    ctx.provide('configEditor', editor({}, {}, {}) as never)
    expect(await failure({ action: 'read_config' })).toContain('target entry patchId is required')
    expect(await failure({ action: 'configure', target: 'other:row', config: { a: 1 } })).toContain('call list_plugins')
    expect(await failure({ action: 'configure', target: 'delorun-agent-context' })).toContain('needs config fields')
  })
})
