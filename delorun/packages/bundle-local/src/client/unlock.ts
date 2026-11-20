/**
 * Where this studio runs relative to the home's device unlock routes: on a device, or away from them.
 *
 * A device never holds an unlock window (A483): each sensitive action asks for Face ID or the PIN keypad in the Face ID
 * sheet (`face-retry.ts`), so the store carries no unlock state, dialog or banner. It tells the Devices section whether
 * the page is a device or the home's computer.
 *
 * - **Device.** A read of the device's unlock route (`GET /auth/elevation`) that the home answers.
 * - **Away.** A page the studio serves on the computer's own address (loopback) is `away` from the start and sends no
 *   request, because the route answers that address with `HOST_MISMATCH`; a profile without the routes answers 404.
 * - **Unreachable.** A read that does not complete leaves the place `unknown`; the next connection reset reads again.
 *
 * @module @delorun/bundle-local/client/unlock
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { readElevation, type HostFetch } from './devices-api.ts'

/** What the Devices section renders. */
export interface UnlockView {
  /** `unknown` before the first read, `device` on a device, `away` where no device unlocks. */
  readonly place: 'unknown' | 'device' | 'away'
}

/** The place store, as the Devices section uses it. */
export interface UnlockSource {
  readonly hooks: { readonly unlock: HostObservable<UnlockView> }
  /** Read the place again, such as after the connection reset. */
  readonly refresh: () => Promise<void>
}

/**
 * Create the place store.
 * @param fetch - the request function.
 * @param onComputer - whether the page is on the home's own computer: the store is `away` and reads nothing.
 * @returns the store.
 */
export function createUnlockSource(fetch: HostFetch, onComputer = false): UnlockSource {
  let view: UnlockView = { place: onComputer ? 'away' : 'unknown' }
  const listeners = new Set<() => void>()
  const publish = (next: UnlockView): void => {
    view = next
    for (const listener of listeners) listener()
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
    async refresh() {
      if (onComputer) return
      let state: Awaited<ReturnType<typeof readElevation>>
      try {
        state = await readElevation(fetch)
      } catch (_unreadable: unknown) {
        // The place stays as it was; the next connection reset reads again.
        return
      }
      const place = state === undefined ? 'away' : 'device'
      if (view.place !== place) publish({ place })
    },
  }
}
