/**
 * The home process's way to the external agents' account service in the Host it runs, which the update channel's
 * `agents.accounts` and `agents.refresh` drive (contract C19). Each call reads `ctx.agentAccounts` when the operation
 * arrives, so a profile that does not load `@delorun/external-agents` answers as absent. `delorun start` attaches it to
 * the running Host.
 *
 * @module @delorun/cli/agents/host
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LocalAgentAccounts } from '@delorun/home-process'
// Type-only: the ctx.agentAccounts merge.
import type {} from '@delorun/external-agents'

/**
 * The account operations of a booted Host.
 * @param ctx - the Host's root context.
 * @returns the operations, each reading the service per call.
 */
export function localAgentAccounts(ctx: Pick<Context, 'get'>): LocalAgentAccounts {
  return {
    accounts: async () => {
      const accounts = ctx.get('agentAccounts')
      return accounts === undefined ? undefined : { ...await accounts.readAll() }
    },
    refresh: async (provider, reason) => {
      const accounts = ctx.get('agentAccounts')
      return accounts === undefined ? undefined : { ...await accounts.refresh(provider, reason) }
    },
  }
}
