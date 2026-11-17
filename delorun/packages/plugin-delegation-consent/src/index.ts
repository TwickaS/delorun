/**
 * @delorun/plugin-delegation-consent: Delorun's consent before an external agent runs. It provides the
 * `delegationConsent` service of `@deepseek-ai/dsh-subagent`'s external-delegation seam ([service](./service.ts)),
 * the loopback-only routes the studio's approval card and External agents section call ([routes](./routes.ts)), and a
 * tool guard that refuses the model's `plugin_manager` calls that would install, enable or reconfigure an external
 * agent's package ([guard](./guard.ts)). With `enabled` off, the schema's default and the C16 switch
 * `external_agent_consent`'s parity value, it mounts nothing: external providers start as upstream starts them and
 * keep upstream's tool description.
 * @module @delorun/plugin-delegation-consent
 */
import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { ComputerOnlySwitch } from '@delorun/home-auth'
import { guardProfile, pluginManagerVerdict, type GuardRow } from './guard.ts'
import { registerDelegationRoutes } from './routes.ts'
import { FailedDelegationConsent } from './failed.ts'
import { DelorunDelegationConsent } from './service.ts'
import { missingClaudeSandboxTools } from '@deepseek-ai/dsh-subagent'
import { AGENT_LEVEL_FIELDS, AGENT_LEVELS, DEFAULT_AGENT_LEVEL, DELEGATION_CONSENT_ROW, RUN_TIMEOUT_MINUTES, type DelegationConsentSettings } from './wire.ts'

export { DelorunDelegationConsent, DelegationConsentError } from './service.ts'
export { isExternalAgentPackage, PLUGIN_MANAGER_REFUSAL, pluginManagerVerdict, targetPackageNames } from './guard.ts'

/**
 * The plugin's configuration: the fields Settings → Safety → External agents writes ([`DelegationConsentSettings`](./wire.ts)), each
 * live, so a saved change applies without a restart.
 */
export interface Config {
  /**
   * The C16 switch `external_agent_consent`: off, the plugin mounts nothing. Delorun's composition turns it on; the
   * person turns it off in Settings → Safety → External agents on the home's own computer.
   */
  readonly enabled: Volatile<boolean>
  /** How long one external agent run may take before it is stopped, in whole minutes; a change applies from the next run. */
  readonly runTimeoutMinutes: Volatile<number>
  /**
   * What Claude Code may do on its own: `careful`, `standard`, `own` or `unrestricted` ([levels](./wire.ts)). A change
   * applies from the next run. A device may set a level no looser than the current one; a looser one is set at the
   * home's own computer.
   */
  readonly claudeCodeLevel: Volatile<DelegationConsentSettings['claudeCodeLevel']>
  /** What Codex may do on its own; same levels and rules as `claudeCodeLevel`. */
  readonly codexLevel: Volatile<DelegationConsentSettings['codexLevel']>
  /**
   * Whether a chat in Full access, with approval policy `never` and sandbox mode `danger-full-access` together, starts
   * an external agent without asking and without a workspace grant. On by default: such a chat is the person's choice
   * to run without prompts. Off, the start is refused unless the workspace allows the agent. Only the home's own computer turns it on.
   */
  readonly fullAccessStartsAgents: Volatile<boolean>
}

/** The schema of {@link Config}; `enabled` defaults to the switch's parity value, off. */
export const Config: z<Partial<DelegationConsentSettings>, Config> = z.object({
  enabled: z.boolean().volatile().default(false),
  runTimeoutMinutes: z.natural().min(RUN_TIMEOUT_MINUTES.min).max(RUN_TIMEOUT_MINUTES.max).volatile().default(RUN_TIMEOUT_MINUTES.default),
  claudeCodeLevel: z.union([...AGENT_LEVELS]).volatile().default(DEFAULT_AGENT_LEVEL),
  codexLevel: z.union([...AGENT_LEVELS]).volatile().default(DEFAULT_AGENT_LEVEL),
  fullAccessStartsAgents: z.boolean().volatile().default(true),
})

/**
 * Declares that this plugin's row provides `delegationConsent` (`DELEGATION_CONSENT_PROVIDER_EXPORT` of
 * `@deepseek-ai/dsh-subagent`), so an external start waits for the row and starts nothing while it is not running.
 */
export const providesDelegationConsent = true

/**
 * The consent's `enabled` field as a switch only the home's own computer turns off. While the plugin is mounted
 * it registers the switch with `@delorun/home-auth`, whose reach policy then refuses a device's settings write that could
 * turn it off, unlocked or not; the run time limit and turning it on stay ordinary settings writes.
 */
export const EXTERNAL_AGENT_CONSENT_SWITCH: ComputerOnlySwitch = Object.freeze({
  ns: DELEGATION_CONSENT_ROW,
  field: 'enabled',
  label: 'the external-agent consent',
})

/**
 * A level field as a ranked switch only the home's own computer loosens: a device may set a level no looser than the
 * current one.
 * @param provider - the provider whose level the switch guards.
 * @param label - what the refusal names.
 * @param current - the level saved now.
 * @returns the switch.
 */
function levelSwitch(provider: keyof typeof AGENT_LEVEL_FIELDS, label: string, current: () => string): ComputerOnlySwitch {
  return Object.freeze({ ns: DELEGATION_CONSENT_ROW, field: AGENT_LEVEL_FIELDS[provider], label, ranked: { order: AGENT_LEVELS, current } })
}

/**
 * The consent's `fullAccessStartsAgents` field as a switch only the home's own computer turns on. A device may write
 * `false`, which makes Full access chats ask again as the grants require; its write of `true` is refused, unlocked or not.
 */
export const FULL_ACCESS_STARTS_AGENTS_SWITCH: ComputerOnlySwitch = Object.freeze({
  ns: DELEGATION_CONSENT_ROW,
  field: 'fullAccessStartsAgents',
  label: 'external agents starting without asking in Full access chats',
  safeValue: false,
})

/**
 * Mount the consent's service, routes, tool guard and computer-only switch in a scope of their own.
 * @param ctx - the scope, disposed when the switch turns off.
 * @param config - the row's live configuration.
 */
function mountConsent(ctx: Context, config: Config): void {
  const rows = (): readonly GuardRow[] => [...ctx.get('loader')?.entries() ?? []].map(entry => ({
    id: entry.id, rowId: entry.options.id, name: entry.options.name,
  }))
  let disposed = false
  ctx.effect(() => () => { disposed = true })
  ctx.plugin(DelorunDelegationConsent, { timeoutMs: () => config.runTimeoutMinutes.get() * 60_000, fullAccessStartsAgents: () => config.fullAccessStartsAgents.get(), env: process.env, now: Date.now,
    levelOf: provider => provider === 'codex' ? config.codexLevel.get() : config.claudeCodeLevel.get(),
    missingSandboxTools: () => missingClaudeSandboxTools(process.platform, process.env.PATH),
  })
    .await().catch((error: unknown) => {
      // The row stays active, so the declaring-row check of the subagent runtime cannot see this failure; a refusing
      // service takes the seam's slot, and every start is refused until the row starts again.
      if (disposed) return
      const reason = error instanceof Error ? error.message : 'no reason was given'
      ctx.logger.error(`delegation-consent: the service of the row ${DELEGATION_CONSENT_ROW} failed to start, so every external agent start is refused until Delorun restarts: ${reason}`)
      ctx.plugin(FailedDelegationConsent, { row: DELEGATION_CONSENT_ROW, reason })
    })
  const profile = () => guardProfile(ctx.get('profileContext')?.dir)
  ctx.inject(['tools'], (scope) => { scope.tools.guard(exec => pluginManagerVerdict(exec, rows, profile)) })
  ctx.inject(['connection', 'delegationConsent'], (scope) => {
    // The refusing service, mounted when the real one failed, has no grants to list.
    if (scope.delegationConsent instanceof DelorunDelegationConsent) registerDelegationRoutes(scope, scope.delegationConsent)
  })
  ctx.inject(['homeAuth'], (scope) => {
    scope.effect(() => scope.homeAuth.registerComputerOnlySwitch(EXTERNAL_AGENT_CONSENT_SWITCH), 'delegation consent: computer-only switch')
    scope.effect(() => scope.homeAuth.registerComputerOnlySwitch(FULL_ACCESS_STARTS_AGENTS_SWITCH), 'delegation consent: computer-only full-access switch')
    scope.effect(() => scope.homeAuth.registerComputerOnlySwitch(levelSwitch('claude-code', 'the Claude Code level', () => config.claudeCodeLevel.get())), 'delegation consent: Claude Code level switch')
    scope.effect(() => scope.homeAuth.registerComputerOnlySwitch(levelSwitch('codex', 'the Codex level', () => config.codexLevel.get())), 'delegation consent: Codex level switch')
  })
}

/**
 * Mount the plugin in the scope that loads it: the consent while `enabled` is on, mounted and disposed as a saved
 * setting turns it on and off.
 * @param ctx - the scope.
 * @param config - the row's validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  let mounted: Fiber | undefined
  const follow = (): void => {
    if (config.enabled.get() === (mounted !== undefined)) return
    if (mounted === undefined) {
      mounted = ctx.plugin({ name: 'delorun-delegation-consent-mounted', apply: mountConsent }, config)
      return
    }
    // Disposal reports its own failures through the scope's logger; turning the switch off needs no answer from it.
    void mounted.dispose()
    mounted = undefined
  }
  follow()
  ctx.on('loader/volatile-update', follow)
}
