/**
 * Sign-in status and plan limits of the external agents: the store, the service behind `ctx.agentAccounts`, the
 * studio's routes and the reached-limit rule the start gate applies.
 *
 * @module @delorun/external-agents/accounts
 */
export { reachedLimit, windowStanding, type ReachedLimit } from './limit.ts'
export { registerAccountRoutes } from './routes.ts'
export { createAgentAccounts, type AgentAccountsDependencies, type AgentAccountsService, type CheckResult, type RefreshReason } from './service.ts'
export { accountsFilePath, parseAccountsAnswer, parseRefreshAnswer, readAccountsFile, type AccountsRead } from './store.ts'
export {
  ACCOUNT_PROVIDERS, ACCOUNT_ROUTES, windowTitle,
  type AccountsAnswer, type AccountsFile, type AccountState, type AccountView, type RefreshAnswer, type RefreshOutcome, type RefreshRequest, type StoredWindow,
} from './wire.ts'
