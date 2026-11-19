/**
 * The gate a plugin Fetch route declares its class with: {@link gateByClass}. It looks the route's row up in
 * `AUTH_CLASSES` ({@link authClassOf}), so the route and the table cannot disagree, and builds the `admitPeer` and
 * `fetch` of a `ConnectionFetchRoute`.
 *
 * - `free`: any approved reach device, no prompt.
 * - `face`: while the Face ID preview flag is on, a reach device passes only with a grant the home keeps for exactly this
 *   call. The home reads the request body itself, up to {@link GRANT_BODY_CAP_BYTES}, and hashes method, path and body
 *   ({@link hashRequest}); the `Delorun-Grant` header only names the grant id and must equal the id of the grant that hash
 *   finds. The grant is used up just before the route's handler runs, and the header is removed before the handler sees
 *   the request. A device that holds a passkey is admitted by a grant alone; a device without one may also hold the
 *   legacy unlock the route declared in `legacy`. While the flag is off, `face` behaves as `gateByUnlock` with `legacy`.
 * - `computer`: not a Fetch gate; such a route registers no `admitPeer`, and the owner's Peer alone reaches it.
 *
 * @module @delorun/home-auth/auth-gate
 */
import { authClassOf } from './auth-classes.ts'
import { gateByUnlock, type DangerousModeHome } from './computer-only.ts'
import { refusalBody } from './errors.ts'
import { GRANT_BODY_CAP_BYTES, hashRequest, type HoldFeature } from './grants.ts'
import { REACH_DEVICE, type ReachDevicePrincipal } from './reach-access.ts'
import type { HomeAuthService } from './service.ts'

/** The request header that names the grant a call uses; the home removes it before the route's handler runs. */
export const GRANT_HEADER = 'delorun-grant'

/** What a gate reads of the home. */
export type GrantGateHome = DangerousModeHome & Pick<HomeAuthService, 'passkeysEnabled' | 'faceGrants' | 'deviceHasPasskey'>

/** The unlock a `face` route keeps while the preview flag is off, and for a device with no passkey: the options of `gateByUnlock`. */
export interface LegacyUnlock {
  readonly grace?: boolean
  readonly renews: boolean
  readonly phonePowers?: 'full'
}

/** What {@link gateByClass} is configured with. */
export interface GateOptions {
  /** The route's `AUTH_CLASSES` row id, such as `route:plugin-packs/src/routes.ts#path (write)`. */
  readonly row: string
  /**
   * The action name the grant is keyed by, which the client names in `POST /auth/passkey/options` and the Face ID sheet
   * describes; the route's own name in the form `<package>/<route>` (for example `plugin-packs/add`).
   */
  readonly action: string
  /** The unlock a `face` route keeps while the flag is off. */
  readonly legacy: LegacyUnlock
  /**
   * For a route that opens or reads inside a terminal or picker: the feature, how the call names the one it concerns, and
   * whether a grant for this call opens that hold. A live hold on the named id admits the call without a new grant.
   */
  readonly hold?: {
    readonly feature: HoldFeature
    /**
     * @param request - the request.
     * @param body - the body the home read.
     * @returns the terminal or picker id the call names, or undefined for none.
     */
    readonly idOf: (request: Request, body: Uint8Array) => string | undefined
    /** Whether a grant for this call opens the hold of the id it names. */
    readonly opens: boolean
  }
}

/** What {@link gateByClass} returns: the two fields of a `ConnectionFetchRoute` that decide who is admitted. */
export interface ClassGate {
  readonly admitPeer: (request: Request, peer: { readonly principal: { readonly kind: string } }) => boolean
  readonly fetch: (request: Request) => Promise<Response>
}

const REFUSAL_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const

/**
 * Read a request's body up to a cap.
 * @param request - a clone of the request, whose body this reads.
 * @param cap - the most bytes to read.
 * @returns the bytes, or undefined when the body is larger than the cap.
 */
export async function readBodyCapped(request: Request, cap: number): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > cap) return undefined
  if (request.body === null) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = request.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) {
      // Not awaited: cancelling a branch of a cloned body waits for the other branch, which nobody reads.
      void reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Declare a plugin Fetch route's class and build its gate.
 * @param homeAuth - a way to the mounted `homeAuth` service, read when a request arrives.
 * @param fetch - the route's own handler.
 * @param options - the route's row, grant action name, legacy unlock and optional hold.
 * @returns the `admitPeer` and `fetch` for `ConnectionFetchRoute`.
 * @throws {Error} when the row is not in `AUTH_CLASSES` or is a `computer` row, which no Fetch gate serves a device.
 */
export function gateByClass(homeAuth: () => GrantGateHome | undefined, fetch: (request: Request) => Promise<Response>, options: GateOptions): ClassGate {
  const authClass = authClassOf(options.row)
  if (authClass === undefined) throw new Error(`home-auth: gateByClass names the row "${options.row}", which AUTH_CLASSES does not list`)
  if (authClass === 'computer') throw new Error(`home-auth: the row "${options.row}" is computer-only; a computer route registers no admitPeer`)
  const principals = new WeakMap<Request, ReachDevicePrincipal>()
  const legacy = gateByUnlock(homeAuth, fetch, { renews: options.legacy.renews, ...options.legacy.grace === undefined ? {} : { grace: options.legacy.grace }, ...options.legacy.phonePowers === undefined ? {} : { phonePowers: options.legacy.phonePowers } })
  const refuse = (message: string): Response => new Response(refusalBody('ELEVATION_REQUIRED', message), { status: 403, headers: REFUSAL_HEADERS })
  return {
    admitPeer: (request, peer) => {
      if (peer.principal.kind !== REACH_DEVICE || homeAuth() === undefined) return false
      if (authClass === 'free') return true
      principals.set(request, peer.principal as ReachDevicePrincipal)
      return legacy.admitPeer(request, peer)
    },
    fetch: async (request) => {
      const principal = principals.get(request)
      if (authClass === 'free' || principal === undefined) return fetch(request)
      const home = homeAuth()
      const grants = home?.passkeysEnabled() === true ? home.faceGrants() : undefined
      if (home === undefined || grants === undefined) return legacy.fetch(request)
      const holder = { deviceId: principal.deviceId, listener: principal.listener }
      const passkey = home.deviceHasPasskey(principal.deviceId)
      const body = await readBodyCapped(request.clone(), GRANT_BODY_CAP_BYTES)
      if (body === undefined) return refuse('This request is too large to confirm. Make it smaller')
      const pathname = new URL(request.url).pathname
      const held = options.hold?.idOf(request, body)
      const feature = options.hold?.feature
      if (feature !== undefined && held !== undefined && grants.holdAdmits(holder, feature, held)) return fetch(withoutGrantHeader(request))
      const hash = hashRequest({ method: request.method, path: pathname, body })
      const named = request.headers.get(GRANT_HEADER)
      const found = hash === undefined ? undefined : grants.peek(holder, options.action, hash)
      if (hash !== undefined && found !== undefined && named === found.grantId) {
        const opens = options.hold?.opens === true && feature !== undefined && held !== undefined ? { feature, id: held } : undefined
        grants.consume(holder, options.action, hash, opens)
        return fetch(withoutGrantHeader(request))
      }
      // A device with no passkey may still hold the unlock a code or its PIN started; one with a passkey is admitted by a grant alone.
      if (!passkey) return legacy.fetch(request)
      return refuse('Confirm with Face ID or your PIN first')
    },
  }
}

/**
 * The request without the grant header, so no handler or plugin downstream reads a grant id.
 * @param request - the request.
 * @returns a request with the same method, URL and body and no `Delorun-Grant` header.
 */
function withoutGrantHeader(request: Request): Request {
  if (!request.headers.has(GRANT_HEADER)) return request
  const headers = new Headers(request.headers)
  headers.delete(GRANT_HEADER)
  return new Request(request, { headers })
}
