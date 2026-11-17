/**
 * The update channel's external-agent account operations (contract C19): `agents.accounts` reads each external agent's
 * stored sign-in status and plan-limit figures from the running Host, and `agents.refresh` makes the Host check one
 * agent's figures now through its start gate. `delorun agents status` and `delorun agents login` send them.
 *
 * `agents.accounts` changes nothing and accepts either token. `agents.refresh` starts the person's own program, so it
 * is accepted only with the person's token: the Host's channel token, which acts for studio sessions on every
 * listener, reach sessions included, is refused with `LOOPBACK_REQUIRED` before the Host is asked anything.
 *
 * @module @delorun/home-process/agents
 */
import type { AgentsAccountsRequest, AgentsRefreshRequest } from '@delorun/contract-home-process'
import type { ChannelCaller } from './devices-approve.ts'
import { HomeProcessError } from './errors.ts'

/** The Host's half of the account operations: the account service of `@delorun/external-agents`, read per operation. */
export interface LocalAgentAccounts {
  /**
   * Every external agent's stored figures. Never starts a check.
   * @returns the answer's fields, or undefined when the profile does not mount the account service.
   */
  accounts(): Promise<Readonly<Record<string, unknown>> | undefined>
  /**
   * Check one agent's figures now, unless its pack is missing or, for `check-now`, the last check was too recent.
   * @param provider - the agent.
   * @param reason - why the check is asked for.
   * @returns the answer's fields, or undefined when the profile does not mount the account service.
   */
  refresh(provider: AgentsRefreshRequest['args']['provider'], reason: AgentsRefreshRequest['args']['reason']): Promise<Readonly<Record<string, unknown>> | undefined>
}

/** The detail of a Host without the account service. */
const NOT_LOADED = 'the running profile does not load external agents'

/**
 * Run `agents.accounts`.
 * @param _request - the request, which has no arguments.
 * @param accounts - the Host's account operations, or undefined while no Host runs.
 * @returns the final line's fields: `accounts` and `now`.
 * @throws {HomeProcessError} `AGENTS_UNAVAILABLE` when no Host or no account service runs.
 */
export async function agentsAccounts(_request: AgentsAccountsRequest, accounts: LocalAgentAccounts | undefined): Promise<Readonly<Record<string, unknown>>> {
  if (accounts === undefined) throw new HomeProcessError('AGENTS_UNAVAILABLE', 'no Host is running')
  const answer = await accounts.accounts()
  if (answer === undefined) throw new HomeProcessError('AGENTS_UNAVAILABLE', NOT_LOADED)
  return answer
}

/**
 * Run `agents.refresh`.
 * @param request - the request.
 * @param caller - the credential it carried.
 * @param accounts - the Host's account operations, or undefined while no Host runs.
 * @returns the final line's fields: `outcome`, `account` and `now`.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `AGENTS_UNAVAILABLE` when no Host or no
 *   account service runs.
 */
export async function agentsRefresh(request: AgentsRefreshRequest, caller: ChannelCaller, accounts: LocalAgentAccounts | undefined): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'checking an agent\'s plan limits starts its program: run delorun agents status --refresh at your computer')
  }
  if (accounts === undefined) throw new HomeProcessError('AGENTS_UNAVAILABLE', 'no Host is running')
  const answer = await accounts.refresh(request.args.provider, request.args.reason)
  if (answer === undefined) throw new HomeProcessError('AGENTS_UNAVAILABLE', NOT_LOADED)
  return answer
}
