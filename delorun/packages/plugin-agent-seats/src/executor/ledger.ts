/**
 * The ledger of program tool calls whose `tool/call` record the seat executor has written. The relay holds a program's
 * question until its call is in this ledger, so the log reads call, asked, decided, result (L36).
 * @module @delorun/plugin-agent-seats/executor/ledger
 */
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Called once for each call record the executor writes. */
export type CallRecordedListener = (event: { readonly sessionId: SessionId; readonly callId: string }) => void

/** Which program calls of which seat Sessions have a written `tool/call` record. */
export class CallRecordLedger {
  private readonly written = new Map<SessionId, Set<string>>()
  private readonly listeners = new Set<CallRecordedListener>()
  private readonly waiters = new Map<string, Set<() => void>>()

  /**
   * Note that the `tool/call` record of a program call is in the seat's log, and tell listeners and waiters.
   * @param sessionId - the seat child's Session.
   * @param callId - the program's id for the call.
   * @throws AggregateError when a listener threw, after every listener ran.
   */
  mark(sessionId: SessionId, callId: string): void {
    let calls = this.written.get(sessionId)
    if (calls === undefined) this.written.set(sessionId, calls = new Set())
    calls.add(callId)
    const key = waiterKey(sessionId, callId)
    const waiting = this.waiters.get(key)
    this.waiters.delete(key)
    for (const wake of waiting ?? []) wake()
    const failures: unknown[] = []
    for (const listener of [...this.listeners]) {
      try {
        listener({ sessionId, callId })
      } catch (error: unknown) {
        // One failing listener must not keep the others from hearing the record.
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} call-record listener(s) failed`)
  }

  /**
   * Hear each call record as the executor writes it.
   * @param listener - called synchronously after the record is appended and before the program's result is awaited.
   * @returns the disposer.
   */
  onCallRecorded(listener: CallRecordedListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Wait until a call's record is written.
   * @param sessionId - the seat child's Session.
   * @param callId - the program's id for the call.
   * @param signal - rejects the wait with the signal's reason when it aborts first.
   * @returns resolves at once when the record is already written.
   */
  recorded(sessionId: SessionId, callId: string, signal?: AbortSignal): Promise<void> {
    if (this.written.get(sessionId)?.has(callId) === true) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const key = waiterKey(sessionId, callId)
      const wake = (): void => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = (): void => {
        const waiting = this.waiters.get(key)
        waiting?.delete(wake)
        if (waiting?.size === 0) this.waiters.delete(key)
        reject(signal?.reason)
      }
      if (signal?.aborted === true) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      let waiting = this.waiters.get(key)
      if (waiting === undefined) this.waiters.set(key, waiting = new Set())
      waiting.add(wake)
    })
  }

  /**
   * Drop what is known about a Session whose seat has ended.
   * @param sessionId - the seat child's Session.
   */
  forget(sessionId: SessionId): void {
    this.written.delete(sessionId)
  }
}

function waiterKey(sessionId: SessionId, callId: string): string {
  return JSON.stringify([sessionId, callId])
}
