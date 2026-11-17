/**
 * "Allow for this run", Host half. The card answers `'allowed-for-run'` through the same authenticated call as Allow
 * once, so the answering Peer passes the same reach check. A listener on `approval/request`, registered ahead of the
 * answerers, turns that raw answer into `allowed-once` plus a mark kept against the request object. Only a request
 * the relay built can be marked, and a mark is read once, so one answer never reaches another request.
 *
 * The `changes` scanner flags this listener because it registers on `approval/request`; that is intended.
 * @module @delorun/plugin-agent-seats/relay/run-scope
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'

/** The raw answer value of the card's "Allow for this run" button. */
export const RUN_ANSWER = 'allowed-for-run'

/** The `runScope` value of a request that offers "Allow for this run". */
export const RUN_SCOPE = 'external-agent-run'

declare module '@deepseek-ai/dsh-user-approval/types' {
  interface ApprovalRequestEvent {
    /**
     * Present only on a seat relay's request whose program offered a run rule: the card then offers "Allow for this
     * run" and answers `'allowed-for-run'`. Never persisted.
     */
    readonly runScope?: typeof RUN_SCOPE
  }
}

/** The relay's requests, which the listener answers or marks. */
export class RunScope {
  /** Requests the relay built and sent. */
  private readonly owned = new WeakSet<object>()
  /** Requests a Full access root decides without a card, with the decision. */
  private readonly automatic = new WeakMap<object, ApprovalOutcome>()
  /** Requests whose raw answer was `'allowed-for-run'`. */
  private readonly marked = new WeakSet<object>()

  /**
   * Take a request as the relay's own.
   * @param request - the request about to be sent.
   * @param automatic - the decision made without a card, when the root is in Full access.
   */
  adopt(request: ApprovalRequestEvent, automatic?: 'allowed-once' | 'rejected'): void {
    this.owned.add(request)
    if (automatic !== undefined) this.automatic.set(request, automatic)
  }

  /**
   * Read, and clear, the run mark of a decided request.
   * @param request - the request the relay sent.
   * @returns whether the person chose "Allow for this run".
   */
  take(request: ApprovalRequestEvent): boolean {
    const had = this.marked.has(request)
    this.marked.delete(request)
    return had
  }

  /**
   * Mount the listener.
   * @param ctx - the plugin's context.
   * @returns the disposer; the listener is also removed with `ctx`.
   */
  mount(ctx: Context): () => boolean {
    return ctx.on('approval/request', async (request, next): Promise<ApprovalOutcome> => {
      const decided = this.owned.has(request) ? this.automatic.get(request) : undefined
      if (decided !== undefined) return decided
      if (request.runScope === undefined) return next()
      const raw: unknown = await next()
      if (raw !== RUN_ANSWER) return typeof raw === 'string' && isOutcome(raw) ? raw : 'unavailable'
      // Only the relay's own request can carry a run allowance; anything else asked for one in vain.
      if (!this.owned.has(request)) return 'unavailable'
      this.marked.add(request)
      return 'allowed-once'
    }, { prepend: true })
  }
}

const OUTCOMES: ReadonlySet<string> = new Set<ApprovalOutcome>(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/**
 * Whether a string is one of the four outcomes.
 * @param value - a raw answer.
 * @returns true for an outcome.
 */
function isOutcome(value: string): value is ApprovalOutcome {
  return OUTCOMES.has(value)
}
