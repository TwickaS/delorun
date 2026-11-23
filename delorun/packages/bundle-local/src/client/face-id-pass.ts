/**
 * The Face ID pass on a paired device (A499): one Face ID opens a pass for this device, so the strong actions that are not
 * always-ask go without a sheet until it ends. The home keeps and checks the pass; this module only mirrors it for the
 * "Unlocked" chip, the sheets that would otherwise open, the sheet's "lasts" line and Lock now.
 *
 * - {@link createPassSource} reads `GET /auth/passkey/pass` when the studio starts, when the window regains focus, when the
 *   page becomes visible and on {@link PASS_CHANGED} (a verified Face ID dispatches it), and clears the pass at its end,
 *   counted from the home's `remainingMs` so a skewed phone clock does not move it. It calls Lock now when the page has
 *   been hidden {@link PASS_HIDDEN_LOCK_MS}: by a timer while the page runs, and, because a phone suspends a hidden page
 *   and its timers, again on return when the page was away that long, before anything else. Lock now ends the device's
 *   pass on every tab, so one tab hidden that long locks the others too. The home also ends a pass 5 minutes after the
 *   device's last request, so a page that never returns cannot keep it. On the home's own computer it reads only the
 *   setting: the computer never asks and has no pass.
 * - {@link passLastsLine} gives the sheet's "lasts" line when a Face ID would open a pass.
 *
 * @module @delorun/bundle-local/client/face-id-pass
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { call, fields, isTime, listOf, orNull, type HostFetch } from './host-api.ts'
import type { FaceIdAction } from './face-id-types.ts'

/** The home's pass routes. */
export const PASS_ROUTES = {
  /** `GET`: `{ minutes, choices, pass }`; `POST` `{ minutes }`: change the setting. */
  pass: '/auth/passkey/pass',
  /** `POST` `{}`: Lock now. */
  lock: '/auth/passkey/lock',
} as const

/** The grant action a device's change of the pass setting is confirmed under. */
export const PASS_SETTING_ACTION = 'auth/passkey/pass'

/**
 * The grant actions no pass covers, as the home's `ALWAYS_ASK_ACTIONS` lists them (`@delorun/home-auth`, pinned equal by
 * `tests/face-grants.spec.ts`): adding or removing a device or a passkey, the Face ID settings, the pass setting, turning
 * Changes protection off, a workspace's full access, turning a prompt off for every chat, and an approval answer that
 * grants full access (`answer/full-access`).
 */
export const ALWAYS_ASK_ACTIONS: ReadonlySet<string> = new Set([
  'auth/devices/remove', 'auth/passkey/devices', 'auth/passkey/remove', PASS_SETTING_ACTION, 'changes/protection-off', 'plugin-permission-defaults/set-full-access',
  'bundle-local/run-prompts', 'answer/full-access',
])

/** The window event that asks every pass source to read the pass again: a Face ID verified, or the setting changed. */
export const PASS_CHANGED = 'delorun:face-pass-changed'

/** How long the page may stay hidden before the studio calls Lock now: 5 minutes. */
export const PASS_HIDDEN_LOCK_MS = 5 * 60_000

/** A confirmation is skipped under a pass only while the pass has at least this long left: 5 seconds. */
export const PASS_MARGIN_MS = 5_000

/** What the device knows of the pass. */
export interface PassState {
  /** The pass setting in minutes; 0 is "Every time". */
  readonly minutes: number
  /** The lengths the setting takes. */
  readonly choices: readonly number[]
  /** When this device's live pass ends by this page's clock (the home's `remainingMs` from the read), or null while it holds none. */
  readonly endsAt: number | null
}

/** The state before the first read: no pass, and the deployment default the home applies until the person chooses. */
export const NO_PASS: PassState = { minutes: 15, choices: [0, 5, 15, 30, 60], endsAt: null }

const isPassAnswer = fields({ minutes: isTime, choices: listOf(isTime), pass: orNull(fields({ startedAt: isTime, endsAt: isTime, remainingMs: isTime })) })

/**
 * Read the pass setting and this device's live pass.
 * @param fetch - the same-origin request function.
 * @param now - this page's clock, which the home's `remainingMs` is added to.
 * @returns the state.
 */
export async function readPass(fetch: HostFetch, now: () => number = Date.now): Promise<PassState> {
  const answer = await call<{ minutes: number; choices: number[]; pass: { startedAt: number; endsAt: number; remainingMs: number } | null }>(fetch, PASS_ROUTES.pass, isPassAnswer)
  return { minutes: answer.minutes, choices: answer.choices, endsAt: answer.pass === null ? null : now() + answer.pass.remainingMs }
}

/** The pass mirror of one studio page. */
export interface PassSource {
  /** The state, for the chip and Settings. */
  readonly hooks: { readonly pass: HostObservable<PassState> }
  /** @returns the state now. */
  readonly current: () => PassState
  /**
   * Whether a live pass covers an action now, with {@link PASS_MARGIN_MS} to spare; an always-ask action never is.
   * @param action - the grant action name.
   * @returns whether the confirmation may be skipped.
   */
  readonly covers: (action: string) => boolean
  /** Read the pass again. */
  readonly refresh: () => Promise<void>
  /** End this device's pass now. */
  readonly lockNow: () => Promise<void>
  /** Stop listening and clear the timers. */
  readonly dispose: () => void
}

/** What a pass source is built from. */
export interface PassSourceOptions {
  readonly fetch: HostFetch
  /** Whether the page is on the home's own computer, which has no pass. */
  readonly atComputer: () => boolean
  /** The clock; `Date.now` by default. */
  readonly now?: () => number
  /** The page's window, for focus, visibility and {@link PASS_CHANGED}; the global one by default. */
  readonly window?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'> & { readonly document: Pick<Document, 'visibilityState'> }
}

/**
 * Create the pass mirror of one page. On the home's computer it reads the setting only and never holds a pass.
 * @param options - the request function, the computer test, the clock and the window.
 * @returns the source.
 */
export function createPassSource(options: PassSourceOptions): PassSource {
  const now = options.now ?? Date.now
  const win = options.window ?? globalThis.window
  const store = createSnapshotStore<PassState>(NO_PASS, { flush: 'sync' })
  let endTimer: number | undefined
  let hiddenTimer: number | undefined
  let disposed = false
  const computer = options.atComputer()
  const apply = (next: PassState): void => {
    if (disposed) return
    if (endTimer !== undefined) win.clearTimeout(endTimer)
    endTimer = undefined
    const live = !computer && next.endsAt !== null && next.endsAt > now() ? next : { ...next, endsAt: null }
    store.set(live)
    if (!computer) pageMinutes = live.minutes
    if (live.endsAt !== null) endTimer = win.setTimeout(() => { apply({ ...store.getSnapshot(), endsAt: null }) }, live.endsAt - now())
  }
  const refresh = async (): Promise<void> => {
    try {
      apply(await readPass(options.fetch, now))
    } catch (_unreadable) {
      // An unreadable pass shows no chip and skips no sheet; the home still decides every call.
      apply({ ...store.getSnapshot(), endsAt: null })
    }
  }
  const lockNow = async (): Promise<void> => {
    if (computer) return
    try {
      await call<object>(options.fetch, PASS_ROUTES.lock, fields({}), {})
    } finally {
      await refresh()
    }
  }
  let hiddenAt: number | undefined
  /**
   * Back from hidden: a page that held a pass and was away {@link PASS_HIDDEN_LOCK_MS} or more locks first, since its
   * timer may never have run on a suspended phone; otherwise it reads the pass again.
   */
  const back = (): void => {
    const away = hiddenAt === undefined ? 0 : now() - hiddenAt
    hiddenAt = undefined
    if (away >= PASS_HIDDEN_LOCK_MS) void lockNow()
    else void refresh()
  }
  const onVisibility = (): void => {
    if (hiddenTimer !== undefined) win.clearTimeout(hiddenTimer)
    hiddenTimer = undefined
    if (win.document.visibilityState === 'hidden') {
      // Only a page that held a pass when it was hidden locks: a pass another tab opened meanwhile is that tab's.
      if (store.getSnapshot().endsAt === null) return
      hiddenAt = now()
      hiddenTimer = win.setTimeout(() => { hiddenTimer = undefined; void lockNow() }, PASS_HIDDEN_LOCK_MS)
      return
    }
    back()
  }
  const onRead = (): void => {
    if (!computer && hiddenAt !== undefined) back()
    else void refresh()
  }
  win.addEventListener('focus', onRead)
  win.addEventListener('pageshow', onRead)
  win.addEventListener(PASS_CHANGED, onRead)
  if (!computer) win.addEventListener('visibilitychange', onVisibility)
  void refresh()
  return {
    hooks: { pass: store },
    current: () => store.getSnapshot(),
    covers: (action) => {
      const { endsAt } = store.getSnapshot()
      return !computer && !ALWAYS_ASK_ACTIONS.has(action) && endsAt !== null && endsAt - now() > PASS_MARGIN_MS
    },
    refresh,
    lockNow,
    dispose: () => {
      disposed = true
      pageMinutes = 0
      if (endTimer !== undefined) win.clearTimeout(endTimer)
      if (hiddenTimer !== undefined) win.clearTimeout(hiddenTimer)
      win.removeEventListener('focus', onRead)
      win.removeEventListener('pageshow', onRead)
      win.removeEventListener(PASS_CHANGED, onRead)
      if (!computer) win.removeEventListener('visibilitychange', onVisibility)
    },
  }
}

/**
 * The pass setting of the page's pass mirror, which {@link passLastsLine} reads: the sheet's "lasts" line has no prop
 * that carries it. One studio page runs one bundle client plugin, so one mirror writes it; its disposal resets it to 0.
 */
let pageMinutes = 0

/**
 * Whether a Face ID confirmation of an action opens a pass, and for how long: never from the PIN, never at "Every time",
 * never for an always-ask action.
 * @param action - the action the sheet confirms.
 * @param factor - what confirms it: Face ID (`passkey`) or the PIN.
 * @param minutes - the pass setting.
 * @returns the pass minutes, or undefined when the confirmation opens none.
 */
export function passMinutesOf(action: FaceIdAction, factor: 'passkey' | 'pin', minutes: number): number | undefined {
  const entries = 'actions' in action.grant ? action.grant.actions : []
  return factor === 'passkey' && minutes > 0 && !entries.some(entry => ALWAYS_ASK_ACTIONS.has(entry.action)) ? minutes : undefined
}

/**
 * The sheet's "Covers" line when the confirmation opens a pass (A499), for `faceIdLastsLine` in `./face-id-lasts.ts`,
 * which falls back to "This action only" or the terminal's or folder picker's hold line when this returns undefined.
 * @param t - the Face ID copy; the sheet passes its `t`.
 * @param action - the action the sheet confirms.
 * @param factor - Face ID (`passkey`) or the PIN.
 * @returns "Strong actions on this phone for 15 minutes", or undefined when no pass opens.
 */
export function passLastsLine(t: (key: 'lasts.pass', params: { readonly minutes: string }) => string, action: FaceIdAction, factor: 'passkey' | 'pin'): string | undefined {
  const minutes = passMinutesOf(action, factor, pageMinutes)
  return minutes === undefined ? undefined : t('lasts.pass', { minutes: String(minutes) })
}
