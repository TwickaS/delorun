/**
 * What the agent surfaces show of an external agent's sign-in and plan limits: each limit window's standing, its
 * words, and the single highest used share the Plans pill carries. Pure: it reads the stored figures and the time the
 * answer was made, and never starts a check.
 * @module @delorun/bundle-local/client/agent-limits
 */
import { windowTitle, type AccountView } from '@delorun/external-agents/accounts/wire'

/** One limit window as the surfaces read it: a stored window, with absent figures allowed to be `undefined`. */
export interface WindowFigure {
  /** The window's kind. */
  readonly kind: string
  /** What the program said of the window. */
  readonly status: 'allowed' | 'near' | 'reached' | 'unknown'
  /** The used share, when known. */
  readonly usedPercent?: number | undefined
  /** When the window resets, in milliseconds since the epoch. */
  readonly resetsAt?: number | undefined
  /** When the figures were seen. */
  readonly seenAt: number
}

/** One agent's figures as the surfaces read them: an {@link AccountView}, or the onboarding readiness's copy of it. */
export interface AccountFigures {
  /** The agent. */
  readonly provider: AccountView['provider']
  /** Whether the agent's pack is added. */
  readonly installed: boolean
  /** Whether the program said it is signed in. */
  readonly signedIn: 'yes' | 'no' | 'unknown'
  /** The plan's name as the program spells it. */
  readonly plan?: string | undefined
  /** The limit windows. */
  readonly windows: readonly WindowFigure[]
  /** When a limits check last answered. */
  readonly checkedAt?: number | undefined
}

/** The used share from which a bar turns amber (L24). */
export const NEAR_PERCENT = 80

/** How long figures stay "as of" their time; older figures say "Last seen". */
export const FRESH_MS = 30 * 60 * 1000

/** How a window stands against its limit. `reset` means its reset time has passed since the figures were seen. */
export type Standing = 'ok' | 'near' | 'reached' | 'reset' | 'unknown'

/** One window as a bar shows it. */
export interface WindowView {
  /** The window's kind. */
  readonly kind: string
  /** The standing, which colours the bar and picks its word. */
  readonly standing: Standing
  /** The used share, 0 to 100, when known and still current. */
  readonly percent: number | undefined
  /** When the window resets, in milliseconds since the epoch. */
  readonly resetsAt: number | undefined
  /** When the figures were seen. */
  readonly seenAt: number
}

/**
 * @param window - a stored window.
 * @param now - the time the answer was made.
 * @returns how the window stands now; a passed reset time outranks every stored figure.
 */
export function windowView(window: WindowFigure, now: number): WindowView {
  const percent = window.usedPercent === undefined ? undefined : Math.min(100, Math.max(0, Math.round(window.usedPercent)))
  const base = { kind: window.kind, resetsAt: window.resetsAt, seenAt: window.seenAt }
  if (window.resetsAt !== undefined && window.resetsAt <= now) return { ...base, standing: 'reset', percent: undefined }
  if (window.status === 'reached' || percent === 100) return { ...base, standing: 'reached', percent: percent ?? 100 }
  if (window.status === 'near' || (percent !== undefined && percent >= NEAR_PERCENT)) return { ...base, standing: 'near', percent }
  if (window.status === 'allowed' || percent !== undefined) return { ...base, standing: 'ok', percent }
  return { ...base, standing: 'unknown', percent }
}

/**
 * @param account - one agent's figures.
 * @param now - the time the answer was made.
 * @returns every window's view, in the order stored.
 */
export function windowViews(account: AccountFigures, now: number): readonly WindowView[] {
  return account.windows.map(window => windowView(window, now))
}

/**
 * @param accounts - every agent's figures.
 * @param now - the time the answer was made.
 * @returns the highest used share among added agents' current windows, or undefined when none carries a figure.
 */
export function highestShare(accounts: readonly AccountFigures[], now: number): number | undefined {
  let highest: number | undefined
  for (const account of accounts) {
    if (!account.installed) continue
    for (const view of windowViews(account, now)) {
      if (view.percent !== undefined && (highest === undefined || view.percent > highest)) highest = view.percent
    }
  }
  return highest
}

/**
 * @param share - a used share, or undefined.
 * @param accounts - every agent's figures.
 * @param now - the time the answer was made.
 * @returns the standing the pill takes: reached when any current window is, otherwise near from the amber share.
 */
export function pillStanding(share: number | undefined, accounts: readonly AccountFigures[], now: number): Standing {
  const reached = accounts.some(account => account.installed && windowViews(account, now).some(view => view.standing === 'reached'))
  if (reached) return 'reached'
  if (share !== undefined && share >= NEAR_PERCENT) return 'near'
  return share === undefined ? 'unknown' : 'ok'
}

/**
 * @param account - one agent's figures.
 * @returns when the figures were last seen: the latest of the check and the windows' sightings, or undefined for none.
 */
export function lastSeenAt(account: AccountFigures): number | undefined {
  const times = [account.checkedAt, ...account.windows.map(window => window.seenAt)].filter((time): time is number => time !== undefined)
  return times.length === 0 ? undefined : Math.max(...times)
}

/**
 * @param plan - a plan name as the program spells it, such as `max`.
 * @returns the name with a capital first letter.
 */
export function planName(plan: string): string {
  return `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`
}

/** Codex names its weekly window by its length; both agents call it the weekly limit. */
const WEEK_MINUTES = 7 * 1440

/**
 * @param kind - a window kind.
 * @returns the copy key and its parameter for kinds with a translated title, or undefined for English fallbacks.
 */
export function titleKey(kind: string): { readonly key: 'limits.window.five_hour' | 'limits.window.seven_day' | 'limits.window.hours' | 'limits.window.days'; readonly count?: string } | undefined {
  if (kind === 'five_hour') return { key: 'limits.window.five_hour' }
  if (kind === 'seven_day') return { key: 'limits.window.seven_day' }
  const minutes = /^window_(\d+)m$/u.exec(kind)?.[1]
  if (minutes === undefined) return undefined
  const count = Number(minutes)
  if (count === WEEK_MINUTES) return { key: 'limits.window.seven_day' }
  if (count > 0 && count % 1440 === 0) return { key: 'limits.window.days', count: String(count / 1440) }
  if (count > 0 && count % 60 === 0) return { key: 'limits.window.hours', count: String(count / 60) }
  return undefined
}

export { windowTitle }
