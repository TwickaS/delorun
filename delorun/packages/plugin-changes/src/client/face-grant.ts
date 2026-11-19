/**
 * The service that asks the person to confirm one call with Face ID: `ctx.delorunFaceGrant`, provided by
 * `@delorun/bundle-local`'s browser half and read by the Changes and update controllers and by every plugin that sends its
 * home requests through {@link grantingFetchOf}. Source-only, so a consumer takes the type without a build of the bundle
 * (which depends on these plugins).
 */
import type { Context } from '@deepseek-ai/cordis'

/** A Fetch call a grant covers, exactly as the page is about to send it. */
export interface FaceGrantCall {
  /** The HTTP method. */
  readonly method: string
  /** The pathname and query the home receives (see {@link fetchedPath}). */
  readonly path: string
  /**
   * The body: a JSON value, or the text as sent. Text that parses as JSON is hashed in its canonical form, any other
   * text as its bytes, as the home hashes the body it reads; an empty text stands for no body.
   */
  readonly body: object | string
}

/** A Remote method call a grant covers: the argument object as the page sends it on the Remote mux. */
export interface RemoteGrantCall {
  /** The call's wire arguments, hashed as `hashArgs`. */
  readonly args: Readonly<Record<string, unknown>>
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

/** The terminal or folder picker a grant opens a hold on when the call that uses it opens that terminal or picker. */
export interface FaceGrantHold {
  readonly feature: 'terminal' | 'picker'
  readonly id: string
}

/** What a confirmation covers. */
export interface FaceGrantRequest {
  /**
   * The grant's action name: a Remote method (`pluginManager/installBundle`), a Fetch route's action
   * (`plugin-packs/add`) or a Changes control (`changes/plugin-apply`). The sheet's words are looked up by it.
   */
  readonly action: string
  /** The call the grant is hashed from. */
  readonly call: FaceGrantCall | RemoteGrantCall
  /** The hold the grant opens, for `terminal/create` and `directoryPicker/list`. */
  readonly hold?: FaceGrantHold | undefined
}

/**
 * Ask for one grant: show the action sheet, then mint the grant with Face ID or the PIN fallback.
 * @param request - what the grant covers.
 * @returns the grant's id to send in `Delorun-Grant`, or undefined when the person cancelled.
 */
export type FaceGrant = (request: FaceGrantRequest) => Promise<string | undefined>

/** The page's `fetch` as the studio's plugins call it: a path relative to the document, and the request's options. */
export type GrantingFetch = (input: string, init?: RequestInit) => Promise<Response>

/** What `ctx.delorunFaceGrant` shares. */
export interface FaceGrantService {
  /** @see FaceGrant */
  readonly grant: FaceGrant
  /**
   * The page's `fetch` with the Face ID step: a `403 ELEVATION_REQUIRED` answer that names its grant `action` opens the
   * confirmation for exactly that request, and a granted request is sent once more with `Delorun-Grant`. A cancelled
   * confirmation, or any other answer, is returned to the caller as the home sent it. On the home's own computer it is
   * the page's `fetch`.
   */
  readonly fetch: GrantingFetch
}

/**
 * The `fetch` a plugin sends its home requests through: the Face ID service's when the studio provides it, read at each
 * call, otherwise the page's own.
 * @param ctx - the plugin's browser context.
 * @returns the function.
 */
export function grantingFetchOf(ctx: Context): GrantingFetch {
  return (input, init) => (ctx.get('delorunFaceGrant')?.fetch ?? ((path: string, options?: RequestInit) => globalThis.fetch(path, options)))(input, init)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Face ID confirmation for one call; absent without this bundle's Face ID row. */
    delorunFaceGrant: FaceGrantService
  }
}
