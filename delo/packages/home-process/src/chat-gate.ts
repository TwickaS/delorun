/**
 * A {@link ChatGate} fed by the Host: each turn or background job registers when it begins and ends, with the
 * function that cancels it. While the gate is held, a new registration is refused with `UPDATE_PENDING`. The Host's
 * update plugin feeds it from upstream's turns and jobs; specs feed it directly.
 *
 * @module @delo/home-process/chat-gate
 */
import { HomeProcessError } from './errors.ts'
import type { ChatGate } from './seams.ts'

/** A {@link ChatGate} that counts registered chats. */
export class CountingChatGate implements ChatGate {
  private readonly chats = new Set<() => void>()
  private holds = 0
  private readonly waiters = new Set<() => void>()

  /**
   * Register a chat that begins now.
   * @param cancel - cancels it through upstream's cancellation.
   * @returns the function the chat calls when it ends; a second call does nothing.
   * @throws {HomeProcessError} `UPDATE_PENDING` while an update or a stop waits for running chats.
   */
  begin(cancel: () => void): () => void {
    if (this.holds > 0) throw new HomeProcessError('UPDATE_PENDING', 'an update is waiting for running chats to end')
    const entry = (): void => { cancel() }
    this.chats.add(entry)
    return () => {
      if (!this.chats.delete(entry)) return
      if (this.chats.size === 0) for (const wake of [...this.waiters]) wake()
    }
  }

  /** @inheritdoc */
  running(): number {
    return this.chats.size
  }

  /** @inheritdoc */
  hold(): () => void {
    this.holds += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds -= 1
    }
  }

  /** @inheritdoc */
  idle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason as Error)
    if (this.chats.size === 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = (): void => {
        this.waiters.delete(done)
        signal.removeEventListener('abort', aborted)
        resolve()
      }
      const aborted = (): void => {
        this.waiters.delete(done)
        reject(signal.reason as Error)
      }
      this.waiters.add(done)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  /** @inheritdoc */
  cancelAll(): Promise<void> {
    for (const cancel of [...this.chats]) cancel()
    return Promise.resolve()
  }
}
