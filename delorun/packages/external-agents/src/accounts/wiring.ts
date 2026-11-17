/**
 * Mount the account service on the package's context: the service over the home's accounts file and the gate's
 * `probe`, the "pack added" hook on the gate's driver registrations, and the studio's routes. Every registration is a
 * context effect, so disposing the context ends them and aborts a check in progress.
 *
 * @module @delorun/external-agents/accounts/wiring
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AccountRefreshReason, ExternalAgentName, ExternalAgentsGate } from '../contract.ts'
import { checkThrough } from './check.ts'
import { registerAccountRoutes } from './routes.ts'
import { createAgentAccounts, type AgentAccountsService } from './service.ts'
import { accountsFilePath } from './store.ts'

/** What {@link wireAccounts} needs besides the context and the gate. */
export interface WireAccountsOptions {
  /** The resolved Delorun home, whose `secrets/external-agents/accounts.json` holds the figures. */
  readonly home: string
  /**
   * The package's Config as it stands now, read at each refresh so a saved change applies at once.
   * @returns the floor between checks and the acts that may start one.
   */
  readonly config: () => { readonly probeMinIntervalMinutes: number; readonly probeTriggers: readonly AccountRefreshReason[] }
  /**
   * Whether an agent's driver is registered, that is whether its pack is added.
   * @param provider - the agent.
   * @returns whether a check can start.
   */
  readonly installed: (provider: ExternalAgentName) => boolean
  /**
   * Report a failure nobody waits for, such as a figures write that failed.
   * @param message - what failed, with no figures and no program output.
   */
  readonly report: (message: string) => void
}

/**
 * Build the account service and mount its hook and routes.
 * @param ctx - the package's context, which holds the Connection; its disposal ends every registration.
 * @param gate - the start gate, whose `probe` runs each check and whose driver registrations start the "pack added" one.
 * @param options - the home, the Config, the driver lookup and the report.
 * @returns the service, for the caller to provide as `ctx.agentAccounts`.
 */
export function wireAccounts(ctx: Context, gate: Pick<ExternalAgentsGate, 'probe' | 'onDriverRegistered'>, options: WireAccountsOptions): AgentAccountsService {
  const disposed = new AbortController()
  ctx.effect(() => () => { disposed.abort() }, 'external agents: limits checks in progress')
  const accounts = createAgentAccounts({
    storePath: accountsFilePath(options.home),
    now: () => Date.now(),
    probeMinIntervalMs: () => options.config().probeMinIntervalMinutes * 60_000,
    triggers: () => options.config().probeTriggers,
    installed: options.installed,
    check: checkThrough(gate),
    report: options.report,
    signal: disposed.signal,
  })
  ctx.effect(() => gate.onDriverRegistered((provider) => { accounts.driverAdded(provider) }), 'external agents: a limits check when a pack is added')
  registerAccountRoutes(ctx, accounts)
  return accounts
}
