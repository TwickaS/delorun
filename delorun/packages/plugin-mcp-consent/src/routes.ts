/**
 * The studio's routes to the stdio MCP servers the add-time consent holds stopped or has accepted
 * ({@link MCP_CONSENT_ROUTES}): the pending reviews and accepted starts the Permissions section shows, and the person's
 * acceptance, decline or revoke. Every route but `waiting` answers only a request that arrived on the loopback
 * listener: a reach device, or a request the home cannot place, is answered `403 LOOPBACK_REQUIRED` before its body is
 * read, so a server command is accepted or revoked only at the home's own computer. `waiting` admits a reach device's
 * Peer and answers only the names and change kinds of the reviews in state `waiting`, never a start's command,
 * arguments, directory or environment, and never a review the person declined or revoked.
 *
 * @module @delorun/plugin-mcp-consent/routes
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge and its `connection/request` event.
import type {} from '@deepseek-ai/dsh-client-connection'
import { admitApprovedDevice, gateByUnlock, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { z } from 'zod'
import { MCP_REVIEW_ID_PATTERN, McpReviewError, type McpReviews } from './review.ts'
import { ACCEPTANCE_ID_PATTERN } from './store.ts'
import { MAX_MCP_CONSENT_REQUEST_BYTES, MCP_CONSENT_ROUTES, SERVER_NAME_PATTERN, type McpConsentRefusalCode } from './wire.ts'

/** The HTTP status each refusal is answered with. */
export const MCP_CONSENT_REFUSAL_STATUS: Readonly<Record<McpConsentRefusalCode, number>> = {
  INVALID_REQUEST: 400,
  UNCONFIRMED: 400,
  STALE_REVIEW: 409,
  STORE_REFUSED: 500,
}

/** The action a reach device is told needs the home's computer. */
const ACTION = 'Answering or revoking an MCP server\'s start'

const Answer = { serverName: z.string().regex(SERVER_NAME_PATTERN), reviewId: z.string().regex(MCP_REVIEW_ID_PATTERN) }
const AcceptBody = z.strictObject({ ...Answer, confirmed: z.boolean() })
const DeclineBody = z.strictObject(Answer)
const RevokeBody = z.strictObject({ acceptanceId: z.string().regex(ACCEPTANCE_ID_PATTERN), confirmed: z.boolean() })

/**
 * One JSON answer, never cached.
 * @param status - the HTTP status.
 * @param body - the answer.
 * @returns the response.
 */
function answer(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/**
 * Read a request's JSON body against a schema, refusing a body over {@link MAX_MCP_CONSENT_REQUEST_BYTES}.
 * @param request - the request.
 * @param schema - the route's message.
 * @returns the message, or undefined when the body is not the message.
 */
async function bodyOf<T>(request: Request, schema: z.ZodType<T>): Promise<T | undefined> {
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_MCP_CONSENT_REQUEST_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // The parser's message quotes the body, so the request is only refused.
    return undefined
  }
  const result = schema.safeParse(parsed)
  return result.success ? result.data : undefined
}

/**
 * Answer a service call, turning its {@link McpReviewError} into the refusal it names.
 * @param call - the call.
 * @returns the answer, or the refusal.
 * @throws whatever else the call throws, which upstream's connection answers as a failure.
 */
async function answered(call: () => object | Promise<object>): Promise<Response> {
  try {
    return answer(200, await call())
  } catch (error) {
    if (error instanceof McpReviewError) return answer(MCP_CONSENT_REFUSAL_STATUS[error.code], { error: error.code, message: error.message })
    throw error
  }
}

/**
 * Register the routes on a context that holds the Connection. The arrival check runs on the Connection's
 * `connection/request` hook, before the route reads anything.
 * @param ctx - the context, whose disposal removes the routes and the hook.
 * @param reviews - the consent service's pending reviews.
 */
export function registerMcpConsentRoutes(ctx: Context, reviews: McpReviews): void {
  const paths: ReadonlySet<string> = new Set(Object.values(MCP_CONSENT_ROUTES).filter(path => path !== MCP_CONSENT_ROUTES.waiting))
  ctx.on('connection/request', async (request, response, next) => {
    if (paths.has(routedPathname(request.url)) && !requireComputerOrDevice(request, response, ctx.get('homeAuth'), ACTION)) return
    await next()
  })
  // Pending, decline and revoke are read or tighten only, so any approved device uses them; accepting a server lets its
  // command run, so it needs an unlock.
  const anyDevice = admitApprovedDevice()
  ctx.connection.fetch.register({
    path: MCP_CONSENT_ROUTES.pending,
    methods: ['GET'],
    requestBody: 'buffered',
    admitPeer: anyDevice,
    fetch: () => answered(async () => ({ servers: reviews.pending(), accepted: await reviews.accepted() })),
  })
  ctx.connection.fetch.register({
    path: MCP_CONSENT_ROUTES.waiting,
    methods: ['GET'],
    requestBody: 'buffered',
    admitPeer: anyDevice,
    fetch: () => answered(() => ({ servers: reviews.pending().filter(({ state }) => state === 'waiting').map(({ serverName, change }) => ({ serverName, change })) })),
  })
  ctx.connection.fetch.register({
    path: MCP_CONSENT_ROUTES.accept,
    methods: ['POST'],
    requestBody: 'buffered',
    ...gateByUnlock(() => ctx.get('homeAuth'), async (request) => {
      const body = await bodyOf(request, AcceptBody)
      if (body === undefined) return answer(400, { error: 'INVALID_REQUEST', message: 'the request must be JSON with the server name, the review id and confirmed' })
      return answered(() => reviews.acceptReview(body.serverName, body.reviewId, body.confirmed))
    }),
  })
  ctx.connection.fetch.register({
    path: MCP_CONSENT_ROUTES.decline,
    methods: ['POST'],
    requestBody: 'buffered',
    admitPeer: anyDevice,
    fetch: async (request) => {
      const body = await bodyOf(request, DeclineBody)
      if (body === undefined) return answer(400, { error: 'INVALID_REQUEST', message: 'the request must be JSON with the server name and the review id' })
      return answered(async () => {
        await reviews.declineReview(body.serverName, body.reviewId)
        return { declined: true }
      })
    },
  })
  ctx.connection.fetch.register({
    path: MCP_CONSENT_ROUTES.revoke,
    methods: ['POST'],
    requestBody: 'buffered',
    admitPeer: anyDevice,
    fetch: async (request) => {
      const body = await bodyOf(request, RevokeBody)
      if (body === undefined) return answer(400, { error: 'INVALID_REQUEST', message: 'the request must be JSON with the acceptance id and confirmed' })
      return answered(() => reviews.revokeAcceptance(body.acceptanceId, body.confirmed))
    },
  })
}
