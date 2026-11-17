/**
 * One live seat: the open program session behind a seat child, kept apart from the harness Agent because an idle
 * child's Agent is disposed while the program session outlives it. The adapter reads the program's events through it;
 * the seat executor reads the program's tool results and the relay reads when a call was recorded.
 * @module @delorun/plugin-agent-seats/adapter/run
 */
import type { ProgramEvent, ProgramFailure, ProgramSession } from '@delorun/external-agents/contract'

/** A tool result the program reported. */
export interface ProgramToolResult {
  /** The program's output text. */
  readonly output: string
  /** Whether the program reported the call as failed. */
  readonly isError: boolean
}

/** One live seat: a program session and the harness side's view of it. */
export class SeatRun {
  /** Id of the last harness message handed to the program. */
  cursor: string | undefined
  /** How the program's last turn failed, kept so a repeated request reports it again. */
  failure: ProgramFailure | undefined
  /** Whether the program's current turn has reported its end. */
  turnEnded = true
  /** Whether Stop interrupted the program and its turn end has not been read yet. */
  interrupted = false
  /** Whether the program's process was closed to stop it, so the seat resumes the program's session next time. */
  closed = false
  /** The seat turn's signal while the executor waits for a program result; Stop aborts it. */
  waitSignal: AbortSignal | undefined
  private readonly held: ProgramEvent[] = []
  private readonly results = new Map<string, ProgramToolResult>()
  private readonly recorded = new Set<string>()
  private readonly recordWaiters = new Map<string, () => void>()

  /** The program session behind the seat. */
  readonly program: ProgramSession

  /** @param program - the program session behind the seat. */
  constructor(program: ProgramSession) {
    this.program = program
  }

  /**
   * Take the next event that is not a tool result; results that arrive meanwhile are kept for {@link result}.
   * @param signal - aborts the wait.
   * @returns the event.
   */
  async next(signal: AbortSignal): Promise<ProgramEvent> {
    for (;;) {
      const event = this.held.shift() ?? await this.program.next(signal)
      if (event.kind !== 'tool-result') return event
      this.results.set(event.id, { output: event.output, isError: event.isError })
    }
  }

  /**
   * Resolve once the executor has written the call record for `callId`, so a question about the call is logged after
   * it: programs ask as soon as they send the call, before the harness step has recorded it.
   * @param callId - the program's call id.
   * @param signal - aborts the wait.
   * @returns resolves when the record exists; rejects with the signal's reason when it aborts first.
   */
  whenRecorded(callId: string, signal: AbortSignal): Promise<void> {
    if (this.recorded.has(callId)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        this.recordWaiters.delete(callId)
        reject(signal.reason)
      }
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
      this.recordWaiters.set(callId, () => {
        signal.removeEventListener('abort', abort)
        resolve()
      })
    })
  }

  /**
   * Wait for the program's result for one recorded call, marking the call recorded. Events that are not results are
   * held, in order, for the adapter's next request; a turn end before the result settles the call as failed.
   * @param callId - the program's call id.
   * @param signal - aborts the wait.
   * @returns the program's result.
   */
  async result(callId: string, signal: AbortSignal): Promise<ProgramToolResult> {
    this.recorded.add(callId)
    this.recordWaiters.get(callId)?.()
    this.recordWaiters.delete(callId)
    this.waitSignal = signal
    try {
      return await this.awaitResult(callId, signal)
    } finally {
      this.waitSignal = undefined
    }
  }

  private async awaitResult(callId: string, signal: AbortSignal): Promise<ProgramToolResult> {
    for (;;) {
      const known = this.results.get(callId)
      if (known !== undefined) {
        this.results.delete(callId)
        return known
      }
      if (this.held.some(event => event.kind === 'turn-end')) {
        return { output: 'The agent ended its turn before reporting this tool\'s result.', isError: true }
      }
      const event = await this.program.next(signal)
      if (event.kind === 'tool-result') this.results.set(event.id, { output: event.output, isError: event.isError })
      else this.held.push(event)
    }
  }

  /** Interrupt the program's running turn after Stop; the next request reads up to its turn end first. */
  async stop(): Promise<void> {
    if (this.turnEnded || this.interrupted) return
    this.interrupted = true
    if (await this.program.interrupt() === 'closed') {
      // The program's process is gone, so no turn end will arrive: the seat resumes the program's session next time.
      this.closed = true
      this.interrupted = false
      this.turnEnded = true
    }
  }

  /**
   * After {@link stop}, drop what the program did until its turn ended. Nothing it did after Stop is logged.
   * @param signal - aborts the wait.
   * @returns the events dropped.
   */
  async settleStop(signal: AbortSignal): Promise<ProgramEvent[]> {
    const dropped: ProgramEvent[] = []
    while (this.interrupted && !this.turnEnded) {
      const event = await this.next(signal)
      if (event.kind === 'turn-end') this.turnEnded = true
      else dropped.push(event)
    }
    this.interrupted = false
    return dropped
  }
}
