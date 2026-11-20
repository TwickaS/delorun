/**
 * PIN mode's state for this device (C14, "PIN mode"): the one store the Face ID sheets read to know whether the keypad
 * applies and what it takes. A device holds no PIN unlock and no lock screen: each sensitive action is confirmed by a
 * one-action grant, with Face ID or with the PIN typed into the grant sheet.
 *
 * - **What it reads.** On a device, `GET /auth/pin/state` answers whether the mode is on and whether it takes a PIN or a
 *   passcode. A home that answers 404 (an older home), the mode off, or a page on the computer's own address leave the
 *   phase `off`.
 * - **When it reads.** Once at load, again after each connection reset, and again after a read that did not complete.
 *
 * @module @delorun/bundle-local/client/pin-lock
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { readPinState } from './pin-api.ts'
import type { HostFetch } from './host-api.ts'

/** How soon the state is read again after a first read that did not complete. */
export const RETRY_MS = 5_000

/** What the Face ID sheets read. */
export interface PinView {
  /** `unknown` before the first read; `off` where no keypad applies; `on` while PIN mode is on for this device. */
  readonly phase: 'unknown' | 'off' | 'on'
  /** What the home asks for; `pin` until a read says otherwise. */
  readonly secret: 'pin' | 'passcode'
}

/** The store, as the Face ID sheets use it. */
export interface PinSource {
  readonly hooks: { readonly pin: HostObservable<PinView> }
  /** Read the state again, such as after the connection reset. */
  readonly refresh: () => Promise<void>
  /** Stop the retry timer, when the plugin unloads. */
  readonly dispose: () => void
}

/**
 * Create PIN mode's state store.
 * @param fetch - the request function.
 * @param onComputer - whether the page is on the home's own computer, where no keypad applies: the store is `off` and
 *   reads nothing.
 * @returns the store.
 */
export function createPinSource(fetch: HostFetch, onComputer = false): PinSource {
  let view: PinView = { phase: onComputer ? 'off' : 'unknown', secret: 'pin' }
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const listeners = new Set<() => void>()
  const publish = (next: PinView): void => {
    view = next
    for (const listener of listeners) listener()
  }

  const refresh = async (): Promise<void> => {
    if (onComputer || disposed) return
    let state
    try {
      state = await readPinState(fetch)
    } catch (_unread: unknown) {
      // An unreadable state leaves the phase as it was; a first read is tried again, a later one at the next reset.
      if (!disposed && view.phase === 'unknown') {
        clearTimeout(timer)
        timer = setTimeout(() => { void refresh() }, RETRY_MS)
      }
      return
    }
    if (disposed) return
    clearTimeout(timer)
    timer = undefined
    publish(state === undefined || state.kind === 'off' ? { phase: 'off', secret: view.secret } : { phase: 'on', secret: state.secret })
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
    dispose() {
      disposed = true
      clearTimeout(timer)
    },
  }
}
