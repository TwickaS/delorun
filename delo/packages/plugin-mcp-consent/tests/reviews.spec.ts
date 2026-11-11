/**
 * Specs of the pending reviews of `@delo/plugin-mcp-consent`: each refused stdio server start is kept for the studio's
 * Permissions section and `delorun mcp`, with a value only of a run-affecting environment variable; an acceptance
 * records exactly the start shown for its server name and starts the refused row again; a decline sets the start aside
 * as `declined` until it changes. The denial cases prove that an unconfirmed answer, a stale review and a request from a
 * reach device record nothing. A review names what changed since the acceptance and which variables, the accepted
 * starts are listed one per server name, and a revoke withdraws one server's acceptance and stops that server's rows
 * only; a stale or unconfirmed revoke changes nothing.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { McpConsentRefusedError, type McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, DeloMcpConsent, MCP_CONSENT_ROUTES, mcpReviewId } from '../src/index.ts'
import { registerMcpConsentRoutes } from '../src/routes.ts'
import { acceptanceStorePath } from '../src/store.ts'
import { showsEnvValue } from '../src/wire.ts'

/** The secret value of the suite's configured environment, which no review or answer may hold. */
const SECRET = 'secret-token-value'

/** The server start the suite's reviews judge. */
const START: McpServerCommand = {
  serverName: 'files',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/data'],
  env: { API_TOKEN: SECRET },
  cwd: '/srv/mcp',
  resolvedCommand: '/usr/local/bin/npx',
  resolvedCwd: '/srv/mcp',
}

let root: string
let ctx: Context
let consent: DeloMcpConsent

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delo-mcp-reviews-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  vi.stubEnv('DELO_HOME', home)
  ctx = new Context()
  consent = new DeloMcpConsent(ctx)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
})

/**
 * The acceptance store's text, or undefined while none exists.
 * @returns the text.
 */
function storeText(): string | undefined {
  const path = acceptanceStorePath(join(root, 'home'))
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

describe('a refused start', () => {
  it('waits as a pending review that names the start without an environment value', async () => {
    await expect(consent.review(START)).resolves.toMatchObject({ allow: false })
    const [pending] = consent.pending()
    expect(pending).toEqual({
      serverName: 'files', reviewId: mcpReviewId(START), command: 'npx', args: START.args, cwd: '/srv/mcp', env: [{ name: 'API_TOKEN' }],
      reason: 'no server is accepted yet (the acceptance store does not exist)', change: 'new', changedVariables: [], state: 'waiting',
      reviewedAt: expect.any(Number),
    })
    expect(JSON.stringify(consent.pending())).not.toContain(SECRET)
  })

  it('names the part of an accepted start that changed', async () => {
    await consent.review(START)
    await consent.acceptReview('files', mcpReviewId(START), true)
    for (const [changed, change, changedVariables] of [
      [{ ...START, command: 'uvx' }, 'command', []],
      [{ ...START, args: [...START.args, '/home'] }, 'arguments', []],
      [{ ...START, cwd: '/srv/other' }, 'directory', []],
      [{ ...START, env: { API_TOKEN: 'another-value' } }, 'environment', ['API_TOKEN']],
      [{ ...START, env: { PATH: '/opt/bin', NODE_ENV: 'test' } }, 'environment', ['API_TOKEN', 'NODE_ENV', 'PATH']],
      [{ ...START, serverName: 'other' }, 'new', []],
    ] as const) {
      await consent.review(changed)
      const review = consent.pending().find(entry => entry.serverName === changed.serverName)
      expect([review?.change, review?.changedVariables, review?.state]).toEqual([change, changedVariables, 'waiting'])
    }
  })

  it('shows the value of a variable that changes what runs, and never another value', async () => {
    const env = { PATH: '/opt/bin', NODE_OPTIONS: '--require ./hook.js', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', PYTHONPATH: '/py', LD_PRELOAD: '/l.so', LD_LIBRARY_PATH: '/lib', API_TOKEN: SECRET, PATHS: 'not-shown' }
    await consent.review({ ...START, env })
    expect(consent.pending()[0]?.env).toEqual([
      { name: 'API_TOKEN' }, { name: 'DYLD_INSERT_LIBRARIES', value: '/tmp/x.dylib' }, { name: 'LD_LIBRARY_PATH', value: '/lib' },
      { name: 'LD_PRELOAD', value: '/l.so' }, { name: 'NODE_OPTIONS', value: '--require ./hook.js' }, { name: 'PATH', value: '/opt/bin' },
      { name: 'PATHS' }, { name: 'PYTHONPATH', value: '/py' },
    ])
    expect(JSON.stringify(consent.pending())).not.toContain(SECRET)
    expect(JSON.stringify(consent.pending())).not.toContain('not-shown')
    expect([showsEnvValue('path'), showsEnvValue('DYLD_'), showsEnvValue('XDYLD_X')]).toEqual([false, true, false])
  })

  it('ends its refusal with where the person accepts it', async () => {
    await expect(consent.review(START)).resolves.toMatchObject({ reason: expect.stringContaining('`delorun mcp accept files`') })
  })

  it('is replaced by the review of the changed start, whose id differs', async () => {
    await consent.review(START)
    const first = consent.pending()[0]?.reviewId
    await consent.review({ ...START, env: { API_TOKEN: 'another-value' } })
    expect(consent.pending()).toHaveLength(1)
    expect(consent.pending()[0]?.reviewId).not.toBe(first)
  })

  it('leaves the list once a review allows the server', async () => {
    await consent.review(START)
    await consent.acceptReview('files', mcpReviewId(START), true)
    await expect(consent.review(START)).resolves.toEqual({ allow: true })
    expect(consent.pending()).toEqual([])
  })
})

describe('an answer to a pending review', () => {
  it('records exactly the start shown once the person confirmed it, and later reviews allow it', async () => {
    await consent.review(START)
    await expect(consent.acceptReview('files', mcpReviewId(START), true)).resolves.toEqual({ started: 0 })
    expect(storeText()).not.toContain(SECRET)
    await expect(consent.review(START)).resolves.toEqual({ allow: true })
  })

  it('records nothing without the person\'s confirmation', async () => {
    await consent.review(START)
    await expect(consent.acceptReview('files', mcpReviewId(START), false)).rejects.toThrow(expect.objectContaining({ code: 'UNCONFIRMED' }))
    expect(storeText()).toBeUndefined()
    expect(consent.pending()).toHaveLength(1)
  })

  it('records nothing for a stale review: the start changed after it was shown', async () => {
    await consent.review(START)
    const shown = mcpReviewId(START)
    const changed = { ...START, args: [...START.args, '/home'] }
    await consent.review(changed)
    await expect(consent.acceptReview('files', shown, true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    expect(storeText()).toBeUndefined()
    await expect(consent.review(changed)).resolves.toMatchObject({ allow: false })
  })

  it('records nothing for a server with no pending review', async () => {
    await expect(consent.acceptReview('files', mcpReviewId(START), true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    await expect(consent.declineReview('files', mcpReviewId(START))).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    expect(storeText()).toBeUndefined()
  })

  it('declines a review: it stays listed as declined, the server stopped, and no acceptance is recorded', async () => {
    await consent.review(START)
    await consent.declineReview('files', mcpReviewId(START))
    expect(consent.pending()).toEqual([expect.objectContaining({ serverName: 'files', state: 'declined', change: 'new' })])
    expect(storeText()).not.toContain(SECRET)
    await expect(consent.review(START)).resolves.toMatchObject({ allow: false, reason: expect.stringContaining('the person declined this start') })
    expect(consent.pending()[0]?.state).toBe('declined')
  })

  it('keeps a declined start declined across a new service instance, until the start changes', async () => {
    await consent.review(START)
    await consent.declineReview('files', mcpReviewId(START))
    const restarted = new DeloMcpConsent(new Context())
    await restarted.review(START)
    expect(restarted.pending()[0]?.state).toBe('declined')
    const changed = { ...START, args: [...START.args, '/home'] }
    await restarted.review(changed)
    expect(restarted.pending()[0]).toMatchObject({ state: 'waiting', change: 'new' })
    // The changed start dropped the set-aside one, so the declined start, configured again, waits too.
    await restarted.review(START)
    expect(restarted.pending()[0]?.state).toBe('waiting')
  })

  it('declines in this process only while the store cannot be read, leaving the store unchanged', async () => {
    const path = acceptanceStorePath(join(root, 'home'))
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, '{ not json', { mode: 0o600 })
    await consent.review(START)
    await consent.declineReview('files', mcpReviewId(START))
    expect(consent.pending()[0]?.state).toBe('declined')
    expect(storeText()).toBe('{ not json')
  })

  it('accepts a declined review like a waiting one', async () => {
    await consent.review(START)
    await consent.declineReview('files', mcpReviewId(START))
    await expect(consent.acceptReview('files', mcpReviewId(START), true)).resolves.toEqual({ started: 0 })
    await expect(consent.review(START)).resolves.toEqual({ allow: true })
    expect(storeText()).not.toContain('declined')
  })

  it('starts again each Loader row this consent refused for the server, and no other row', async () => {
    const update = vi.fn(async () => {})
    const unrelated = vi.fn(async () => {})
    const refusedRow = (serverName: string, onUpdate: () => Promise<void>) => ({
      id: `mcp-${serverName}`,
      fiber: {
        config: { serverName },
        await: () => Promise.reject(new McpConsentRefusedError({ ...START, serverName }, 'not accepted')),
        update: onUpdate,
      },
    })
    ctx.provide('loader', {
      entries: () => [
        refusedRow('files', update),
        refusedRow('other', unrelated),
        { id: 'active', fiber: { config: { serverName: 'files' }, await: () => Promise.resolve(), update: unrelated } },
        { id: 'failed-otherwise', fiber: { config: { serverName: 'files' }, await: () => Promise.reject(new Error('another failure')), update: unrelated } },
        { id: 'not-a-server', fiber: { config: 'files', await: () => Promise.reject(new Error('never awaited')), update: unrelated } },
        { id: 'not-loaded' },
      ],
    } as never)
    await consent.review(START)
    await expect(consent.acceptReview('files', mcpReviewId(START), true)).resolves.toEqual({ started: 1 })
    expect(update).toHaveBeenCalledWith({ serverName: 'files' }, true)
    expect(unrelated).not.toHaveBeenCalled()
  })
})

/**
 * Register the routes on a fake Connection with a `homeAuth` that places every request on the listener given.
 * @param listener - the listener `homeAuth` reports.
 * @returns the captured hook and a caller of the captured routes.
 */
function routesOver(listener: string) {
  let hook: ((request: object, response: ServerResponse, next: () => Promise<void>) => Promise<void>) | undefined
  type Route = { path: string, fetch: (request: Request) => Promise<Response>, admitPeer?: (request: Request, peer: object) => boolean }
  const routes = new Map<string, Route>()
  registerMcpConsentRoutes({
    on: (_name: string, registered: typeof hook) => { hook = registered },
    get: (name: string) => (name === 'homeAuth' ? { arrivalOf: () => ({ listener }) } : undefined),
    connection: { fetch: { register: (route: Route) => { routes.set(route.path, route) } } },
  } as never, consent)
  return {
    hook: (path: string, host: string) => {
      const answered: { status?: number, body?: string } = {}
      let reached = false
      const response = { writeHead(status: number) { answered.status = status }, end(body: string) { answered.body = body } }
      return hook!({ url: path, headers: { host } }, response as never, async () => { reached = true }).then(() => ({ reached, ...answered }))
    },
    post: (path: string, body: object) => routes.get(path)!.fetch(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })),
    get: (path: string) => routes.get(path)!.fetch(new Request(`http://localhost${path}`)),
    admits: (path: string, principal: object) => routes.get(path)?.admitPeer?.(new Request(`http://localhost${path}`), { principal }) === true,
  }
}

describe('an accepted start', () => {
  /**
   * A Loader holding one row per server name given, each configured to start the suite's command.
   * @param names - the rows' server names.
   * @returns the rows' update spies, by name.
   */
  function loaderWith(...names: string[]) {
    const updates = new Map(names.map(name => [name, vi.fn(async () => {})]))
    ctx.provide('loader', {
      entries: () => [
        ...names.map(serverName => ({
          id: `mcp-${serverName}`,
          fiber: {
            config: { serverName, command: START.command },
            update: updates.get(serverName),
            await: () => Promise.reject(new McpConsentRefusedError({ ...START, serverName }, 'not accepted')),
          },
        })),
        { id: 'http', fiber: { config: { serverName: 'web', url: 'https://example.com' }, update: vi.fn(), await: () => Promise.resolve() } },
      ],
    } as never)
    return updates
  }

  /**
   * Accept one start through its review.
   * @param start - the start.
   * @returns the start.
   */
  async function accepted(start: McpServerCommand): Promise<McpServerCommand> {
    await consent.review(start)
    await consent.acceptReview(start.serverName, mcpReviewId(start), true)
    return start
  }

  it('is listed per server name, with a value only of a run-affecting variable its configured row still sets', async () => {
    loaderWith('files')
    await accepted({ ...START, env: { ...START.env, PATH: '/opt/bin' } })
    await expect(consent.accepted()).resolves.toEqual([{
      acceptanceId: expect.stringMatching(/^[0-9a-f]{32}$/), serverName: 'files', command: 'npx', args: START.args, cwd: '/srv/mcp',
      env: [{ name: 'API_TOKEN' }, { name: 'PATH' }], acceptedAt: expect.any(Number), configured: true,
    }])
    expect(JSON.stringify(await consent.accepted())).not.toContain(SECRET)
  })

  it('shows a run-affecting value from the configured row whose value the acceptance holds', async () => {
    const env = { ...START.env, PATH: '/opt/bin' }
    ctx.provide('loader', { entries: () => [{ id: 'mcp-files', fiber: { config: { serverName: 'files', command: 'npx', env }, await: () => Promise.resolve(), update: vi.fn() } }] } as never)
    await accepted({ ...START, env })
    const [listed] = await consent.accepted()
    expect(listed?.env).toEqual([{ name: 'API_TOKEN' }, { name: 'PATH', value: '/opt/bin' }])
    expect(JSON.stringify(listed)).not.toContain(SECRET)
  })

  it('keeps two servers of the same command apart: neither overwrites the other, and each is allowed only its own start', async () => {
    const files = await accepted(START)
    const memory = await accepted({ ...START, serverName: 'memory', args: ['-y', '@modelcontextprotocol/server-memory'] })
    const listed = await consent.accepted()
    expect(listed.map(entry => [entry.serverName, entry.args, entry.configured])).toEqual([['files', files.args, false], ['memory', memory.args, false]])
    expect(new Set(listed.map(entry => entry.acceptanceId)).size).toBe(2)
    await expect(consent.review(files)).resolves.toEqual({ allow: true })
    await expect(consent.review(memory)).resolves.toEqual({ allow: true })
    await expect(consent.review({ ...memory, serverName: 'files' })).resolves.toMatchObject({ allow: false })
  })

  it('is revoked for one server: the store drops it, only that server\'s rows stop, and its next review is revoked', async () => {
    const updates = loaderWith('files', 'memory')
    await accepted(START)
    const memory = await accepted({ ...START, serverName: 'memory', args: ['-y', '@modelcontextprotocol/server-memory'] })
    updates.get('files')?.mockClear()
    updates.get('memory')?.mockClear()
    const files = (await consent.accepted()).find(entry => entry.serverName === 'files')
    await expect(consent.revokeAcceptance(files?.acceptanceId ?? '', true)).resolves.toEqual({ stopped: 1 })
    expect(updates.get('files')).toHaveBeenCalledWith({ serverName: 'files', command: START.command }, true)
    expect(updates.get('memory')).not.toHaveBeenCalled()
    expect((await consent.accepted()).map(entry => entry.serverName)).toEqual(['memory'])
    await expect(consent.review(memory)).resolves.toEqual({ allow: true })
    await expect(consent.review(START)).resolves.toMatchObject({ allow: false, reason: expect.stringContaining('the person revoked this server\'s acceptance') })
    expect(consent.pending()).toEqual([expect.objectContaining({ serverName: 'files', state: 'revoked', change: 'new' })])
  })

  it('stays revoked across a new service instance until the start changes or the person accepts it', async () => {
    await accepted(START)
    const [listed] = await consent.accepted()
    await consent.revokeAcceptance(listed?.acceptanceId ?? '', true)
    const restarted = new DeloMcpConsent(new Context())
    await restarted.review(START)
    expect(restarted.pending()[0]?.state).toBe('revoked')
    await expect(restarted.acceptReview('files', mcpReviewId(START), true)).resolves.toEqual({ started: 0 })
    await expect(restarted.review(START)).resolves.toEqual({ allow: true })
    await restarted.revokeAcceptance((await restarted.accepted())[0]?.acceptanceId ?? '', true)
    await restarted.review({ ...START, cwd: '/srv/other' })
    expect(restarted.pending()[0]).toMatchObject({ state: 'waiting', change: 'new' })
  })

  it('stays accepted after an unconfirmed or stale revoke', async () => {
    const updates = loaderWith('files')
    await accepted(START)
    // The acceptance itself started the refused row again.
    updates.get('files')?.mockClear()
    const [listed] = await consent.accepted()
    const acceptanceId = listed?.acceptanceId ?? ''
    await expect(consent.revokeAcceptance(acceptanceId, false)).rejects.toThrow(expect.objectContaining({ code: 'UNCONFIRMED' }))
    await expect(consent.revokeAcceptance('0'.repeat(32), true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    // Accepting a changed start of the server replaces the acceptance, so the id shown before it is stale.
    await accepted({ ...START, cwd: '/srv/other' })
    await expect(consent.revokeAcceptance(acceptanceId, true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    await expect(consent.review({ ...START, cwd: '/srv/other' })).resolves.toEqual({ allow: true })
  })
})

describe('the routes', () => {
  it('refuse every request from a reach device with LOOPBACK_REQUIRED before any route runs', async () => {
    const remote = routesOver('tailscale-private')
    const guarded = Object.values(MCP_CONSENT_ROUTES).filter(path => path !== MCP_CONSENT_ROUTES.waiting)
    // Every spelling the Connection routes to the same exact route is refused too.
    for (const path of guarded.flatMap(path => [path, path.replace('/api/', '/api/x/../'), path.replace('/api/', '/api/x/%2e%2e/'), path.replace('/api/', '/api\\x\\..\\')])) {
      const answered = await remote.hook(path, 'home.example.ts.net')
      expect(answered.reached).toBe(false)
      expect(answered.status).toBe(403)
      expect(JSON.parse(answered.body ?? '{}')).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
    }
    expect((await routesOver('loopback').hook(MCP_CONSENT_ROUTES.accept, 'localhost:3080')).reached).toBe(true)
  })

  it('let a reach device read only the waiting servers\' names and what changed', async () => {
    const remote = routesOver('tailscale-private')
    expect((await remote.hook(MCP_CONSENT_ROUTES.waiting, 'home.example.ts.net')).reached).toBe(true)
    expect(remote.admits(MCP_CONSENT_ROUTES.waiting, { kind: 'reach-device', deviceId: 'phone' })).toBe(true)
    expect(remote.admits(MCP_CONSENT_ROUTES.waiting, { kind: 'sdk' })).toBe(false)
    expect(remote.admits(MCP_CONSENT_ROUTES.pending, { kind: 'reach-device', deviceId: 'phone' })).toBe(false)
    await consent.review(START)
    await consent.review({ ...START, serverName: 'declined' })
    await consent.declineReview('declined', mcpReviewId({ ...START, serverName: 'declined' }))
    const answered = await (await remote.get(MCP_CONSENT_ROUTES.waiting)).text()
    expect(JSON.parse(answered)).toEqual({ servers: [{ serverName: 'files', change: 'new' }] })
    expect(answered).not.toContain('npx')
    expect(answered).not.toContain('API_TOKEN')
  })

  it('revoke a confirmed, current acceptance, and refuse an unconfirmed, stale or malformed revoke with its code', async () => {
    const routes = routesOver('loopback')
    await consent.review(START)
    await consent.acceptReview('files', mcpReviewId(START), true)
    const listed = await (await routes.get(MCP_CONSENT_ROUTES.pending)).json() as { accepted: { acceptanceId: string }[] }
    const acceptanceId = listed.accepted[0]?.acceptanceId ?? ''
    const unconfirmed = await routes.post(MCP_CONSENT_ROUTES.revoke, { acceptanceId, confirmed: false })
    expect([unconfirmed.status, await unconfirmed.json()]).toEqual([400, expect.objectContaining({ error: 'UNCONFIRMED' })])
    const stale = await routes.post(MCP_CONSENT_ROUTES.revoke, { acceptanceId: 'f'.repeat(32), confirmed: true })
    expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ error: 'STALE_REVIEW' })])
    for (const body of [{ acceptanceId: 'files', confirmed: true }, { command: 'npx', acceptedAt: 1, confirmed: true }, { acceptanceId, confirmed: true, extra: 1 }]) {
      const malformed = await routes.post(MCP_CONSENT_ROUTES.revoke, body)
      expect([malformed.status, await malformed.json()]).toEqual([400, expect.objectContaining({ error: 'INVALID_REQUEST' })])
    }
    await expect(consent.review(START)).resolves.toEqual({ allow: true })
    const revoked = await routes.post(MCP_CONSENT_ROUTES.revoke, { acceptanceId, confirmed: true })
    expect([revoked.status, await revoked.json()]).toEqual([200, { stopped: 0 }])
    await expect(consent.review(START)).resolves.toMatchObject({ allow: false })
  })

  it('accept a confirmed, current review, and refuse an unconfirmed, stale or malformed answer with its code', async () => {
    const routes = routesOver('loopback')
    await consent.review(START)
    const listed = await (await routes.get(MCP_CONSENT_ROUTES.pending)).json() as { servers: { reviewId: string }[] }
    const reviewId = listed.servers[0]?.reviewId ?? ''
    const unconfirmed = await routes.post(MCP_CONSENT_ROUTES.accept, { serverName: 'files', reviewId, confirmed: false })
    expect([unconfirmed.status, await unconfirmed.json()]).toEqual([400, expect.objectContaining({ error: 'UNCONFIRMED' })])
    const stale = await routes.post(MCP_CONSENT_ROUTES.accept, { serverName: 'files', reviewId: '0'.repeat(32), confirmed: true })
    expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ error: 'STALE_REVIEW' })])
    const malformed = await routes.post(MCP_CONSENT_ROUTES.decline, { serverName: 'files; rm', reviewId })
    expect([malformed.status, await malformed.json()]).toEqual([400, expect.objectContaining({ error: 'INVALID_REQUEST' })])
    expect(storeText()).toBeUndefined()
    const accepted = await routes.post(MCP_CONSENT_ROUTES.accept, { serverName: 'files', reviewId, confirmed: true })
    expect([accepted.status, await accepted.json()]).toEqual([200, { started: 0 }])
    await expect(consent.review(START)).resolves.toEqual({ allow: true })
  })
})

describe('the mounted plugin', () => {
  it('provides its pending reviews as mcpReviews while the switch is on', async () => {
    const mountedCtx = new Context()
    try {
      await apply(mountedCtx, { enabled: true })
      expect(mountedCtx.get('mcpReviews')).toBeInstanceOf(DeloMcpConsent)
      expect(mountedCtx.get('mcpReviews')?.pending()).toEqual([])
    } finally {
      await mountedCtx.fiber.dispose()
    }
  })
})
