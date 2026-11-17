/**
 * The studio's routes to a chat's real-browser grant ({@link REAL_BROWSER_ROUTES}): its state and its end, which any
 * approved device reaches because they read or only narrow, and the away permission, which widens what the grant
 * covers and so needs the computer or a device unlocked with a code or PIN, as the grant's own approval does; the
 * approval grace opens neither. A request the
 * home cannot place is refused before its body is read.
 * @module @delorun/browser-use-browse/routes
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { admitApprovedDevice, gateByUnlock, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { z } from 'zod'
import type { RealBrowserGrants } from './grant.ts'
import { MAX_REAL_BROWSER_REQUEST_BYTES, REAL_BROWSER_ROUTES, type RealBrowserRefusalCode, type RealBrowserState } from './wire.ts'

/** The HTTP status each refusal is answered with. */
export const REAL_BROWSER_REFUSAL_STATUS: Readonly<Record<RealBrowserRefusalCode, number>> = {
  INVALID_REQUEST: 400,
  UNKNOWN_CHAT: 404,
  NO_GRANT: 409,
}

const ChatBody = z.strictObject({ sessionId: z.string().min(1).max(256) })
const AwayBody = z.strictObject({ sessionId: z.string().min(1).max(256), on: z.boolean() })

/**
 * The JSON response of a status and a body, never cached.
 * @param status - the HTTP status.
 * @param body - the body.
 * @returns the response.
 */
function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * A refusal.
 * @param code - the code.
 * @param message - the sentence.
 * @returns the response.
 */
function refuse(code: RealBrowserRefusalCode, message: string): Response {
  return json(REAL_BROWSER_REFUSAL_STATUS[code], { error: code, message })
}

/**
 * Parse a bounded JSON body against a schema.
 * @param request - the request.
 * @param schema - the message.
 * @returns the message, or undefined for a body that is too long, not JSON or not the message.
 */
async function parsed<T>(request: Request, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_REAL_BROWSER_REQUEST_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // A body that is not JSON is only refused; its text is not echoed.
    return undefined
  }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

/** What the routes need besides the grants. */
export interface RealBrowserRouteOptions {
  /** How long the away permission lasts once turned on, in milliseconds. */
  readonly awayMs: () => number
  /** The clock. */
  readonly now: () => number
}

/**
 * Register the routes on a context that holds the Connection.
 * @param ctx - the context, whose disposal removes the routes.
 * @param grants - the grants the routes read and change.
 * @param options - the away permission's length and the clock.
 */
export function registerRealBrowserRoutes(ctx: Context, grants: RealBrowserGrants, options: RealBrowserRouteOptions): void {
  const paths: ReadonlySet<string> = new Set(Object.values(REAL_BROWSER_ROUTES))
  ctx.on('connection/request', async (request, response, next) => {
    if (paths.has(routedPathname(request.url)) && !requireComputerOrDevice(request, response, ctx.get('homeAuth'), 'Changing whether the agent uses your own browser')) return
    await next()
  })
  const chat = (sessionId: string): Agent | undefined => ctx.get('agents')?.get(SessionId(sessionId))
  const stateOf = (agent: Agent): RealBrowserState => grants.view(agent.session)
  const admitPeer = admitApprovedDevice()
  const unknownChat = (): Response => refuse('UNKNOWN_CHAT', 'nothing changed: the chat is not open')
  const invalid = (): Response => refuse('INVALID_REQUEST', 'the request must be JSON naming the chat')
  ctx.connection.fetch.register({
    path: REAL_BROWSER_ROUTES.state, methods: ['POST'], requestBody: 'buffered', admitPeer,
    fetch: async (request) => {
      const body = await parsed(request, ChatBody)
      if (body === undefined) return invalid()
      const agent = chat(body.sessionId)
      return agent === undefined ? unknownChat() : json(200, stateOf(agent))
    },
  })
  ctx.connection.fetch.register({
    path: REAL_BROWSER_ROUTES.end, methods: ['POST'], requestBody: 'buffered', admitPeer,
    fetch: async (request) => {
      const body = await parsed(request, ChatBody)
      if (body === undefined) return invalid()
      const agent = chat(body.sessionId)
      if (agent === undefined) return unknownChat()
      grants.end(agent.session)
      return json(200, stateOf(agent))
    },
  })
  ctx.connection.fetch.register({
    path: REAL_BROWSER_ROUTES.away, methods: ['POST'], requestBody: 'buffered',
    ...gateByUnlock(() => ctx.get('homeAuth'), async (request) => {
      const body = await parsed(request, AwayBody)
      if (body === undefined) return refuse('INVALID_REQUEST', 'the request must be JSON naming the chat and on')
      const agent = chat(body.sessionId)
      if (agent === undefined) return unknownChat()
      const recorded = grants.setAway(agent.session, body.on ? options.now() + options.awayMs() : null)
      if (!recorded) return refuse('NO_GRANT', 'nothing changed: the chat does not use the person\'s own browser')
      return json(200, stateOf(agent))
    }, { grace: false, renews: true }),
  })
}
