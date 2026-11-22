/**
 * The studio's routes to the per-workspace full access ({@link PERMISSION_ROUTES}): the list the Permissions
 * section shows, the review of one chat's workspace the consent shows when the person picks full access, and the
 * change the person's answer makes. Every route answers only a request that arrived on the loopback listener: a reach
 * device, or a request the home cannot place, is answered `403 LOOPBACK_REQUIRED` before its body is read, so full
 * access is turned on and off only at the home's own computer. A request there is one upstream's Connection admitted
 * as the studio's owner session after its `Origin` and `Sec-Fetch-Site` check; the routes cannot tell whether the
 * person or another program running as the person at that computer sent `confirmed: true`.
 *
 * @module @delorun/plugin-permission-defaults/routes
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge and its `connection/request` event.
import type {} from '@deepseek-ai/dsh-client-connection'
import { admitApprovedDevice, gateByClass, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { removeDangerousGrant } from './store.ts'
import { resolveDelorunHome } from '@delorun/home'
import { z } from 'zod'
import { FullAccessChangeError, REVIEW_ID_PATTERN } from './review.ts'
import { MAX_PERMISSION_REQUEST_BYTES, PERMISSION_ROUTES, type PermissionRefusalCode } from './wire.ts'

/** The HTTP status each refusal is answered with. */
export const PERMISSION_REFUSAL_STATUS: Readonly<Record<PermissionRefusalCode, number>> = {
  INVALID_REQUEST: 400,
  UNCONFIRMED: 400,
  UNKNOWN_CHAT: 404,
  NO_WORKSPACE: 422,
  UNKNOWN_WORKSPACE: 404,
  STALE_REVIEW: 409,
  STORE_REFUSED: 500,
}

/** The action a reach device is told needs the home's computer. */
const ACTION = 'Changing a workspace\'s full access'

const ReviewBody = z.strictObject({ sessionId: z.string().min(1).max(256) })
const SetFullAccessBody = z.strictObject({
  workspace: z.string().min(1).max(4096),
  reviewId: z.string().regex(REVIEW_ID_PATTERN),
  on: z.boolean(),
  confirmed: z.boolean(),
  chat: z.string().min(1).max(256).optional(),
})

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
 * The refusal of one {@link PermissionRefusalCode}.
 * @param code - the code.
 * @param message - the sentence a surface shows.
 * @returns the response.
 */
function refusal(code: PermissionRefusalCode, message: string): Response {
  return answer(PERMISSION_REFUSAL_STATUS[code], { error: code, message })
}

/**
 * Read a request's JSON body against a schema, refusing a body over {@link MAX_PERMISSION_REQUEST_BYTES}.
 * @param request - the request.
 * @param schema - the route's message.
 * @returns the message, or undefined when the body is not the message.
 */
async function bodyOf<T>(request: Request, schema: z.ZodType<T>): Promise<T | undefined> {
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_PERMISSION_REQUEST_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // The parser's message quotes the body, which may hold a path, so the request is only refused.
    return undefined
  }
  const result = schema.safeParse(parsed)
  return result.success ? result.data : undefined
}

/**
 * Answer a service call, turning its {@link FullAccessChangeError} into the refusal it names.
 * @param call - the call.
 * @returns the answer, or the refusal.
 * @throws whatever else the call throws, which upstream's connection answers as a failure.
 */
async function answered(call: () => object | Promise<object>): Promise<Response> {
  try {
    return answer(200, await call())
  } catch (error) {
    if (error instanceof FullAccessChangeError) return refusal(error.code, error.message)
    throw error
  }
}

/**
 * Register the routes on a context that holds the Connection and the `permissionDefaults` service. The arrival check
 * runs on the Connection's `connection/request` hook, before the route reads anything.
 * @param ctx - the context, whose disposal removes the routes and the hook.
 */
export function registerPermissionRoutes(ctx: Context): void {
  const paths: ReadonlySet<string> = new Set(Object.values(PERMISSION_ROUTES))
  ctx.on('connection/request', async (request, response, next) => {
    if (paths.has(routedPathname(request.url)) && !requireComputerOrDevice(request, response, ctx.get('homeAuth'), ACTION)) return
    await next()
  })
  // Reading, reviewing and turning dangerous mode off only read or tighten, so any approved device may; granting a
  // workspace full access is a `face` route. Turning dangerous mode on is computer-only: `delorun setup`, or the two routes of `@delorun/bundle-local`'s run-settings.
  const anyDevice = admitApprovedDevice()
  const requesters = new AsyncLocalStorage<'device' | 'computer'>()
  const fullAccessGate = gateByClass(() => ctx.get('homeAuth'), async (request) => {
    const body = await bodyOf(request, SetFullAccessBody)
    if (body === undefined) return refusal('INVALID_REQUEST', 'the request must be JSON with the workspace, the review id, on and confirmed')
    return answered(() => ctx.permissionDefaults.setFullAccess(body, requesters.getStore() ?? 'device'))
  }, { row: 'route:plugin-permission-defaults/src/routes.ts#PERMISSION_ROUTES.setFullAccess', action: 'plugin-permission-defaults/set-full-access', legacy: { grace: false, renews: true } })
  const deviceRequests = new WeakSet<Request>()
  // The gate hands its handler a copy of the request (with the grant header removed), so the device mark kept on the original request is read here and carried in async context.
  ctx.connection.fetch.register({
    path: PERMISSION_ROUTES.everywhere,
    methods: ['GET'],
    requestBody: 'buffered',
    admitPeer: anyDevice,
    fetch: () => answered(() => ctx.permissionDefaults.everywhere()),
  })
  ctx.connection.fetch.register({
    path: PERMISSION_ROUTES.everywhereOff,
    methods: ['POST'],
    requestBody: 'buffered',
    admitPeer: anyDevice,
    fetch: () => answered(async () => {
      const home = (await resolveDelorunHome(process.env)).path
      await removeDangerousGrant(home)
      // The store's watch also reads the removal within a second; reading now answers the page with the result.
      await ctx.permissionDefaults.reload()
      return ctx.permissionDefaults.everywhere()
    }),
  })
  ctx.connection.fetch.register({
    path: PERMISSION_ROUTES.workspaces,
    methods: ['GET'],
    requestBody: 'buffered',
    admitPeer: anyDevice,
    fetch: () => answered(() => ctx.permissionDefaults.workspaces()),
  })
  ctx.connection.fetch.register({
    path: PERMISSION_ROUTES.review,
    methods: ['POST'],
    requestBody: 'buffered',
    admitPeer: anyDevice,
    fetch: async (request) => {
      const body = await bodyOf(request, ReviewBody)
      if (body === undefined) return refusal('INVALID_REQUEST', 'the request must be JSON with one session id')
      return answered(() => ({ access: ctx.permissionDefaults.reviewChat(body.sessionId) }))
    },
  })
  ctx.connection.fetch.register({
    path: PERMISSION_ROUTES.setFullAccess,
    methods: ['POST'],
    requestBody: 'buffered',
    // Only a device reaches `admitPeer`; the owner's Peer is the computer. The request object is the one `fetch` receives.
    admitPeer: (request, peer) => {
      if (!fullAccessGate.admitPeer(request, peer)) return false
      deviceRequests.add(request)
      return true
    },
    fetch: request => requesters.run(deviceRequests.has(request) ? 'device' : 'computer', () => fullAccessGate.fetch(request)),
  })
}
