/**
 * The boot rows of a home's studio page. The home answers them as JSON at `/index-injections.json` (the same rows its
 * index page renders for the admitted browser Peer); the bundled client applies them in order before it starts.
 */

import { z } from 'zod'

/** The dist-root path of the Host's route that answers the rows. */
export const INDEX_INJECTIONS_PATH = '/index-injections.json'

const placement = z.enum(['head', 'body'])

/** The row kinds the bundled client's `applyIndexInjections` executes. */
const rowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global'), name: z.string(), value: z.json().optional() }),
  z.object({ kind: z.literal('script'), placement, text: z.string() }),
  z.object({ kind: z.literal('script-src'), placement, src: z.string() }),
  z.object({ kind: z.literal('script-preload'), src: z.string() }),
  z.object({ kind: z.literal('style'), text: z.string() }),
  z.object({ kind: z.literal('html'), placement, html: z.string() }),
])

/** One row the bundled client applies. */
export type HomeInjection = z.infer<typeof rowSchema>

/**
 * Check the home's answer.
 * @param value - Parsed JSON of the route's answer.
 * @returns the rows in apply order, or `undefined` when the answer is not a list of rows this client understands (a
 *   home that is newer or older than the client, or not a Delorun home).
 */
export function parseHomeInjections(value: unknown): HomeInjection[] | undefined {
  const parsed = z.array(rowSchema).safeParse(value)
  return parsed.success ? parsed.data : undefined
}
