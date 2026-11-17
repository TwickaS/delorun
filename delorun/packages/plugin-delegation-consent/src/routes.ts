/**
 * The studio's routes to the external-agent grants ({@link DELEGATION_CONSENT_ROUTES}): the list the External agents
 * section shows, the grant the approval card's "Allow for this workspace" records, and the revoke. Every route answers
 * only a request that arrived on the loopback listener: a reach device, or a request the home cannot place, is
 * answered `403 LOOPBACK_REQUIRED` before its body is read, so an external agent is allowed and revoked only at the
 * home's own computer.
 *
 * @module @delorun/plugin-delegation-consent/routes
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge and its `connection/request` event.
import type {} from '@deepseek-ai/dsh-client-connection'
import { admitApprovedDevice, gateByUnlock, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { z } from 'zod'
import { DelegationConsentError, type DelorunDelegationConsent } from './service.ts'
import { DELEGATION_CONSENT_ROUTES, MAX_DELEGATION_REQUEST_BYTES, type DelegationRefusalCode } from './wire.ts'

/** The HTTP status each refusal is answered with. */
export const DELEGATION_REFUSAL_STATUS: Readonly<Record<DelegationRefusalCode, number>> = {
  INVALID_REQUEST: 400,
  UNCONFIRMED: 400,
  UNKNOWN_CHAT: 404,
  UNKNOWN_AGENT: 404,
  NO_WORKSPACE: 422,
  UNKNOWN_WORKSPACE: 404,
  STORE_REFUSED: 500,
}

/** The action a reach device is told needs the home's computer. */
const ACTION = 'Allowing or revoking an external agent'

const AllowBody = z.strictObject({ sessionId: z.string().min(1).max(256), provider: z.string().min(1).max(128), confirmed: z.boolean() })
const RevokeBody = z.strictObject({ workspace: z.string().min(1).max(4096), provider: z.string().min(1).max(128) })

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
 * Parse a bounded JSON body against a schema.
 * @param request - the request.
 * @param schema - the message.
 * @returns the message, or undefined for a body that is too long, not JSON or not the message.
 */
async function parsed<T>(request: Request, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_DELEGATION_REQUEST_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // The parser's message quotes the body, which may hold a path, so the request is only refused.
    return undefined
  }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

/**
 * Run a service call and answer it, turning a {@link DelegationConsentError} into its refusal.
 * @param call - the call.
 * @returns the response.
 * @throws whatever else the call throws, which upstream's connection answers as a failure.
 */
async function run(call: () => Promise<object>): Promise<Response> {
  try {
    return json(200, await call())
  } catch (error) {
    if (error instanceof DelegationConsentError) return json(DELEGATION_REFUSAL_STATUS[error.code], { error: error.code, message: error.message })
    throw error
  }
}

/**
 * Register the routes on a context that holds the Connection. The arrival check runs on the Connection's
 * `connection/request` hook, before the route reads anything.
 * @param ctx - the context, whose disposal removes the routes and the hook.
 * @param service - the consent service the routes call.
 */
export function registerDelegationRoutes(ctx: Context, service: DelorunDelegationConsent): void {
  const paths: ReadonlySet<string> = new Set(Object.values(DELEGATION_CONSENT_ROUTES))
  ctx.on('connection/request', async (request, response, next) => {
    if (paths.has(routedPathname(request.url)) && !requireComputerOrDevice(request, response, ctx.get('homeAuth'), ACTION)) return
    await next()
  })
  // Reading the grants and revoking one need no unlock; allowing an agent into a workspace does.
  const admitPeer = admitApprovedDevice()
  ctx.connection.fetch.register({
    path: DELEGATION_CONSENT_ROUTES.grants, methods: ['GET'], requestBody: 'buffered', admitPeer,
    fetch: () => run(() => service.grants()),
  })
  ctx.connection.fetch.register({
    path: DELEGATION_CONSENT_ROUTES.allow, methods: ['POST'], requestBody: 'buffered',
    ...gateByUnlock(() => ctx.get('homeAuth'), async (request) => {
      const body = await parsed(request, AllowBody)
      if (body === undefined) return json(400, { error: 'INVALID_REQUEST', message: 'the request must be JSON with the chat, the agent and confirmed' })
      return run(() => service.allowWorkspace(body))
    }),
  })
  ctx.connection.fetch.register({
    path: DELEGATION_CONSENT_ROUTES.revoke, methods: ['POST'], requestBody: 'buffered', admitPeer,
    fetch: async (request) => {
      const body = await parsed(request, RevokeBody)
      if (body === undefined) return json(400, { error: 'INVALID_REQUEST', message: 'the request must be JSON with the workspace and the agent' })
      return run(() => service.revoke(body))
    },
  })
}
