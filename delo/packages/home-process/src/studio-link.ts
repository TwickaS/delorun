/**
 * The `studio.open-token` operation (contract C19, "Requests and responses"; contract C4, "Loopback sessions") and
 * the two tokens the update channel accepts. The person's `delorun` reads the start token from the token file; the
 * Host's own requests carry a second token that the home process holds only in memory. The channel accepts either
 * for every operation but `studio.open-token`, which mints a studio sign-in link and is accepted only with the start
 * token. The split stops a request sent with the Host's channel token, such as one the Host forwards for a studio
 * session, from minting a link. It does not confine Host code: a Host plugin runs unconfined in the home process and
 * can call upstream's `authenticatedUrl` itself or read the token file.
 *
 * @module @delo/home-process/studio-link
 */
import type { StartToken } from '@delo/contract-home-layout'
import type { StudioOpenTokenRequest } from '@delo/contract-home-process'
import { StartTokenCheck } from '@delo/home'
import { HomeProcessError } from './errors.ts'
import type { RunningHost } from './seams.ts'

/** Accepts the start token or the Host's channel token, each compared in constant time. */
export class ChannelTokenCheck extends StartTokenCheck {
  private readonly hostCheck: StartTokenCheck

  /**
   * @param start - the current start's token, which the token file holds.
   * @param host - the token the Host's requests carry, held only in memory.
   */
  constructor(start: StartToken, host: StartToken) {
    super(start)
    this.hostCheck = new StartTokenCheck(host)
  }

  /**
   * Whether a request's `token` is the start token or the Host's channel token. Both comparisons run every time.
   * @param candidate - the field's value as parsed from the request line.
   * @returns true for either token.
   */
  override accepts(candidate: unknown): boolean {
    const start = super.accepts(candidate)
    const host = this.hostCheck.accepts(candidate)
    return start || host
  }

  /**
   * Whether a request's `token` is the start token.
   * @param candidate - the field's value.
   * @returns true only for the start token.
   */
  acceptsStart(candidate: unknown): boolean {
    return super.accepts(candidate)
  }
}

/**
 * Answer `studio.open-token`: a fresh studio link from the Host.
 * @param request - the authenticated request.
 * @param check - the channel's token check.
 * @param host - the running Host, or `undefined` while none runs.
 * @returns the final line's fields: `url` and `oneTime`.
 * @throws {HomeProcessError} `UNAUTHENTICATED` when the request carries the Host's channel token;
 *   `STUDIO_UNAVAILABLE`, with the reason, when no Host runs or it cannot make a link for this computer.
 */
export function studioOpenToken(request: StudioOpenTokenRequest, check: ChannelTokenCheck, host: RunningHost | undefined): Readonly<Record<string, unknown>> {
  if (!check.acceptsStart(request.token)) throw new HomeProcessError('UNAUTHENTICATED')
  const result = host === undefined ? { kind: 'unavailable', reason: 'no Host is running' } as const : host.studioLink(request.args?.port)
  if (result.kind === 'unavailable') throw new HomeProcessError('STUDIO_UNAVAILABLE', result.reason)
  return { url: result.link.url, oneTime: result.link.oneTime }
}
