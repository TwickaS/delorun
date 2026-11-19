/**
 * The seat's logged state: reads come from the `agentSeat` projection's state, writes are plugin records of the seat
 * child's own log. This is the {@link SeatStateStore} the adapter takes, and the writer of the status and notice
 * records the chat shows.
 * @module @delorun/plugin-agent-seats/state/store
 */
import { appendPluginRecord, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import type { SeatState, SeatStateStore } from '../adapter/state-port.ts'
import type { SeatProjectionState } from './fold.ts'
import { viewOf } from './fold.ts'
import { SEAT_NOTICE_RECORD, SEAT_STATE_RECORD, SEAT_STATUS_RECORD, type SeatNoticeKind } from './record.ts'
import type { AgentSeatView, SeatModelPicker, SeatViewState } from './view.ts'

/** Where the store finds a seat child's Session. */
export interface SeatSessions {
  /**
   * @param id - a Session id.
   * @returns the loaded Session, or undefined.
   */
  get(id: SessionId): Session | undefined
}

/** The registered projection's reader. */
export interface SeatStateReader {
  /**
   * @param session - a Session.
   * @returns the fold's state at the Session's cursor.
   */
  stateOf(session: Session): SeatProjectionState
}

/** The plan and limit figures of an account, as the chat shows them. */
export interface AccountFigures {
  /** The plan's name. */
  readonly plan?: string
  /** Percent of the 5-hour allowance used. */
  readonly fiveHourPercent?: number
  /** Percent of the weekly allowance used. */
  readonly weeklyPercent?: number
  /** When the 5-hour window resets, epoch milliseconds. */
  readonly fiveHourResetAt?: number
}

/** What a status record adds to the current view. */
export interface StatusChange extends AccountFigures {
  /** The version of the program, when it has reported one. */
  readonly version?: string
  /** A short name for the program's own settings. */
  readonly ownSettings?: string
  /** Whether the program's own sandbox confines it at its level, as of its start; a `starting` record clears it. */
  readonly sandboxed?: boolean
  /** While `limit`: when the limit lifts, epoch milliseconds. */
  readonly resetAt?: number
  /** While `ended`: the plain-words reason. */
  readonly endedReason?: string
  /** While `model-needed`: the models to pick from. */
  readonly modelPicker?: SeatModelPicker
}

/**
 * The status fields that belong to the state a view is in, which a status record that only changes another field repeats.
 * @param view - the view shown.
 * @returns the state and its own fields.
 */
function stateFields(view: AgentSeatView): StatusChange & { readonly state: SeatViewState } {
  return {
    state: view.state,
    ...view.resetAt === undefined ? {} : { resetAt: view.resetAt },
    ...view.endedReason === undefined ? {} : { endedReason: view.endedReason },
    ...view.modelPicker === undefined ? {} : { modelPicker: view.modelPicker },
  }
}

/** The seat children's logged state. */
export class SeatRecords implements SeatStateStore {
  private readonly sessions: SeatSessions
  private readonly reader: SeatStateReader

  /**
   * @param sessions - where a seat child's Session is found.
   * @param reader - the registered projection.
   */
  constructor(sessions: SeatSessions, reader: SeatStateReader) {
    this.sessions = sessions
    this.reader = reader
  }

  private sessionOf(child: SessionId): Session {
    const session = this.sessions.get(child)
    if (session === undefined) throw new Error(`the seat child ${child} is not loaded, so its state cannot be read or logged`)
    return session
  }

  /**
   * Whether a child's Session is live, so its state can be read and logged. A finished or failed child is cold until the
   * person's next message resumes it.
   * @param child - the seat child.
   * @returns true while the Session is loaded.
   */
  isLoaded(child: SessionId): boolean {
    return this.sessions.get(child) !== undefined
  }

  /**
   * The fold's state of a seat child.
   * @param child - the seat child.
   * @returns the state.
   * @throws when the child's Session is not loaded.
   */
  stateOf(child: SessionId): SeatProjectionState {
    return this.reader.stateOf(this.sessionOf(child))
  }

  /**
   * The view the child's chat shows.
   * @param child - the seat child.
   * @returns the view, or null when the chat is not a seat child.
   * @throws when the child's Session is not loaded.
   */
  viewOf(child: SessionId): AgentSeatView | null {
    return viewOf(this.stateOf(child).shown)
  }

  /**
   * The provider of the child's own `subagent/descriptor`.
   * @param child - the child.
   * @returns the provider name, or undefined without a descriptor or a loaded Session.
   */
  providerOf(child: SessionId): string | undefined {
    const session = this.sessions.get(child)
    return session === undefined ? undefined : this.reader.stateOf(session).provider ?? undefined
  }

  /**
   * Whether the child's latest approval policy is the pin seeded at delegation.
   * @param child - the child.
   * @returns true while the pin is the latest `approval/policy` event.
   * @throws when the child's Session is not loaded.
   */
  delegationPinned(child: SessionId): boolean {
    return this.stateOf(child).pinned
  }

  read(child: SessionId): SeatState | undefined {
    const { programSessionId, cursor } = this.stateOf(child).logged
    if (programSessionId === null && cursor === null) return undefined
    return { ...programSessionId === null ? {} : { programSessionId }, ...cursor === null ? {} : { cursor } }
  }

  write(child: SessionId, state: SeatState): void {
    const { logged } = this.stateOf(child)
    // The program's last message id belongs to the program session it was read from.
    const keep = state.programSessionId !== undefined && state.programSessionId === logged.programSessionId && logged.programMessageId !== null
    appendPluginRecord(this.sessionOf(child), SEAT_STATE_RECORD, {
      ...state.programSessionId === undefined ? {} : { programSessionId: state.programSessionId },
      ...state.cursor === undefined ? {} : { cursor: state.cursor },
      ...keep ? { programMessageId: logged.programMessageId } : {},
    })
  }

  /**
   * Drop the program session id after the program's own conversation could not be resumed, and keep a cursor at the
   * newest message, so the next fresh program session is sent only what the person writes next.
   * @param child - the seat child.
   */
  clearProgram(child: SessionId): void {
    const { tail } = this.stateOf(child)
    appendPluginRecord(this.sessionOf(child), SEAT_STATE_RECORD, tail === null ? {} : { cursor: tail })
  }

  /**
   * Keep the program's last message id, or forget it.
   * @param child - the seat child.
   * @param programMessageId - the id, or undefined when it cannot be known (a stopped turn).
   */
  recordProgramMessage(child: SessionId, programMessageId: string | undefined): void {
    const { logged } = this.stateOf(child)
    if ((programMessageId ?? null) === logged.programMessageId) return
    appendPluginRecord(this.sessionOf(child), SEAT_STATE_RECORD, {
      ...logged.programSessionId === null ? {} : { programSessionId: logged.programSessionId },
      ...logged.cursor === null ? {} : { cursor: logged.cursor },
      ...programMessageId === undefined ? {} : { programMessageId },
    })
  }

  /**
   * Log a new state of the agent. The fields that belong to a state are those of `change`; `version` and
   * `ownSettings` stay as they were when `change` has none.
   * @param child - the seat child.
   * @param state - the state.
   * @param change - the fields that belong to it.
   */
  setStatus(child: SessionId, state: SeatViewState, change: StatusChange = {}): void {
    appendPluginRecord(this.sessionOf(child), SEAT_STATUS_RECORD, { state, ...change })
  }

  /**
   * Log whether a question of the agent waits, keeping the state it is in.
   * @param child - the seat child.
   * @param since - when the question began to wait, epoch milliseconds; undefined when none waits.
   */
  setPending(child: SessionId, since: number | undefined): void {
    const view = this.viewOf(child)
    if (view === null) throw new Error(`the chat ${child} is not a seat child`)
    appendPluginRecord(this.sessionOf(child), SEAT_STATUS_RECORD, { ...stateFields(view), ...since === undefined ? {} : { pending: since } })
  }

  /**
   * Log the account figures the chat shows, keeping the state it is in. Nothing is logged when they are the ones shown.
   * @param child - the seat child.
   * @param figures - the plan and limit figures; an absent field keeps what is shown.
   */
  setAccount(child: SessionId, figures: AccountFigures): void {
    const view = this.viewOf(child)
    if (view === null) throw new Error(`the chat ${child} is not a seat child`)
    const changed = (Object.keys(figures) as (keyof AccountFigures)[]).some(key => figures[key] !== view[key])
    if (!changed) return
    appendPluginRecord(this.sessionOf(child), SEAT_STATUS_RECORD, {
      ...stateFields(view),
      ...view.pending === undefined ? {} : { pending: view.pending.since },
      ...figures,
    })
  }

  /**
   * Log a notice for the chat's transcript.
   * @param child - the seat child.
   * @param kind - what happened.
   * @param text - the sentence the chat shows.
   */
  notice(child: SessionId, kind: SeatNoticeKind, text: string): void {
    appendPluginRecord(this.sessionOf(child), SEAT_NOTICE_RECORD, { kind, text })
  }
}
