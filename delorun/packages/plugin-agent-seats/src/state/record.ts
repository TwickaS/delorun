/**
 * The seat's logged state record: which program session backs a seat child and how far input has reached it. It is
 * a plugin record of the seat child's own log (`appendPluginRecord`), so a restart, an archive restore and a fork
 * carry it with the rest of the log.
 * @module @delorun/plugin-agent-seats/state/record
 */

/** The plugin record type of the seat state. */
export const SEAT_STATE_RECORD = 'plugin:delorun/agent-seat/state'

/**
 * One state record. The latest record wins. A record with no `programSessionId` clears the program session (the
 * program's own conversation could not be resumed); `cursor` then names the last harness message the next fresh
 * program session must not be sent.
 */
export interface SeatStateRecordData {
  /** The program's own session or thread id, which `resume` takes. */
  readonly programSessionId?: string
  /** Id of the last harness message handed to the program, or, without `programSessionId`, the last one it skips. */
  readonly cursor?: string
  /** Id of the last program assistant message the harness logged, for parting detection on resume. */
  readonly programMessageId?: string
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** The seat child's program session and input cursor. */
    'plugin:delorun/agent-seat/state': SeatStateRecordData
  }
}
