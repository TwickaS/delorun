/**
 * Follows the end of a seat's lease (chat archived, permission revoked, consent off) so the seat's chat says why its
 * agent stopped. The start gate stops the program itself; this half only logs the reason and drops the adapter's run.
 * @module @delorun/plugin-agent-seats/lease
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the ctx.delegationConsent merge.
import type {} from '@deepseek-ai/dsh-subagent'
import type { SeatConsent, SeatLeaseEnd } from '@delorun/external-agents/contract'

/** What the chat says when a lease ends, by reason. */
export const LEASE_END_TEXT: Readonly<Record<SeatLeaseEnd, string>> = {
  archived: 'This chat was archived, so its agent stopped.',
  revoked: 'You revoked this agent\'s permission, so it stopped.',
  'grant-revoked': 'Its permission for this workspace was revoked, so it stopped.',
  'consent-off': 'Running agents was switched off, so it stopped.',
  refused: 'This agent can no longer run here, so it stopped.',
}

/**
 * Whether the delegation consent service tells when a seat's lease ends.
 * @param consent - the service, whatever it provides.
 * @returns true for a seat-aware consent.
 */
function hearsLeaseEnds(consent: object): consent is Pick<SeatConsent, 'onLeaseEnded'> {
  return 'onLeaseEnded' in consent && typeof consent.onLeaseEnded === 'function'
}

/**
 * Hear every lease end for as long as the consent service is present.
 * @param ctx - the plugin context.
 * @param ended - called with the seat child and the sentence the chat shows.
 */
export function followLeaseEnds(ctx: Context, ended: (child: SessionId, text: string) => void): void {
  ctx.inject(['delegationConsent'], (scope) => {
    const consent = scope.delegationConsent
    if (!hearsLeaseEnds(consent)) return
    scope.effect(() => consent.onLeaseEnded((lease, reason) => { ended(lease.child, LEASE_END_TEXT[reason]) }), 'delorun-agent-seats: lease ends')
  })
}
