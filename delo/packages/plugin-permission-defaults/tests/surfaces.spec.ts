/**
 * Specs of the full-access surfaces of `@delo/plugin-permission-defaults`: the service calls the studio's consent, its
 * Permissions section and `delorun workspace full-access` make — the list of workspaces, the review of one chat's
 * workspace, turning full access on and off with the person's answer, and reading the store again after the CLI wrote
 * it — and the routes over them, whose denial cases prove that a remote device, an unconfirmed answer and a stale
 * review record nothing.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  Config,
  FULL_ACCESS_PRESET,
  FullAccessChangeError,
  fullAccessReviewId,
  permissionEntriesDigest,
  permissionStorePath,
  MAX_PERMISSION_REQUEST_BYTES,
  NETWORK_LIST_PATH,
  NETWORK_SET_PATH,
  PERMISSION_ROUTES,
  PermissionDefaults,
  readPermissionStore,
  SAFER_PRESET,
  serializePermissionStore,
  workspaceKey,
} from '../src/index.ts'
import { registerPermissionRoutes } from '../src/routes.ts'

const roots: string[] = []
const originalHome = process.env['DELO_HOME']

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env['DELO_HOME']
  else process.env['DELO_HOME'] = originalHome
})

/** One mounted composition: the real permission services of a chat, a Delo home and two workspace folders. */
interface Mounted {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly defaults: PermissionDefaults
  readonly home: string
  readonly workspace: string
  readonly other: string
}

/**
 * Mount the permission presets and this plugin over a fresh home, or over the home and folders of another mount, as a
 * second profile's Host shares the home.
 * @param shared - the home and folders of another mount.
 * @returns the composition.
 */
async function mounted(shared?: Pick<Mounted, 'home' | 'workspace' | 'other'>): Promise<Mounted> {
  const root = mkdtempSync(join(tmpdir(), 'delo-permission-surfaces-'))
  roots.push(root)
  const { home, workspace, other } = shared ?? { home: join(root, 'home'), workspace: join(root, 'work'), other: join(root, 'other') }
  for (const directory of [home, workspace, other]) mkdirSync(directory, { recursive: true })
  process.env['DELO_HOME'] = home
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SandboxPolicyService, { mode: SAFER_PRESET, workspaceRoot: workspace })
  ctx.provide('shell', {
    sandboxMode: 'workspace-write' as SandboxMode,
    resolve() { throw new Error('these specs do not execute bash') },
    run() { throw new Error('these specs do not execute bash') },
    start() { throw new Error('these specs do not execute bash') },
  } as never)
  ctx.provide('approval', { config: { policy: 'ask' }, request: async () => 'rejected', setPolicy() {} } as never)
  await ctx.plugin(PermissionPresetService, { defaultPreset: SAFER_PRESET })
  await ctx.plugin({ name: 'permission-defaults', apply: (pluginCtx: Context) => apply(pluginCtx, { ...Config(), enabled: true }) })
  return { ctx, harness, defaults: ctx.get('permissionDefaults') as PermissionDefaults, home, workspace, other }
}

/**
 * The store's grants as the file holds them.
 * @param home - the Delo home.
 * @returns each workspace key's grant time, or null.
 */
async function storedGrants(home: string): Promise<Record<string, number | null>> {
  const read = await readPermissionStore(permissionStorePath(home))
  if (read.kind !== 'readable') return {}
  return Object.fromEntries([...read.entries].map(([key, entry]) => [key, entry.fullAccessGrantedAt]))
}

describe('the workspaces a surface shows', () => {
  it('lists the folder of each open chat and each recorded workspace once, with its full access and review id', async () => {
    const { harness, defaults, workspace, other } = await mounted()
    await harness.create(SessionId('chat-a'), {}, { cwd: workspace })
    await harness.create(SessionId('chat-b'), {}, { cwd: workspace })
    await harness.create(SessionId('chat-none'))
    const listed = defaults.workspaces()
    expect(listed.workspaces.map(access => access.workspace)).toEqual([workspaceKey(workspace)])
    expect(listed.workspaces[0]).toEqual({ workspace: workspaceKey(workspace), preset: SAFER_PRESET, grantedAt: null, reviewId: fullAccessReviewId(workspaceKey(workspace), false) })
    expect(listed.storeProblem).toBeUndefined()
    expect(defaults.workspaces().workspaces.some(access => access.workspace === workspaceKey(other))).toBe(false)
  })

  it('reviews one open chat\'s workspace, and refuses an unknown chat and a chat without a folder', async () => {
    const { harness, defaults, workspace } = await mounted()
    await harness.create(SessionId('chat-review'), {}, { cwd: workspace })
    await harness.create(SessionId('chat-nowhere'))
    expect(defaults.reviewChat('chat-review').workspace).toBe(workspaceKey(workspace))
    expect(() => defaults.reviewChat('chat-unknown')).toThrow(expect.objectContaining({ code: 'UNKNOWN_CHAT' }))
    expect(() => defaults.reviewChat('chat-nowhere')).toThrow(expect.objectContaining({ code: 'NO_WORKSPACE' }))
  })
})

describe('turning a workspace\'s full access on and off', () => {
  it('records the grant the person confirmed, so the guard lets a chat there switch to full access', async () => {
    const { ctx, harness, defaults, home, workspace } = await mounted()
    const agent = await harness.create(SessionId('chat-grant'), {}, { cwd: workspace })
    expect(() => { ctx.permissionPresets.set(agent.session, FULL_ACCESS_PRESET) }).toThrow('needs one consent for that workspace first')
    const shown = defaults.reviewChat('chat-grant')
    const change = await defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true })
    expect(change.chats).toBe(0)
    expect(change.access.grantedAt).toEqual(expect.any(Number))
    expect(change.access.reviewId).toBe(fullAccessReviewId(shown.workspace, true))
    expect(await storedGrants(home)).toEqual({ [shown.workspace]: change.access.grantedAt })
    ctx.permissionPresets.set(agent.session, FULL_ACCESS_PRESET)
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe(FULL_ACCESS_PRESET)
  })

  it('switches the chat the consent was asked from to full access, and only that chat', async () => {
    const { ctx, harness, defaults, workspace } = await mounted()
    const asking = await harness.create(SessionId('chat-asking'), {}, { cwd: workspace })
    const sibling = await harness.create(SessionId('chat-sibling'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-asking')
    const change = await defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true, chat: 'chat-asking' })
    expect(change.chats).toBe(1)
    expect(ctx.sandboxPolicy.resolve({ session: asking.session }).mode).toBe(FULL_ACCESS_PRESET)
    expect(ctx.sandboxPolicy.resolve({ session: sibling.session }).mode).toBe(SAFER_PRESET)
  })

  it('refuses a chat that is not open in the workspace, and records nothing', async () => {
    const { harness, defaults, home, workspace } = await mounted()
    await harness.create(SessionId('chat-here'), {}, { cwd: workspace })
    await harness.create(SessionId('chat-nowhere'))
    const shown = defaults.reviewChat('chat-here')
    for (const chat of ['chat-nowhere', 'chat-unknown']) {
      await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true, chat }))
        .rejects.toThrow(expect.objectContaining({ code: 'UNKNOWN_CHAT' }))
    }
    expect(await storedGrants(home)).toEqual({})
  })

  it('refuses an unconfirmed change and records nothing', async () => {
    const { harness, defaults, home, workspace } = await mounted()
    await harness.create(SessionId('chat-unconfirmed'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-unconfirmed')
    await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: false }))
      .rejects.toThrow(expect.objectContaining({ code: 'UNCONFIRMED' }))
    expect(await storedGrants(home)).toEqual({})
    expect(defaults.granted(workspace)).toBe(false)
  })

  it('refuses an answer given to a review that another surface changed meanwhile, and records nothing', async () => {
    const { harness, defaults, home, workspace } = await mounted()
    await harness.create(SessionId('chat-stale'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-stale')
    await defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true })
    const granted = await storedGrants(home)
    // The first review showed the workspace without a grant; turning it off with that review is a stale answer.
    await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: false, confirmed: true }))
      .rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    expect(await storedGrants(home)).toEqual(granted)
  })

  it('refuses a folder no surface shows', async () => {
    const { defaults, other } = await mounted()
    await expect(defaults.setFullAccess({ workspace: other, reviewId: fullAccessReviewId(workspaceKey(other), false), on: true, confirmed: true }))
      .rejects.toThrow(FullAccessChangeError)
    expect(defaults.granted(other)).toBe(false)
  })

  it('withdraws the grant and sets the workspace\'s open full-access chats back to the safer preset', async () => {
    const { ctx, harness, defaults, home, workspace } = await mounted()
    const agent = await harness.create(SessionId('chat-withdraw'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-withdraw')
    const on = await defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true })
    ctx.permissionPresets.set(agent.session, FULL_ACCESS_PRESET)
    const off = await defaults.setFullAccess({ workspace: shown.workspace, reviewId: on.access.reviewId, on: false, confirmed: true })
    expect(off.chats).toBe(1)
    expect(off.access.grantedAt).toBeNull()
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe(SAFER_PRESET)
    expect(await storedGrants(home)).toEqual({ [shown.workspace]: null })
    expect(() => { ctx.permissionPresets.set(agent.session, FULL_ACCESS_PRESET) }).toThrow('needs one consent for that workspace first')
  })

  it('keeps a grant the CLI wrote after the service read the store when it records another workspace', async () => {
    const { harness, defaults, home, workspace, other } = await mounted()
    await harness.create(SessionId('chat-keep'), {}, { cwd: workspace })
    mkdirSync(join(permissionStorePath(home), '..'), { recursive: true, mode: 0o700 })
    writeFileSync(permissionStorePath(home), serializePermissionStore(new Map([[workspaceKey(other), { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 1_700_000_000_000 }]])), { mode: 0o600 })
    const shown = defaults.reviewChat('chat-keep')
    await defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true })
    expect(Object.keys(await storedGrants(home)).sort()).toEqual([workspaceKey(other), shown.workspace].sort())
  })
})

describe('reading the store again', () => {
  it('counts a grant the CLI wrote, and answers the digest of what it now holds', async () => {
    const { harness, defaults, home, workspace } = await mounted()
    await harness.create(SessionId('chat-reload'), {}, { cwd: workspace })
    const entries = new Map([[workspaceKey(workspace), { preset: FULL_ACCESS_PRESET, fullAccessGrantedAt: 1_700_000_000_000 }]] as const)
    mkdirSync(join(permissionStorePath(home), '..'), { recursive: true, mode: 0o700 })
    writeFileSync(permissionStorePath(home), serializePermissionStore(entries), { mode: 0o600 })
    // The next decision reads the changed file; the reload answers the digest and the grant it counted as added.
    expect(defaults.granted(workspace)).toBe(true)
    expect(await defaults.reload()).toEqual({ digest: permissionEntriesDigest(entries), added: 1, lost: 0 })
    expect(defaults.granted(workspace)).toBe(true)
  })

  it('sets the open chats of a workspace whose grant the CLI withdrew back to the safer preset', async () => {
    const { ctx, harness, defaults, home, workspace } = await mounted()
    const agent = await harness.create(SessionId('chat-reload-off'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-reload-off')
    await defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true })
    ctx.permissionPresets.set(agent.session, FULL_ACCESS_PRESET)
    writeFileSync(permissionStorePath(home), serializePermissionStore(new Map([[shown.workspace, { preset: SAFER_PRESET, fullAccessGrantedAt: null }]])), { mode: 0o600 })
    await defaults.reload()
    expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe(SAFER_PRESET)
  })

  it('names a store it cannot read, so no grant counts', async () => {
    const { defaults, home, workspace } = await mounted()
    mkdirSync(join(permissionStorePath(home), '..'), { recursive: true, mode: 0o700 })
    writeFileSync(permissionStorePath(home), '{', { mode: 0o600 })
    const reloaded = await defaults.reload()
    expect(reloaded.storeProblem).toContain('no JSON document')
    expect(defaults.granted(workspace)).toBe(false)
    expect(readFileSync(permissionStorePath(home), 'utf8')).toBe('{')
  })
})

/** What a fake Connection captured: the request hook and the routes. */
interface FakeConnection {
  readonly hook: (request: object, response: ServerResponse, next: () => Promise<void>) => Promise<void>
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
}

/**
 * Register the routes on a fake Connection over the mounted service, with a `homeAuth` that places every request on
 * the listener given.
 * @param defaults - the service.
 * @param listener - the listener `homeAuth` reports.
 * @returns the captured hook and a caller of the captured routes.
 */
function routesOver(defaults: PermissionDefaults, listener: string | undefined): FakeConnection {
  let hook: FakeConnection['hook'] | undefined
  const routes = new Map<string, { fetch: (request: Request) => Promise<Response> | Response }>()
  const ctx = {
    on: (_name: string, listener: FakeConnection['hook']) => { hook = listener },
    get: (name: string) => (name === 'homeAuth' ? { arrivalOf: () => ({ listener }) } : undefined),
    connection: { fetch: { register: (route: { path: string, fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route) } } },
    permissionDefaults: defaults,
  }
  registerPermissionRoutes(ctx as never)
  return {
    hook: (request, response, next) => hook!(request, response, next),
    fetch: async (path, init) => routes.get(path)!.fetch(new Request(`http://localhost${path}`, init)),
  }
}

/**
 * A response that records what the hook answered.
 * @returns the response and what it holds.
 */
function recordingResponse(): { response: ServerResponse, answered: { status?: number, body?: string } } {
  const answered: { status?: number, body?: string } = {}
  const response = {
    writeHead(status: number) { answered.status = status },
    end(body: string) { answered.body = body },
  }
  return { response: response as never, answered }
}

describe('the routes', () => {
  it('refuse a request from a reach device with LOOPBACK_REQUIRED before any route runs', async () => {
    const { defaults } = await mounted()
    const routes = routesOver(defaults, 'tailscale-private')
    // Every spelling the Connection routes to the same exact route is refused too.
    const spellings = Object.values(PERMISSION_ROUTES).flatMap(path => [path, path.replace('/api/', '/api/x/../'), path.replace('/api/', '/api/x/%2e%2e/'), path.replace('/api/', '/api\\x\\..\\')])
    for (const path of spellings) {
      const { response, answered } = recordingResponse()
      let reached = false
      await routes.hook({ url: path, headers: { host: 'home.example.ts.net' } }, response, async () => { reached = true })
      expect(reached).toBe(false)
      expect(answered.status).toBe(403)
      expect(JSON.parse(answered.body ?? '{}')).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
    }
  })

  it('leave a doubled slash, an encoded slash and an uppercase prefix to the next hook, as no route serves them', async () => {
    const { defaults } = await mounted()
    const routes = routesOver(defaults, 'tailscale-private')
    const route = PERMISSION_ROUTES.setFullAccess
    for (const path of [`/${route}`, route.replace('/api/', '/api//'), route.replace('/api/', '/api%2F'), route.replace('/api/', '/API/')]) {
      let reached = false
      await routes.hook({ url: path, headers: { host: 'home.example.ts.net' } }, recordingResponse().response, async () => { reached = true })
      expect({ path, reached }).toEqual({ path, reached: true })
      expect(Object.values(PERMISSION_ROUTES)).not.toContain(new URL(path, 'http://dsh.internal').pathname)
    }
  })

  it('refuse a body over the limit or not JSON, and pass on a failure that is not a refusal', async () => {
    const { defaults } = await mounted()
    const routes = routesOver(defaults, 'loopback')
    const oversized = await routes.fetch(PERMISSION_ROUTES.review, { method: 'POST', body: JSON.stringify({ sessionId: 'x'.repeat(MAX_PERMISSION_REQUEST_BYTES) }) })
    expect([oversized.status, await oversized.json()]).toEqual([400, expect.objectContaining({ error: 'INVALID_REQUEST' })])
    const notJson = await routes.fetch(PERMISSION_ROUTES.review, { method: 'POST', body: '{' })
    expect(notJson.status).toBe(400)
    vi.spyOn(defaults, 'workspaces').mockImplementation(() => { throw new Error('broken') })
    await expect(routes.fetch(PERMISSION_ROUTES.workspaces)).rejects.toThrow('broken')
  })

  it('let a loopback request through, and leave every other path to the next hook', async () => {
    const { defaults } = await mounted()
    const loopback = routesOver(defaults, 'loopback')
    let reached = 0
    await loopback.hook({ url: PERMISSION_ROUTES.setFullAccess, headers: { host: 'localhost:3080' } }, recordingResponse().response, async () => { reached++ })
    await routesOver(defaults, 'tailscale-private').hook({ url: '/api/other', headers: { host: 'home.example.ts.net' } }, recordingResponse().response, async () => { reached++ })
    expect(reached).toBe(2)
  })

  it('turn full access on for a confirmed, current review, and refuse an unconfirmed or stale one with its code', async () => {
    const { harness, defaults, home, workspace } = await mounted()
    await harness.create(SessionId('chat-route'), {}, { cwd: workspace })
    const routes = routesOver(defaults, 'loopback')
    const review = await routes.fetch(PERMISSION_ROUTES.review, { method: 'POST', body: JSON.stringify({ sessionId: 'chat-route' }) })
    const { access } = await review.json() as { access: { workspace: string, reviewId: string } }
    const post = (body: object) => routes.fetch(PERMISSION_ROUTES.setFullAccess, { method: 'POST', body: JSON.stringify(body) })
    const unconfirmed = await post({ workspace: access.workspace, reviewId: access.reviewId, on: true, confirmed: false })
    expect(unconfirmed.status).toBe(400)
    expect(await unconfirmed.json()).toMatchObject({ error: 'UNCONFIRMED' })
    expect(await storedGrants(home)).toEqual({})
    const granted = await post({ workspace: access.workspace, reviewId: access.reviewId, on: true, confirmed: true })
    expect(granted.status).toBe(200)
    const stale = await post({ workspace: access.workspace, reviewId: access.reviewId, on: true, confirmed: true })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'STALE_REVIEW' })
    const malformed = await post({ workspace: access.workspace, reviewId: 'x', on: true, confirmed: true, extra: 1 })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: 'INVALID_REQUEST' })
    const listed = await (await routes.fetch(PERMISSION_ROUTES.workspaces)).json() as { workspaces: { grantedAt: number | null }[] }
    expect(listed.workspaces.map(entry => entry.grantedAt !== null)).toEqual([true])
  })
})

describe('a home shared by several Hosts', () => {
  it('a withdrawal in one Host stops counting at the other Host\'s next decision, and its new chats start on the safer preset', async () => {
    const first = await mounted()
    const second = await mounted(first)
    await first.harness.create(SessionId('chat-first'), {}, { cwd: first.workspace })
    const shown = first.defaults.reviewChat('chat-first')
    const on = await first.defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true })
    // The second Host counts the grant at its next decision: a chat there switches, and a new chat starts with it.
    const open = await second.harness.create(SessionId('chat-second'), {}, { cwd: second.workspace })
    expect(second.ctx.sandboxPolicy.resolve({ session: open.session }).mode).toBe(FULL_ACCESS_PRESET)

    await first.defaults.setFullAccess({ workspace: shown.workspace, reviewId: on.access.reviewId, on: false, confirmed: true })

    const fresh = await second.harness.create(SessionId('chat-second-new'), {}, { cwd: second.workspace })
    expect(second.ctx.sandboxPolicy.resolve({ session: fresh.session }).mode).toBe(SAFER_PRESET)
    expect(() => { second.ctx.permissionPresets.set(fresh.session, FULL_ACCESS_PRESET) }).toThrow('needs one consent for that workspace first')
    // The open chat that ran with full access is set back once the decision that saw the withdrawal has been made.
    await second.defaults.reload()
    expect(second.ctx.sandboxPolicy.resolve({ session: open.session }).mode).toBe(SAFER_PRESET)
  })

  it('sets the open full-access chats back after a decision saw the withdrawal, without a reload', async () => {
    const first = await mounted()
    const second = await mounted(first)
    await first.harness.create(SessionId('chat-a'), {}, { cwd: first.workspace })
    const shown = first.defaults.reviewChat('chat-a')
    const on = await first.defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true })
    const open = await second.harness.create(SessionId('chat-b'), {}, { cwd: second.workspace })
    expect(second.ctx.sandboxPolicy.resolve({ session: open.session }).mode).toBe(FULL_ACCESS_PRESET)
    await first.defaults.setFullAccess({ workspace: shown.workspace, reviewId: on.access.reviewId, on: false, confirmed: true })
    expect(second.defaults.granted(second.workspace)).toBe(false)
    await new Promise(resolve => setImmediate(resolve))
    expect(second.ctx.sandboxPolicy.resolve({ session: open.session }).mode).toBe(SAFER_PRESET)
  })

  it('refuses full access for a folder Delo never adds as a workspace, through the surfaces and the chat picker', async () => {
    const { harness, defaults, home } = await mounted()
    // The folder holding the Delo home is one Delo never adds.
    const container = join(home, '..')
    const agent = await harness.create(SessionId('chat-container'), {}, { cwd: container })
    const shown = defaults.reviewChat('chat-container')
    await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true }))
      .rejects.toMatchObject({ code: 'UNKNOWN_WORKSPACE', message: expect.stringContaining('Nothing was changed.') })
    await expect(defaults.select(agent, FULL_ACCESS_PRESET)).rejects.toMatchObject({ code: 'UNKNOWN_WORKSPACE' })
    expect(await storedGrants(home)).toEqual({})
    // Turning full access off only takes access away, so it is not refused there.
    await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: false, confirmed: true })).resolves.toMatchObject({ chats: 0 })
  })
})

describe('a change that cannot be recorded', () => {
  it('records nothing while the home cannot be resolved, and counts no grant', async () => {
    const { harness, defaults, workspace } = await mounted()
    await harness.create(SessionId('chat-nohome'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-nohome')
    // Upstream's ~/.dsh under the real OS home is a home resolveDeloHome refuses.
    process.env['DELO_HOME'] = join(homedir(), '.dsh')
    await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true }))
      .rejects.toMatchObject({ code: 'STORE_REFUSED', message: expect.stringContaining('the Delo home could not be resolved') })
    await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: false, confirmed: true }))
      .rejects.toMatchObject({ code: 'STORE_REFUSED' })
    await expect(defaults.reload()).resolves.toMatchObject({ storeProblem: expect.stringContaining('could not be resolved') })
    expect(defaults.granted(workspace)).toBe(false)
  })

  it('records nothing while the store\'s lock file is not a lock record', async () => {
    const { harness, defaults, home, workspace } = await mounted()
    await harness.create(SessionId('chat-lock'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-lock')
    mkdirSync(join(permissionStorePath(home), '..'), { recursive: true, mode: 0o700 })
    writeFileSync(`${permissionStorePath(home)}.lock`, JSON.stringify({ v: 2 }), { mode: 0o600 })
    await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true }))
      .rejects.toMatchObject({ code: 'STORE_REFUSED', message: expect.stringContaining('is not a permission store lock record') })
    expect(await storedGrants(home)).toEqual({})
  })
})

describe('the service around its decisions', () => {
  it('titles a registered workspace, names a store problem in the list, and refuses a chat without a folder', async () => {
    const { ctx, harness, defaults, home, workspace } = await mounted()
    ctx.provide('workspaceRegistry', { list: () => [{ path: workspace, title: 'Site' }] } as never)
    const chat = await harness.create(SessionId('chat-titled'), {}, { cwd: workspace })
    expect(defaults.reviewChat('chat-titled').title).toBe('Site')
    const shown = defaults.reviewChat('chat-titled')
    expect((await defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true })).access.title).toBe('Site')
    const bare = await harness.create(SessionId('chat-bare'))
    expect(defaults.review(bare.session, FULL_ACCESS_PRESET)).toContain('a chat with no workspace folder')
    writeFileSync(permissionStorePath(home), '{ not json', { mode: 0o600 })
    expect(defaults.workspaces().storeProblem).toBe('the store holds no JSON document')
    expect(chat).toBeDefined()
  })

  it('records nothing when the store cannot be written', async () => {
    const { harness, defaults, home, workspace } = await mounted()
    await harness.create(SessionId('chat-readonly'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-readonly')
    const directory = join(permissionStorePath(home), '..')
    // The store's directory turns read-only after the lock was taken and the store read, so only the write fails.
    Reflect.set(defaults, 'readForChange', async () => {
      chmodSync(directory, 0o500)
      return new Map()
    })
    try {
      await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true }))
        .rejects.toMatchObject({ code: 'STORE_REFUSED' })
    } finally {
      chmodSync(directory, 0o700)
    }
    expect(defaults.granted(workspace)).toBe(false)
  })

  it('names a chat it could not set, and opens a new chat whose seed failed with the deployment default', async () => {
    const { ctx, harness, defaults, workspace } = await mounted()
    const open = await harness.create(SessionId('chat-stuck'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-stuck')
    const on = await defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true, chat: 'chat-stuck' })
    expect(on.chats).toBe(1)
    const set = vi.spyOn(ctx.permissionPresets, 'set').mockImplementation(() => { throw 'refused by another layer' })
    try {
      const off = await defaults.setFullAccess({ workspace: shown.workspace, reviewId: on.access.reviewId, on: false, confirmed: true })
      expect(off.chats).toBe(0)
      const again = await defaults.setFullAccess({ workspace: shown.workspace, reviewId: off.access.reviewId, on: true, confirmed: true, chat: 'chat-stuck' })
      expect(again.chats).toBe(0)
      await expect(harness.create(SessionId('chat-seed-fails'), {}, { cwd: workspace })).resolves.toBeDefined()
    } finally {
      set.mockRestore()
    }
    expect(open).toBeDefined()
  })

  it('lists and withdraws without the agents service, which a profile without chats does not mount', async () => {
    const { ctx, harness, defaults, workspace } = await mounted()
    await harness.create(SessionId('chat-agents'), {}, { cwd: workspace })
    const shown = defaults.reviewChat('chat-agents')
    const on = await defaults.setFullAccess({ workspace: shown.workspace, reviewId: shown.reviewId, on: true, confirmed: true })
    const get = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation(((name: string) => (name === 'agents' ? undefined : get(name as never))) as typeof ctx.get)
    try {
      expect(defaults.workspaces().workspaces.map(access => access.workspace)).toEqual([shown.workspace])
      await expect(defaults.setFullAccess({ workspace: shown.workspace, reviewId: on.access.reviewId, on: false, confirmed: true })).resolves.toMatchObject({ chats: 0 })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('registers its routes and the network\'s where a Connection serves the studio', async () => {
    const { ctx } = await mounted()
    const register = vi.fn<(route: { readonly path: string }) => void>()
    ctx.provide('connection', { fetch: { register } } as never)
    await new Promise(resolve => setImmediate(resolve))
    expect(register.mock.calls.map(([route]) => route.path).sort()).toEqual([...Object.values(PERMISSION_ROUTES), NETWORK_LIST_PATH, NETWORK_SET_PATH].sort())
  })
})
