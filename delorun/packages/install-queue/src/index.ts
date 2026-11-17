/**
 * The Host's plugin install queue (owner decision A404). One queue holds every plugin download and install: first come
 * first served, a configured number at once, the same plugin once, a failure that never stops the others, and one
 * Host reload when the queue drains, never while a chat runs. The queue's state is persisted through an injected
 * store, so a page reload or a Host restart finds it again, and every change goes to subscribers, so every device
 * sees the same list. The queue runs installs through an injected runner and reloads through an injected function; it
 * knows nothing of packs, the plugin manager or the network.
 *
 * @module @delorun/install-queue
 */

/** Where one item stands. */
export type InstallState = 'queued' | 'downloading' | 'verifying' | 'installing' | 'needs-reload' | 'ready' | 'failed' | 'cancelled'

/** Why an item failed, in terms the panel can show and act on. */
export interface InstallFailure {
  /** `offline` when the download could not start for lack of a connection; `interrupted` when the Host stopped during the install; otherwise `failed`. */
  readonly code: 'offline' | 'interrupted' | 'failed'
  /** A sentence for the person. */
  readonly message: string
}

/** One plugin in the queue. */
export interface InstallItem {
  /** The package name, the item's identity: the same plugin is one item. */
  readonly key: string
  /** The person's words for the plugin, when the caller gave one. */
  readonly title?: string
  /** Where it stands. */
  readonly state: InstallState
  /** Bytes received so far while downloading. */
  readonly receivedBytes: number
  /** Total bytes to download, when known. */
  readonly totalBytes?: number
  /** `1` for the next item to start; absent once it has started. */
  readonly position?: number
  /** Present while `failed`. */
  readonly failure?: InstallFailure
  /** Whether the finished install needs the Host to reload before the plugin runs. */
  readonly reloadNeeded: boolean
}

/** What a runner reports while it works. */
export interface InstallProgress {
  /** The runner entered a stage. */
  stage(state: 'downloading' | 'verifying' | 'installing'): void
  /** Bytes downloaded so far, and the total when known. */
  bytes(received: number, total?: number): void
}

/** The outcome of a finished run. */
export interface InstallOutcome {
  /** Whether the plugin only runs after a Host reload. */
  readonly reloadNeeded: boolean
}

/** A refusal the runner raises for a failure the person can act on. */
export class InstallRefusal extends Error {
  /** The failure code the item shows. */
  readonly code: InstallFailure['code']

  /**
   * @param code - the failure code.
   * @param message - a sentence for the person.
   */
  constructor(code: InstallFailure['code'], message: string) {
    super(message)
    this.code = code
  }
}

/** The injected collaborators. */
export interface InstallQueueOptions {
  /** How many installs run at once; a validated Config field of the caller, at least 1. */
  readonly concurrency: number
  /**
   * Download, verify and install one plugin.
   * @param key - the package name.
   * @param signal - aborted when the person cancels the item.
   * @param progress - stage and byte reports.
   * @returns the outcome.
   */
  readonly run: (key: string, signal: AbortSignal, progress: InstallProgress) => Promise<InstallOutcome>
  /**
   * The Host reload that makes finished installs run; called once per drained queue.
   * @returns when the Host has reloaded.
   */
  readonly reload: () => Promise<void>
  /**
   * How many chats run now; a reload waits until it is zero.
   * @returns the number.
   */
  readonly runningChats: () => number
  /** Persisted items, read once by {@link InstallQueue.restore}. */
  readonly load: () => readonly InstallItem[]
  /**
   * Persist the items after each change.
   * @param items - the queue's items.
   */
  readonly save: (items: readonly InstallItem[]) => void
}

const ACTIVE: ReadonlySet<InstallState> = new Set(['downloading', 'verifying', 'installing'])

/** The queue. */
export class InstallQueue {
  private items: InstallItem[] = []
  private readonly running = new Map<string, AbortController>()
  private readonly listeners = new Set<(items: readonly InstallItem[]) => void>()
  private reloading = false
  private readonly options: InstallQueueOptions

  /**
   * @param options - the collaborators.
   * @throws Error when the concurrency is not a positive integer.
   */
  constructor(options: InstallQueueOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error(`the install queue's concurrency must be a positive integer, not ${String(options.concurrency)}`)
    this.options = options
  }

  /**
   * Read the persisted items: queued ones keep their place and start again; an item that was working when the Host
   * stopped is failed as interrupted, because its files are in an unknown state; items awaiting a reload stay so.
   */
  restore(): void {
    this.items = this.options.load().map(item => (ACTIVE.has(item.state)
      ? { ...item, state: 'failed' as const, failure: { code: 'interrupted' as const, message: 'Delorun stopped while this was installing. Try again.' }, receivedBytes: 0 }
      : item))
    this.settle()
  }

  /**
   * The items in queue order.
   * @returns a copy.
   */
  snapshot(): readonly InstallItem[] {
    return this.items.map(item => ({ ...item }))
  }

  /**
   * Follow every change.
   * @param listener - called with the whole list after each change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (items: readonly InstallItem[]) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Add a plugin. A plugin already queued or working stays as it is; a failed, cancelled or finished one starts again.
   * @param key - the package name.
   * @param title - the person's words for it.
   * @returns the item.
   */
  enqueue(key: string, title?: string): InstallItem {
    const existing = this.items.find(item => item.key === key)
    if (existing !== undefined && (existing.state === 'queued' || ACTIVE.has(existing.state) || existing.state === 'needs-reload')) return { ...existing }
    this.items = this.items.filter(item => item.key !== key)
    const item: InstallItem = { key, ...title === undefined ? {} : { title }, state: 'queued', receivedBytes: 0, reloadNeeded: false }
    this.items.push(item)
    this.settle()
    return { ...item }
  }

  /**
   * Cancel an item: a queued one is dropped from the line, a working one is aborted.
   * @param key - the package name.
   */
  cancel(key: string): void {
    const item = this.items.find(each => each.key === key)
    if (item === undefined) return
    if (item.state === 'queued') this.replace(key, { state: 'cancelled' })
    else if (ACTIVE.has(item.state)) this.running.get(key)?.abort()
    this.settle()
  }

  /**
   * Remove a finished, failed or cancelled item from the list.
   * @param key - the package name.
   */
  remove(key: string): void {
    const item = this.items.find(each => each.key === key)
    if (item === undefined || item.state === 'queued' || ACTIVE.has(item.state) || item.state === 'needs-reload') return
    this.items = this.items.filter(each => each.key !== key)
    this.publish()
  }

  /**
   * Remove a failed or cancelled item from the list, which is only a queue record: a `ready` item stays.
   * @param key - the package name.
   * @returns whether an item was removed.
   */
  dismiss(key: string): boolean {
    const item = this.items.find(each => each.key === key)
    if (item === undefined || (item.state !== 'failed' && item.state !== 'cancelled')) return false
    this.remove(key)
    return true
  }

  /** Tell the queue a chat finished, so a reload that waited for the chats can run. */
  chatsChanged(): void {
    this.settle()
  }

  private replace(key: string, change: Partial<Omit<InstallItem, 'key'>>): void {
    this.items = this.items.map(item => (item.key === key ? { ...item, ...change } : item))
    this.publish()
  }

  private publish(): void {
    let place = 0
    this.items = this.items.map(item => {
      if (item.state !== 'queued') return item.position === undefined ? item : (({ position: _position, ...rest }) => rest)(item)
      place += 1
      return { ...item, position: place }
    })
    this.options.save(this.items)
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private settle(): void {
    this.publish()
    while (this.running.size < this.options.concurrency) {
      const next = this.items.find(item => item.state === 'queued')
      if (next === undefined) break
      this.start(next.key)
    }
    if (this.running.size === 0 && !this.items.some(item => item.state === 'queued')) this.drained()
  }

  private start(key: string): void {
    const controller = new AbortController()
    this.running.set(key, controller)
    this.replace(key, { state: 'downloading', receivedBytes: 0 })
    const progress: InstallProgress = {
      stage: state => { this.replace(key, { state }) },
      bytes: (received, total) => { this.replace(key, { receivedBytes: received, ...total === undefined ? {} : { totalBytes: total } }) },
    }
    this.options.run(key, controller.signal, progress).then(
      outcome => { this.finish(key, outcome.reloadNeeded ? { state: 'needs-reload', reloadNeeded: true } : { state: 'ready', reloadNeeded: false }) },
      (error: unknown) => {
        if (controller.signal.aborted) this.finish(key, { state: 'cancelled' })
        else this.finish(key, { state: 'failed', failure: error instanceof InstallRefusal ? { code: error.code, message: error.message } : { code: 'failed', message: error instanceof Error ? error.message : String(error) } })
      },
    ).catch(() => undefined)
  }

  private finish(key: string, change: Partial<Omit<InstallItem, 'key'>>): void {
    this.running.delete(key)
    this.replace(key, change)
    this.settle()
  }

  /** The queue is empty of work: one reload applies every finished install that needs it, once no chat runs. */
  private drained(): void {
    if (this.reloading || !this.items.some(item => item.state === 'needs-reload') || this.options.runningChats() > 0) return
    this.reloading = true
    this.options.reload().then(
      () => { this.items = this.items.map(item => (item.state === 'needs-reload' ? { ...item, state: 'ready' as const, reloadNeeded: false } : item)) },
      (error: unknown) => {
        const message = `Delorun could not restart to finish these installs: ${error instanceof Error ? error.message : String(error)}`
        this.items = this.items.map(item => (item.state === 'needs-reload' ? { ...item, state: 'failed' as const, reloadNeeded: false, failure: { code: 'failed' as const, message } } : item))
      },
    ).finally(() => {
      this.reloading = false
      this.publish()
    }).catch(() => undefined)
  }
}
