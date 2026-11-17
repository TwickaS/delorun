/**
 * Reading a route's JSON body and answering JSON, shared by every route of this package.
 * @module @delorun/plugin-new-workspace/http
 */
import type { z } from 'zod'
import { MAX_BODY_BYTES } from './wire.ts'

/**
 * Read a request's JSON body against a schema, refusing a body over {@link MAX_BODY_BYTES}.
 * @param request - the request.
 * @param schema - the body's schema.
 * @returns the parsed body, or undefined when it cannot be read or does not match.
 */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | undefined> {
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_BODY_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (_notJson) {
    // The parser's message quotes the body, so the request is only refused.
    return undefined
  }
  const body = schema.safeParse(parsed)
  return body.success ? body.data : undefined
}

/**
 * Answer one JSON message.
 * @param status - the HTTP status.
 * @param answer - the message.
 * @returns the response, never cached.
 */
export function reply(status: number, answer: object): Response {
  return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
