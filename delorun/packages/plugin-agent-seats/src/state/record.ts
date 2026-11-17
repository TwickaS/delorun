/**
 * The seat's logged records. They are plugin records of the seat child's own log (`appendPluginRecord`), so a restart,
 * an archive restore and a fork carry them with the rest of the log; the `agentSeat` projection folds them.
 * @module @delorun/plugin-agent-seats/state/record
 */
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SeatModelPicker, SeatViewState } from './view.ts'

/** The plugin record type of the seat state. */
export const SEAT_STATE_RECORD = 'plugin:delorun/agent-seat/state'

/** The plugin record type of a status change the chat shows. */
export const SEAT_STATUS_RECORD = 'plugin:delorun/agent-seat/status'

/** The plugin record type of a notice the chat shows in its transcript. */
export const SEAT_NOTICE_RECORD = 'plugin:delorun/agent-seat/notice'

/**
 * The plugin record type of "Allow for this run": the gate kept the rule, so later questions it covers are not asked.
 * It is ignorable and lives in the plugin namespace, outside the Session event vocabulary.
 */
export const SEAT_RUN_ALLOWED_RECORD = 'plugin:delorun/agent-seat/run-allowed'

/**
 * One state record; the latest wins and replaces every field. A record with no `programSessionId` says the program has
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
 * One status record. It replaces `state` and the fields that belong to a state (`resetAt`, `endedReason`,
 * `modelPicker`, `pending`); `version` and `ownSettings` stay as they were when absent.
 */
export interface SeatStatusRecordData {
  /** The agent's state. */
  readonly state: SeatViewState
  /** The program's version. */
  readonly version?: string
  /** A short name for the program's own settings. */
  readonly ownSettings?: string
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

/** One notice record, shown in the chat's transcript. */
export interface SeatNoticeRecordData {
  /** What happened. */
  readonly kind: SeatNoticeKind
  /** The sentence the chat shows. */
  readonly text: string
}

/** The seat child's record that the person allowed a program rule for the rest of the run. */
export interface SeatRunAllowedRecordData {
  /** The `approval/asked` event of the question the person answered with "Allow for this run". */
  readonly askedSeq: SessionSeq
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** The seat child's program session and input cursor. */
    'plugin:delorun/agent-seat/state': SeatStateRecordData
    /** The seat child's status. */
    'plugin:delorun/agent-seat/status': SeatStatusRecordData
    /** A notice in the seat child's transcript. */
    'plugin:delorun/agent-seat/notice': SeatNoticeRecordData
    /** The person allowed a program rule for this run. */
    'plugin:delorun/agent-seat/run-allowed': SeatRunAllowedRecordData
  }
}
