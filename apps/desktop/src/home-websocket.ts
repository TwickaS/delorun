/** The credential the shell adds to the studio's WebSocket requests, for the chosen home's exact origin only (F23, A604). */

/** Request headers as Chromium reports them. */
export type RequestHeaders = Record<string, string | string[]>

/** What the shell knows when a WebSocket request leaves the main window. */
export interface WebSocketRequest {
  /** The chosen home's origin, with no token; `undefined` before a home is connected. */
  readonly homeOrigin: string | undefined
  /** The home's cookie header; `undefined` before a home is connected. */
  readonly cookie: string | undefined
  /** The request's URL. */
  readonly url: string
  /** The web contents that sent it. */
  readonly webContentsId: number | undefined
  /** The main window's web contents. */
  readonly mainWebContentsId: number | undefined
  /** The request headers. */
  readonly headers: RequestHeaders
}

/** The application origin the bundled client's requests carry. */
export const APPLICATION_ORIGIN = 'dsh-app://app'

/**
 * Decide what a WebSocket request gets. The cookie is added only when the request goes to the chosen home's exact
 * scheme, host and port, from the main window, with the application's own origin; a request with another origin is
 * cancelled, and a request to any other address passes through with no credential.
 * @param request - The request and the shell's state.
 * @returns `{ cancel: true }`, `{ requestHeaders }` with the credential, or `{}` to leave the request as it is.
 */
export function webSocketCredential(
  request: WebSocketRequest,
): { cancel: true } | { requestHeaders: RequestHeaders } | Record<string, never> {
  if (request.homeOrigin === undefined || request.cookie === undefined || request.mainWebContentsId === undefined
    || request.webContentsId !== request.mainWebContentsId) return {}
  const target = new URL(request.homeOrigin)
  const requested = URL.parse(request.url)
  if (requested === null || requested.host !== target.host || requested.protocol !== (target.protocol === 'https:' ? 'wss:' : 'ws:')) return {}
  const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]))
  if (headers.origin !== APPLICATION_ORIGIN) return { cancel: true }
  return { requestHeaders: { ...headers, origin: target.origin, cookie: request.cookie, 'sec-fetch-site': 'same-origin' } }
}
