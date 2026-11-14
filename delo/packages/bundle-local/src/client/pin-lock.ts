/**
 * The page's lock under PIN mode (C14, "PIN mode"): one store behind the lock screen and the Lock button.
 *
 * - **When it locks the studio.** On a device whose home answers `GET /auth/pin/state` with the mode on, a page that
 *   holds no unlock token shows the lock screen. A home that answers 404 (an older home), the mode off, or a page on the
 *   computer's own address leave the phase `off`, and today's unlock overlay applies unchanged.
 * - **The token.** It lives only in [`./page-unlock-token.ts`](./page-unlock-token.ts); the store never stores or logs
 *   it, and a reload starts locked.
 * - **Staying unlocked.** {@link PinSource.activity} sends `POST /auth/pin/touch` at most once per throttle interval
 *   (a minute, or half the idle time when that is shorter); polls and reads never touch. A local timer locks the page at
 *   the unlock's idle end, and any `401 UNLOCK_INVALID` locks it at once.
 * - **Locking.** Lock, a hidden page (when the state says `lockWhenHidden`), a page restored from the back-forward cache
 *   and a closing page each drop the token; Lock and a closing page also tell the home.
 *
 * @module @delo/bundle-local/client/pin-lock
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { hostFailureOf, type HostFetch } from './host-api.ts'
import { lockPin, PIN_CODES, pinMissOf, readPinState, touchPin, unlockPin } from './pin-api.ts'
import { currentUnlockToken, setUnlockToken } from './page-unlock-token.ts'

/** The longest gap between two touches. */
export const TOUCH_INTERVAL_MS = 60_000

/** How soon the state is read again after a read that did not complete. */
export const RETRY_MS = 5_000

/** What the unlock attempt last came to, shown in place on the lock screen. */
export type PinOutcome =
  | { readonly kind: 'wrong'; readonly triesLeft: number | undefined }
  /** The fifth miss: the home removed this device, and it needs approval again at the computer. */
  | { readonly kind: 'removed' }
  /** Unlocks are paused home-wide until the computer resumes them. */
  | { readonly kind: 'paused' }
  | { readonly kind: 'unreachable' }
  /** The PIN unlocks only on the Tailscale private address. */
  | { readonly kind: 'address' }
  | { readonly kind: 'failed' }

/** What the lock screen renders. */
export interface PinView {
  /**
   * `unknown` before the first read; `off` where today's overlay applies; `locked` while the lock screen shows;
   * `unlocked` while this page holds a live unlock.
   */
  readonly phase: 'unknown' | 'off' | 'locked' | 'unlocked'
  /** What the home asks for; `pin` until a read says otherwise. */
  readonly secret: 'pin' | 'passcode'
  readonly busy: boolean
  readonly outcome: PinOutcome | undefined
  /** Whether unlocks are paused home-wide, as the last read said. */
  readonly paused: boolean
}

/** The store, as the lock screen, the Lock button and the page triggers use it. */
export interface PinSource {
  readonly hooks: { readonly pin: HostObservable<PinView> }
  /** Read the state again, such as after the connection reset. */
  readonly refresh: () => Promise<void>
  /**
   * Unlock this page.
   * @param secret - what the person typed; the store does not keep it.
   */
  readonly unlock: (secret: string) => Promise<void>
  /** Lock this page: tell the home, and drop the token whatever the home answers. */
  readonly lock: () => Promise<void>
  /** Report input on the page; touches the home at most once per throttle interval. */
  readonly activity: () => void
  /** The page became hidden. */
  readonly hidden: () => void
  /** The page was restored from the back-forward cache: drop the token and read the state. */
  readonly restored: () => void
  /** The page is closing: send a `keepalive` lock and drop the token. */
  readonly closing: () => void
  /** Whether this page holds a live unlock. */
  readonly holdsUnlock: () => boolean
  /** Stop every timer, when the plugin unloads. */
  readonly dispose: () => void
}

/**
 * Create the lock's store.
 * @param fetch - the request function.
 * @param now - the clock, in milliseconds since the epoch.
 * @param onComputer - whether the page is on the home's own computer, where no PIN applies: the store is `off` and
 *   reads nothing.
 * @returns the store.
 */
export function createPinSource(fetch: HostFetch, now: () => number = Date.now, onComputer = false): PinSource {
  let view: PinView = { phase: onComputer ? 'off' : 'unknown', secret: 'pin', busy: false, outcome: undefined, paused: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let lockWhenHidden = false
  let throttleMs = TOUCH_INTERVAL_MS
  let idleEndsAt = 0
  let lastTouch = 0
  // Counts the page's own changes (unlock, lock): a read that started before one answers an older state.
  let changes = 0
  const listeners = new Set<() => void>()
  const publish = (next: Partial<PinView>): void => {
    view = { ...view, ...next }
    for (const listener of listeners) listener()
  }

  /** Arm the local lock for the unlock's idle end. */
  const schedule = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (disposed || view.phase !== 'unlocked') return
    timer = setTimeout(() => { dropLocally(); void refresh() }, Math.max(0, idleEndsAt - now()))
  }

  /** Drop the token and show the lock screen, without telling the home. */
  const dropLocally = (outcome?: PinOutcome): void => {
    changes++
    clearTimeout(timer)
    timer = undefined
    setUnlockToken(null)
    if (view.phase === 'unlocked' || view.phase === 'locked') publish({ phase: 'locked', busy: false, outcome })
  }

  /**
   * Take the idle end the home gave for the page's unlock.
   * @param endsAt - the idle end, in milliseconds since the epoch.
   */
  const holdUntil = (endsAt: number): void => {
    idleEndsAt = endsAt
    schedule()
  }

  const refresh = async (): Promise<void> => {
    if (onComputer || disposed) return
    const started = changes
    let state
    try {
      state = await readPinState(fetch, currentUnlockToken())
    } catch (error) {
      if (disposed || started !== changes) return
      const failure = hostFailureOf(error)
      if (failure.kind === 'refused' && failure.code === PIN_CODES.unlockInvalid) dropLocally()
      else if (view.phase === 'unknown') {
        clearTimeout(timer)
        timer = setTimeout(() => { void refresh() }, RETRY_MS)
      }
      return
    }
    if (disposed || started !== changes) return
    if (state === undefined || state.kind === 'off') {
      clearTimeout(timer)
      timer = undefined
      setUnlockToken(null)
      publish({ phase: 'off', busy: false, outcome: undefined, paused: false })
      return
    }
    lockWhenHidden = state.lockWhenHidden === true
    throttleMs = Math.min(TOUCH_INTERVAL_MS, state.idleMinutes * 30_000)
    if (currentUnlockToken() !== null && state.unlock !== null) {
      publish({ phase: 'unlocked', secret: state.secret, paused: state.paused, outcome: undefined })
      holdUntil(state.unlock.idleEndsAt)
      return
    }
    // A token the home no longer knows is dropped; the page shows the lock either way.
    setUnlockToken(null)
    clearTimeout(timer)
    timer = undefined
    publish({ phase: 'locked', secret: state.secret, paused: state.paused })
  }

  const lock = async (): Promise<void> => {
    const token = currentUnlockToken()
    dropLocally()
    if (token === null) return
    try {
      await lockPin(fetch, token)
    } catch (_unreachable: unknown) {
      // The token is already dropped, so this page cannot use the unlock again; the home ends it at its idle end.
    }
  }

  return {
    hooks: {
      pin: {
        getSnapshot: () => view,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    refresh,
    async unlock(secret) {
      changes++
      publish({ busy: true, outcome: undefined })
      try {
        const unlocked = await unlockPin(fetch, secret)
        setUnlockToken(unlocked.token)
        lastTouch = now()
        publish({ phase: 'unlocked', busy: false, outcome: undefined })
        holdUntil(unlocked.idleEndsAt)
      } catch (error) {
        const failure = hostFailureOf(error)
        publish({ busy: false, outcome: unlockOutcomeOf(failure) })
        if (failure.kind === 'refused' && failure.code === PIN_CODES.off) void refresh()
        if (failure.kind === 'refused' && failure.code === PIN_CODES.paused) publish({ paused: true })
      }
    },
    lock,
    activity() {
      const token = currentUnlockToken()
      if (view.phase !== 'unlocked' || token === null || now() - lastTouch < throttleMs) return
      lastTouch = now()
      const started = changes
      void touchPin(fetch, token).then(touched => {
        if (disposed || started !== changes) return
        holdUntil(touched.idleEndsAt)
      }, (error: unknown) => {
        if (disposed || started !== changes) return
        const failure = hostFailureOf(error)
        if (failure.kind === 'refused' && failure.code === PIN_CODES.unlockInvalid) dropLocally()
        // Any other failure leaves the unlock to the local timer, and the next input touches again.
      })
    },
    hidden() {
      if (lockWhenHidden && view.phase === 'unlocked') void lock()
    },
    restored() {
      if (view.phase === 'off' || view.phase === 'unknown') return
      dropLocally()
      void refresh()
    },
    closing() {
      const token = currentUnlockToken()
      if (token === null) return
      dropLocally()
      void lockPin(fetch, token, true).catch((_unreachable: unknown) => {
        // The page is closing: the home ends the unlock at its idle end.
      })
    },
    holdsUnlock: () => view.phase === 'unlocked' && currentUnlockToken() !== null,
    dispose() {
      disposed = true
      clearTimeout(timer)
    },
  }
}

/**
 * What a failed unlock came to.
 * @param failure - the failure of `POST /auth/pin/unlock`.
 * @returns the outcome the lock screen shows.
 */
function unlockOutcomeOf(failure: ReturnType<typeof hostFailureOf>): PinOutcome {
  if (failure.kind === 'unreachable') return { kind: 'unreachable' }
  if (failure.kind !== 'refused') return { kind: 'failed' }
  switch (failure.code) {
    case PIN_CODES.invalid:
      return pinMissOf(failure.fields)
    case PIN_CODES.paused:
      return { kind: 'paused' }
    case PIN_CODES.address:
      return { kind: 'address' }
    default:
      return { kind: 'failed' }
  }
}
