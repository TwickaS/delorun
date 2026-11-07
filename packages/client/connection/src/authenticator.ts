/**
 * The admission seam's Service Definition: `ctx.authenticator` decides, for
 * one request on one listener, whether it proceeds and which Peer it speaks
 * for. While no plugin provides it, Connection admits loopback requests with
 * its built-in admission, upstream's launch token and signed cookies, and no
 * reach listener can open.
 * @module @deepseek-ai/dsh-client-connection/src/authenticator
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionIndexRequest } from './rpc.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    authenticator: Authenticator
  }
  interface Events {
    /**
     * The provider changed the policy of one listener. An open reach listener
     * reads the policy again, and stops when the provider no longer serves it.
     * @param listener - id of the listener whose policy changed.
     * @mode emit
     */
    'authenticator/policy'(listener: string): void
    /**
     * Connection minted a loopback credential. Emitted synchronously, before
     * the response that carries the credential is written, so a provider can
     * record it before the browser can present it.
     * @param credential - what identifies the credential; never its value.
     * @mode emit
     */
    'authenticator/minted'(credential: MintedCredential): void
  }
}

/** Id of the listener Connection's configured web server address answers on. */
export const LOOPBACK_LISTENER = 'loopback'

/** A loopback credential Connection minted, as `authenticator/minted` carries it. It never holds the credential's value. */
export interface MintedCredential {
  /** `browser` for the launch-token exchange's cookie, `api` for the `/connect` cookie. */
  readonly kind: 'browser' | 'api'
  /** SHA-256 of the cookie value, base64url without padding. */
  readonly hash: string
  /** The audience the credential is bound to: the request's authority, as an `https:` origin on a TLS listener. */
  readonly authority: string
  /** Issue time, in milliseconds since the epoch. */
  readonly issuedAt: number
  /** Absolute expiry, in milliseconds since the epoch. */
  readonly expiresAt: number
  /** The API Peer an `api` credential admits. */
  readonly peer?: PeerId
}

/** Scheme a listener declares: the scheme the browser sees, not the socket's protocol. */
export type DeclaredScheme = 'http' | 'https'

/** The `Host` rule a listener applies before admission. */
export type HostRule =
  /** The loopback listener's fence: a loopback name, the bind address, or a `trustedHosts` authority. */
  | { readonly kind: 'upstream-fence' }
  /** `Host` equals the address's host, with its port when it is not 443. */
  | { readonly kind: 'equals-address'; readonly address: string }
  /** `Host` equals the address's host and the TLS connection's SNI equals its hostname. */
  | { readonly kind: 'equals-bound-name-and-sni'; readonly address: string }

/**
 * One exact method and path a reach listener serves before sign-in. A final
 * `<…>` segment stands for one non-empty path segment that the owning route
 * parses; no other segment may hold one.
 */
export interface PreLoginRoute {
  readonly method: 'GET' | 'POST'
  readonly path: string
}

/** The policy of one listener, read when it opens and on each `authenticator/policy` event. */
export interface ListenerPolicy {
  readonly listener: string
  readonly scheme: DeclaredScheme
  readonly hostRule: HostRule
  /** Whether the launch token and `/connect` are accepted; true only on the loopback listener. */
  readonly acceptsLaunchToken: boolean
  /** Routes served before sign-in; empty on the loopback listener. */
  readonly preLogin: readonly PreLoginRoute[]
}

/**
 * The result of admitting one request.
 * - `admitted`: the request proceeds and speaks for `peer`; `setCookie` is a
 *   complete `Set-Cookie` value the dispatcher adds to an HTTP response.
 * - `pre-login`: the request is unauthenticated and only `route`, which must
 *   be on the listener's pre-login list, may answer it.
 * - `refused`: the dispatcher answers `status` with `{"error":"<code>"}`.
 */
export type Admission =
  | {
    readonly kind: 'admitted'
    readonly peer: PeerScope
    readonly deviceId?: string
    readonly sessionId?: string
    readonly setCookie?: string
  }
  | { readonly kind: 'pre-login'; readonly route: PreLoginRoute }
  | { readonly kind: 'refused'; readonly status: 401 | 403 | 421; readonly code: string }

/**
 * Admission provider. Subclass it and load the subclass as a plugin; it
 * registers as `ctx.authenticator`, one provider per context. Connection's
 * loopback admission calls {@link admit} after its `Host` and `Origin` fence,
 * and each reach listener's dispatcher calls it after the reach checks.
 *
 * Providers must keep these rules:
 * - {@link admit} is synchronous and reads only in-memory state; a provider
 *   whose state is not loaded yet refuses.
 * - {@link policy} returns a policy only for listeners the provider serves.
 *   A reach listener opens only while its provider returns a policy for it,
 *   and closes when that provider is removed or replaced.
 * - Each change to a returned policy is announced with `authenticator/policy`.
 * - A `setCookie` on an upgrade request is never sent, because the upgrade
 *   handler writes the response; a provider rolls a session only on a request
 *   without an `Upgrade` header.
 */
export abstract class Authenticator extends Service {
  constructor(ctx: Context) {
    super(ctx, 'authenticator')
  }

  /**
   * Admit one request on one listener.
   * @param request - the request's headers, method and target.
   * @param listener - the listener that received it.
   * @returns the admission.
   */
  abstract admit(request: ConnectionIndexRequest, listener: string): Admission

  /**
   * The policy of one listener.
   * @param listener - a listener id.
   * @returns the policy, or `undefined` when this provider does not serve the listener.
   */
  abstract policy(listener: string): ListenerPolicy | undefined
}
