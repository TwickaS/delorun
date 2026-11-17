/**
 * The studio's requests for the external agents' figures: reading them (which never starts a check) and "Check now".
 * @module @delorun/bundle-local/client/agent-limits-api
 */
import { ACCOUNT_PROVIDERS, ACCOUNT_ROUTES, type AccountsAnswer, type RefreshAnswer } from '@delorun/external-agents/accounts/wire'
import { call, fields, isBoolean, isRecord, isString, isTime, listOf, optional, type Check, type HostFetch } from './host-api.ts'

const isWindow: Check = fields({ kind: isString, status: isString, seenAt: isTime })
const isAccount: Check = value => fields({
  provider: v => typeof v === 'string' && (ACCOUNT_PROVIDERS as readonly string[]).includes(v),
  signedIn: v => v === 'yes' || v === 'no' || v === 'unknown',
  plan: optional(isString),
  windows: listOf(isWindow),
  checkedAt: optional(isTime),
  installed: isBoolean,
})(value)
const isAccounts: Check = fields({ accounts: listOf(isAccount), now: isTime })
const isRefresh: Check = value => isRecord(value) && isRecord(value['outcome']) && isString(value['outcome']['kind']) && isAccount(value['record']) && isTime(value['now'])

/**
 * Read every agent's stored figures. Never starts a check.
 * @param fetch - the request function.
 * @returns the figures and the time the answer was made.
 * @throws {HostRequestError} when the home refuses, cannot be reached or answers something else.
 */
export function readAccounts(fetch: HostFetch): Promise<AccountsAnswer> {
  return call<AccountsAnswer>(fetch, ACCOUNT_ROUTES.accounts, isAccounts)
}

/**
 * Check one agent's account now, as the person asked.
 * @param fetch - the request function.
 * @param provider - the agent.
 * @returns what the check did and the figures after it.
 * @throws {HostRequestError} `ELEVATION_REQUIRED` from a locked reach device, or any other failure.
 */
export function checkAccount(fetch: HostFetch, provider: RefreshAnswer['record']['provider']): Promise<RefreshAnswer> {
  return call<RefreshAnswer>(fetch, ACCOUNT_ROUTES.refresh, isRefresh, { provider })
}
