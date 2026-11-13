/**
 * Specs of `@delo/plugin-changes` against upstream's real `plugin_manager` tool and tool pipeline: with the C16 switch
 * `plugin_changes_pending` on and protection on, the model's install, update and removal record a pending change and
 * change nothing the profile runs, without reaching the tool's full-access approval; with protection off, the default,
 * a removal or a turn-off reaches upstream's approval and manager as with the switch off, while an install is recorded and a turn-on is left to the person at their computer, as at every level; a protection record that cannot be
 * read holds the call; the setting is read at each call, so changing it takes effect without a restart; a listener that
 * allows such a call without the plugin's listener is overruled by its guard; and with the switch at parity the tool
 * asks its approval as upstream's does.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type PluginManager from '@deepseek-ai/dsh-plugin-manager'
import type { ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import * as tool from '@deepseek-ai/dsh-plugin-manager/tools'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { attestTerminal, protectionPath, readChangeLog, setProtection, type ProtectionLevel } from '@delo/changes'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '../src/index.ts'

// Each case boots a tool pipeline and writes a change log under a temporary home; a loaded host needs more than the default.
vi.setConfig({ testTimeout: 90_000 })

const PROFILE = 'default'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A Delo home whose profile has one registry plugin, a lockfile and `node_modules`. */
function home(): { home: string, profileDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-plugin-changes-')))
  roots.push(root)
  const deloHome = join(root, '.delo')
  const profileDir = join(deloHome, 'profiles', PROFILE)
  mkdirSync(join(profileDir, 'node_modules', 'installed-plugin'), { recursive: true, mode: 0o700 })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: { 'installed-plugin': '1.0.0' } }, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFileSync(join(profileDir, 'node_modules', 'installed-plugin', 'package.json'), '{"name":"installed-plugin","version":"1.0.0"}\n')
  return { home: deloHome, profileDir }
}

/**
 * Every file under the profile directory with its bytes, so a spec can tell that nothing the profile runs changed.
 * @param directory - the profile directory.
 * @returns contents by relative path.
 */
function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative))) {
      const path = join(relative, entry)
      if (lstatSync(join(directory, path)).isDirectory()) walk(path)
      else files[path] = readFileSync(join(directory, path), 'utf8')
    }
  }
  walk('')
  return files
}

/**
 * Set the protection setting, as `delorun changes protection` at a terminal does.
 * @param deloHome - the Delo home.
 * @param level - the level.
 */
async function protect(deloHome: string, level: ProtectionLevel): Promise<void> {
  await setProtection(deloHome, level, attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
}

/** An agent whose session has an open turn, so an approval can be asked. */
function activeAgent(): Agent {
  const id = SessionId('plugin-changes')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  session.append('turn/start', { turn: 1 })
  const agent: Partial<Agent> = { session }
  return agent as Agent
}

/**
 * Upstream's `plugin_manager` tool with a manager whose changes are spies, the approval service asking every time, and
 * this plugin mounted with the given switch.
 * @param enabled - the switch.
 * @param withProfile - whether the Host runs a profile launched by dsh.
 * @param profileHistory - the tool's switch that offers `configure`, `undo` and `restore`.
 * @param protection - the protection setting the home records; `none`, the home has no record and is at the default.
 * @param sandboxMode - the sandbox mode the chat runs in.
 * @returns the context, the manager, the approval spy, the profile and a call.
 */
async function harness(enabled: boolean, withProfile = true, profileHistory = false, protection: ProtectionLevel | 'none' = 'on', sandboxMode: 'workspace-write' | 'danger-full-access' = 'workspace-write') {
  const profile = home()
  if (protection !== 'none') await protect(profile.home, protection)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const applied = async (): Promise<ChangeResult> => ({ changed: true, application: 'applied', stage: 'install', target: 'plug' })
  const manager = {
    installBundle: vi.fn(applied),
    removeBundle: vi.fn(applied),
    listPlugins: vi.fn(async () => []),
    setBundleEnabled: vi.fn(applied),
    setPluginEnabled: vi.fn(applied),
    setVersionExemption: vi.fn(applied),
    undo: vi.fn(applied),
    restore: vi.fn(applied),
    previewUndo: vi.fn(async () => ({ ok: false, error: { code: 'nothing-to-undo' } })),
    previewRestore: vi.fn(async () => ({ ok: false, error: { code: 'unknown-version' } })),
  }
  ctx.provide('pluginManager', manager as Partial<PluginManager> as PluginManager)
  if (withProfile) ctx.provide('profileContext', { name: PROFILE, dir: profile.profileDir, home: profile.home } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: sandboxMode })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(tool, { profileHistory })
  await ctx.plugin(plugin, { enabled, installationBundles: [] })
  const approval = vi.fn(async () => 'allowed-once' as const)
  ctx.on('approval/request', approval)
  const agent = activeAgent()
  const call = (args: unknown): Promise<ToolExecutionResult> => executeToolFixture(ctx, { name: 'plugin_manager', arguments: args, agent, callId: ToolCallId('manager-call'), signal: new AbortController().signal })
  return { ctx, manager, approval, profile, call }
}

/**
 * @param result - a tool result.
 * @returns its text.
 */
function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('the model\'s plugin_manager changes wait for the person', () => {
  it('the model\'s plugin_manager install creates a pending change and installs nothing', async () => {
    const { manager, approval, profile, call } = await harness(true)
    const before = snapshot(profile.profileDir)
    const result = await call({ action: 'install_bundle', target: 'new-plugin@2.0.0' })
    const log = await readChangeLog(profile.home, PROFILE)
    expect(log.entries).toEqual([expect.objectContaining({ kind: 'plugin-install', state: 'pending', subject: { plugin: 'new-plugin', spec: 'new-plugin@2.0.0' } })])
    const id = log.entries[0]!.id
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(`Error: Recorded as a change waiting for the person's review at their computer: delorun changes show ${id}. Nothing was installed.`)
    expect(result.error?.info).toEqual({ name: 'PluginChangePending', code: plugin.PLUGIN_CHANGE_PENDING })
    // Stock's approval and its manager are never reached, and the manifest, the lockfile and node_modules are as they were.
    expect(approval).not.toHaveBeenCalled()
    expect(manager.installBundle).not.toHaveBeenCalled()
    expect(snapshot(profile.profileDir)).toEqual(before)
  })

  it('the model\'s plugin_manager remove creates a pending change and removes nothing', async () => {
    const { manager, approval, profile, call } = await harness(true)
    const before = snapshot(profile.profileDir)
    const result = await call({ action: 'remove_bundle', target: 'installed-plugin' })
    const [entry] = (await readChangeLog(profile.home, PROFILE)).entries
    expect(entry).toMatchObject({ kind: 'plugin-remove', state: 'pending', subject: { plugin: 'installed-plugin', spec: 'installed-plugin' } })
    expect(text(result)).toBe(`Error: Recorded as a change waiting for the person's review at their computer: delorun changes show ${entry!.id}. Nothing was removed.`)
    expect(approval).not.toHaveBeenCalled()
    expect(manager.removeBundle).not.toHaveBeenCalled()
    expect(snapshot(profile.profileDir)).toEqual(before)
  })

  it('the model\'s plugin_manager update creates a pending change and updates nothing', async () => {
    const { manager, approval, profile, call } = await harness(true)
    const before = snapshot(profile.profileDir)
    const result = await call({ action: 'install_bundle', target: 'installed-plugin@2.0.0' })
    const [entry] = (await readChangeLog(profile.home, PROFILE)).entries
    expect(entry).toMatchObject({ kind: 'plugin-update', state: 'pending', subject: { plugin: 'installed-plugin', spec: 'installed-plugin@2.0.0' } })
    expect(text(result)).toBe(`Error: Recorded as a change waiting for the person's review at their computer: delorun changes show ${entry!.id}. Nothing was installed or updated.`)
    expect(approval).not.toHaveBeenCalled()
    expect(manager.installBundle).not.toHaveBeenCalled()
    expect(snapshot(profile.profileDir)).toEqual(before)
  })

  it('denies a call it cannot record, and changes nothing', async () => {
    const { manager, approval, profile, call } = await harness(true)
    const before = snapshot(profile.profileDir)
    const missing = await call({ action: 'install_bundle' })
    expect(text(missing)).toBe('Error: Plugin installs, updates and removals wait for the person\'s review at their computer, and this one could not be recorded: the call names no target. Nothing was changed.')
    expect(missing.error?.info).toEqual({ name: 'PluginChangeUnrecorded', code: plugin.PLUGIN_CHANGE_UNRECORDED })
    const unknown = await call({ action: 'remove_bundle', target: 'not-a-plugin' })
    expect(text(unknown)).toContain('could not be recorded: not-a-plugin is not a plugin of this profile, so there is nothing to remove. Nothing was changed.')
    expect(approval).not.toHaveBeenCalled()
    expect(manager.removeBundle).not.toHaveBeenCalled()
    expect(snapshot(profile.profileDir)).toEqual(before)
  })

  it('denies when the harness runs no profile whose changes Delo keeps', async () => {
    const { manager, call } = await harness(true, false, true)
    const result = await call({ action: 'install_bundle', target: 'new-plugin' })
    expect(text(result)).toContain('could not be recorded: this harness runs no profile whose changes Delo keeps.')
    expect(manager.installBundle).not.toHaveBeenCalled()
    const restore = await call({ action: 'restore', target: 'version-1' })
    expect(restore.error?.info).toEqual({ name: 'PluginChangeAtComputer', code: plugin.PLUGIN_CHANGE_AT_COMPUTER })
    expect(manager.restore).not.toHaveBeenCalled()
  })

  it('reports a record it cannot read as the reason', async () => {
    const { manager, profile, call } = await harness(true)
    writeFileSync(join(profile.profileDir, 'package.json'), 'not json')
    const result = await call({ action: 'install_bundle', target: 'new-plugin' })
    expect(text(result)).toContain('could not be recorded: The profile\'s package.json could not be read')
    expect(manager.installBundle).not.toHaveBeenCalled()
  })

  it('a listener that allows the call without the plugin\'s listener is overruled by its guard', async () => {
    const { ctx, manager, approval, profile, call } = await harness(true)
    // Prepended after the plugin's, so it runs first and never calls next().
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })
    const result = await call({ action: 'install_bundle', target: 'new-plugin' })
    expect(text(result)).toBe('Error: Plugin changes wait for the person at their computer; this call was not handled as one, so it does not run.')
    expect(approval).not.toHaveBeenCalled()
    expect(manager.installBundle).not.toHaveBeenCalled()
    expect((await readChangeLog(profile.home, PROFILE)).entries).toEqual([])
  })

  it('the model\'s plugin_manager restore, undo and settings changes do not run and record nothing', async () => {
    const { manager, approval, profile, call } = await harness(true, true, true)
    const before = snapshot(profile.profileDir)
    const calls: Record<string, Record<string, unknown>> = {
      set_bundle: { target: 'installed-plugin', enabled: false },
      set_plugin: { target: 'installed-plugin', enabled: false },
      configure: { target: 'installed-plugin', config: { mode: 'fast' } },
      set_version_exemption: { target: 'installed-plugin@1.0.0', runtimeVersion: '0.2.2', enabled: true },
      undo: {},
      restore: { target: 'version-1' },
    }
    expect(Object.keys(calls).toSorted()).toEqual([...plugin.AT_COMPUTER_ACTIONS].toSorted())
    for (const [action, args] of Object.entries(calls)) {
      const result = await call({ action, ...args })
      expect(result.isError).toBe(true)
      expect(result.error?.info).toEqual({ name: 'PluginChangeAtComputer', code: plugin.PLUGIN_CHANGE_AT_COMPUTER })
      expect(text(result)).toBe(`Error: ${action} changes what the person's harness runs, so the person makes it at their computer, in the studio or with delorun plugin. Nothing was changed; tell the person what you would change and why.`)
    }
    for (const spy of [manager.setBundleEnabled, manager.setPluginEnabled, manager.setVersionExemption, manager.undo, manager.restore, manager.previewUndo, manager.previewRestore]) {
      expect(spy).not.toHaveBeenCalled()
    }
    expect(approval).not.toHaveBeenCalled()
    expect((await readChangeLog(profile.home, PROFILE)).entries).toEqual([])
    expect(snapshot(profile.profileDir)).toEqual(before)
  })

  it('a listener that allows a restore without the plugin\'s listener is overruled by its guard', async () => {
    const { ctx, manager, approval, profile, call } = await harness(true, true, true)
    const before = snapshot(profile.profileDir)
    // Prepended after the plugin's, so it runs first and never calls next().
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })
    const result = await call({ action: 'restore', target: 'version-1' })
    expect(text(result)).toBe('Error: Plugin changes wait for the person at their computer; this call was not handled as one, so it does not run.')
    expect(approval).not.toHaveBeenCalled()
    expect(manager.previewRestore).not.toHaveBeenCalled()
    expect(manager.restore).not.toHaveBeenCalled()
    expect((await readChangeLog(profile.home, PROFILE)).entries).toEqual([])
    expect(snapshot(profile.profileDir)).toEqual(before)
  })

  it('leaves every other tool and action to upstream', async () => {
    const { manager, approval, call } = await harness(true)
    const result = await call({ action: 'list_plugins' })
    expect(result.isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(manager.listPlugins).toHaveBeenCalledTimes(1)
    expect(plugin.heldRequest({ name: 'write', arguments: { action: 'install_bundle' } })).toBeUndefined()
    expect(plugin.heldRequest({ name: 'plugin_manager', arguments: undefined })).toBeUndefined()
    expect(plugin.heldRequest({ name: 'plugin_manager', arguments: { action: 7 } })).toBeUndefined()
    expect(plugin.heldRequest({ name: 'plugin_manager', arguments: { action: 'toString' } })).toBeUndefined()
  })
})

describe('with protection off', () => {
  it.each(['off', 'none'] as const)('records the model\'s plugin_manager install as pending at protection %s, and a removal goes to upstream', async (level) => {
    const { manager, approval, profile, call } = await harness(true, true, false, level)
    const result = await call({ action: 'install_bundle', target: 'link:/work/plugins/new-plugin' })
    expect(result.error?.info).toEqual({ name: 'PluginChangePending', code: plugin.PLUGIN_CHANGE_PENDING })
    expect(manager.installBundle).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect((await readChangeLog(profile.home, PROFILE)).entries).toEqual([expect.objectContaining({ kind: 'plugin-install', state: 'pending' })])
    expect((await call({ action: 'remove_bundle', target: 'installed-plugin' })).isError).toBe(false)
    expect(manager.removeBundle).toHaveBeenCalledWith('installed-plugin')
    expect(approval).toHaveBeenCalledTimes(1)
  })

  it('holds a chat\'s install and turn-on at protection off although the chat has full access', async () => {
    const { manager, approval, call } = await harness(true, true, false, 'off', 'danger-full-access')
    expect((await call({ action: 'install_bundle', target: 'link:/work/plugins/new-plugin' })).error?.info).toEqual({ name: 'PluginChangePending', code: plugin.PLUGIN_CHANGE_PENDING })
    expect((await call({ action: 'set_bundle', target: 'new-plugin', enabled: true })).error?.info).toEqual({ name: 'PluginChangeAtComputer', code: plugin.PLUGIN_CHANGE_AT_COMPUTER })
    expect(manager.installBundle).not.toHaveBeenCalled()
    expect(manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
  })

  it('keeps holding a chat\'s install and turn-on in dangerous mode: full access, every approval allowed and the default protection record change nothing (A330)', async () => {
    // Dangerous mode gives the chat danger-full-access with approvals the person never answers; neither reaches the hold on a plugin that is not on yet.
    const { manager, approval, profile, call } = await harness(true, true, false, 'none', 'danger-full-access')
    for (const target of ['link:/work/plugins/new-plugin', 'registry-plugin@2.0.0']) {
      expect((await call({ action: 'install_bundle', target })).error?.info, target).toEqual({ name: 'PluginChangePending', code: plugin.PLUGIN_CHANGE_PENDING })
    }
    expect((await call({ action: 'set_plugin', target: 'new-plugin', enabled: true })).error?.info).toEqual({ name: 'PluginChangeAtComputer', code: plugin.PLUGIN_CHANGE_AT_COMPUTER })
    expect(manager.installBundle).not.toHaveBeenCalled()
    expect(manager.setPluginEnabled).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect((await readChangeLog(profile.home, PROFILE)).entries).toHaveLength(2)
  })

  it('leaves a turn-on to the person at the computer at protection off, and a turn-off to upstream', async () => {
    const { manager, call } = await harness(true, true, false, 'off')
    for (const action of ['set_bundle', 'set_plugin']) {
      const result = await call({ action, target: 'some-plugin', enabled: true })
      expect(result.error?.info).toEqual({ name: 'PluginChangeAtComputer', code: plugin.PLUGIN_CHANGE_AT_COMPUTER })
    }
    expect(manager.setBundleEnabled).not.toHaveBeenCalled()
    expect(manager.setPluginEnabled).not.toHaveBeenCalled()
    expect((await call({ action: 'set_plugin', target: 'some-plugin', enabled: false })).isError).toBe(false)
    expect(manager.setPluginEnabled).toHaveBeenCalledTimes(1)
  })

  it('leaves undo, restore and any turn-on that is not a boolean false to the person at every level, dangerous mode included', async () => {
    for (const level of ['off', 'none'] as const) {
      const { manager, approval, call } = await harness(true, true, true, level, 'danger-full-access')
      for (const args of [
        { action: 'undo' }, { action: 'restore', target: 'version-1' },
        { action: 'set_plugin', target: 'p', enabled: 'true' }, { action: 'set_bundle', target: 'p', enabled: 1 },
      ]) {
        expect((await call(args)).error?.info, `${level} ${JSON.stringify(args)}`).toEqual({ name: 'PluginChangeAtComputer', code: plugin.PLUGIN_CHANGE_AT_COMPUTER })
      }
      for (const spy of [manager.undo, manager.restore, manager.setPluginEnabled, manager.setBundleEnabled]) expect(spy).not.toHaveBeenCalled()
      expect(approval).not.toHaveBeenCalled()
    }
  })

  it('every other action that changes what runs goes to upstream too', async () => {
    const { manager, approval, call } = await harness(true, true, true, 'off')
    expect((await call({ action: 'set_bundle', target: 'installed-plugin', enabled: false })).isError).toBe(false)
    expect(manager.setBundleEnabled).toHaveBeenCalledTimes(1)
    expect(approval).toHaveBeenCalledTimes(1)
  })

  it('a listener that allows the call without the plugin\'s listener is still overruled by its guard', async () => {
    const { ctx, manager, approval, call } = await harness(true, true, false, 'off')
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })
    const result = await call({ action: 'install_bundle', target: 'new-plugin' })
    expect(text(result)).toBe('Error: Plugin changes wait for the person at their computer; this call was not handled as one, so it does not run.')
    expect(approval).not.toHaveBeenCalled()
    expect(manager.installBundle).not.toHaveBeenCalled()
  })

  it('a protection record that cannot be read holds the call', async () => {
    const { manager, approval, profile, call } = await harness(true, true, true, 'off')
    writeFileSync(protectionPath(profile.home), 'not json', { mode: 0o600 })
    for (const args of [{ action: 'install_bundle', target: 'new-plugin' }, { action: 'set_bundle', target: 'installed-plugin', enabled: false }]) {
      const result = await call(args)
      expect(result.isError).toBe(true)
      expect(result.error?.info).toEqual({ name: 'PluginChangeUnrecorded', code: plugin.PLUGIN_CHANGE_UNRECORDED })
      expect(text(result)).toMatch(new RegExp(`^Error: ${args.action} changes what the person's harness runs, and the protection setting that decides whether it waits for the person cannot be read: .+ Nothing was changed; tell the person, who checks it with delorun changes protection\\.$`, 's'))
    }
    expect(approval).not.toHaveBeenCalled()
    expect(manager.installBundle).not.toHaveBeenCalled()
    expect(manager.setBundleEnabled).not.toHaveBeenCalled()
    expect((await readChangeLog(profile.home, PROFILE)).entries).toEqual([])
  })

  it('reads the setting at each call, so changing it takes effect in the running Host without a restart', async () => {
    const { manager, approval, profile, call } = await harness(true, true, false, 'off')
    expect((await call({ action: 'remove_bundle', target: 'first-plugin' })).isError).toBe(false)
    expect(manager.removeBundle).toHaveBeenCalledTimes(1)
    await protect(profile.home, 'on')
    const held = await call({ action: 'install_bundle', target: 'second-plugin' })
    expect(held.error?.info).toEqual({ name: 'PluginChangePending', code: plugin.PLUGIN_CHANGE_PENDING })
    expect(manager.installBundle).not.toHaveBeenCalled()
    expect((await readChangeLog(profile.home, PROFILE)).entries).toEqual([expect.objectContaining({ kind: 'plugin-install', state: 'pending', subject: { plugin: 'second-plugin', spec: 'second-plugin' } })])
    await protect(profile.home, 'off')
    expect((await call({ action: 'remove_bundle', target: 'third-plugin' })).isError).toBe(false)
    expect(manager.removeBundle).toHaveBeenLastCalledWith('third-plugin')
    expect(approval).toHaveBeenCalledTimes(2)
  })
})

describe('the plugin_changes_pending switch', () => {
  it('defaults to off, the parity value', () => {
    expect(plugin.Config()).toEqual({ enabled: false, installationBundles: [] })
    expect(() => plugin.Config({ enabled: true, installationBundles: ['../escape'] })).toThrow()
  })

  it('with the switch at parity the plugin_manager action asks stock\'s approval', async () => {
    const { manager, approval, profile, call } = await harness(false)
    const result = await call({ action: 'install_bundle', target: 'new-plugin' })
    expect(result.isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(1)
    expect(manager.installBundle).toHaveBeenCalledWith('new-plugin', {})
    expect((await call({ action: 'remove_bundle', target: 'installed-plugin' })).isError).toBe(false)
    expect(approval).toHaveBeenCalledTimes(2)
    expect(manager.removeBundle).toHaveBeenCalledWith('installed-plugin')
    expect((await readChangeLog(profile.home, PROFILE)).entries).toEqual([])
  })
})
