/**
 * The remote studio's unlock: the state of this device's short unlock of sensitive actions (C14, "Elevation"), which the
 * unlock dialog, the unlocked banner and the Devices section read from one store.
 *
 * - **Where it applies.** Only on a device: the first read of `GET /auth/elevation` answers the computer's own address
 *   with `HOST_MISMATCH`, and a profile without the routes with 404, and the store then stays `away` and shows nothing.
 * - **Asking.** An action remote access refused with `elevation-required:` opens the dialog with the reason; the
 *   Devices section opens it without one. Unlock posts the request and shows the code with its expiry; the store reads
 *   the state every {@link ELEVATION_POLL_MS} until the computer answers or the request expires.
 * - **Honest outcomes.** A request that disappears before its expiry was declined or cancelled at the computer; one that
 *   disappears at its expiry expired; a read that does not complete says the computer cannot be reached and is tried
 *   again; a home with its limit of waiting requests says so.
 * - **While unlocked.** The banner shows the end time and Lock now, which ends the unlock through the device's own
 *   route: a device may end its unlock, never start or extend one. The store reads the state every
 *   {@link ELEVATED_POLL_MS}, at the unlock's end, after the connection resets (an unlock's end closes the device's
 *   connections) and after each refusal, so an unlock ended at the computer leaves the banner.
 *
 * @module @delo/bundle-local/client/unlock
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ELEVATED_POLL_MS, ELEVATION_POLL_MS, ELEVATION_REQUIRED, hostFailureOf, lockElevation, readElevation, requestElevation,
  type ElevationState, type HostFetch,
} from './devices-api.ts'

/** Why the dialog shows an outcome instead of the request: what happened to the last request or unlock. */
export type UnlockOutcome = 'expired' | 'declined' | 'unreachable' | 'limit' | 'failed'

/** The dialog while it shows: why it opened, whether a request is on its way, and the last outcome. */
export interface UnlockDialog {
  /** The refused action that opened it, without the `elevation-required:` prefix; undefined when the person opened it. */
  readonly action: string | undefined
  readonly busy: boolean
  readonly outcome: UnlockOutcome | undefined
}

/** What the overlay and the Devices section render. */
export interface UnlockView {
  /** `unknown` before the first read, `device` on a device, `away` where no device unlocks. */
  readonly place: 'unknown' | 'device' | 'away'
  readonly state: ElevationState
  readonly dialog: UnlockDialog | null
  /** The sequence of the last unlock that ended while this page watched it, while its notice shows; 0 otherwise. */
  readonly ended: number
  /** Whether the last Lock now did not reach the computer. */
  readonly lockFailed: boolean
}

/** The unlock's store, as the overlay entry and the Devices section use it. */
export interface UnlockSource {
  readonly hooks: { readonly unlock: HostObservable<UnlockView> }
  /** Read the state again, such as after the connection reset. */
  readonly refresh: () => Promise<void>
  /**
   * Report a call remote access refused; a reason that needs an unlock opens the dialog on a device.
   * @param reason - the policy's reason, such as `elevation-required: terminal/create`.
   */
  readonly refused: (reason: string | undefined) => void
  /** Open the dialog without a refused action, from the Devices section. */
  readonly open: () => void
  /** Ask the computer for an unlock. */
  readonly request: () => Promise<void>
  /** Withdraw the waiting request and close the dialog, or close the dialog when nothing waits. */
  readonly cancel: () => Promise<void>
  /** End the running unlock from this device. */
  readonly lock: () => Promise<void>
  /** Clear the notice that sensitive actions are locked again. */
  readonly dismissEnded: () => void
  /** Stop every timer, when the plugin unloads. */
  readonly dispose: () => void
}

const NONE: ElevationState = { kind: 'none' }

/**
 * Create the unlock's store.
 * @param fetch - the request function.
 * @param now - the clock, in milliseconds since the epoch.
 * @returns the store.
 */
export function createUnlockSource(fetch: HostFetch, now: () => number = Date.now): UnlockSource {
  let view: UnlockView = { place: 'unknown', state: NONE, dialog: null, ended: 0, lockFailed: false }
  let endings = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  // Counts the device's own changes (ask, withdraw, lock): a read that started before one answers an older state.
  let changes = 0
  const listeners = new Set<() => void>()
  const publish = (next: Partial<UnlockView>): void => {
    view = { ...view, ...next }
    for (const listener of listeners) listener()
  }
  const withDialog = (next: Partial<UnlockDialog>): UnlockDialog | null =>
    view.dialog === null ? null : { ...view.dialog, ...next }

  /** Arm the next read for the state the store holds now. */
  const schedule = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (disposed) return
    const state = view.state
    if (state.kind === 'pending') timer = setTimeout(() => { void refresh() }, Math.max(0, Math.min(ELEVATION_POLL_MS, state.expiresAt - now())))
    else if (state.kind === 'elevated') timer = setTimeout(() => { void refresh() }, Math.max(0, Math.min(ELEVATED_POLL_MS, state.endsAt - now())))
  }

  /**
   * Take a state the home answered, telling what ended since the one the store held.
   * @param state - the home's answer.
   */
  const settle = (state: ElevationState): void => {
    const before = view.state
    const at = now()
    if (before.kind === 'pending' && state.kind === 'none') {
      publish({ state, dialog: withDialog({ busy: false, outcome: at >= before.expiresAt ? 'expired' : 'declined' }) })
    } else if (before.kind === 'elevated' && state.kind === 'none') {
      publish({ state, ended: ++endings })
    } else if (state.kind === 'elevated') {
      publish({ state, dialog: null, lockFailed: false })
    } else {
      publish({ state, dialog: withDialog({ busy: false, outcome: undefined }) })
    }
    schedule()
  }

  const refresh = async (): Promise<void> => {
    const started = changes
    let state: ElevationState | undefined
    try {
      state = await readElevation(fetch)
    } catch (error) {
      if (disposed || started !== changes) return
      // Unreachable or refused, the request may still be answered: the dialog says so and the next read tries again.
      if (view.state.kind === 'pending' && hostFailureOf(error).kind === 'unreachable') publish({ dialog: withDialog({ outcome: 'unreachable' }) })
      schedule()
      return
    }
    if (disposed || started !== changes) return
    if (state === undefined) {
      clearTimeout(timer)
      publish({ place: 'away', state: NONE, dialog: null })
      return
    }
    if (view.place !== 'device') publish({ place: 'device' })
    settle(state)
  }

  return {
    hooks: {
      unlock: {
        getSnapshot: () => view,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    refresh,
    refused(reason) {
      if (reason?.startsWith(ELEVATION_REQUIRED) !== true || view.place === 'away') return
      const action = reason.slice(ELEVATION_REQUIRED.length).trim()
      publish({ dialog: { action: action === '' ? undefined : action, busy: false, outcome: undefined } })
      // A refusal while the banner shows means the unlock ended where this page did not see it.
      void refresh()
    },
    open() {
      if (view.place !== 'device') return
      publish({ dialog: { action: undefined, busy: false, outcome: undefined } })
    },
    async request() {
      changes++
      publish({ dialog: withDialog({ busy: true, outcome: undefined }) })
      let state: ElevationState
      try {
        state = await requestElevation(fetch)
      } catch (error) {
        const failure = hostFailureOf(error)
        const outcome: UnlockOutcome = failure.kind === 'unreachable' ? 'unreachable'
          : failure.kind === 'refused' && failure.code === 'APPROVAL_PENDING_LIMIT' ? 'limit' : 'failed'
        publish({ dialog: withDialog({ busy: false, outcome }) })
        return
      }
      settle(state)
    },
    async cancel() {
      if (view.state.kind !== 'pending') {
        publish({ dialog: null })
        return
      }
      changes++
      publish({ dialog: withDialog({ busy: true }) })
      try {
        await lockElevation(fetch)
      } catch (_unreachable: unknown) {
        // The request could not be withdrawn: it expires on its own at the computer, and the dialog closes either way.
      }
      clearTimeout(timer)
      publish({ state: NONE, dialog: null })
    },
    async lock() {
      changes++
      try {
        await lockElevation(fetch)
      } catch (_unreachable: unknown) {
        // The banner stays, saying Lock now did not reach the computer, and the next read shows what holds.
        publish({ lockFailed: true })
        // A read this lock overtook is discarded, so the next read is armed again here.
        schedule()
        return
      }
      clearTimeout(timer)
      publish({ state: NONE, ended: ++endings, lockFailed: false })
    },
    dismissEnded() {
      publish({ ended: 0 })
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
    },
  }
}
