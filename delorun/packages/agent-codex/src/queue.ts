/**
 * A single-consumer event queue that can be closed: takes drain what is queued, then reject with the close reason.
 * @module @delorun/agent-codex/queue
 */

/** An unbounded single-consumer queue. */
export class EventQueue<T> {
  private readonly items: T[] = []
  private waiter: PromiseWithResolvers<T> | undefined
  private closedWith: Error | undefined

  /**
   * Add one item, waking a waiting consumer. Ignored once the queue is closed.
   * @param item - the item.
   */
  push(item: T): void {
    if (this.closedWith !== undefined) return
    const waiter = this.waiter
    if (waiter !== undefined) {
      this.waiter = undefined
      waiter.resolve(item)
      return
    }
    this.items.push(item)
  }

  /**
   * Refuse later pushes; takes still drain queued items, then reject with the reason.
   * @param reason - what the consumer receives once the queue is empty.
   */
  close(reason: Error): void {
    if (this.closedWith !== undefined) return
    this.closedWith = reason
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.reject(reason)
  }

  /**
   * Take the next item, waiting for one.
   * @param signal - abandons the wait.
   * @returns the item.
   * @throws the close reason once the queue is closed and empty, or the signal's reason.
   */
  async take(signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    if (this.items.length > 0) return this.items.shift() as T
    if (this.closedWith !== undefined) throw this.closedWith
    if (this.waiter !== undefined) throw new Error('EventQueue has one consumer at a time')
    const waiter = Promise.withResolvers<T>()
    this.waiter = waiter
    const onAbort = (): void => {
      if (this.waiter === waiter) this.waiter = undefined
      waiter.reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await waiter.promise
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
