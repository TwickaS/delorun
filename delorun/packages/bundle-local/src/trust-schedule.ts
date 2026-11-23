/**
 * When the Host runs the trust checks by itself (contract C15's trust bill, A628): the background full check once the
 * studio has started and no turn has run for {@link TrustScheduleOptions.idleMs}, and a re-read of the cheap sections
 * (plugins and the person's changes) after a key moment, such as a plugin added, updated, switched on or off or removed,
 * or the person's changes loaded.
 *
 * - **Idle wait.** The full check starts only after the studio has been idle, with no turn of any chat running, for
 *   `idleMs` in a row; a turn that starts restarts the wait.
 * - **Yield.** A turn that starts while the full check runs stops it, and the check waits for the next idle stretch and
 *   runs again from the start; a full check costs seconds, so starting again is cheaper than holding a paused process.
 *   A check a person asked for with Check now is never stopped: {@link TrustSchedule.hold} marks the run as theirs.
 * - **Debounce.** Key moments that arrive together re-read once, `debounceMs` after the last of them, and never while a
 *   turn runs: the re-read waits for the turn to end. A key moment for the release asks for another full check, which
 *   waits for idle as above.
 *
 * The schedule owns no check: it calls {@link TrustScheduleWork}. Timers are the global `setTimeout`, so a spec drives
 * the schedule with fake timers.
 *
 * @module @delorun/bundle-local/trust-schedule
 */

/** What the schedule runs. */
export interface TrustScheduleWork {
  /**
   * Run the full check at low priority.
   * @param signal - aborted when a turn starts and the run is not held; the run then ends early.
   * @returns once the run ended, whatever its outcome.
   */
  full(signal: AbortSignal): Promise<void>
  /**
   * Re-read the cheap sections: plugins and the person's changes.
   * @returns once the re-read ended, whatever its outcome.
   */
  refresh(): Promise<void>
}

/** The schedule's timings. */
export interface TrustScheduleOptions {
  /** How long the studio must be idle, with no turn running, before the full check starts, in milliseconds. */
  readonly idleMs: number
  /** How long after the last key moment the cheap sections are re-read, in milliseconds. */
  readonly debounceMs: number
}

/** A key moment: what changed, which decides the check it asks for. */
export type TrustKeyMoment = 'plugins' | 'changes' | 'release'

/** The background checks' schedule. */
export class TrustSchedule {
  /** What the schedule runs. */
  readonly #work: TrustScheduleWork
  /** The timings. */
  readonly #options: TrustScheduleOptions
  /** The agents whose turn runs now. */
  readonly #turns = new Set<unknown>()
  /** Whether a full check is wanted. */
  #wantFull = false
  /** Whether a re-read of the cheap sections is wanted. */
  #wantRefresh = false
  /** What runs now. */
  #running: 'full' | 'refresh' | undefined
  /** Stops the running full check. */
  #abort: AbortController | undefined
  /** Whether the running full check is a person's, which a turn never stops. */
  #held = false
  /** The idle wait before the full check. */
  #idle: ReturnType<typeof setTimeout> | undefined
  /** The debounce before the re-read. */
  #debounce: ReturnType<typeof setTimeout> | undefined
  /** Whether {@link close} ran. */
  #closed = false

  /**
   * @param work - what the schedule runs.
   * @param options - the timings.
   */
  constructor(work: TrustScheduleWork, options: TrustScheduleOptions) {
    this.#work = work
    this.#options = options
  }

  /** Whether any turn runs now. */
  get busy(): boolean {
    return this.#turns.size > 0
  }

  /** Whether a full check is wanted or runs: waiting for idle, or hashing. */
  get fullPending(): boolean {
    return this.#wantFull || this.#running === 'full'
  }

  /**
   * The studio has finished starting: from now the full check, when wanted, waits for idle.
   * @param full - whether a full check is wanted.
   */
  start(full: boolean): void {
    this.#wantFull = full
    this.#arm()
  }

  /**
   * An agent's turn started or ended.
   * @param agent - the agent.
   * @param running - whether its turn runs now.
   */
  turn(agent: unknown, running: boolean): void {
    if (running) {
      this.#turns.add(agent)
      this.#clearIdle()
      if (this.#running === 'full' && !this.#held && this.#abort !== undefined) {
        this.#wantFull = true
        this.#abort.abort(new Error('a turn started, so the background full check stopped and waits for the next idle stretch'))
      }
      return
    }
    this.#turns.delete(agent)
    this.#next()
  }

  /**
   * A key moment: a plugin added, updated, switched on or off or removed, the person's changes loaded, or an update
   * applied.
   * @param moment - what changed.
   */
  keyMoment(moment: TrustKeyMoment): void {
    if (this.#closed) return
    if (moment === 'release') {
      this.#wantFull = true
      this.#arm()
      return
    }
    this.#wantRefresh = true
    this.#armRefresh()
  }

  /** The running full check is a person's (they joined it with Check now): no turn stops it. */
  hold(): void {
    if (this.#running === 'full') this.#held = true
  }

  /** Stop: no timer fires again and a running full check is stopped. */
  close(): void {
    this.#closed = true
    this.#clearIdle()
    if (this.#debounce !== undefined) clearTimeout(this.#debounce)
    this.#debounce = undefined
    this.#abort?.abort(new Error('the trust row stopped'))
  }

  /** Clear the idle wait. */
  #clearIdle(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle)
    this.#idle = undefined
  }

  /** Start the idle wait again when a full check is wanted and nothing stands in its way. */
  #arm(): void {
    this.#clearIdle()
    if (this.#closed || !this.#wantFull || this.busy || this.#running !== undefined) return
    this.#idle = setTimeout(() => { this.#runFull() }, this.#options.idleMs)
  }

  /** Start the debounce again. */
  #armRefresh(): void {
    if (this.#debounce !== undefined) clearTimeout(this.#debounce)
    this.#debounce = setTimeout(() => {
      this.#debounce = undefined
      this.#runRefresh()
    }, this.#options.debounceMs)
  }

  /** After a run or a turn: the re-read first, when wanted and its debounce is not pending, then the idle wait. */
  #next(): void {
    if (this.#closed || this.busy || this.#running !== undefined) return
    if (this.#wantRefresh && this.#debounce === undefined) {
      this.#runRefresh()
      return
    }
    this.#arm()
  }

  /** Run the full check. */
  #runFull(): void {
    this.#idle = undefined
    if (this.#closed || this.busy || this.#running !== undefined) return
    this.#wantFull = false
    this.#running = 'full'
    this.#held = false
    const abort = new AbortController()
    this.#abort = abort
    void this.#work.full(abort.signal).catch(() => undefined).finally(() => {
      this.#running = undefined
      this.#abort = undefined
      this.#held = false
      this.#next()
    })
  }

  /** Re-read the cheap sections, unless a turn or another run is in the way; {@link next} tries again after it. */
  #runRefresh(): void {
    if (this.#closed || this.busy || this.#running !== undefined) return
    this.#wantRefresh = false
    this.#running = 'refresh'
    void this.#work.refresh().catch(() => undefined).finally(() => {
      this.#running = undefined
      this.#next()
    })
  }
}
