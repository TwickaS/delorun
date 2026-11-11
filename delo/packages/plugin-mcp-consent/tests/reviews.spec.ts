/**
 * Specs of the pending reviews of `@delo/plugin-mcp-consent`: each refused stdio server start is kept for the studio's
 * MCP servers section and `delorun mcp`, without an environment value; an acceptance records exactly the start shown
 * and starts the refused row again; a decline records nothing. The denial cases prove that an unconfirmed answer, a
 * stale review and a request from a reach device record nothing.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { McpConsentRefusedError, type McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, DeloMcpConsent, MCP_CONSENT_ROUTES, mcpReviewId } from '../src/index.ts'
import { registerMcpConsentRoutes } from '../src/routes.ts'
import { acceptanceStorePath } from '../src/store.ts'

/** The secret value of the suite's configured environment, which no review or answer may hold. */
const SECRET = 'secret-token-value'

/** The server start the suite's reviews judge. */
const START: McpServerCommand = {
  serverName: 'files',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/data'],
  env: { API_TOKEN: SECRET },
  cwd: '/srv/mcp',
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
      serverName: 'files', reviewId: mcpReviewId(START), command: 'npx', args: START.args, cwd: '/srv/mcp', envNames: ['API_TOKEN'],
      reason: 'no command is accepted yet (the acceptance store does not exist)', reviewedAt: expect.any(Number),
    })
    expect(JSON.stringify(consent.pending())).not.toContain(SECRET)
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
    expect(() => { consent.declineReview('files', mcpReviewId(START)) }).toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    expect(storeText()).toBeUndefined()
  })

  it('declines a review: the server stays stopped and nothing is recorded', async () => {
    await consent.review(START)
    consent.declineReview('files', mcpReviewId(START))
    expect(consent.pending()).toEqual([])
    expect(storeText()).toBeUndefined()
    await expect(consent.review(START)).resolves.toMatchObject({ allow: false })
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
  const routes = new Map<string, { fetch: (request: Request) => Promise<Response> }>()
  registerMcpConsentRoutes({
    on: (_name: string, registered: typeof hook) => { hook = registered },
    get: (name: string) => (name === 'homeAuth' ? { arrivalOf: () => ({ listener }) } : undefined),
    connection: { fetch: { register: (route: { path: string, fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route) } } },
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
  }
}

describe('the routes', () => {
  it('refuse every request from a reach device with LOOPBACK_REQUIRED before any route runs', async () => {
    const remote = routesOver('tailscale-private')
    for (const path of Object.values(MCP_CONSENT_ROUTES)) {
      const answered = await remote.hook(path, 'home.example.ts.net')
      expect(answered.reached).toBe(false)
      expect(answered.status).toBe(403)
      expect(JSON.parse(answered.body ?? '{}')).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
    }
    expect((await routesOver('loopback').hook(MCP_CONSENT_ROUTES.accept, 'localhost:3080')).reached).toBe(true)
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
