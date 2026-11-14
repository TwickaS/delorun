/**
 * The requests that arrived at the home without an approval window, as the studio at the home's own computer shows them
 * (contract C5, "Pop-up pairing"). One store reads `GET /auth/devices/pending` every {@link PENDING_POLL_MS} while a
 * studio is mounted, keeps the window-less requests and the home's pairing choices, and answers a request: the code the
 * person typed approves it, Decline cancels it. A `LOOPBACK_REQUIRED` answer means this studio is a remote one, which never
 * receives pending requests, so the store stops reading.
 * @module @delorun/bundle-local/client/pairing-source
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  approveDevice, cancelPendingDevice, hostFailureOf, LOOPBACK_REQUIRED, PENDING_POLL_MS, readPendingDevices,
  type ApprovalRequestId, type HostFailure, type HostFetch, type PendingDevice,
} from './devices-api.ts'
import type { PairingView } from '@delorun/home-auth/wire'

/** The digits of a typed code, without the spaces and hyphens a person may type or paste between them. */
export function codeDigits(typed: string): string {
  return typed.replace(/[\s-]/g, '')
}

/** What the store holds. */
export interface PairingState {
  /** `unknown` until the first read; `remote` once the home refused the read to this studio. */
  readonly place: 'unknown' | 'computer' | 'remote'
  /** The requests that arrived without an approval window, oldest first. */
  readonly requests: readonly PendingDevice[]
  /** The home's pairing choices; undefined until the first read. */
  readonly view: PairingView | undefined
  /** The request whose code box is open. */
  readonly open: ApprovalRequestId | undefined
  /** Requests whose notice timed out; they stay in Settings → Devices. */
  readonly quieted: readonly ApprovalRequestId[]
}

/** How an answer to a request ended. */
export type PairingOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly failure: HostFailure; readonly gone: boolean }

/** The store and its actions. */
export interface PairingSource {
  /** The state for the overlay entry and the Devices section. */
  readonly hooks: { readonly pairing: HostObservable<PairingState> }
  /** Read the requests now and keep reading while a studio is mounted. @returns the function that stops reading. */
  readonly start: () => () => void
  /** Open the code box of a request. @param id - the request. */
  readonly openCode: (id: ApprovalRequestId) => void
  /** Close the code box; the request stays waiting. */
  readonly closeCode: () => void
  /** Hide a request's notice until the next one; the request stays waiting. @param id - the request. */
  readonly quiet: (id: ApprovalRequestId) => void
  /** Decline a request, which cancels it at the home. @param id - the request. @returns the outcome. */
  readonly decline: (id: ApprovalRequestId) => Promise<PairingOutcome>
  /** Approve a request with the typed code. @param id - the request. @param typed - the code. @returns the outcome. */
  readonly approve: (id: ApprovalRequestId, typed: string) => Promise<PairingOutcome>
  /** Read the requests once more, such as after a wrong code raised the count. @returns after the read settles. */
  readonly refresh: () => Promise<void>
}

/**
 * Create the store.
 * @param fetch - the same-origin request function.
 * @returns the store.
 */
export function createPairingSource(fetch: HostFetch): PairingSource {
  let state: PairingState = { place: 'unknown', requests: [], view: undefined, open: undefined, quieted: [] }
  const listeners = new Set<() => void>()
  const publish = (next: Partial<PairingState>): void => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  let mounted = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading = false

  const refresh = async (): Promise<void> => {
    if (reading || state.place === 'remote') return
    reading = true
    try {
      const answer = await readPendingDevices(fetch)
      const requests = answer.pending.filter(request => request.windowless)
      publish({
        place: 'computer',
        requests,
        view: answer.pairing,
        open: requests.some(request => request.requestId === state.open) ? state.open : undefined,
        quieted: state.quieted.filter(id => requests.some(request => request.requestId === id)),
      })
    } catch (error) {
      const failure = hostFailureOf(error)
      if (failure.kind === 'refused' && failure.code === LOOPBACK_REQUIRED) publish({ place: 'remote', requests: [], open: undefined })
      // Another failure leaves the last read on screen; the next read tries again.
    } finally {
      reading = false
    }
  }
  const schedule = (): void => {
    timer = setTimeout(() => {
      void refresh().finally(() => { if (mounted > 0 && state.place !== 'remote') schedule() })
    }, PENDING_POLL_MS)
  }
  const outcome = async (id: ApprovalRequestId, run: () => Promise<unknown>): Promise<PairingOutcome> => {
    let failure: HostFailure | undefined
    try {
      await run()
    } catch (error) {
      failure = hostFailureOf(error)
    }
    await refresh()
    if (failure === undefined) return { kind: 'done' }
    return { kind: 'failed', failure, gone: !state.requests.some(request => request.requestId === id) }
  }
  return {
    hooks: {
      pairing: {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    },
    start() {
      mounted += 1
      if (mounted === 1) {
        void refresh().finally(() => { if (mounted > 0 && state.place !== 'remote') schedule() })
      }
      return () => {
        mounted -= 1
        if (mounted === 0) clearTimeout(timer)
      }
    },
    openCode: (id) => { publish({ open: id }) },
    closeCode: () => { publish({ open: undefined }) },
    quiet: (id) => { if (!state.quieted.includes(id)) publish({ quieted: [...state.quieted, id] }) },
    decline: id => outcome(id, () => cancelPendingDevice(fetch, id)),
    approve: (id, typed) => outcome(id, () => approveDevice(fetch, id, codeDigits(typed))),
    refresh,
  }
}
