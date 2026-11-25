/**
 * Specs of `@delorun/plugin-delegation-consent`: the review's order and its refusals, the ask's grant marker, the
 * per-workspace grant and its revoke, the grants file's refusals, the plugin_manager guard, the routes' loopback rule,
 * and, through the real subagent runtime, that an external agent without consent never starts.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { DELEGATION_CONSENT_PROVIDER_EXPORT } from '@deepseek-ai/dsh-subagent/consent'
import type { ExternalDelegationVerdict, SubagentResult } from '@deepseek-ai/dsh-subagent'
import ApprovalService, { setApprovalPolicy, type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCondition, type ComputerOnlySwitch } from '@delorun/home-auth'
import { apply, Config, DelorunDelegationConsent, EXTERNAL_AGENT_CONSENT_SWITCH, FULL_ACCESS_STARTS_AGENTS_SWITCH, DelegationConsentError, PLUGIN_MANAGER_REFUSAL, pluginManagerVerdict } from '../src/index.ts'
import { guardProfile, isExternalAgentPackage, modulePackage, targetPackageNames, type GuardProfile } from '../src/guard.ts'
import { agentName, askText, askTextZh, describeAgent, noSandboxPolicyRefusal, notApprovedRefusal, noWorkspaceRefusal } from '../src/copy.ts'
import { registerDelegationRoutes } from '../src/routes.ts'
import { changeGrantStore, grantStorePath, parseGrantStore, problemOf, readGrantStore } from '../src/store.ts'
import { DELEGATION_CONSENT_ROUTES, type AgentLevel, type DelegationConsentSettings } from '../src/wire.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh home and two workspace folders. */
function folders(): { home: string, workspace: string, other: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-delegation-consent-')))
  roots.push(root)
  const paths = { home: join(root, 'home'), workspace: join(root, 'work'), other: join(root, 'other') }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
  return paths
}

/** A local subagent's chat: its session header names the delegating chat as its parent. */
function child(cwd: string | undefined, id: string, parent: Agent): Agent {
  return { id: SessionId(id), session: { id: SessionId(id), header: { cwd, origin: 'subagent', parentSession: parent.id } } } as never
}

/** A parent chat whose session runs in a folder. */
function chat(cwd: string | undefined, id = 'chat-1'): Agent {
  const agent: Agent = { id: SessionId(id), session: { id: SessionId(id), header: { cwd } } } as never
  return agent
}

interface Mounted {
  readonly ctx: Context
  readonly consent: DelorunDelegationConsent
  readonly asks: ApprovalRequest[]
  readonly home: string
  readonly workspace: string
  readonly other: string
}

/**
 * The service over a fresh home with optional fake neighbours.
 * @param options - the chat's mode (`workspace-write` by default, none for no sandbox policy), the approval's answer (none
 *   for no approval service), and the agents and providers.
 */
async function mounted(options: {
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access' | null
  answer?: (() => ApprovalOutcome) | null
  agents?: readonly Agent[] | ((paths: { workspace: string }) => readonly Agent[])
  providers?: Record<string, { prepareContinuable?: () => void }>
  /** The approval policy of the configured approval service. */
  policy?: 'ask' | 'never'
  /** The `fullAccessStartsAgents` switch; on by default, as the schema defaults it. */
  fullAccess?: boolean
  /** A chat's own logged sandbox mode by session id, over `mode`. */
  modeOf?: Record<string, 'workspace-write' | 'danger-full-access'>
  /** A chat's own logged approval policy by session id, over the configured one. */
  policyOf?: Record<string, 'ask' | 'never'>
} = {}): Promise<Mounted> {
  const paths = folders()
  const ctx = new Context()
  const asks: ApprovalRequest[] = []
  if (options.mode !== null) ctx.provide('sandboxPolicy', { resolve: (request: { session: { id: string } }) => ({ mode: options.modeOf?.[request.session.id] ?? options.mode ?? 'workspace-write' }) } as never)
  if (options.answer !== null) {
    const answer = options.answer ?? (() => 'allowed-once')
    ctx.provide('approval', { request: (request: ApprovalRequest) => { asks.push(request); return Promise.resolve(answer()) }, config: { policy: options.policy ?? 'ask' }, overrideOf: (session: { id: string }) => options.policyOf?.[session.id] } as never)
  }
  const agents = typeof options.agents === 'function' ? options.agents(paths) : options.agents ?? []
  ctx.provide('agents', { get: (id: string) => agents.find(agent => agent.id === id) } as never)
  ctx.provide('subagents', { getProvider: (name: string) => options.providers?.[name] } as never)
  await ctx.plugin(DelorunDelegationConsent, { timeoutMs: () => 1_800_000, fullAccessStartsAgents: () => options.fullAccess ?? true, env: { DELORUN_HOME: paths.home }, now: () => 1_000, levelOf: () => 'standard', missingSandboxTools: () => [] })
  return { ctx, consent: ctx.get('delegationConsent') as DelorunDelegationConsent, asks, ...paths }
}

/** A review of one start in a folder. */
function review(parent: Agent, cwd: string, provider = 'claude-code') {
  return { provider, parent, cwd, label: 'Review the diff', signal: new AbortController().signal }
}

/** Record a grant straight into the home's grants file. */
async function grant(home: string, workspace: string, provider = 'claude-code'): Promise<void> {
  await changeGrantStore(grantStorePath(home), grants => [...grants, { workspace, provider, grantedAt: 5 }])
}

/**
 * The row's configuration as the loader validates it.
 * @param value - the row's fields.
 * @returns the validated configuration.
 */
const configOf = (value: Partial<DelegationConsentSettings>): Parameters<typeof apply>[1] => Config(value)

describe('the review', () => {
  it('asks with the external-agent grant marker and allows once, recording nothing', async () => {
    const { consent, asks, home, workspace } = await mounted()
    const verdict = await consent.review(review(chat(workspace), workspace))
    expect(verdict).toEqual({ kind: 'allow', timeoutMs: 1_800_000 })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ toolName: 'claude-code', grants: 'external-agent', reason: askText({ provider: 'claude-code', workspace, cwd: workspace, label: 'Review the diff' }) })
    expect(asks[0]?.displayReason?.['zh']).toContain('Claude Code')
    // Allow once does not persist: the grants file is never written, and the next start asks again.
    expect((await readGrantStore(grantStorePath(home)))).toEqual({ kind: 'readable', grants: [] })
    await consent.review(review(chat(workspace), workspace))
    expect(asks).toHaveLength(2)
  })

  it('refuses a read-only chat before the grant and the ask', async () => {
    const { consent, asks, home, workspace } = await mounted({ mode: 'read-only' })
    await grant(home, workspace)
    const verdict = await consent.review(review(chat(workspace), workspace))
    expect(verdict).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('this chat runs read-only') })
    expect(asks).toEqual([])
  })

  it('refuses a run folder outside the chat\'s workspace without asking', async () => {
    const { consent, asks, workspace, other } = await mounted({ mode: 'workspace-write' })
    const verdict = await consent.review(review(chat(workspace), other))
    expect(verdict).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('is outside it') })
    expect(asks).toEqual([])
    await expect(consent.review(review(chat(workspace), join(workspace, 'sub')))).resolves.toMatchObject({ kind: 'allow' })
    await expect(consent.review(review(chat(`${workspace}/`), workspace))).resolves.toMatchObject({ kind: 'allow' })
  })

  it('starts a granted agent without asking, for that workspace and agent only', async () => {
    const { consent, asks, home, workspace, other } = await mounted()
    await grant(home, workspace)
    await expect(consent.review(review(chat(workspace), workspace))).resolves.toEqual({ kind: 'allow', timeoutMs: 1_800_000 })
    expect(asks).toEqual([])
    await consent.review(review(chat(other), other))
    await consent.review(review(chat(workspace), workspace, 'codex'))
    expect(asks).toHaveLength(2)
  })

  describe('in a chat whose approval policy is never', () => {
    it('allows with the switch on, without an approval request or a grant', async () => {
      const { consent, asks, home, workspace } = await mounted({ policy: 'never', mode: 'danger-full-access', fullAccess: true })
      await expect(consent.review(review(chat(workspace), workspace))).resolves.toEqual({ kind: 'allow', timeoutMs: 1_800_000 })
      await expect(consent.review(review(chat(workspace), workspace, 'codex'))).resolves.toMatchObject({ kind: 'allow' })
      expect(asks).toEqual([])
      expect(await readGrantStore(grantStorePath(home))).toEqual({ kind: 'readable', grants: [] })
    })

    it('refuses with the switch off, naming the workspace allowance and the switch', async () => {
      const { consent, asks, workspace } = await mounted({ policy: 'never', mode: 'danger-full-access', fullAccess: false, answer: () => 'rejected' })
      const verdict = await consent.review(review(chat(workspace), workspace))
      expect(verdict).toEqual({ kind: 'refuse', reason: notApprovedRefusal('claude-code', 'never', workspace) })
      expect(verdict).toMatchObject({ reason: expect.stringContaining('"Allow for this workspace" in Settings') })
      expect(verdict).toMatchObject({ reason: expect.stringContaining('"Full access chats start agents without asking"') })
      expect(asks).toHaveLength(1)
    })

    it('keeps today\'s refusal for a never policy on a sandboxed preset, with the switch on', async () => {
      const { consent, asks, workspace } = await mounted({ policy: 'never', mode: 'workspace-write', fullAccess: true, answer: () => 'rejected' })
      await expect(consent.review(review(chat(workspace), workspace))).resolves.toEqual({ kind: 'refuse', reason: notApprovedRefusal('claude-code', 'never', workspace) })
      expect(asks).toHaveLength(1)
    })

    describe('for a local subagent', () => {
      /** The chats of a root, its child and its grandchild, in the workspace of the mounted folders. */
      const lineage = (paths: { workspace: string }): Agent[] => {
        const root = chat(paths.workspace, 'root')
        const first = child(paths.workspace, 'child', root)
        return [root, first, child(paths.workspace, 'grand', first)]
      }

      it('asks for the child and the grandchild of an Ask root on danger-full-access', async () => {
        const mount = await mounted({ policy: 'ask', mode: 'danger-full-access', policyOf: { child: 'never', grand: 'never' }, agents: lineage, answer: () => 'rejected' })
        const [, first, second] = lineage(mount)
        for (const delegating of [first as Agent, second as Agent]) {
          await expect(mount.consent.review(review(delegating, mount.workspace))).resolves.toEqual({ kind: 'refuse', reason: notApprovedRefusal('claude-code', 'never', mount.workspace) })
        }
        expect(mount.asks).toHaveLength(2)
      })

      it('starts the child and the grandchild of a Full access root without asking', async () => {
        const mount = await mounted({ policy: 'ask', mode: 'danger-full-access', policyOf: { root: 'never', child: 'never', grand: 'never' }, agents: lineage })
        const [, first, second] = lineage(mount)
        for (const delegating of [first as Agent, second as Agent]) await expect(mount.consent.review(review(delegating, mount.workspace))).resolves.toMatchObject({ kind: 'allow' })
        expect(mount.asks).toEqual([])
      })

      it('reads the root\'s own sandbox mode, not the inherited one', async () => {
        const mount = await mounted({ policy: 'ask', mode: 'danger-full-access', modeOf: { root: 'workspace-write' }, policyOf: { root: 'never', child: 'never' }, agents: lineage, answer: () => 'rejected' })
        const [, first] = lineage(mount)
        await expect(mount.consent.review(review(first as Agent, mount.workspace))).resolves.toMatchObject({ kind: 'refuse' })
        expect(mount.asks).toHaveLength(1)
      })

      it('counts an ancestor it cannot find, or a cycle, as not Full access', async () => {
        const lost = await mounted({ policy: 'never', mode: 'danger-full-access', answer: () => 'rejected' })
        const orphan = child(lost.workspace, 'child', chat(lost.workspace, 'root'))
        await expect(lost.consent.review(review(orphan, lost.workspace))).resolves.toMatchObject({ kind: 'refuse' })
        const ring = (paths: { workspace: string }): Agent[] => {
          const a = { id: SessionId('a'), session: { id: SessionId('a'), header: { cwd: paths.workspace, origin: 'subagent', parentSession: SessionId('b') } } } as never as Agent
          const b = { id: SessionId('b'), session: { id: SessionId('b'), header: { cwd: paths.workspace, origin: 'subagent', parentSession: SessionId('a') } } } as never as Agent
          return [a, b]
        }
        const cycle = await mounted({ policy: 'never', mode: 'danger-full-access', answer: () => 'rejected', agents: ring })
        await expect(cycle.consent.review(review(ring(cycle)[0] as Agent, cycle.workspace))).resolves.toMatchObject({ kind: 'refuse' })
      })
    })

    it('still refuses a read-only chat, a chat without a workspace and a folder outside it, and a grants file that cannot be read', async () => {
      const readOnly = await mounted({ policy: 'never', mode: 'read-only' })
      await expect(readOnly.consent.review(review(chat(readOnly.workspace), readOnly.workspace))).resolves.toMatchObject({ kind: 'refuse', reason: expect.stringContaining('this chat runs read-only') })
      const noPolicy = await mounted({ policy: 'never', mode: null })
      await expect(noPolicy.consent.review(review(chat(noPolicy.workspace), noPolicy.workspace))).resolves.toEqual({ kind: 'refuse', reason: noSandboxPolicyRefusal('claude-code') })
      const open = await mounted({ policy: 'never', mode: 'danger-full-access' })
      await expect(open.consent.review(review(chat(undefined), open.workspace))).resolves.toEqual({ kind: 'refuse', reason: noWorkspaceRefusal('claude-code') })
      await expect(open.consent.review(review(chat(open.workspace), open.other))).resolves.toMatchObject({ kind: 'refuse', reason: expect.stringContaining('is outside it') })
      await grant(open.home, open.workspace)
      writeFileSync(grantStorePath(open.home), '{ not json')
      await expect(open.consent.review(review(chat(open.workspace), open.workspace))).resolves.toMatchObject({ kind: 'refuse', reason: expect.stringContaining('cannot be read') })
      for (const mounted of [readOnly, noPolicy, open]) expect(mounted.asks).toEqual([])
    })

    it('still starts a granted agent in both policies, and still asks in a chat whose policy asks', async () => {
      const never = await mounted({ policy: 'never', mode: 'danger-full-access', fullAccess: false })
      await grant(never.home, never.workspace)
      await expect(never.consent.review(review(chat(never.workspace), never.workspace))).resolves.toMatchObject({ kind: 'allow' })
      expect(never.asks).toEqual([])
      const ask = await mounted({ policy: 'ask', mode: 'danger-full-access', fullAccess: true })
      await expect(ask.consent.review(review(chat(ask.workspace), ask.workspace))).resolves.toMatchObject({ kind: 'allow' })
      expect(ask.asks).toHaveLength(1)
      expect(ask.asks[0]).toMatchObject({ grants: 'external-agent' })
      await grant(ask.home, ask.workspace)
      await ask.consent.review(review(chat(ask.workspace), ask.workspace))
      expect(ask.asks).toHaveLength(1)
    })
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('refuses when the ask ends %s', async (outcome) => {
    const { consent, workspace } = await mounted({ answer: () => outcome })
    const verdict = await consent.review(review(chat(workspace), workspace))
    expect(verdict).toEqual({ kind: 'refuse', reason: notApprovedRefusal('claude-code', outcome, workspace) })
  })

  it('refuses when no approval service can ask', async () => {
    const { consent, workspace } = await mounted({ answer: null })
    await expect(consent.review(review(chat(workspace), workspace))).resolves.toMatchObject({ kind: 'refuse', reason: expect.stringContaining('no one could be asked') })
  })

  it('refuses a chat without a workspace folder without asking, whatever was granted', async () => {
    const { consent, asks, home } = await mounted()
    const run = folders().workspace
    await grant(home, run)
    await expect(consent.review(review(chat(undefined), run))).resolves.toEqual({ kind: 'refuse', reason: noWorkspaceRefusal('claude-code') })
    expect(asks).toEqual([])
  })

  it('refuses without asking while no sandbox policy can tell a read-only chat apart', async () => {
    const { consent, asks, home, workspace } = await mounted({ mode: null })
    await grant(home, workspace)
    await expect(consent.review(review(chat(workspace), workspace))).resolves.toEqual({ kind: 'refuse', reason: noSandboxPolicyRefusal('claude-code') })
    expect(asks).toEqual([])
  })

  it('names the folder the agent runs in when it is inside the workspace', async () => {
    const { consent, asks, workspace } = await mounted()
    const sub = join(workspace, 'packages', 'api')
    mkdirSync(sub, { recursive: true })
    await consent.review(review(chat(workspace), sub))
    expect(asks[0]?.reason).toContain(`Start Claude Code in ${sub}, inside the workspace ${workspace}?`)
    expect(asks[0]?.displayReason?.['zh']).toContain(`${sub}（位于工作区 ${workspace} 内）`)
  })

  it.each([
    ['another format', '{"v":2,"grants":[]}', 0o600],
    ['a laxer mode', '{"v":1,"grants":[]}', 0o644],
  ])('refuses without asking while the grants file has %s', async (_name, text, mode) => {
    const { consent, asks, home, workspace } = await mounted()
    const path = grantStorePath(home)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, text, { mode })
    chmodSync(path, mode)
    await expect(consent.review(review(chat(workspace), workspace))).resolves.toMatchObject({ kind: 'refuse', reason: expect.stringContaining('cannot be read') })
    expect(asks).toEqual([])
    await expect(consent.grants()).resolves.toMatchObject({ grants: [], storeProblem: expect.any(String) })
    await expect(consent.revoke({ workspace, provider: 'claude-code' })).rejects.toMatchObject({ code: 'STORE_REFUSED' })
  })
})

describe('the workspace grant', () => {
  const external = { 'claude-code': {}, 'spawn': { prepareContinuable: () => undefined } }

  it('records a confirmed grant for an open chat\'s workspace, which then starts without asking until revoked', async () => {
    const paths = folders()
    const parent = chat(paths.workspace)
    const { consent, asks, home, workspace } = await mounted({ agents: [parent], providers: external })
    await expect(consent.allowWorkspace({ sessionId: 'chat-1', provider: 'claude-code', confirmed: true }))
      .resolves.toEqual({ grant: { workspace: paths.workspace, provider: 'claude-code', agent: 'Claude Code', grantedAt: 1_000 } })
    expect(JSON.parse(readFileSync(grantStorePath(home), 'utf8'))).toEqual({ v: 1, grants: [{ workspace: paths.workspace, provider: 'claude-code', grantedAt: 1_000 }] })
    await expect(consent.review(review(parent, paths.workspace))).resolves.toMatchObject({ kind: 'allow' })
    expect(asks).toEqual([])
    // Allowing again keeps the first grant's time.
    await consent.allowWorkspace({ sessionId: 'chat-1', provider: 'claude-code', confirmed: true })
    await expect(consent.grants()).resolves.toEqual({ grants: [{ workspace: paths.workspace, provider: 'claude-code', agent: 'Claude Code', grantedAt: 1_000 }] })
    // The revoke takes effect at the next start.
    await expect(consent.revoke({ workspace: paths.workspace, provider: 'claude-code' })).resolves.toEqual({ revoked: true })
    await expect(consent.revoke({ workspace: paths.workspace, provider: 'claude-code' })).resolves.toEqual({ revoked: false })
    await consent.review(review(parent, paths.workspace))
    expect(asks).toHaveLength(1)
    expect(workspace).not.toBe(paths.workspace)
  })

  it.each([
    ['UNCONFIRMED', { sessionId: 'chat-1', provider: 'claude-code', confirmed: false }],
    ['UNKNOWN_AGENT', { sessionId: 'chat-1', provider: 'spawn', confirmed: true }],
    ['UNKNOWN_AGENT', { sessionId: 'chat-1', provider: 'missing', confirmed: true }],
    ['UNKNOWN_CHAT', { sessionId: 'chat-9', provider: 'claude-code', confirmed: true }],
  ])('records nothing and refuses with %s', async (code, request) => {
    const paths = folders()
    const { consent, home } = await mounted({ agents: [chat(paths.workspace)], providers: external })
    await expect(consent.allowWorkspace(request)).rejects.toMatchObject({ code })
    await expect(readGrantStore(grantStorePath(home))).resolves.toEqual({ kind: 'readable', grants: [] })
  })

  it('lists the grants by workspace, then agent, and describes an agent for its delegation tool', async () => {
    const { consent, home } = await mounted({ agents: [], providers: external })
    await changeGrantStore(grantStorePath(home), () => [
      { workspace: '/b', provider: 'codex', grantedAt: 1 },
      { workspace: '/a', provider: 'codex', grantedAt: 2 },
      { workspace: '/a', provider: 'claude-code', grantedAt: 3 },
    ])
    expect((await consent.grants()).grants.map(grant => `${grant.workspace} ${grant.provider}`)).toEqual(['/a claude-code', '/a codex', '/b codex'])
    expect(consent.describe('codex')).toBe(describeAgent('codex'))
  })

  it('refuses a chat without a folder and a folder Delorun never adds as a workspace', async () => {
    const noFolder = await mounted({ agents: [chat(undefined)], providers: external })
    await expect(noFolder.consent.allowWorkspace({ sessionId: 'chat-1', provider: 'claude-code', confirmed: true })).rejects.toMatchObject({ code: 'NO_WORKSPACE' })
    const homeFolder = await mounted({ agents: [chat(homedir())], providers: external })
    await expect(homeFolder.consent.allowWorkspace({ sessionId: 'chat-1', provider: 'claude-code', confirmed: true })).rejects.toBeInstanceOf(DelegationConsentError)
  })
})

describe('the safety levels', () => {
  it('names the saved level of Claude Code and Codex at each start, and Careful for a provider under another name', async () => {
    const { consent } = await mounted()
    expect([consent.permissionLevel('claude-code'), consent.permissionLevel('codex'), consent.permissionLevel('claude-code-2'), consent.permissionLevel('toString')]).toEqual(['standard', 'standard', 'careful', 'careful'])
  })

  it('lists both levels and says what Claude Code\'s sandbox lacks only where its level needs it', async () => {
    const lacking = async (level: AgentLevel, tools: readonly string[]) => {
      const ctx = new Context()
      await ctx.plugin(DelorunDelegationConsent, { timeoutMs: () => 1, fullAccessStartsAgents: () => true, env: {}, now: () => 1, levelOf: () => level, missingSandboxTools: () => tools })
      return (ctx.get('delegationConsent') as DelorunDelegationConsent).levels().levels
    }
    expect((await lacking('standard', ['socat']))[0]).toEqual({
      provider: 'claude-code', agent: 'Claude Code', level: 'standard', sandboxMissing: { tools: ['socat'], installCommand: 'sudo apt install bubblewrap socat' },
    })
    expect((await lacking('careful', ['bwrap']))[0]?.sandboxMissing?.tools).toEqual(['bwrap'])
    expect((await lacking('own', ['socat']))[0]).not.toHaveProperty('sandboxMissing')
    expect((await lacking('standard', []))[0]).not.toHaveProperty('sandboxMissing')
    expect((await lacking('standard', ['socat']))[1]).toEqual({ provider: 'codex', agent: 'Codex', level: 'standard' })
  })
})

describe('the grants file', () => {
  it.each([
    ['not an object', '[]'],
    ['another version', '{"v":2,"grants":[]}'],
    ['an extra field', '{"v":1,"grants":[],"x":1}'],
    ['grants that are no list', '{"v":1,"grants":{}}'],
    ['a grant with another field', '{"v":1,"grants":[{"workspace":"/w","provider":"codex","grantedAt":1,"x":1}]}'],
    ['a relative workspace', '{"v":1,"grants":[{"workspace":"w","provider":"codex","grantedAt":1}]}'],
    ['an empty provider', '{"v":1,"grants":[{"workspace":"/w","provider":"","grantedAt":1}]}'],
    ['a negative time', '{"v":1,"grants":[{"workspace":"/w","provider":"codex","grantedAt":-1}]}'],
    ['a null grant', '{"v":1,"grants":[null]}'],
  ])('refuses %s', (_name, text) => {
    expect(() => parseGrantStore(text)).toThrow()
  })

  it('words a failure that is not an Error as text', () => {
    expect(problemOf(new Error('locked'))).toBe('locked')
    expect(problemOf('locked')).toBe('locked')
  })

  it('reads a symbolic link as refused', async () => {
    const { home } = folders()
    await expect(readGrantStore(join(home, 'missing', 'grants.json'))).resolves.toEqual({ kind: 'readable', grants: [] })
    const path = grantStorePath(home)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, 'not json', { mode: 0o600 })
    await expect(readGrantStore(path)).resolves.toMatchObject({ kind: 'refused' })
    await expect(readGrantStore(join(path, '..'))).resolves.toMatchObject({ kind: 'refused' })
  })
})

describe('the copy', () => {
  it('names the known agents and any other provider by its id', () => {
    expect(agentName('codex')).toBe('Codex')
    expect(agentName('acp-gemini')).toBe('acp-gemini')
    expect(describeAgent('claude-code')).toContain('outside Delorun\'s sandbox')
    expect(describeAgent('codex')).toContain('own Codex sign-in and account')
    expect(describeAgent('codex')).toContain('Every run waits until the person approves it at their computer, unless they allowed Codex for this workspace')
    expect(askText({ provider: 'codex', workspace: '/w', cwd: '/w', label: undefined })).not.toContain('Task:')
    // A173's facts stay, and the ask adds that the agent reads the workspace's own project settings.
    expect(askText({ provider: 'codex', workspace: '/w', cwd: '/w', label: undefined })).toContain('runs as its own program, outside Delorun\'s sandbox and approval prompts')
    expect(askText({ provider: 'claude-code', workspace: '/w', cwd: '/w', label: undefined }))
      .toContain('It reads this workspace\'s own project settings, including any MCP servers the project declares, under its own rules rather than Delorun\'s MCP consent.')
    expect(askTextZh({ provider: 'claude-code', workspace: '/w', cwd: '/w', label: undefined }))
      .toContain('它会读取此工作区自己的项目设置，包括项目声明的任何 MCP 服务器，并按其自身的规则处理，而不是 Delorun 的 MCP 同意。')
    expect(askTextZh({ provider: 'codex', workspace: '/w', cwd: '/w', label: 'x' })).toContain('要在 /w 中启动 Codex 吗？任务')
    expect(askTextZh({ provider: 'codex', workspace: '/w', cwd: '/w', label: undefined })).not.toContain('任务')
    expect(notApprovedRefusal('codex', 'cancelled', '/w')).toContain('withdrawn')
    expect(notApprovedRefusal('codex', 'rejected', '/w')).toContain('the person declined')
  })
})

describe('the plugin_manager guard', () => {
  const rows = () => [
    { id: 'e1', rowId: 'subagent-claude-code', name: '@deepseek-ai/dsh-subagent-claude-code' },
    { id: 'e2', rowId: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'e3', rowId: 'subagent-acp', name: '@DeepSeek-AI/dsh-subagent-acp/plugin' },
    { id: 'e4', rowId: 'subagent-fork', name: '@deepseek-ai/dsh-subagent-fork-in-process' },
  ]
  let profile: GuardProfile | undefined
  const call = (args: object) => pluginManagerVerdict({ name: 'plugin_manager', arguments: args }, rows, () => profile)

  it('refuses installing, enabling and configuring an external agent\'s package, however the target spells it', () => {
    const { workspace: dir } = folders()
    // A package the profile holds under node_modules, named by its manifest.
    const local = join(dir, 'node_modules', '@deepseek-ai', 'dsh-subagent-claude-code')
    mkdirSync(local, { recursive: true })
    writeFileSync(join(local, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-subagent-claude-code' }))
    const renamed = join(dir, 'vendor', 'agent')
    mkdirSync(renamed, { recursive: true })
    writeFileSync(join(renamed, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-subagent-codex' }))
    profile = { dir, dependencies: { saved: 'github:someone/agent' } }
    for (const target of [
      '@deepseek-ai/dsh-subagent-claude-code@0.2.2',
      '@deepseek-ai/dsh-subagent-claude-code',
      'x@npm:@deepseek-ai/dsh-subagent-claude-code',
      'npm:@deepseek-ai/dsh-subagent-claude-code@^1',
      './node_modules/@deepseek-ai/dsh-subagent-claude-code',
      local,
      './vendor/agent',
      ' @deepseek-ai/dsh-subagent-claude-code',
      '@DeepSeek-AI/DSH-Subagent-Claude-Code',
      '@deepseek-ai/dsh-subagent-acp',
      '@deepseek-ai/dsh-subagent-dsh-sdk',
      '@deepseek-ai/dsh-experimental-subagent-oar',
    ]) {
      expect(call({ action: 'install_bundle', target }), target).toBe(PLUGIN_MANAGER_REFUSAL)
    }
    // A git spec the profile saved under an external agent's name.
    profile = { dir, dependencies: { '@deepseek-ai/dsh-subagent-codex': 'github:someone/agent' } }
    expect(call({ action: 'install_bundle', target: 'github:someone/agent' })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'set_bundle', target: '@deepseek-ai/dsh-subagent-codex', enabled: true })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'set_plugin', target: 'e1', enabled: true })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'set_plugin', target: ' e3 ', enabled: true })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'configure', target: 'subagent-claude-code', config: { permissionMode: 'bypassPermissions' } })).toBe(PLUGIN_MANAGER_REFUSAL)
    // Without a profile, the target's own text is read.
    profile = undefined
    expect(call({ action: 'install_bundle', target: './node_modules/@deepseek-ai/dsh-subagent-claude-code' })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'install_bundle', target: 'node_modules\\@deepseek-ai\\dsh-subagent-codex' })).toBe(PLUGIN_MANAGER_REFUSAL)
  })

  it('lets disabling, in-process subagents, other packages, other actions and other tools through', () => {
    profile = undefined
    expect(call({ action: 'set_bundle', target: '@deepseek-ai/dsh-subagent-claude-code', enabled: false })).toBeUndefined()
    expect(call({ action: 'install_bundle', target: '@deepseek-ai/dsh-subagent-claude-code', enabled: false })).toBeUndefined()
    expect(call({ action: 'install_bundle', target: '@deepseek-ai/dsh-subagent-spawn-in-process' })).toBeUndefined()
    expect(call({ action: 'install_bundle', target: '/nowhere/package' })).toBeUndefined()
    expect(call({ action: 'install_bundle', target: '/' })).toBeUndefined()
    expect(call({ action: 'set_plugin', target: 'e1', enabled: false })).toBeUndefined()
    expect(call({ action: 'set_plugin', target: 'e2', enabled: true })).toBeUndefined()
    expect(call({ action: 'set_plugin', target: 'e4', enabled: true })).toBeUndefined()
    expect(call({ action: 'configure', target: 'unknown' })).toBeUndefined()
    expect(call({ action: 'remove_bundle', target: '@deepseek-ai/dsh-subagent-claude-code' })).toBeUndefined()
    expect(call({ action: 'list_plugins' })).toBeUndefined()
    expect(pluginManagerVerdict({ name: 'plugin_manager', arguments: null }, rows, () => undefined)).toBeUndefined()
    expect(pluginManagerVerdict({ name: 'bash', arguments: { action: 'install_bundle', target: '@deepseek-ai/dsh-subagent-claude-code' } }, rows, () => undefined)).toBeUndefined()
    expect(isExternalAgentPackage('@deepseek-ai/dsh-subagent')).toBe(false)
    expect(modulePackage('plain-name/sub')).toBe('plain-name')
    expect(targetPackageNames('plain-name@1', undefined)).toContain('plain-name')
  })

  it('reads the profile\'s saved dependencies, and none from a profile whose manifest cannot be read', () => {
    const { workspace: dir, other } = folders()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { a: '1.0.0' } }))
    expect(guardProfile(dir)).toEqual({ dir, dependencies: { a: '1.0.0' } })
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'profile' }))
    expect(guardProfile(other)).toEqual({ dir: other, dependencies: {} })
    expect(guardProfile(join(other, 'missing'))).toEqual({ dir: join(other, 'missing'), dependencies: {} })
    expect(guardProfile(undefined)).toBeUndefined()
    // A relative path with no package there names only its own text.
    expect(targetPackageNames('./missing', { dir, dependencies: {} })).toEqual(['./missing', 'missing'])
  })
})

describe('mounting', () => {
  it('declares its row as the provider an external start waits for', async () => {
    const plugin: Record<string, unknown> = await import('../src/index.ts')
    expect(plugin[DELEGATION_CONSENT_PROVIDER_EXPORT]).toBe(true)
  })

  it('mounts nothing with the switch off, its parity value', async () => {
    const parity = configOf({})
    expect([parity.enabled.get(), parity.runTimeoutMinutes.get()]).toEqual([false, 30])
    const ctx = new Context()
    apply(ctx, configOf({}))
    expect(ctx.get('delegationConsent')).toBeUndefined()
    expect(() => configOf({ enabled: true, runTimeoutMinutes: 0 })).toThrow()
    expect(() => configOf({ enabled: true, runTimeoutMinutes: 1441 })).toThrow()
    expect(() => configOf({ enabled: true, runTimeoutMinutes: 1.5 })).toThrow()
  })

  it('provides the service, the guard and the routes with the switch on', async () => {
    const ctx = new Context()
    const guards: ((exec: object) => string | undefined)[] = []
    const routes: string[] = []
    ctx.provide('tools', { guard: (guard: (exec: object) => string | undefined) => { guards.push(guard); return () => undefined } } as never)
    ctx.provide('connection', { fetch: { register: (route: { path: string }) => { routes.push(route.path) } } } as never)
    ctx.provide('loader', { entries: () => [{ id: 'e1', options: { id: 'subagent-codex', name: '@deepseek-ai/dsh-subagent-codex' } }] } as never)
    apply(ctx, configOf({ enabled: true, runTimeoutMinutes: 5 }))
    await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeDefined() })
    await vi.waitFor(() => { expect(routes).toHaveLength(4) })
    expect(guards[0]?.({ name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'e1', enabled: true } })).toBe(PLUGIN_MANAGER_REFUSAL)
    // The guard reads the running profile's saved dependencies.
    const { workspace: dir } = folders()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { '@deepseek-ai/dsh-subagent-acp': 'github:someone/acp' } }))
    expect(guards[0]?.({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'github:someone/acp' } })).toBeUndefined()
    ctx.provide('profileContext', { dir } as never)
    expect(guards[0]?.({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'github:someone/acp' } })).toBe(PLUGIN_MANAGER_REFUSAL)
  })

  it('gives each allowed start the configured run time limit in milliseconds', async () => {
    const paths = folders()
    vi.stubEnv('DELORUN_HOME', paths.home)
    try {
      await grant(paths.home, paths.workspace)
      const ctx = new Context()
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) } as never)
      apply(ctx, configOf({ enabled: true, runTimeoutMinutes: 5 }))
      await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeDefined() })
      await expect(ctx.delegationConsent.review(review(chat(paths.workspace), paths.workspace))).resolves.toEqual({ kind: 'allow', timeoutMs: 300_000 })
      await ctx.fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('turns the full-access start on by default and reads it live at each review', async () => {
    expect(configOf({}).fullAccessStartsAgents.get()).toBe(true)
    expect(configOf({ fullAccessStartsAgents: false }).fullAccessStartsAgents.get()).toBe(false)
    const paths = folders()
    vi.stubEnv('DELORUN_HOME', paths.home)
    try {
      const saved = { enabled: true, runTimeoutMinutes: 5, fullAccessStartsAgents: true }
      const ctx = new Context()
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) } as never)
      ctx.provide('approval', { request: () => Promise.resolve('rejected'), config: { policy: 'never' }, overrideOf: () => undefined } as never)
      apply(ctx, { enabled: { get: () => saved.enabled }, runTimeoutMinutes: { get: () => saved.runTimeoutMinutes }, fullAccessStartsAgents: { get: () => saved.fullAccessStartsAgents }, claudeCodeLevel: { get: () => 'standard' }, codexLevel: { get: () => 'standard' } })
      await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeDefined() })
      await expect(ctx.delegationConsent.review(review(chat(paths.workspace), paths.workspace))).resolves.toMatchObject({ kind: 'allow' })
      saved.fullAccessStartsAgents = false
      await expect(ctx.delegationConsent.review(review(chat(paths.workspace), paths.workspace))).resolves.toMatchObject({ kind: 'refuse' })
      await ctx.fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('registers its switch as one only the home\'s computer turns off while it is mounted with the switch on', async () => {
    const ctx = new Context()
    const registered: object[] = []
    let removed = 0
    ctx.provide('homeAuth', { registerComputerOnlySwitch: (target: object) => { registered.push(target); return () => { removed += 1 } } } as never)
    // Pins the registration the reach policy reads: without it an unlocked device could turn the consent off.
    apply(ctx, configOf({ enabled: true }))
    await vi.waitFor(() => { expect(registered).toHaveLength(4) })
    expect(registered[0]).toBe(EXTERNAL_AGENT_CONSENT_SWITCH)
    expect(registered[0]).toEqual({ ns: 'delorun-delegation-consent', field: 'enabled', label: 'the external-agent consent' })
    // The full-access start loosens when it is on, so a device may only write it false.
    expect(registered[1]).toBe(FULL_ACCESS_STARTS_AGENTS_SWITCH)
    expect(registered[1]).toEqual({ ns: 'delorun-delegation-consent', field: 'fullAccessStartsAgents', label: 'external agents starting without asking in Full access chats', safeValue: false })
    await ctx.fiber.dispose()
    expect(removed).toBe(4)
  })

  it('has a phone\'s write that turns the full-access start on refused, and one that turns it off taken', async () => {
    const ctx = new Context()
    const registered: ComputerOnlySwitch[] = []
    ctx.provide('homeAuth', { registerComputerOnlySwitch: (target: ComputerOnlySwitch) => { registered.push(target); return () => undefined } } as never)
    apply(ctx, configOf({ enabled: true }))
    await vi.waitFor(() => { expect(registered).toHaveLength(4) })
    const device = createCondition({
      workspaces: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere', elevationOf: () => ({ id: 'elevation-1' }), pageUnlockOf: () => undefined,
      unlockModeEnabled: () => false, keyRefs: () => new Set(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
      computerOnlySwitches: () => registered, protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set(),
      defaultPermission: () => undefined, dangerousMode: () => false, touchUnlock: () => {},
    } as never, { kind: 'reach-device', deviceId: 'phone', listener: 'reach-tailscale-private' } as never)
    const ns = 'delorun-delegation-consent'
    const patch = (value: boolean) => device({ action: 'settings/update', resource: { kind: 'global' }, args: { ns, patch: { fullAccessStartsAgents: value } } } as never)
    expect(patch(true)).toEqual({ kind: 'deny', reason: 'loopback-required: turning external agents starting without asking in Full access chats on' })
    expect(patch(false)).toEqual({ kind: 'allow' })
    await ctx.fiber.dispose()
  })

  it('registers each agent\'s level as a ranked switch that reads the saved level at each settings write', async () => {
    const ctx = new Context()
    const registered: Array<{ field: string, label: string, ranked: { order: readonly string[], current: () => string } }> = []
    ctx.provide('homeAuth', { registerComputerOnlySwitch: (target: never) => { registered.push(target); return () => {} } } as never)
    const saved = { claudeCodeLevel: 'standard', codexLevel: 'own' }
    apply(ctx, { ...configOf({ enabled: true }), claudeCodeLevel: { get: () => saved.claudeCodeLevel }, codexLevel: { get: () => saved.codexLevel } } as never)
    await vi.waitFor(() => { expect(registered).toHaveLength(4) })
    const [, , claude, codex] = registered
    expect([claude?.field, claude?.label, codex?.field, codex?.label]).toEqual(['claudeCodeLevel', 'the Claude Code level', 'codexLevel', 'the Codex level'])
    expect(claude?.ranked.order).toEqual(['careful', 'standard', 'own', 'unrestricted'])
    saved.codexLevel = 'careful'
    expect([claude?.ranked.current(), codex?.ranked.current()]).toEqual(['standard', 'careful'])
    await ctx.fiber.dispose()
  })

  describe('with the consent off', () => {
    const ns = 'delorun-delegation-consent'
    const saved = { claudeCodeLevel: 'standard', codexLevel: 'careful' }

    /**
     * Mount the plugin with `enabled` as given and put a reach device and the computer in front of the registered switches.
     * @param enabled - the consent's saved switch.
     * @returns what the plugin registered, the device's and the computer's verdict on a settings patch, and the context.
     */
    async function offered(enabled: boolean) {
      const ctx = new Context()
      const registered: ComputerOnlySwitch[] = []
      ctx.provide('homeAuth', { registerComputerOnlySwitch: (target: ComputerOnlySwitch) => { registered.push(target); return () => undefined } } as never)
      apply(ctx, { ...configOf({ enabled }), claudeCodeLevel: { get: () => saved.claudeCodeLevel }, codexLevel: { get: () => saved.codexLevel } } as never)
      await vi.waitFor(() => { expect(registered).toHaveLength(4) })
      const facts = {
        workspaces: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere', elevationOf: () => ({ id: 'elevation-1' }), pageUnlockOf: () => undefined,
        unlockModeEnabled: () => false, keyRefs: () => new Set(), logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
        computerOnlySwitches: () => registered, protectedEntryIds: () => new Set(), computerOnlyEntryIds: () => new Set(),
        defaultPermission: () => undefined, dangerousMode: () => false, touchUnlock: () => {},
      }
      const asDevice = createCondition(facts as never, { kind: 'reach-device', deviceId: 'phone', listener: 'reach-tailscale-private' } as never)
      const write = (who: typeof asDevice) => (patch: object) => who({ action: 'settings/update', resource: { kind: 'global' }, args: { ns, patch } } as never)
      return { ctx, registered, device: write(asDevice) }
    }

    it('refuses a reach device\'s write that turns the full-access start on, and takes one that turns it off', async () => {
      const { ctx, device } = await offered(false)
      expect(device({ fullAccessStartsAgents: true })).toEqual({ kind: 'deny', reason: 'loopback-required: turning external agents starting without asking in Full access chats on' })
      expect(device({ fullAccessStartsAgents: false })).toEqual({ kind: 'allow' })
      await ctx.fiber.dispose()
    })

    it('refuses a reach device\'s write that raises a level, and takes one that lowers it', async () => {
      const { ctx, device } = await offered(false)
      expect(device({ claudeCodeLevel: 'unrestricted' })).toEqual({ kind: 'deny', reason: 'loopback-required: loosening the Claude Code level' })
      expect(device({ codexLevel: 'standard' })).toEqual({ kind: 'deny', reason: 'loopback-required: loosening the Codex level' })
      expect(device({ claudeCodeLevel: 'careful' })).toEqual({ kind: 'allow' })
      expect(device({ claudeCodeLevel: 'standard' })).toEqual({ kind: 'allow' })
      expect(device({ codexLevel: 'careful' })).toEqual({ kind: 'allow' })
      await ctx.fiber.dispose()
    })

    it('refuses a reach device\'s write that turns the consent off, and the computer\'s settings take every value', async () => {
      const { ctx, device } = await offered(false)
      expect(device({ enabled: false })).toMatchObject({ kind: 'deny' })
      expect(device({ enabled: true })).toEqual({ kind: 'allow' })
      // The computer's own writes are loopback requests, which the reach policy never sees; its settings validate and apply.
      const written = configOf({ enabled: false, fullAccessStartsAgents: true, claudeCodeLevel: 'unrestricted', codexLevel: 'unrestricted' })
      expect([written.fullAccessStartsAgents.get(), written.claudeCodeLevel.get(), written.codexLevel.get()]).toEqual([true, 'unrestricted', 'unrestricted'])
      await ctx.fiber.dispose()
    })

    it('registers each switch once whatever the consent is, and removes them with the plugin', async () => {
      for (const enabled of [false, true]) {
        const { ctx, registered } = await offered(enabled)
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(registered.map(target => target.field)).toEqual(['enabled', 'fullAccessStartsAgents', 'claudeCodeLevel', 'codexLevel'])
        await ctx.fiber.dispose()
      }
    })
  })

  it('defaults both levels to Standard and refuses an unknown level', () => {
    const value = configOf({})
    expect([value.claudeCodeLevel.get(), value.codexLevel.get()]).toEqual(['standard', 'standard'])
    expect(() => configOf({ codexLevel: 'reckless' as never })).toThrow()
  })

  it('follows a saved change of either field without a restart', async () => {
    const paths = folders()
    vi.stubEnv('DELORUN_HOME', paths.home)
    try {
      await grant(paths.home, paths.workspace)
      const saved = { enabled: false, runTimeoutMinutes: 5 }
      const ctx = new Context()
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) } as never)
      apply(ctx, { enabled: { get: () => saved.enabled }, runTimeoutMinutes: { get: () => saved.runTimeoutMinutes }, fullAccessStartsAgents: { get: () => true }, claudeCodeLevel: { get: () => 'standard' }, codexLevel: { get: () => 'standard' } })
      expect(ctx.get('delegationConsent')).toBeUndefined()

      saved.enabled = true
      ctx.emit('loader/volatile-update', [['enabled']])
      ctx.emit('loader/volatile-update', [['enabled']])
      await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeDefined() })
      saved.runTimeoutMinutes = 7
      await expect(ctx.delegationConsent.review(review(chat(paths.workspace), paths.workspace))).resolves.toEqual({ kind: 'allow', timeoutMs: 420_000 })

      saved.enabled = false
      ctx.emit('loader/volatile-update', [['enabled']])
      await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeUndefined() })
      await ctx.fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reads no rows without a Loader', async () => {
    const ctx = new Context()
    const guards: ((exec: object) => string | undefined)[] = []
    ctx.provide('tools', { guard: (guard: (exec: object) => string | undefined) => { guards.push(guard); return () => undefined } } as never)
    apply(ctx, configOf({ enabled: true }))
    await vi.waitFor(() => { expect(guards).toHaveLength(1) })
    expect(guards[0]?.({ name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'e1', enabled: true } })).toBeUndefined()
  })
})

interface FakeConnection {
  readonly hook: (request: object, response: ServerResponse, next: () => Promise<void>) => Promise<void>
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  /** The route's `admitPeer` answer for a Peer principal. */
  readonly admits: (path: string, principal: object) => boolean
  /** Run a route as a Peer: `admitPeer` first, then `fetch` with the same request, as the Connection does. */
  readonly callAs: (path: string, principal: object, body: object) => Promise<Response>
}

/**
 * Register the routes on a fake Connection whose `homeAuth` places every request on one listener.
 * @param service - the consent service.
 * @param listener - the listener `homeAuth` reports.
 * @param dangerous - whether `homeAuth` reports dangerous mode.
 */
function routesOver(service: DelorunDelegationConsent, listener: string | undefined, dangerous = false): FakeConnection {
  let hook: FakeConnection['hook'] | undefined
  const routes = new Map<string, { fetch: (request: Request) => Promise<Response>, admitPeer?: (request: Request, peer: object) => boolean }>()
  const ctx = {
    on: (_name: string, registered: FakeConnection['hook']) => { hook = registered },
    get: (name: string) => (name === 'homeAuth' ? { arrivalOf: () => ({ listener }), dangerousMode: () => dangerous, unlockModeEnabled: () => false, faceGrants: () => undefined, deviceHasPasskey: () => false, elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'e' } : deviceId === 'grace-phone' ? { id: 'g', grace: true } : undefined) } : undefined),
    connection: { fetch: { register: (route: { path: string, fetch: (request: Request) => Promise<Response>, admitPeer?: (request: Request, peer: object) => boolean }) => { routes.set(route.path, route) } } },
  }
  registerDelegationRoutes(ctx as never, service)
  return {
    hook: (request, response, next) => hook!(request, response, next),
    fetch: async (path, init) => routes.get(path)!.fetch(new Request(`http://localhost${path}`, init)),
    admits: (path, principal) => routes.get(path)?.admitPeer?.(new Request(`http://localhost${path}`), { principal }) === true,
    callAs: async (path, principal, body) => {
      const request = new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })
      const route = routes.get(path)!
      if (route.admitPeer?.(request, { principal }) !== true) return new Response('forbidden', { status: 403 })
      return route.fetch(request)
    },
  }
}

describe('the routes', () => {
  it('refuse a request the home cannot place, or a foreign Host on the loopback listener, and let the computer and a reach device through to the route', async () => {
    const { consent } = await mounted()
    for (const [listener, host, expected] of [
      ['loopback', '127.0.0.1:4500', true],
      ['loopback', 'home.example.ts.net', false],
      [undefined, '127.0.0.1:4500', false],
      ['reach-tailscale-private', 'home.example.ts.net', true],
    ] as const) {
      const routes = routesOver(consent, listener)
      for (const path of Object.values(DELEGATION_CONSENT_ROUTES)) {
        const answered: { status?: number, body?: string } = {}
        const response = { writeHead: (status: number) => { answered.status = status }, end: (body: string) => { answered.body = body } }
        let reached = false
        await routes.hook({ url: path, headers: { host } }, response as never, async () => { reached = true })
        expect({ listener, host, reached }).toEqual({ listener, host, reached: expected })
        if (!expected) expect(JSON.parse(answered.body ?? '{}')).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
      }
    }
    let other = false
    await routesOver(consent, 'loopback').hook({ url: '/api/other', headers: { host: 'home.example.ts.net' } }, {} as never, async () => { other = true })
    expect(other).toBe(true)
  })

  it('let any approved device read the grants and revoke one, and answer a locked device ELEVATION_REQUIRED on allow in either dangerous mode', async () => {
    const { consent } = await mounted()
    const device = (deviceId: string) => ({ kind: 'reach-device', deviceId, listener: 'reach-tailscale-private' })
    for (const mode of [false, true]) {
      const routes = routesOver(consent, 'reach-tailscale-private', mode)
      for (const path of [DELEGATION_CONSENT_ROUTES.grants, DELEGATION_CONSENT_ROUTES.revoke]) {
        expect(routes.admits(path, device('locked-phone')), path).toBe(true)
        expect(routes.admits(path, { kind: 'sdk' }), path).toBe(false)
      }
      const body = { sessionId: 'chat-1', provider: 'codex', confirmed: false }
      // Pins the unlock check on the one route that grants an agent into a workspace.
      const locked = await routes.callAs(DELEGATION_CONSENT_ROUTES.allow, device('locked-phone'), body)
      expect([locked.status, await locked.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      expect((await routes.callAs(DELEGATION_CONSENT_ROUTES.allow, device('unlocked-phone'), body)).status).not.toBe(403)
      expect((await routes.callAs(DELEGATION_CONSENT_ROUTES.allow, { kind: 'sdk' }, body)).status).toBe(403)
    }
  })

  it('answers a device holding only the approval grace ELEVATION_REQUIRED on allow, and runs it after a code', async () => {
    const { consent } = await mounted()
    const routes = routesOver(consent, 'reach-tailscale-private')
    const device = (deviceId: string) => ({ kind: 'reach-device', deviceId, listener: 'reach-tailscale-private' })
    const body = { sessionId: 'chat-1', provider: 'codex', confirmed: false }
    // Pins the grace exclusion: allowing an agent loosens a consent row.
    const grace = await routes.callAs(DELEGATION_CONSENT_ROUTES.allow, device('grace-phone'), body)
    expect([grace.status, await grace.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
    expect((await routes.callAs(DELEGATION_CONSENT_ROUTES.allow, device('unlocked-phone'), body)).status).not.toBe(403)
    expect(routes.admits(DELEGATION_CONSENT_ROUTES.revoke, device('grace-phone'))).toBe(true)
  })

  it('answer the service\'s calls and refusals', async () => {
    const paths = folders()
    const { consent } = await mounted({ agents: [chat(paths.workspace)], providers: { 'codex': {} } })
    const routes = routesOver(consent, 'loopback')
    const post = (path: string, body: unknown) => routes.fetch(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
    expect((await post(DELEGATION_CONSENT_ROUTES.allow, 'not json')).status).toBe(400)
    expect((await post(DELEGATION_CONSENT_ROUTES.allow, { sessionId: 'chat-1' })).status).toBe(400)
    expect((await post(DELEGATION_CONSENT_ROUTES.allow, 'x'.repeat(20_000))).status).toBe(400)
    const unconfirmed = await post(DELEGATION_CONSENT_ROUTES.allow, { sessionId: 'chat-1', provider: 'codex', confirmed: false })
    expect({ status: unconfirmed.status, body: await unconfirmed.json() }).toMatchObject({ status: 400, body: { error: 'UNCONFIRMED' } })
    expect((await post(DELEGATION_CONSENT_ROUTES.allow, { sessionId: 'chat-1', provider: 'codex', confirmed: true })).status).toBe(200)
    await expect((await routes.fetch(DELEGATION_CONSENT_ROUTES.grants)).json()).resolves.toMatchObject({ grants: [{ provider: 'codex', agent: 'Codex' }] })
    expect((await post(DELEGATION_CONSENT_ROUTES.revoke, { workspace: 1 })).status).toBe(400)
    await expect((await post(DELEGATION_CONSENT_ROUTES.revoke, { workspace: paths.workspace, provider: 'codex' })).json()).resolves.toEqual({ revoked: true })
    vi.spyOn(consent, 'grants').mockRejectedValueOnce(new Error('boom'))
    await expect(routes.fetch(DELEGATION_CONSENT_ROUTES.grants)).rejects.toThrow('boom')
  })
})

/** The working directory the subagent runtime reads: each chat's own folder. */
class ChatFolder extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }

  get(session: Session): string {
    return session.header.cwd ?? process.cwd()
  }

  async ensure(agent: Agent): Promise<string> {
    return this.get(agent.session)
  }

  async set(agent: Agent): Promise<string> {
    return this.get(agent.session)
  }
}

/**
 * Register an idle parent chat in a folder, with a real Session and an Inbox nothing drives.
 * @param ctx - the scope with the session store and the agent registry.
 * @param cwd - the chat's folder.
 * @returns the parent.
 */
async function parentChat(ctx: Context, cwd: string): Promise<Agent> {
  const session = ctx.sessions.create(SessionId(randomUUID()), { meta: { cwd } })
  const inbox = createInboxStub()
  const parent: Agent = {
    id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox,
    send: (message, target) => { inbox.append(target, message) },
    followup: (message) => { inbox.append('next-turn', message) },
    steer: (message) => { inbox.append('next-step', message) },
    inject: (message) => { inbox.append('next-step', message) },
    cancel: () => { inbox.clear() },
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
  await ctx.agents.register(parent)
  return parent
}

describe('through the subagent runtime', () => {
  it('never starts an external agent the person did not approve, and starts it once approved', async () => {
    const paths = folders()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ChatFolder)
    await ctx.plugin(SubagentRuntime)
    let answer: ApprovalOutcome = 'rejected'
    ctx.provide('approval', { request: () => Promise.resolve(answer), config: {}, overrideOf: () => undefined } as never)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) } as never)
    await ctx.plugin(DelorunDelegationConsent, { timeoutMs: () => 60_000, fullAccessStartsAgents: () => true, env: { DELORUN_HOME: paths.home }, now: () => 1, levelOf: () => 'standard', missingSandboxTools: () => [] })
    const parent = await parentChat(ctx, paths.workspace)
    const result = Promise.withResolvers<SubagentResult>()
    const start = vi.fn(() => Promise.resolve({ id: SessionId('run'), result: result.promise, dispose: () => Promise.resolve() }))
    ctx.subagents.registerProvider({ name: 'claude-code', capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }, inheritsParentContext: false, start })
    const delegate = () => ctx.subagents.startActivation({
      provider: 'claude-code', label: 'Fix the bug', signal: new AbortController().signal, delivery: 'caller',
      parent, prompt: [{ type: 'text', text: 'Fix the bug' }],
    })
    await expect(delegate()).rejects.toMatchObject({ code: 'DELEGATION_CONSENT_REFUSED' })
    expect(start).not.toHaveBeenCalled()
    answer = 'allowed-once'
    await delegate()
    expect(start).toHaveBeenCalledOnce()
    result.resolve({ output: [], stopReason: 'completed' })
    const verdict: ExternalDelegationVerdict = await ctx.delegationConsent.review(review(parent, paths.workspace))
    expect(verdict.kind).toBe('allow')
    await ctx.fiber.dispose()
  })
})

describe('through the approval service', () => {
  /**
   * The real approval service over a chat with an open turn, with an answerer that would allow the start.
   * @param policy - the service's configured approval policy.
   * @param fullAccess - the `fullAccessStartsAgents` switch.
   * @returns the composition, the consent, the chat, the answerer and the folders.
   */
  async function approving(policy: 'ask' | 'never', fullAccess = false) {
    const paths = folders()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ApprovalService, { policy })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) } as never)
    const answerer = vi.fn(() => Promise.resolve<ApprovalOutcome>('allowed-once'))
    ctx.on('approval/request', answerer)
    await ctx.plugin(DelorunDelegationConsent, { timeoutMs: () => 60_000, fullAccessStartsAgents: () => fullAccess, env: { DELORUN_HOME: paths.home }, now: () => 1, levelOf: () => 'standard', missingSandboxTools: () => [] })
    const session = ctx.sessions.create(SessionId(randomUUID()), { meta: { cwd: paths.workspace } })
    session.append('turn/start', { turn: 1 })
    const parent: Agent = { id: session.id, session } as never
    return { ctx, consent: ctx.delegationConsent, parent, answerer, ...paths }
  }

  it('with the switch off, refuses a full-access chat, whose policy is never, without asking anyone, unless the workspace allows the agent', async () => {
    const { ctx, consent, parent, answerer, home, workspace } = await approving('never')
    const refused = await consent.review(review(parent, workspace))
    expect(refused).toEqual({ kind: 'refuse', reason: notApprovedRefusal('claude-code', 'never', workspace) })
    expect(notApprovedRefusal('claude-code', 'never', workspace)).toContain('approval policy is never')
    expect(notApprovedRefusal('claude-code', 'never', workspace)).toContain('"Allow for this workspace" in Settings')
    expect(notApprovedRefusal('claude-code', 'never', workspace)).toContain('"Full access chats start agents without asking"')
    expect(answerer).not.toHaveBeenCalled()
    await grant(home, workspace)
    await expect(consent.review(review(parent, workspace))).resolves.toEqual({ kind: 'allow', timeoutMs: 60_000 })
    await ctx.fiber.dispose()
  })

  it('with the switch off, reads a chat\'s own never policy over the configured one', async () => {
    const { ctx, consent, parent, answerer, workspace } = await approving('ask')
    setApprovalPolicy(parent.session, 'never')
    await expect(consent.review(review(parent, workspace))).resolves.toEqual({ kind: 'refuse', reason: notApprovedRefusal('claude-code', 'never', workspace) })
    expect(answerer).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('with the switch on, starts a full-access chat without asking anyone and records nothing', async () => {
    const { ctx, consent, parent, answerer, home, workspace } = await approving('never', true)
    await expect(consent.review(review(parent, workspace))).resolves.toEqual({ kind: 'allow', timeoutMs: 60_000 })
    expect(answerer).not.toHaveBeenCalled()
    expect(await readGrantStore(grantStorePath(home))).toEqual({ kind: 'readable', grants: [] })
    await ctx.fiber.dispose()
  })

  it('with the switch on, reads a chat\'s own never policy over the configured one, and an ask policy still asks', async () => {
    const { ctx, consent, parent, answerer, workspace } = await approving('ask', true)
    await consent.review(review(parent, workspace))
    expect(answerer).toHaveBeenCalledOnce()
    setApprovalPolicy(parent.session, 'never')
    await expect(consent.review(review(parent, workspace))).resolves.toMatchObject({ kind: 'allow' })
    expect(answerer).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('asks the person in a chat whose policy asks, such as an Auto chat, and names a decline as theirs', async () => {
    const { ctx, consent, parent, answerer, workspace } = await approving('ask')
    await expect(consent.review(review(parent, workspace))).resolves.toEqual({ kind: 'allow', timeoutMs: 60_000 })
    expect(answerer).toHaveBeenCalledOnce()
    answerer.mockResolvedValueOnce('rejected')
    await expect(consent.review(review(parent, workspace))).resolves.toEqual({ kind: 'refuse', reason: notApprovedRefusal('claude-code', 'rejected', workspace) })
    await ctx.fiber.dispose()
  })
})
