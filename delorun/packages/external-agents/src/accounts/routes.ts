/**
 * The studio's routes to the external agents' account figures ({@link ACCOUNT_ROUTES}). Any approved device reads the
 * figures, and reading never starts a check. "Check now" starts the person's own program, so a reach device needs a
 * Face ID grant for exactly that call (action `external-agents/refresh`; the PIN on a device with no passkey) and is
 * otherwise answered `403 ELEVATION_REQUIRED` naming the action; the computer always may. A request the
 * home cannot place, or a foreign `Host` on the loopback listener, is answered `403 LOOPBACK_REQUIRED` before the
 * route reads anything.
 *
 * @module @delorun/external-agents/accounts/routes
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge and its `connection/request` event.
import type {} from '@deepseek-ai/dsh-client-connection'
import { admitApprovedDevice, gateByClass, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { z } from 'zod'
import type { AgentAccountsService } from './service.ts'
import { ACCOUNT_PROVIDERS, ACCOUNT_ROUTES, MAX_ACCOUNT_REQUEST_BYTES } from './wire.ts'

/** The action a request the home cannot place is told needs the home's computer. */
const ACTION = 'Reading or checking an external agent\'s plan limits'

const RefreshBody = z.strictObject({ provider: z.enum(ACCOUNT_PROVIDERS) })

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
 * The refresh request's provider.
 * @param request - the request.
 * @returns the provider, or undefined for a body that is too long, not JSON or not a known provider.
 */
async function refreshProvider(request: Request): Promise<z.infer<typeof RefreshBody>['provider'] | undefined> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_ACCOUNT_REQUEST_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // A body that is not JSON is refused as a whole; its text is not echoed.
    return undefined
  }
  const parsed = RefreshBody.safeParse(value)
  return parsed.success ? parsed.data.provider : undefined
}

/**
 * Register the routes on a context that holds the Connection.
 * @param ctx - the context, whose disposal removes the routes and the hook.
 * @param accounts - the account service the routes call.
 */
export function registerAccountRoutes(ctx: Context, accounts: AgentAccountsService): void {
  const paths: ReadonlySet<string> = new Set(Object.values(ACCOUNT_ROUTES))
  ctx.on('connection/request', async (request, response, next) => {
    if (paths.has(routedPathname(request.url)) && !requireComputerOrDevice(request, response, ctx.get('homeAuth'), ACTION)) return
    await next()
  })
  ctx.connection.fetch.register({
    path: ACCOUNT_ROUTES.accounts, methods: ['GET'], requestBody: 'buffered', admitPeer: admitApprovedDevice(),
    fetch: async () => json(200, await accounts.readAll()),
  })
  ctx.connection.fetch.register({
    path: ACCOUNT_ROUTES.refresh, methods: ['POST'], requestBody: 'buffered',
    ...gateByClass(() => ctx.get('homeAuth'), async (request) => {
      const provider = await refreshProvider(request)
      if (provider === undefined) return json(400, { error: 'INVALID_REQUEST', message: `the request must be JSON naming one agent: ${ACCOUNT_PROVIDERS.join(' or ')}` })
      return json(200, await accounts.refresh(provider, 'check-now'))
    }, { row: 'route:external-agents/src/accounts/routes.ts#ACCOUNT_ROUTES.refresh', action: 'external-agents/refresh', legacy: { renews: true } }),
  })
}
