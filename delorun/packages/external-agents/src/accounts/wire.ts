/**
 * The external agents' account figures as the store keeps them and the studio's routes answer them, free of Cordis and
 * Node so the browser and the CLI import them.
 *
 * @module @delorun/external-agents/accounts/wire
 */
import type { AccountRecord, AccountRefreshOutcome, AgentAccounts, ExternalAgentName, RecordedLimitWindow } from '../contract.ts'

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

/** One limit window as stored, with when it was seen and where. */
export type StoredWindow = RecordedLimitWindow

/** One provider's stored figures: its {@link AccountRecord} without what the Host knows only at run time. */
export type AccountState = Omit<AccountRecord, 'provider' | 'installed'>

/** The accounts file's content. */
export interface AccountsFile {
  /** Format version. */
  readonly v: 1
  /** The figures per provider; a provider never seen is absent. */
  readonly accounts: Readonly<Partial<Record<ExternalAgentName, AccountState>>>
}

/** One provider's entry in {@link AccountsAnswer}: its stored figures, and whether its pack is added. */
export type AccountView = AccountRecord

/** The `accounts` route's answer, `AgentAccounts.readAll`'s: every provider in {@link ACCOUNT_PROVIDERS} order, and the time "as of" and "reset at" compare against. */
export type AccountsAnswer = Awaited<ReturnType<AgentAccounts['readAll']>>

/** The `refresh` route's request. */
export interface RefreshRequest {
  /** The provider to check. */
  readonly provider: ExternalAgentName
}

/** What a refresh did. */
export type RefreshOutcome = AccountRefreshOutcome

/** The `refresh` route's answer, `AgentAccounts.refresh`'s: the outcome, the provider's figures after it, and the time. */
export type RefreshAnswer = Awaited<ReturnType<AgentAccounts['refresh']>>

/** The names a person knows each limit window kind by, as the drivers name them; any other kind is shown in words. */
export const WINDOW_TITLES: Readonly<Record<string, string>> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly Opus limit',
  seven_day_sonnet: 'Weekly Sonnet limit',
  seven_day_overage_included: 'Weekly limit with extra usage',
  overage: 'Extra usage',
  unknown: 'Plan limit',
}

/** Codex names its weekly window by its length (`window_10080m`); both agents show it as the weekly limit. */
const WEEK_MINUTES = 7 * 1440

/**
 * The name a person knows a limit window by.
 * @param kind - the window's kind, such as `five_hour` or Codex's `window_43200m`.
 * @returns its title, such as `5-hour limit` or `30-day limit`, or the kind in words for a kind with no title.
 */
export function windowTitle(kind: string): string {
  const titled = WINDOW_TITLES[kind]
  if (titled !== undefined) return titled
  const minutes = /^window_(\d+)m$/u.exec(kind)?.[1]
  if (minutes !== undefined) {
    const count = Number(minutes)
    if (count === WEEK_MINUTES) return WINDOW_TITLES['seven_day']
    if (count > 0 && count % 1440 === 0) return `${String(count / 1440)}-day limit`
    if (count > 0 && count % 60 === 0) return `${String(count / 60)}-hour limit`
    return `${minutes}-minute limit`
  }
  const words = kind.replaceAll(/[-_]+/gu, ' ')
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} limit`
}
