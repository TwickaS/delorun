/**
 * A chat's grant to use the person's own browser: the `realBrowserGrant` Session projection over the `real-browser/*`
 * events, and the service that reads it, records grants, the away permission and their end.
 * @module @delorun/browser-use-browse/grant
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { RealBrowserGrantSource } from '@deepseek-ai/dsh-experimental-browser-use-runtime'
import { z } from 'zod'

/** The host-only projection key of a Session's real-browser grant. */
export const GRANT_PROJECTION_KEY = 'realBrowserGrant'

/** The `user/message` source kinds of a prompt the person sent: a message, or a retry of one. */
const PERSON_PROMPT_KINDS: ReadonlySet<string> = new Set(['user', 'retry'])

/** A Session's real-browser grant as its log records it. */
export interface GrantState {
  /**
   * The count of events the Session took over from the one it was forked from. A grant among those belongs to the
   * other chat, so a fork starts without one.
   */
  readonly inherited: number
  /** The `real-browser/granted` event of the running grant, or null without one. */
  readonly grantedSeq: number | null
  /** Until when, in Unix epoch milliseconds, a run the person did not start may use the grant; null for never. */
  readonly awayUntil: number | null
  /** Whether the current turn holds a prompt the person sent; false before the first turn and at each `turn/start`. */
  readonly attended: boolean
}

const grantStateSchema: z.ZodType<GrantState> = z.object({
  inherited: z.number().int().min(0),
  grantedSeq: z.number().int().min(0).nullable(),
  awayUntil: z.number().int().nullable(),
  attended: z.boolean(),
})

/**
 * Fold one event into a Session's grant.
 * @param state - the grant before the event.
 * @param event - one committed event.
 * @returns the grant after it; the same reference for every event that changes nothing.
 */
export function applyGrantEvent(state: GrantState, event: SessionEvent): GrantState {
  switch (event.type) {
    case 'turn/start':
      return state.attended ? { ...state, attended: false } : state
    case 'user/message':
      return !state.attended && PERSON_PROMPT_KINDS.has(event.data.source.kind) ? { ...state, attended: true } : state
    case 'real-browser/granted':
      if (event.seq < state.inherited || state.grantedSeq !== null) return state
      return { ...state, grantedSeq: event.seq }
    case 'real-browser/away':
      if (event.seq < state.inherited || state.grantedSeq === null || state.awayUntil === event.data.until) return state
      return { ...state, awayUntil: event.data.until }
    case 'real-browser/ended':
      if (event.seq < state.inherited || state.grantedSeq === null) return state
      return { ...state, grantedSeq: null, awayUntil: null }
    default:
      // Every other event, the merge-extensible rest of the vocabulary included, leaves the grant as it is.
      return state
  }
}

/** A grant's change, which {@link RealBrowserGrants.onChange} reports after the event commits. */
export interface GrantChange {
  readonly session: Session
  /** Whether the grant runs after the change. */
  readonly live: boolean
}

/** What one Session's grant allows right now. */
export interface GrantView {
  /** Whether the grant runs. */
  readonly live: boolean
  /** Until when a run the person did not start may use it, in Unix epoch milliseconds; null for never. */
  readonly awayUntil: number | null
}

/** Whether a browse call may run, and the sentence that refuses it otherwise. */
export type UseVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'refuse'; readonly reason: 'no-grant' | 'away' }

/**
 * The grants of every live Session. Each change is a Session event, so a grant survives a restart and a resume, and
 * a forked Session starts without its parent's.
 */
export class RealBrowserGrants {
  private readonly listeners = new Set<(change: GrantChange) => void | Promise<void>>()
  private readonly pending = new WeakMap<Session, Promise<unknown>>()
  private readonly handle: ProjectionHandle<GrantState>
  private readonly now: () => number

  /**
   * @param ctx - the plugin context, whose `session/event` reports the changes.
   * @param handle - the registered `realBrowserGrant` projection.
   * @param now - the clock the away permission is read against.
   */
  constructor(ctx: Context, handle: ProjectionHandle<GrantState>, now: () => number) {
    this.handle = handle
    this.now = now
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'real-browser/granted' && event.type !== 'real-browser/ended') return
      const live = this.live(session)
      const previous = this.pending.get(session) ?? Promise.resolve()
      const results = [...this.listeners].map(listener => listener({ session, live }))
      this.pending.set(session, Promise.allSettled([previous, ...results]))
    })
  }

  /**
   * What a Session's grant allows.
   * @param session - the Session.
   * @returns whether it runs and until when it covers runs the person did not start.
   */
  view(session: Session): GrantView {
    const state = this.handle.stateOf(session)
    return { live: state.grantedSeq !== null, awayUntil: state.awayUntil }
  }

  /**
   * Whether a Session's grant is running.
   * @param session - the Session.
   * @returns true from its `real-browser/granted` until its `real-browser/ended`.
   */
  live(session: Session): boolean {
    return this.handle.stateOf(session).grantedSeq !== null
  }

  /**
   * Whether an Agent's chat holds a running grant, which is what the browse server's admission asks: an admitted chat
   * sees the browse tools, and each call is then decided by {@link mayUse}.
   * @param agent - the Agent.
   * @returns whether its Session's grant runs.
   */
  admitted(agent: Agent): boolean {
    return this.live(agent.session)
  }

  /**
   * Whether the current turn of a Session may use its grant: a turn that holds the person's own prompt may, and a turn
   * the person did not start, such as a scheduled or background one, only while the away permission runs.
   * @param session - the Session.
   * @returns the verdict.
   */
  mayUse(session: Session): UseVerdict {
    const state = this.handle.stateOf(session)
    if (state.grantedSeq === null) return { kind: 'refuse', reason: 'no-grant' }
    if (this.attended(session)) return { kind: 'allow' }
    if (state.awayUntil !== null && this.now() < state.awayUntil) return { kind: 'allow' }
    return { kind: 'refuse', reason: 'away' }
  }

  /**
   * {@link mayUse} for a browse call about to run. When the call is refused because the away permission ran out, the
   * lapse is recorded once, as a `real-browser/away` with `cause: 'expired'`, which also stops later refusals from
   * recording it again.
   * @param session - the Session.
   * @returns the verdict.
   */
  admitCall(session: Session): UseVerdict {
    const verdict = this.mayUse(session)
    const { awayUntil } = this.handle.stateOf(session)
    if (verdict.kind === 'refuse' && verdict.reason === 'away' && awayUntil !== null) {
      session.append('real-browser/away', { until: null, cause: 'expired' })
    }
    return verdict
  }

  /**
   * Whether the current turn of a Session holds a prompt the person sent. A delegated Session's prompts come from the
   * Agent that delegated it, whatever their kind, so its turns are never attended.
   * @param session - the Session.
   * @returns the answer the log gives.
   */
  attended(session: Session): boolean {
    if ((session.header.delegationDepth ?? 0) > 0) return false
    return this.handle.stateOf(session).attended
  }

  /**
   * Record a grant.
   * @param session - the chat.
   * @param source - the approval it answers, or the person starting it.
   * @returns the event's sequence number, or undefined when a grant already runs.
   */
  grant(session: Session, source: RealBrowserGrantSource): SessionSeq | undefined {
    if (this.live(session)) return undefined
    return session.append('real-browser/granted', { source }).seq
  }

  /**
   * Allow runs the person did not start to use the running grant until a time, or stop allowing them, as the person
   * chose.
   * @param session - the chat.
   * @param until - Unix epoch milliseconds, or null to stop.
   * @returns whether a grant runs, so the change was recorded.
   */
  setAway(session: Session, until: number | null): boolean {
    if (!this.live(session)) return false
    if (this.handle.stateOf(session).awayUntil !== until) session.append('real-browser/away', { until, cause: 'person' })
    return true
  }

  /**
   * End a running grant, and its away permission, because the person turned it off.
   * @param session - the chat.
   * @returns whether a grant was running and is now ended.
   */
  end(session: Session): boolean {
    if (!this.live(session)) return false
    session.append('real-browser/ended', { reason: 'person' })
    return true
  }

  /**
   * Wait for the listeners of a Session's grant changes so far, such as the browse server starting.
   * @param session - the chat.
   * @returns when every listener has settled; a listener's failure is its own to report.
   */
  async settled(session: Session): Promise<void> {
    await this.pending.get(session)
  }

  /**
   * Hear every start and end of a grant in any Session.
   * @param listener - called after the event commits, with whether the grant now runs; {@link settled} waits for the
   *   promise it returns.
   * @returns the disposer.
   */
  onChange(listener: (change: GrantChange) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/**
 * Register the projection and build the service on it.
 * @param ctx - the plugin context with `sessionProjections`.
 * @param now - the clock the away permission is read against.
 * @returns the service.
 */
export async function registerGrants(ctx: Context, now: () => number): Promise<RealBrowserGrants> {
  const handle = await ctx.sessionProjections.register<typeof GRANT_PROJECTION_KEY, GrantState>({
    key: GRANT_PROJECTION_KEY,
    stateSchema: grantStateSchema,
    init: (_header, inheritedEventCount) => ({ inherited: inheritedEventCount, grantedSeq: null, awayUntil: null, attended: false }),
    apply: applyGrantEvent,
    stateVersion: 1,
  })
  return new RealBrowserGrants(ctx, handle, now)
}
