/**
 * The studio's side of the packs routes ({@link PACK_ROUTES}): a small client over `fetch` that answers what the
 * downloads panel, Plugins and the setup guide need. It imports no Cordis, so a client bundle may import it.
 *
 * @module @delorun/plugin-packs/client
 */
import { PACK_ELEVATED_ROUTES, PACK_ROUTES, type PacksResult, type PacksSnapshot } from './wire.ts'

/** The failure of a route the Host refused or could not be reached for. */
export class PacksRequestError extends Error {
  /** The HTTP status; 0 when the Host could not be reached. */
  readonly status: number
  /** Present for a refusal that asks for an unlock, in the form the unlock dialog reads: `elevation-required: packs/<action>`. */
  readonly details: { readonly reason: string } | undefined

  /**
   * @param message - what happened.
   * @param status - the HTTP status, or 0.
   * @param details - the unlock reason, for an unlock refusal.
   */
  constructor(message: string, status: number, details?: { readonly reason: string }) {
    super(message)
    this.status = status
    this.details = details
  }
}

/** What the client sends through. */
export type PacksFetch = (input: string, init?: RequestInit) => Promise<Response>

/** The client's calls. */
export interface PacksClient {
  /**
   * Read the packs and the install list.
   * @returns the snapshot.
   */
  list(): Promise<PacksSnapshot>
  /**
   * Add packs to the install list.
   * @param request - the package names.
   * @returns the new snapshot, or why nothing was added.
   */
  enqueue(request: { readonly names: readonly string[] }): Promise<PacksResult>
  /**
   * Stop a queued or working install.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  cancel(request: { readonly name: string }): Promise<PacksResult>
  /**
   * Clear a failed or cancelled row.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  dismiss(request: { readonly name: string }): Promise<PacksResult>
  /**
   * Queue a failed or cancelled install again.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  retry(request: { readonly name: string }): Promise<PacksResult>
  /**
   * Take a finished item off the list.
   * @param request - the package name.
   * @returns the new snapshot.
   */
  remove(request: { readonly name: string }): Promise<PacksResult>
}

/**
 * Create the client.
 * @param send - the `fetch` the requests go through; the browser's own by default.
 * @returns the client.
 */
export function createPacksClient(send: PacksFetch = (input, init) => globalThis.fetch(input, init)): PacksClient {
  const post = async <T>(path: string, body: object): Promise<T> => {
    let response: Response
    try {
      // Relative to the document, without the leading slash, as every studio route is fetched.
      response = await send(path.slice(1), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    } catch (error) {
      throw new PacksRequestError(`The Host could not be reached: ${error instanceof Error ? error.message : String(error)}`, 0)
    }
    if (response.status === 403 && PACK_ELEVATED_ROUTES.includes(path)) {
      throw new PacksRequestError('This needs an unlock.', 403, { reason: `elevation-required: packs/${path.slice(path.lastIndexOf('.') + 1)}` })
    }
    if (!response.ok) throw new PacksRequestError(`The Host refused the request (${String(response.status)}).`, response.status)
    return await response.json() as T
  }
  return {
    list: () => post<PacksSnapshot>(PACK_ROUTES.list, {}),
    enqueue: request => post<PacksResult>(PACK_ROUTES.enqueue, request),
    cancel: request => post<PacksResult>(PACK_ROUTES.cancel, request),
    dismiss: request => post<PacksResult>(PACK_ROUTES.dismiss, request),
    retry: request => post<PacksResult>(PACK_ROUTES.retry, request),
    remove: request => post<PacksResult>(PACK_ROUTES.remove, request),
  }
}
