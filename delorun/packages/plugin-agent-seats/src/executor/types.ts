/**
 * What the seat tool executor needs from the seat's live program sessions. The adapter and seat state implement it;
 * the executor never opens or closes a program.
 * @module @delorun/plugin-agent-seats/executor/types
 */
import type {} from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CallRecordLedger } from './ledger.ts'

/** The program's own result for one of its tool calls. */
export interface SeatProgramResult {
  /** The tool's output text, as the program reported it. */
  readonly output: string
  /** Whether the program reported the call as failed. */
  readonly isError: boolean
}

/** One seat's live program session, as the executor uses it. */
export interface SeatProgram {
  /**
   * Wait for the program's result for a recorded tool call. A turn that ends before the result arrives settles the
   * call as an error result; events that are not results stay queued for the adapter.
   * @param callId - the program's id for the call.
   * @param signal - aborts the wait.
   * @returns the program's result.
   */
  result(callId: string, signal: AbortSignal): Promise<SeatProgramResult>
  /**
   * Interrupt the program's running turn after Stop. Idempotent.
   * @returns once the program has accepted the interrupt.
   */
  stop(): Promise<void>
}

/** The live program sessions of seat children. */
export interface SeatPrograms {
  /** Where the executor notes each call record it writes; the relay waits on it. */
  readonly records: CallRecordLedger
  /**
   * The live program session of a seat child.
   * @param sessionId - the seat child's Session.
   * @returns the program, or undefined when none is live.
   */
  program(sessionId: SessionId): SeatProgram | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The seat children's live program sessions; provided by the seat's adapter and state. */
    seatPrograms: SeatPrograms
  }
}
