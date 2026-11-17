/**
 * The external agents' account figures as the store keeps them and the studio's routes answer them, free of Cordis and
 * Node so the browser and the CLI import them.
 *
 * @module @delorun/external-agents/accounts/wire
 */
import type { ExternalAgentName, LimitWindow, OfferedModel } from '../contract.ts'

/** The providers whose accounts are kept, in display order. */
export const ACCOUNT_PROVIDERS = ['claude-code', 'codex'] as const satisfies readonly ExternalAgentName[]

/** The exact routes under `/api`. */
export const ACCOUNT_ROUTES = {
  /** `GET`: every provider's stored figures, as {@link AccountsAnswer}. Reading never starts a check. */
  accounts: '/api/delorunExternalAgents.accounts',
  /** `POST` {@link RefreshRequest}: check one provider now, as {@link RefreshAnswer}. */
  refresh: '/api/delorunExternalAgents.refresh',
} as const

/** The largest request body a route reads, in bytes. */
export const MAX_ACCOUNT_REQUEST_BYTES = 1024

/** One limit window as stored: a {@link LimitWindow} with when it was seen and where. */
export interface StoredWindow extends LimitWindow {
  /** When the figures were seen, in milliseconds since the epoch. */
  readonly seenAt: number
  /** Whether a run or a limits check reported them. */
  readonly source: 'run' | 'probe'
}

/** One provider's stored figures. */
export interface AccountState {
  /** Whether the program last said it is signed in; `unknown` until a check or a run says. */
  readonly signedIn: 'yes' | 'no' | 'unknown'
  /** The plan's name as the program spells it, such as `max` or `plus`. */
  readonly plan?: string
  /** The limit windows, one per kind. */
  readonly windows: readonly StoredWindow[]
  /** The models the program offers on this sign-in, when it lists them (Codex). */
  readonly offeredModels?: readonly OfferedModel[]
  /** When a limits check last answered, in milliseconds since the epoch. */
  readonly checkedAt?: number
  /** When a limits check last failed, in milliseconds since the epoch. */
  readonly checkFailedAt?: number
}

/** The accounts file's content. */
export interface AccountsFile {
  /** Format version. */
  readonly v: 1
  /** The figures per provider; a provider never seen is absent. */
  readonly accounts: Readonly<Partial<Record<ExternalAgentName, AccountState>>>
}

/** One provider's entry in {@link AccountsAnswer}. */
export interface AccountView extends AccountState {
  /** The provider. */
  readonly provider: ExternalAgentName
  /** Whether the provider's pack is added, so a check can run. */
  readonly installed: boolean
}

/** The `accounts` route's answer. */
export interface AccountsAnswer {
  /** Every provider, in {@link ACCOUNT_PROVIDERS} order. */
  readonly accounts: readonly AccountView[]
  /** The time the answer was made, in milliseconds since the epoch, which "as of" and "reset at" compare against. */
  readonly now: number
}

/** The `refresh` route's request. */
export interface RefreshRequest {
  /** The provider to check. */
  readonly provider: ExternalAgentName
}

/**
 * What a refresh did:
 * - `checked`: a check ran and answered; `account` holds its figures;
 * - `failed`: a check ran and did not answer; the figures stay as they were seen;
 * - `throttled`: the last check was too recent; `nextAt` is when the next may run;
 * - `not-installed`: the provider's pack is not added, so nothing started;
 * - `refused`: the start gate refused the check, with its sentence for the person.
 */
export type RefreshOutcome =
  | { readonly kind: 'checked' }
  | { readonly kind: 'failed'; readonly problem: string }
  | { readonly kind: 'throttled'; readonly nextAt: number }
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'refused'; readonly problem: string }

/** The `refresh` route's answer. */
export interface RefreshAnswer {
  /** What the refresh did. */
  readonly outcome: RefreshOutcome
  /** The provider's figures after it. */
  readonly account: AccountView
  /** The time the answer was made, in milliseconds since the epoch. */
  readonly now: number
}

/** The names a person knows each limit window kind by; any other kind is shown as its own words. */
export const WINDOW_TITLES: Readonly<Record<string, string>> = {
  'five-hour': '5-hour limit',
  'seven-day': 'Weekly limit',
  'seven-day-opus': 'Weekly Opus limit',
  'seven-day-sonnet': 'Weekly Sonnet limit',
  'thirty-day': '30-day limit',
  'overage': 'Extra usage',
}

/**
 * The name a person knows a limit window by.
 * @param kind - the window's kind, such as `five-hour`.
 * @returns its title, such as `5-hour limit`, or the kind in words for a kind with no title.
 */
export function windowTitle(kind: string): string {
  const titled = WINDOW_TITLES[kind]
  if (titled !== undefined) return titled
  const minutes = /^(\d+)-minute$/u.exec(kind)?.[1]
  if (minutes !== undefined) return `${minutes}-minute limit`
  const words = kind.replaceAll('-', ' ')
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} limit`
}
