/**
 * Specs of `@delo/plugin-changes` against upstream's real `plugin_manager` tool and tool pipeline: with the C16 switch
 * `plugin_changes_pending` on, the model's install, update and removal record a pending change and change nothing the
 * profile runs, without reaching the tool's full-access approval; a listener that allows such a call without the
 * plugin's listener is overruled by its guard; and with the switch at parity the tool asks its approval as upstream's
 * does.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type PluginManager from '@deepseek-ai/dsh-plugin-manager'
import * as tool from '@deepseek-ai/dsh-plugin-manager/tools'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { readChangeLog } from '@delo/changes'
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

/** An agent whose session has an open turn, so an approval can be asked. */
function activeAgent(): Agent {
  const id = SessionId('plugin-changes')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  session.append('turn/start', { turn: 1 })
  return { session } as unknown as Agent
}

/**
 * Upstream's `plugin_manager` tool with a manager whose changes are spies, the approval service asking every time, and
 * this plugin mounted with the given switch.
 * @param enabled - the switch.
 * @param withProfile - whether the Host runs a profile launched by dsh.
 * @returns the context, the manager, the approval spy, the profile and a call.
 */
async function harness(enabled: boolean, withProfile = true) {
  const profile = home()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const manager = {
    installBundle: vi.fn(async () => ({ changed: true, application: 'applied' })),
    removeBundle: vi.fn(async () => ({ changed: true, application: 'applied' })),
    listPlugins: vi.fn(async () => []),
  }
  ctx.provide('pluginManager', manager as unknown as PluginManager)
  if (withProfile) ctx.provide('profileContext', { name: PROFILE, dir: profile.profileDir, home: profile.home } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(tool, {})
  await ctx.plugin(plugin, { enabled })
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
    const { manager, call } = await harness(true, false)
    const result = await call({ action: 'install_bundle', target: 'new-plugin' })
    expect(text(result)).toContain('could not be recorded: this harness runs no profile whose changes Delo keeps.')
    expect(manager.installBundle).not.toHaveBeenCalled()
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
    expect(text(result)).toBe('Error: Plugin installs, updates and removals wait for the person\'s review at their computer; this call was not recorded as a change, so it does not run.')
    expect(approval).not.toHaveBeenCalled()
    expect(manager.installBundle).not.toHaveBeenCalled()
    expect((await readChangeLog(profile.home, PROFILE)).entries).toEqual([])
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

describe('the plugin_changes_pending switch', () => {
  it('defaults to off, the parity value', () => {
    expect(plugin.Config()).toEqual({ enabled: false })
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
