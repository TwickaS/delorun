/**
 * Specs of `@delo/plugin-delegation-consent`: the review's order and its refusals, the ask's grant marker, the
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
import type { ExternalDelegationVerdict, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, ConfigSchema, DeloDelegationConsent, DelegationConsentError, packageOfTarget, PLUGIN_MANAGER_REFUSAL, pluginManagerVerdict } from '../src/index.ts'
import { agentName, askText, askTextZh, describeAgent, notApprovedRefusal } from '../src/copy.ts'
import { registerDelegationRoutes } from '../src/routes.ts'
import { changeGrantStore, grantStorePath, parseGrantStore, problemOf, readGrantStore } from '../src/store.ts'
import { DELEGATION_CONSENT_ROUTES } from '../src/wire.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh home and two workspace folders. */
function folders(): { home: string, workspace: string, other: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-delegation-consent-')))
  roots.push(root)
  const paths = { home: join(root, 'home'), workspace: join(root, 'work'), other: join(root, 'other') }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
  return paths
}

/** A parent chat whose session runs in a folder. */
function chat(cwd: string | undefined, id = 'chat-1'): Agent {
  const agent: Agent = { id: SessionId(id), session: { id: SessionId(id), header: { cwd } } } as never
  return agent
}

interface Mounted {
  readonly ctx: Context
  readonly consent: DeloDelegationConsent
  readonly asks: ApprovalRequest[]
  readonly home: string
  readonly workspace: string
  readonly other: string
}

/**
 * The service over a fresh home with optional fake neighbours.
 * @param options - the chat's mode, the approval's answer (none for no approval service), and the agents and providers.
 */
async function mounted(options: {
  mode?: 'read-only' | 'workspace-write'
  answer?: (() => ApprovalOutcome) | null
  agents?: readonly Agent[]
  providers?: Record<string, { prepareContinuable?: () => void }>
} = {}): Promise<Mounted> {
  const paths = folders()
  const ctx = new Context()
  const asks: ApprovalRequest[] = []
  if (options.mode !== undefined) ctx.provide('sandboxPolicy', { resolve: () => ({ mode: options.mode }) } as never)
  if (options.answer !== null) {
    const answer = options.answer ?? (() => 'allowed-once')
    ctx.provide('approval', { request: (request: ApprovalRequest) => { asks.push(request); return Promise.resolve(answer()) } } as never)
  }
  const agents = options.agents ?? []
  ctx.provide('agents', { get: (id: string) => agents.find(agent => agent.id === id) } as never)
  ctx.provide('subagents', { getProvider: (name: string) => options.providers?.[name] } as never)
  await ctx.plugin(DeloDelegationConsent, { timeoutMs: 1_800_000, env: { DELO_HOME: paths.home }, now: () => 1_000 })
  return { ctx, consent: ctx.get('delegationConsent') as DeloDelegationConsent, asks, ...paths }
}

/** A review of one start in a folder. */
function review(parent: Agent, cwd: string, provider = 'claude-code') {
  return { provider, parent, cwd, label: 'Review the diff', signal: new AbortController().signal }
}

/** Record a grant straight into the home's grants file. */
async function grant(home: string, workspace: string, provider = 'claude-code'): Promise<void> {
  await changeGrantStore(grantStorePath(home), grants => [...grants, { workspace, provider, grantedAt: 5 }])
}

describe('the review', () => {
  it('asks with the external-agent grant marker and allows once, recording nothing', async () => {
    const { consent, asks, home, workspace } = await mounted()
    const verdict = await consent.review(review(chat(workspace), workspace))
    expect(verdict).toEqual({ kind: 'allow', timeoutMs: 1_800_000 })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ toolName: 'claude-code', grants: 'external-agent', reason: askText({ provider: 'claude-code', workspace, label: 'Review the diff' }) })
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

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('refuses when the ask ends %s', async (outcome) => {
    const { consent, workspace } = await mounted({ answer: () => outcome })
    const verdict = await consent.review(review(chat(workspace), workspace))
    expect(verdict).toEqual({ kind: 'refuse', reason: notApprovedRefusal('claude-code', outcome, workspace) })
  })

  it('refuses when no approval service can ask, and asks for a chat without a folder', async () => {
    const { consent, workspace } = await mounted({ answer: null })
    await expect(consent.review(review(chat(workspace), workspace))).resolves.toMatchObject({ kind: 'refuse', reason: expect.stringContaining('no one could be asked') })
    const asking = await mounted()
    await expect(asking.consent.review(review(chat(undefined), asking.workspace))).resolves.toMatchObject({ kind: 'allow' })
    expect(asking.asks[0]?.reason).toContain('this chat\'s folder')
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

  it('refuses a chat without a folder and a folder Delo never adds as a workspace', async () => {
    const noFolder = await mounted({ agents: [chat(undefined)], providers: external })
    await expect(noFolder.consent.allowWorkspace({ sessionId: 'chat-1', provider: 'claude-code', confirmed: true })).rejects.toMatchObject({ code: 'NO_WORKSPACE' })
    const homeFolder = await mounted({ agents: [chat(homedir())], providers: external })
    await expect(homeFolder.consent.allowWorkspace({ sessionId: 'chat-1', provider: 'claude-code', confirmed: true })).rejects.toBeInstanceOf(DelegationConsentError)
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
    expect(describeAgent('claude-code')).toContain('outside Delo\'s sandbox')
    expect(describeAgent('codex')).toContain('own Codex sign-in and account')
    expect(askText({ provider: 'codex', workspace: '/w', label: undefined })).not.toContain('Task:')
    expect(askTextZh({ provider: 'codex', workspace: '', label: 'x' })).toContain('此对话的文件夹')
    expect(askTextZh({ provider: 'codex', workspace: '/w', label: undefined })).not.toContain('任务')
    expect(notApprovedRefusal('codex', 'cancelled', '/w')).toContain('withdrawn')
    expect(notApprovedRefusal('codex', 'rejected', '')).not.toContain('delorun')
  })
})

describe('the plugin_manager guard', () => {
  const refused = new Set(['@deepseek-ai/dsh-subagent-claude-code'])
  const rows = () => [
    { id: 'e1', rowId: 'subagent-claude-code', name: '@deepseek-ai/dsh-subagent-claude-code' },
    { id: 'e2', rowId: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  ]
  const call = (args: object) => pluginManagerVerdict({ name: 'plugin_manager', arguments: args }, refused, rows)

  it('refuses installing, enabling and configuring a refused package', () => {
    expect(call({ action: 'install_bundle', target: '@deepseek-ai/dsh-subagent-claude-code@0.2.2' })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'install_bundle', target: '@deepseek-ai/dsh-subagent-claude-code' })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'set_bundle', target: '@deepseek-ai/dsh-subagent-claude-code', enabled: true })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'set_plugin', target: 'e1', enabled: true })).toBe(PLUGIN_MANAGER_REFUSAL)
    expect(call({ action: 'configure', target: 'subagent-claude-code', config: { permissionMode: 'bypassPermissions' } })).toBe(PLUGIN_MANAGER_REFUSAL)
  })

  it('lets disabling, other packages, other actions and other tools through', () => {
    expect(call({ action: 'set_bundle', target: '@deepseek-ai/dsh-subagent-claude-code', enabled: false })).toBeUndefined()
    expect(call({ action: 'install_bundle', target: '@deepseek-ai/dsh-subagent-claude-code', enabled: false })).toBeUndefined()
    expect(call({ action: 'set_plugin', target: 'e1', enabled: false })).toBeUndefined()
    expect(call({ action: 'set_plugin', target: 'e2', enabled: true })).toBeUndefined()
    expect(call({ action: 'configure', target: 'unknown' })).toBeUndefined()
    expect(call({ action: 'remove_bundle', target: '@deepseek-ai/dsh-subagent-claude-code' })).toBeUndefined()
    expect(call({ action: 'list_plugins' })).toBeUndefined()
    expect(pluginManagerVerdict({ name: 'plugin_manager', arguments: null }, refused, rows)).toBeUndefined()
    expect(pluginManagerVerdict({ name: 'bash', arguments: { action: 'install_bundle', target: '@deepseek-ai/dsh-subagent-claude-code' } }, refused, rows)).toBeUndefined()
    expect(packageOfTarget('plain-name@1')).toBe('plain-name')
  })
})

describe('mounting', () => {
  it('mounts nothing with the switch off, its parity value', async () => {
    expect(ConfigSchema.parse({})).toMatchObject({ enabled: false, runTimeoutMinutes: 30 })
    const ctx = new Context()
    apply(ctx)
    expect(ctx.get('delegationConsent')).toBeUndefined()
    expect(() => ConfigSchema.parse({ enabled: true, runTimeoutMinutes: 0 })).toThrow()
  })

  it('provides the service, the guard and the routes with the switch on', async () => {
    const ctx = new Context()
    const guards: ((exec: object) => string | undefined)[] = []
    const routes: string[] = []
    ctx.provide('tools', { guard: (guard: (exec: object) => string | undefined) => { guards.push(guard); return () => undefined } } as never)
    ctx.provide('connection', { fetch: { register: (route: { path: string }) => { routes.push(route.path) } } } as never)
    ctx.provide('loader', { entries: () => [{ id: 'e1', options: { id: 'subagent-codex', name: '@deepseek-ai/dsh-subagent-codex' } }] } as never)
    apply(ctx, { enabled: true, runTimeoutMinutes: 5 })
    await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeDefined() })
    await vi.waitFor(() => { expect(routes).toHaveLength(3) })
    expect(guards[0]?.({ name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'e1', enabled: true } })).toBe(PLUGIN_MANAGER_REFUSAL)
  })

  it('gives each allowed start the configured run time limit in milliseconds', async () => {
    const paths = folders()
    vi.stubEnv('DELO_HOME', paths.home)
    try {
      await grant(paths.home, paths.workspace)
      const ctx = new Context()
      apply(ctx, { enabled: true, runTimeoutMinutes: 5 })
      await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeDefined() })
      await expect(ctx.delegationConsent.review(review(chat(paths.workspace), paths.workspace))).resolves.toEqual({ kind: 'allow', timeoutMs: 300_000 })
      await ctx.fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reads no rows without a Loader', async () => {
    const ctx = new Context()
    const guards: ((exec: object) => string | undefined)[] = []
    ctx.provide('tools', { guard: (guard: (exec: object) => string | undefined) => { guards.push(guard); return () => undefined } } as never)
    apply(ctx, { enabled: true })
    await vi.waitFor(() => { expect(guards).toHaveLength(1) })
    expect(guards[0]?.({ name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'e1', enabled: true } })).toBeUndefined()
  })
})

interface FakeConnection {
  readonly hook: (request: object, response: ServerResponse, next: () => Promise<void>) => Promise<void>
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
}

/**
 * Register the routes on a fake Connection whose `homeAuth` places every request on one listener.
 * @param service - the consent service.
 * @param listener - the listener `homeAuth` reports.
 */
function routesOver(service: DeloDelegationConsent, listener: string | undefined): FakeConnection {
  let hook: FakeConnection['hook'] | undefined
  const routes = new Map<string, { fetch: (request: Request) => Promise<Response> }>()
  const ctx = {
    on: (_name: string, registered: FakeConnection['hook']) => { hook = registered },
    get: (name: string) => (name === 'homeAuth' ? { arrivalOf: () => ({ listener }) } : undefined),
    connection: { fetch: { register: (route: { path: string, fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route) } } },
  }
  registerDelegationRoutes(ctx as never, service)
  return {
    hook: (request, response, next) => hook!(request, response, next),
    fetch: async (path, init) => routes.get(path)!.fetch(new Request(`http://localhost${path}`, init)),
  }
}

describe('the routes', () => {
  it('refuse a reach device with LOOPBACK_REQUIRED before any route runs, and let the computer through', async () => {
    const { consent } = await mounted()
    for (const listener of ['reach-tailscale-private', 'loopback'] as const) {
      const routes = routesOver(consent, listener)
      for (const path of Object.values(DELEGATION_CONSENT_ROUTES)) {
        const answered: { status?: number, body?: string } = {}
        const response = { writeHead: (status: number) => { answered.status = status }, end: (body: string) => { answered.body = body } }
        let reached = false
        await routes.hook({ url: path, headers: { host: listener === 'loopback' ? '127.0.0.1:4500' : 'home.example.ts.net' } }, response as never, async () => { reached = true })
        expect({ listener, reached }).toEqual({ listener, reached: listener === 'loopback' })
        if (listener !== 'loopback') expect(JSON.parse(answered.body ?? '{}')).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
      }
      let other = false
      await routes.hook({ url: '/api/other', headers: { host: 'home.example.ts.net' } }, {} as never, async () => { other = true })
      expect(other).toBe(true)
    }
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
    ctx.provide('approval', { request: () => Promise.resolve(answer) } as never)
    await ctx.plugin(DeloDelegationConsent, { timeoutMs: 60_000, env: { DELO_HOME: paths.home }, now: () => 1 })
    const parent = await parentChat(ctx, paths.workspace)
    const result = Promise.withResolvers<SubagentResult>()
    const start = vi.fn(() => Promise.resolve({ id: SessionId('run'), result: result.promise, dispose: () => Promise.resolve() }))
    ctx.subagents.registerProvider({ name: 'claude-code', capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }, inheritsParentContext: false, start })
    const delegate = () => ctx.subagents.startActivation({
      provider: 'claude-code', label: 'Fix the bug', signal: new AbortController().signal, delivery: 'caller',
      request: { parent, prompt: [{ type: 'text', text: 'Fix the bug' }] },
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
