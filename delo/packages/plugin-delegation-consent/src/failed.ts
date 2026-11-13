/**
 * The `delegationConsent` service a consent row mounts when its real service failed to activate while the row's
 * switch is on: it refuses every external start, so a crashed consent never reads as a composition without one.
 *
 * @module @delo/plugin-delegation-consent/failed
 */
import { FAIL_CLOSED_STUB } from '@delo/home'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { DelegationConsentService, ExternalDelegationReview, ExternalDelegationVerdict } from '@deepseek-ai/dsh-subagent'

/**
 * The refusal of a start while the consent's service is down.
 * @param row - the consent row's id.
 * @param provider - the provider the start selects.
 * @param reason - why the service failed.
 * @returns the sentence the person and the model read.
 */
export function failedConsentRefusal(row: string, provider: string, reason: string): string {
  return `"${provider}" was not started: the external-agent consent row ${row} is on but its service failed to start (${reason}), so no external agent runs. `
    + 'To recover, restart Delorun; if it fails again, read the Delo logs for the row\'s failure, or start in safe mode with `delorun recover safe-mode`.'
}

/** The `delegationConsent` service that refuses every start while the real service is down. */
export class FailedDelegationConsent extends Service implements DelegationConsentService {
  /** Read by the CLI's boot invariant. */
  readonly [FAIL_CLOSED_STUB] = true as const
  private readonly row: string
  private readonly failure: string

  /**
   * @param ctx - the plugin context.
   * @param options - the consent row and the reason its service failed.
   */
  constructor(ctx: Context, options: { readonly row: string, readonly reason: string }) {
    super(ctx, 'delegationConsent')
    this.row = options.row
    this.failure = options.reason
  }

  review(review: ExternalDelegationReview): Promise<ExternalDelegationVerdict> {
    return Promise.resolve({ kind: 'refuse', reason: failedConsentRefusal(this.row, review.provider, this.failure) })
  }
}
