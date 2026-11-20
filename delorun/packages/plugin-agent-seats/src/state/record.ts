/**
 * The seat's logged events: typed Session events of the seat child's own log, so a restart and an archive restore
 * carry them with the rest of the log (a fork inherits them but shows no seat); the `agentSeat` projection folds them. They are required events, not
 * ignorable ones: a build that does not know them refuses the log instead of resuming a seat child as an ordinary
 * chat that has lost its program session. Earlier previews wrote the same three records as ignorable `plugin:`
 * records; the fold ignores those.
 * @module @delorun/plugin-agent-seats/state/record
 */
import type { SeatModelPicker, SeatSandbox, SeatViewState } from './view.ts'

/** The Session event type of the seat state. */
export const SEAT_STATE_EVENT = 'external-agent/state'

/** The Session event type of a status change the chat shows. */
export const SEAT_STATUS_EVENT = 'external-agent/status'

/** The Session event type of a notice the chat shows in its transcript. */
export const SEAT_NOTICE_EVENT = 'external-agent/notice'

/**
 * One state event; the latest wins and replaces every field. An event with no `programSessionId` says the program has
 * no session to resume (the program's own conversation could not be resumed); `cursor` then names the last harness
 * message the next fresh program session must not be sent.
 */
export interface SeatStateRecordData {
  /** The program's own session or thread id, which `resume` takes. */
  readonly programSessionId?: string
  /** Id of the last harness message handed to the program, or, without `programSessionId`, the last one it skips. */
  readonly cursor?: string
  /** Id of the last program message when the program's last turn ended, for parting detection on resume. */
  readonly programMessageId?: string
}

/**
 * One status event. It replaces `state` and the fields that belong to a state (`resetAt`, `endedReason`,
 * `modelPicker`, `pending`); `version`, `ownSettings` and the account figures stay as they were when absent.
 */
export interface SeatStatusRecordData {
  /** The agent's state. */
  readonly state: SeatViewState
  /** The program's version. */
  readonly version?: string
  /** A short name for the program's own settings. */
  readonly ownSettings?: string
  /** The plan's name; stays as it was when absent. */
  readonly plan?: string
  /** Percent of the 5-hour allowance used; stays as it was when absent. */
  readonly fiveHourPercent?: number
  /** Percent of the weekly allowance used; stays as it was when absent. */
  readonly weeklyPercent?: number
  /** When the 5-hour window resets, epoch milliseconds; stays as it was when absent. */
  readonly fiveHourResetAt?: number
  /** What the program's own sandbox does at its level, as of its start; a `starting` event clears it. */
  readonly sandbox?: SeatSandbox
  /** While `limit`: when the limit lifts, epoch milliseconds. */
  readonly resetAt?: number
  /** While `ended`: the plain-words reason. */
  readonly endedReason?: string
  /** While `model-needed`: the models to pick from. */
  readonly modelPicker?: SeatModelPicker
  /** When a question of the agent began to wait, epoch milliseconds; absent when none waits. */
  readonly pending?: number
}

/** What a notice says happened. */
export type SeatNoticeKind =
  /** The program did work Delorun did not record (a crash, or the same program session used elsewhere). */
  | 'unrecorded-work'
  /** The program's earlier conversation could not be resumed; the next message starts a fresh one. */
  | 'unresumable'
  /** The person picked the model for this workspace's agent. */
  | 'model-chosen'
  /** Delorun refused a question of the program without asking the person. */
  | 'question-refused'
  /** The program failed in a way that has no state of its own; the notice gives the fixed facts. */
  | 'program-failed'

/** One notice event, shown in the chat's transcript. */
export interface SeatNoticeRecordData {
  /** What happened. */
  readonly kind: SeatNoticeKind
  /** The sentence the chat shows. */
  readonly text: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The seat child's program session and input cursor; the latest one replaces every field. Log-only: it carries no
     * `surfaceOp` and never enters model history.
     * @param data - `programSessionId`, `cursor` and `programMessageId`, each absent when unknown.
     */
    'external-agent/state': SeatStateRecordData
    /**
     * The seat child's status, which the chat shows. Log-only: it carries no `surfaceOp` and never enters model
     * history.
     * @param data - the new `state` and the fields that belong to it.
     */
    'external-agent/status': SeatStatusRecordData
    /**
     * A notice in the seat child's transcript. Log-only: it carries no `surfaceOp` and never enters model history.
     * @param data - what happened (`kind`) and the `text` the chat shows.
     */
    'external-agent/notice': SeatNoticeRecordData
  }
}
