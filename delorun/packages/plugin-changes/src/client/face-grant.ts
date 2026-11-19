/**
 * The service that asks the person to confirm one call with Face ID: `ctx.delorunFaceGrant`, provided by
 * `@delorun/bundle-local`'s browser half and read by the Changes and update controllers. Source-only, so a consumer takes the
 * type without a build of the bundle (which depends on these plugins).
 */
import type {} from '@deepseek-ai/cordis'

/** The call a grant covers, exactly as the page is about to send it. */
export interface FaceGrantCall {
  /** The HTTP method. */
  readonly method: 'POST'
  /** The pathname and query the home receives (see {@link fetchedPath}). */
  readonly path: string
  /** The JSON body. */
  readonly body: object
}

/**
 * The path and query the home receives for a route the page fetches relative to its document, which is what the grant's
 * hash covers: `path.slice(1)` resolved against the document's base URL, so a path prefix of the studio is included.
 * @param path - the route from `wire.ts`, with its leading slash and query.
 * @returns the resolved pathname and search.
 */
export function fetchedPath(path: string): string {
  const url = new URL(path.slice(1), globalThis.document.baseURI)
  return `${url.pathname}${url.search}`
}

/** What a confirmation covers. */
export interface FaceGrantRequest {
  /** The grant's action name, such as `changes/plugin-apply`. */
  readonly action: string
  /** The call the grant is hashed from. */
  readonly call: FaceGrantCall
}

/**
 * Ask for one grant: show the action sheet, then mint the grant with Face ID or the PIN fallback.
 * @param request - what the grant covers.
 * @returns the grant's id to send in `Delorun-Grant`, or undefined when the person cancelled.
 */
export type FaceGrant = (request: FaceGrantRequest) => Promise<string | undefined>

/** What `ctx.delorunFaceGrant` shares. */
export interface FaceGrantService {
  /** @see FaceGrant */
  readonly grant: FaceGrant
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Face ID confirmation for one call; absent without this bundle's Face ID row. */
    delorunFaceGrant: FaceGrantService
  }
}
