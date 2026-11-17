/**
 * A client of an installed studio's Web API that signs in as the computer's own browser does: it opens the one-time
 * link `delorun open --print` prints, keeps the `dsh-auth-` cookie the studio sets, and sends that cookie with each
 * request. It calls the Delorun routes (`POST /api/<route>` with a JSON body) and upstream's unary RPCs (`POST
 * /api/<method>` with a `client-request` envelope), which is how the studio's page calls both.
 *
 * @module @delorun/release/installed-smoke/studio
 */
import { randomUUID } from 'node:crypto'

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 120_000

/** A signed-in client of one studio. */
export interface StudioClient {
  /** The studio's origin. */
  readonly origin: string
  /**
   * Call a Delorun route.
   * @param path - the route's path, such as `/api/delorunPacks.list`.
   * @param body - the JSON body.
   * @returns the parsed answer.
   * @throws Error when the route answers anything but 200.
   */
  route(path: string, body: object): Promise<unknown>
  /**
   * Call an upstream unary RPC.
   * @param method - the endpoint, such as `session/create`.
   * @param args - the method's arguments by parameter name.
   * @returns the result's value.
   * @throws Error when the call answers no successful `server-response`.
   */
  rpc(method: string, args: Readonly<Record<string, unknown>>): Promise<unknown>
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The `dsh-auth-` cookie among a response's `set-cookie` values.
 * @param setCookies - the values.
 * @returns the `name=value` pair the `cookie` header sends back.
 * @throws Error when none sets it.
 */
export function studioCookie(setCookies: readonly string[]): string {
  const pair = setCookies.map(value => value.split(';', 1)[0]!.trim()).find(value => value.startsWith('dsh-auth-'))
  if (pair === undefined) throw new Error('the sign-in link set no dsh-auth cookie')
  return pair
}

/**
 * The value of a unary RPC's answer.
 * @param method - the endpoint, for messages.
 * @param rpcId - the call's id.
 * @param answer - the parsed answer.
 * @returns the value.
 * @throws Error when the answer is not the call's successful `server-response`; the message carries the error.
 */
export function rpcResult(method: string, rpcId: string, answer: unknown): unknown {
  if (!isRecord(answer) || answer.type !== 'server-response' || answer.rpcId !== rpcId || !isRecord(answer.result)) throw new Error(`${method} answered no server-response for its call: ${JSON.stringify(answer)}`)
  if (answer.result.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(answer.result.error)}`)
  return answer.result.value
}

/**
 * Sign in with a one-time link.
 * @param link - the link `delorun open --print` printed.
 * @returns the client.
 * @throws Error when the link sets no cookie.
 */
export async function signIn(link: string): Promise<StudioClient> {
  const origin = new URL(link).origin
  const opened = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  await opened.body?.cancel()
  const cookie = studioCookie(opened.headers.getSetCookie())
  const post = async (path: string, body: object): Promise<unknown> => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const text = await response.text()
    if (response.status !== 200) throw new Error(`${path} answered HTTP ${String(response.status)}: ${text.slice(0, 500)}`)
    const answer: unknown = JSON.parse(text)
    return answer
  }
  return {
    origin,
    route: post,
    async rpc(method, args) {
      const rpcId = randomUUID()
      return rpcResult(method, rpcId, await post(`/api/${method}`, { type: 'client-request', rpcId, method, payload: { args } }))
    },
  }
}
