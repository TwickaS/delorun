/**
 * The request that pairs the browse extension with this computer, and the reading of its answer: the Host runs
 * `browse pair` from the row's pack and answers with one JSON event per line as the program reports them, so the
 * one-time code reaches the studio as soon as browse prints it. Only the computer's own studio may start a pairing
 * ([`../browse-pairing.ts`](../browse-pairing.ts)).
 * @module @delorun/bundle-local/client/browse-pair-api
 */
import type { HostFetch } from './host-api.ts'

/** The route under `/api`: `POST {packageName, rowId}` answers {@link BrowsePairEvent}s, one JSON object per line. */
export const BROWSE_PAIR_ROUTE = '/api/delorunBrowsePair.start'

/** What the row the pairing is for is: the bundle package and the row id whose need is a browse pairing. */
export interface BrowsePairRequest {
  readonly packageName: string
  readonly rowId: string
}

/**
 * One step of a pairing: the one-time code to type into the extension, the browser that connected with it, the code
 * running out unused, or a failure with browse's own message.
 */
export type BrowsePairEvent =
  | { readonly kind: 'code', readonly code: string }
  | { readonly kind: 'paired', readonly name?: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'failed', readonly message: string }

/** A pairing the Host refused or could not answer. */
export class BrowsePairError extends Error {
  override readonly name = 'BrowsePairError'
  /** The HTTP status, or 0 when the Host could not be reached. */
  readonly status: number
  /**
   * @param status - the HTTP status, or 0.
   * @param message - what went wrong.
   */
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Whether a parsed line is a pairing event.
 * @param value - the parsed line.
 * @returns true for one of {@link BrowsePairEvent}.
 */
function isEvent(value: unknown): value is BrowsePairEvent {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  switch (value.kind) {
    case 'code': return 'code' in value && typeof value.code === 'string'
    case 'paired': return !('name' in value) || typeof value.name === 'string'
    case 'expired': return true
    case 'failed': return 'message' in value && typeof value.message === 'string'
    default: return false
  }
}

/**
 * Start a pairing and read its events until browse finishes.
 * @param fetch - the request function.
 * @param request - the row to pair for.
 * @param signal - ends the pairing: the Host stops `browse pair` when the request closes.
 * @yields each event as the Host sends it.
 * @throws {BrowsePairError} for a refusal, an unreachable Host or a line that is not an event.
 */
export async function* startBrowsePair(fetch: HostFetch, request: BrowsePairRequest, signal: AbortSignal): AsyncGenerator<BrowsePairEvent> {
  let response: Response
  try {
    response = await fetch(BROWSE_PAIR_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal })
  } catch (error) {
    if (signal.aborted) return
    throw new BrowsePairError(0, (error as Error).message)
  }
  if (!response.ok || response.body === null) throw new BrowsePairError(response.status, await response.text())
  const decoder = new TextDecoder()
  // A reader rather than `for await`: Safari's ReadableStream has no async iterator.
  const reader = response.body.getReader()
  let pending = ''
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    pending += decoder.decode(read.value, { stream: true })
    let end = pending.indexOf('\n')
    while (end !== -1) {
      const line = pending.slice(0, end).trim()
      pending = pending.slice(end + 1)
      if (line !== '') {
        const event: unknown = JSON.parse(line)
        if (!isEvent(event)) throw new BrowsePairError(response.status, `an unreadable pairing event: ${line}`)
        yield event
      }
      end = pending.indexOf('\n')
    }
  }
}
