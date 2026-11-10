/**
 * Specs of the approved-plugin write consent (C16 switch `approved_plugin_write_consent`) through upstream's real write
 * tool on the local filesystem: the agent's first write in a chat to an approved plugin's folders asks, naming the
 * plugin and carrying the diff, however the path is spelt; later writes in that chat pass and another chat asks again;
 * a refusal leaves the file unwritten; and with the switch at parity the write runs as upstream runs it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { activeDirectory, APPROVED_RECORD_SCHEMA, writeApproved } from '@delo/changes'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { approvedPluginFolders, callDiff, pluginOfTarget, pluginWriteAsk } from '../src/plugin-folders.ts'

// Each case boots the write tool on a real filesystem; a loaded host needs more than the default.
vi.setConfig({ testTimeout: 60_000 })

const PROFILE = 'default'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A Delo home whose profile approved the plugin `plug` from a folder, a workspace beside it, and a link into the folder. */
async function layout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-plugin-writes-')))
  roots.push(root)
  const home = join(root, '.delo')
  const profileDir = join(home, 'profiles', PROFILE)
  const source = join(root, 'plug')
  const workspace = join(root, 'work')
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  mkdirSync(source)
  mkdirSync(workspace)
  writeFileSync(join(source, 'index.js'), 'export default 1\n')
  writeFileSync(join(profileDir, 'package.json'), '{"name":"dsh-profile-default","private":true}\n')
  await writeApproved(profileDir, { schema: APPROVED_RECORD_SCHEMA, plugins: { plug: { source, version: 'a'.repeat(64) as never, approvedAt: '2026-11-10T10:00:00.000Z' } } })
  symlinkSync(source, join(workspace, 'link'))
  return { root, home, profileDir, source, workspace, profile: { home, name: PROFILE, dir: profileDir } }
}

/**
 * An agent whose session has an open turn, so an approval can be asked.
 * @param name - the chat's session id.
 * @returns the agent.
 */
function chat(name: string): Agent {
  const id = SessionId(name)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false })
  session.append('turn/start', { turn: 1 })
  return { id, session } as unknown as Agent
}

/**
 * Upstream's write tool on the local filesystem, the approval service, and the plugin with the given switch.
 * @param switchOn - `approvedPluginWrites`.
 * @param answer - what the person answers to each ask.
 * @returns the layout, the asks the person saw, and a write.
 */
async function harness(switchOn: boolean, answer: ApprovalOutcome = 'allowed-once') {
  const fixture = await layout()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  provideWorkingDirectoryFixture(ctx, fixture.workspace)
  ctx.provide('profileContext', fixture.profile as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: fixture.workspace })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(ToolFs)
  await ctx.plugin({ name: 'instruction-consent', apply }, { enabled: false, approvedPluginWrites: switchOn })
  const asks: ApprovalRequestEvent[] = []
  ctx.on('approval/request', (request) => {
    asks.push(request)
    return Promise.resolve(answer)
  })
  const write = (agent: Agent, path: string, content = 'export default 2\n'): Promise<ToolExecutionResult> =>
    executeToolFixture(ctx, { name: 'write', arguments: { file_path: path, content }, agent, callId: ToolCallId(`call-${String(asks.length)}-${path}`), signal: new AbortController().signal })
  return { ...fixture, ctx, asks, write }
}

/**
 * @param result - a tool result.
 * @returns its text.
 */
function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('the approved-plugin write consent', () => {
  it('the agent\'s first write to an approved plugin\'s folder asks', async () => {
    const { source, asks, write } = await harness(true)
    const first = chat('chat-one')
    const result = await write(first, join(source, 'new.js'), 'export const added = true\n')
    expect(result.isError, text(result)).toBe(false)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ toolName: 'write', reason: expect.stringContaining('The agent is changing what your harness runs: plug. The change will wait for your review in Changes.') as unknown })
    expect(asks[0]!.reason).toContain('--- new ---\nexport const added = true\n')
    expect(asks[0]!.displayReason?.zh).toContain('智能体正在更改你的 harness 运行的内容：plug。')
    expect(readFileSync(join(source, 'new.js'), 'utf8')).toBe('export const added = true\n')

    // A second write in the same chat passes; another chat asks again.
    expect((await write(first, join(source, 'second.js'))).isError).toBe(false)
    expect(asks).toHaveLength(1)
    expect((await write(chat('chat-two'), join(source, 'third.js'))).isError).toBe(false)
    expect(asks).toHaveLength(2)
  })

  it('a symlinked or `..` spelling of the folder asks too, and so does the plugin\'s active directory', async () => {
    const { home, workspace, source, asks, write } = await harness(true)
    expect((await write(chat('via-link'), join(workspace, 'link', 'linked.js'))).isError).toBe(false)
    expect((await write(chat('via-dots'), `${workspace}/../plug/dotted.js`)).isError).toBe(false)
    expect((await write(chat('relative'), 'link/nested/relative.js')).isError).toBe(false)
    const active = activeDirectory(home, PROFILE, 'plug')
    mkdirSync(active, { recursive: true })
    expect((await write(chat('active'), join(active, 'index.js'))).isError).toBe(false)
    expect(asks.map(ask => ask.reason?.split('.')[0])).toEqual(Array.from({ length: 4 }, () => 'The agent is changing what your harness runs: plug'))
    expect(existsSync(join(source, 'linked.js')) && existsSync(join(source, 'dotted.js')) && existsSync(join(source, 'nested', 'relative.js'))).toBe(true)
  })

  it('a refused ask leaves the file unwritten, and the next write asks again', async () => {
    const { source, asks, write } = await harness(true, 'rejected')
    const agent = chat('refusing')
    const result = await write(agent, join(source, 'refused.js'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`the user refused the write to "${join(source, 'refused.js')}", which changes the plugin plug; it stays unchanged`)
    expect(result.error?.info).toEqual({ name: 'WriteConsentRefusedError', code: 'FS_CONSENT_DENIED' })
    expect(existsSync(join(source, 'refused.js'))).toBe(false)
    await write(agent, join(source, 'refused.js'))
    expect(asks).toHaveLength(2)
  })

  it.each([
    ['cancelled', 'was cancelled'],
    ['unavailable', 'requires approval, but no approval channel is available'],
  ] as const)('a %s ask leaves the file unwritten', async (answer, words) => {
    const { source, write } = await harness(true, answer)
    const result = await write(chat(answer), join(source, `${answer}.js`))
    expect(text(result)).toContain(words)
    expect(existsSync(join(source, `${answer}.js`))).toBe(false)
  })

  it('asks nothing for a write outside every approved plugin\'s folders', async () => {
    const { workspace, asks, write } = await harness(true)
    expect((await write(chat('elsewhere'), join(workspace, 'notes.md'))).isError).toBe(false)
    expect(asks).toEqual([])
  })

  it('refuses a write when the profile\'s record of approved plugins cannot be read', async () => {
    const { profileDir, workspace, asks, write } = await harness(true)
    writeFileSync(join(profileDir, 'package.json'), 'not json')
    const result = await write(chat('unreadable'), join(workspace, 'notes.md'))
    expect(text(result)).toContain('the profile\'s record of approved plugins cannot be read')
    expect(existsSync(join(workspace, 'notes.md'))).toBe(false)
    expect(asks).toEqual([])
  })

  it('with the switch at parity the write runs as upstream runs it', async () => {
    const { source, workspace, asks, write } = await harness(false)
    expect((await write(chat('parity'), join(source, 'unasked.js'))).isError).toBe(false)
    expect((await write(chat('parity'), join(workspace, 'link', 'unasked-link.js'))).isError).toBe(false)
    expect(asks).toEqual([])
    expect(readFileSync(join(source, 'unasked.js'), 'utf8')).toBe('export default 2\n')
  })
})

describe('the consent\'s waterfall', () => {
  /**
   * The plugin mounted alone, with the given services.
   * @param services - the profile and the approval service, when present.
   * @returns the context.
   */
  async function bare(services: { readonly profile?: object, readonly approval?: object }) {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    if (services.profile !== undefined) ctx.provide('profileContext', services.profile as never)
    if (services.approval !== undefined) ctx.provide('approval', services.approval as never)
    await ctx.plugin({ name: 'instruction-consent', apply }, { enabled: false, approvedPluginWrites: true })
    return ctx
  }

  it('passes an emission no tool made, and any write in a harness that runs no profile', async () => {
    const fixture = await layout()
    const target = { targetKey: 'k' as never, displayPath: join(fixture.source, 'x.js') }
    const withProfile = await bare({ profile: fixture.profile })
    expect(await withProfile.waterfall('fs/write-intent', target, undefined, () => 'next' as never)).toBe('next')
    const withoutProfile = await bare({})
    expect(await withoutProfile.waterfall('fs/edit-intent', target, { name: 'edit' }, () => 'next' as never)).toBe('next')
  })

  it('refuses a call with no agent or no approval service, and asks without a call id', async () => {
    const fixture = await layout()
    const target = { targetKey: 'k' as never, displayPath: join(fixture.source, 'x.js') }
    const noApproval = await bare({ profile: fixture.profile })
    await expect(noApproval.waterfall('fs/delete-intent', target, { name: 'apply_patch' }, () => 'next' as never)).rejects.toThrow('the apply_patch to "' + target.displayPath + '" changes the plugin plug and requires approval, but the call has no agent to route it through')
    await expect(noApproval.waterfall('fs/delete-intent', target, { name: 'apply_patch', agent: chat('a') }, () => 'next' as never)).rejects.toThrow('requires approval, but no approval service is composed')
    const request = vi.fn(async (_request: object) => 'allowed-once' as const)
    const withApproval = await bare({ profile: fixture.profile, approval: { request } })
    expect(await withApproval.waterfall('fs/write-intent', target, { name: 'custom_writer', agent: chat('b') }, () => 'next' as never)).toBe('next')
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'custom_writer', reason: expect.stringContaining('(the tool carries no diff)') as unknown }))
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty('callId')
  })
})

describe('the folders and the target', () => {
  it('reads every approved plugin\'s source and active directory, and none without a record', async () => {
    const fixture = await layout()
    expect(await approvedPluginFolders(fixture.profile)).toEqual([{ plugin: 'plug', folders: [fixture.source, activeDirectory(fixture.home, PROFILE, 'plug')] }])
    writeFileSync(join(fixture.profileDir, 'package.json'), '{"name":"dsh-profile-default"}')
    expect(await approvedPluginFolders(fixture.profile)).toEqual([])
  })

  it('follows a dangling link to where a write through it would land, and gives up on a loop', async () => {
    const fixture = await layout()
    const plugins = await approvedPluginFolders(fixture.profile)
    symlinkSync(join(fixture.source, 'future.js'), join(fixture.workspace, 'dangling.js'))
    expect(await pluginOfTarget(join(fixture.workspace, 'dangling.js'), plugins)).toBe('plug')
    symlinkSync(join(fixture.workspace, 'loop-b'), join(fixture.workspace, 'loop-a'))
    symlinkSync(join(fixture.workspace, 'loop-a'), join(fixture.workspace, 'loop-b'))
    expect(await pluginOfTarget(join(fixture.workspace, 'loop-a', 'x.js'), plugins)).toBeUndefined()
    expect(await pluginOfTarget(join(fixture.source), plugins)).toBe('plug')
    expect(await pluginOfTarget(`${fixture.source}-sibling/x.js`, plugins)).toBeUndefined()
    // A folder named with a trailing separator compares the same.
    expect(await pluginOfTarget(join(fixture.source, 'x.js'), [{ plugin: 'plug', folders: [`${fixture.source}/`] }])).toBe('plug')
  })

  it('carries each writing tool\'s diff', () => {
    expect(callDiff('write', { content: 'all' })).toEqual({ old: null, new: 'all' })
    expect(callDiff('write', {})).toEqual({ old: null, new: '' })
    expect(callDiff('edit', { old_string: 'a', new_string: 'b' })).toEqual({ old: 'a', new: 'b' })
    expect(callDiff('apply_patch', { input: '*** Begin Patch' })).toBe('*** Begin Patch')
    expect(callDiff('apply_patch', {})).toBeUndefined()
    expect(callDiff('str_replace_editor', { file_text: 'whole' })).toEqual({ old: null, new: 'whole' })
    expect(callDiff('str_replace_editor', { old_str: 'a', new_str: 'b' })).toEqual({ old: 'a', new: 'b' })
    expect(callDiff('other', {})).toBeUndefined()
    expect(pluginWriteAsk('plug', 'patch text')).toEqual({
      en: 'The agent is changing what your harness runs: plug. The change will wait for your review in Changes. The diff, verbatim:\npatch text',
      zh: '智能体正在更改你的 harness 运行的内容：plug。这项更改会在“更改”中等待你的审查。差异原文：\npatch text',
    })
  })
})
