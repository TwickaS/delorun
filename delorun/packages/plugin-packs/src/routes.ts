/**
 * The studio's routes to the install list ({@link PACK_ROUTES}). Every route answers the computer; an approved device
 * reaches the read, cancel and dismiss routes freely, and the routes that add, retry or remove only while its unlock
 * runs (A408), or, with Face ID on, only with a grant for exactly that call: home-auth's `gateByClass` (class `face`) answers
 * `403 ELEVATION_REQUIRED` otherwise, and each call renews the sliding unlock a device with no passkey runs under; the
 * reads never do.
 *
 * @module @delorun/plugin-packs/routes
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
import { admitApprovedDevice, gateByClass, type GrantGateHome } from '@delorun/home-auth'
import type { PacksHub } from './hub.ts'
import { PACK_ROUTES, type PacksResult } from './wire.ts'

/** The `AUTH_CLASSES` row of the routes that add, retry and remove: one registration site serves the reads and these. */
const PACKS_WRITE_ROW = 'route:plugin-packs/src/routes.ts#path (write)'

/** The most bytes of a request body. */
const MAX_BODY_BYTES = 8 * 1024

/** The longest package name a request may carry. */
const MAX_NAME_LENGTH = 214

/** The most names one add may carry. */
const MAX_NAMES = 32

function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Read a bounded JSON object.
 * @param request - the request.
 * @returns the object, or undefined for a body that is too long, not JSON or not an object.
 */
async function bodyOf(request: Request): Promise<Readonly<Record<string, unknown>> | undefined> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // The parser's message quotes the body; the request is only refused.
    return undefined
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined
}

const nameOk = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH

/**
 * Register the routes.
 * @param ctx - the Host context, holding `connection`.
 * @param hub - the pack hub.
 */
export function registerPackRoutes(ctx: Context, hub: Pick<PacksHub, 'snapshot' | 'enqueue' | 'cancel' | 'dismiss' | 'retry' | 'remove'>): void {
  const homeAuth = (): GrantGateHome | undefined => ctx.get('homeAuth')
  const anyDevice = { admitPeer: admitApprovedDevice() }
  type Handle = (body: Readonly<Record<string, unknown>>) => Promise<PacksResult | object> | undefined
  const route = (path: string, gate: 'read' | 'add' | 'retry' | 'remove', handle: Handle): void => {
    const run = async (request: Request): Promise<Response> => {
      const body = await bodyOf(request)
      const answer = body === undefined ? undefined : handle(body)
      if (answer === undefined) return json(400, { error: 'INVALID_REQUEST', message: 'the request must be a small JSON object with the package name' })
      return json(200, await answer)
    }
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods: ['POST'], requestBody: 'buffered',
      ...gate === 'read' ? { ...anyDevice, fetch: run } : gateByClass(homeAuth, run, { row: PACKS_WRITE_ROW, action: `plugin-packs/${gate}`, legacy: { renews: true } }),
    }), `plugin-packs: ${path}`)
  }
  const named = (call: (name: string) => Promise<PacksResult>) => (body: Readonly<Record<string, unknown>>) => (nameOk(body.name) ? call(body.name) : undefined)
  route(PACK_ROUTES.list, 'read', () => hub.snapshot())
  route(PACK_ROUTES.enqueue, 'add', body => (Array.isArray(body.names) && body.names.length > 0 && body.names.length <= MAX_NAMES && body.names.every(nameOk) ? hub.enqueue(body.names) : undefined))
  route(PACK_ROUTES.cancel, 'read', named(name => hub.cancel(name)))
  route(PACK_ROUTES.dismiss, 'read', named(name => hub.dismiss(name)))
  route(PACK_ROUTES.retry, 'retry', named(name => hub.retry(name)))
  route(PACK_ROUTES.remove, 'remove', named(name => hub.remove(name)))
}
