/**
 * An unbounded single-consumer queue that can be ended with a failure, used for the program's events and for the input
 * the SDK reads.
 * @module @delorun/agent-claude-code/queue
 */

/** An unbounded queue with one consumer at a time. Items pushed before {@link Queue.end} are still taken in order. */
export class Queue<T> {
  readonly #items: T[] = []
  #waiter: PromiseWithResolvers<T> | undefined
  #ended: Error | undefined

  /**
   * Add one item, waking a waiting consumer. An item pushed after {@link Queue.end} is dropped.
   * @param item - the item.
   */
  push(item: T): void {
    if (this.#ended !== undefined) return
    const waiter = this.#waiter
    if (waiter === undefined) {
      this.#items.push(item)
      return
    }
    this.#waiter = undefined
    waiter.resolve(item)
  }

  /**
   * End the queue: the items already in it are still taken, then every take rejects with `reason`.
   * @param reason - the failure later takes reject with.
   */
  end(reason: Error): void {
    if (this.#ended !== undefined) return
    this.#ended = reason
    const waiter = this.#waiter
    this.#waiter = undefined
    waiter?.reject(reason)
  }

  /**
   * Take the next item, waiting for one.
   * @param signal - aborts the wait; the item that arrives later stays in the queue.
   * @returns the item.
   */
  async take(signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    if (this.#items.length > 0) return this.#items.shift() as T
    if (this.#ended !== undefined) throw this.#ended
    if (this.#waiter !== undefined) throw new Error('agent-claude-code: a queue has one consumer at a time')
    const waiter = Promise.withResolvers<T>()
    this.#waiter = waiter
    const onAbort = (): void => {
      if (this.#waiter === waiter) this.#waiter = undefined
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
