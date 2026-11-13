/**
 * @delo/plugin-delegation-consent: Delo's consent before an external agent runs. It provides the
 * `delegationConsent` service of `@deepseek-ai/dsh-subagent`'s external-delegation seam ([service](./service.ts)),
 * the loopback-only routes the studio's approval card and Permissions section call ([routes](./routes.ts)), and a
 * tool guard that refuses the model's `plugin_manager` calls that would install, enable or reconfigure an external
 * agent's package ([guard](./guard.ts)). With `enabled` off, the schema's default and the C16 switch
 * `external_agent_consent`'s parity value, it mounts nothing: external providers start as upstream starts them and
 * keep upstream's tool description.
 * @module @delo/plugin-delegation-consent
 */
import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { ComputerOnlySwitch } from '@delo/home-auth'
import { guardProfile, pluginManagerVerdict, type GuardRow } from './guard.ts'
import { registerDelegationRoutes } from './routes.ts'
import { DeloDelegationConsent } from './service.ts'
import { DELEGATION_CONSENT_ROW, RUN_TIMEOUT_MINUTES, type DelegationConsentSettings } from './wire.ts'

export { DeloDelegationConsent, DelegationConsentError } from './service.ts'
export { isExternalAgentPackage, PLUGIN_MANAGER_REFUSAL, pluginManagerVerdict, targetPackageNames } from './guard.ts'

/**
 * The plugin's configuration: the fields Settings, Permissions writes ([`DelegationConsentSettings`](./wire.ts)), each
 * live, so a saved change applies without a restart.
 */
export interface Config {
  /**
   * The C16 switch `external_agent_consent`: off, the plugin mounts nothing. Delo's composition turns it on; the
   * person turns it off in Settings, Permissions on the home's own computer.
   */
  readonly enabled: Volatile<boolean>
  /** How long one external agent run may take before it is stopped, in whole minutes; a change applies from the next run. */
  readonly runTimeoutMinutes: Volatile<number>
}

/** The schema of {@link Config}; `enabled` defaults to the switch's parity value, off. */
export const Config: z<Partial<DelegationConsentSettings>, Config> = z.object({
  enabled: z.boolean().volatile().default(false),
  runTimeoutMinutes: z.natural().min(RUN_TIMEOUT_MINUTES.min).max(RUN_TIMEOUT_MINUTES.max).volatile().default(RUN_TIMEOUT_MINUTES.default),
})

/**
 * Declares that this plugin's row provides `delegationConsent` (`DELEGATION_CONSENT_PROVIDER_EXPORT` of
 * `@deepseek-ai/dsh-subagent`), so an external start waits for the row and starts nothing while it is not running.
 */
export const providesDelegationConsent = true

/**
 * The consent's `enabled` field as a switch only the home's own computer turns off (A299). While the plugin is mounted
 * it registers the switch with `@delo/home-auth`, whose reach policy then refuses a device's settings write that could
 * turn it off, unlocked or not; the run time limit and turning it on stay ordinary settings writes.
 */
export const EXTERNAL_AGENT_CONSENT_SWITCH: ComputerOnlySwitch = Object.freeze({
  ns: DELEGATION_CONSENT_ROW,
  field: 'enabled',
  label: 'the external-agent consent',
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
  ctx.plugin(DeloDelegationConsent, { timeoutMs: () => config.runTimeoutMinutes.get() * 60_000, env: process.env, now: Date.now })
  const profile = () => guardProfile(ctx.get('profileContext')?.dir)
  ctx.inject(['tools'], (scope) => { scope.tools.guard(exec => pluginManagerVerdict(exec, rows, profile)) })
  ctx.inject(['connection', 'delegationConsent'], (scope) => {
    registerDelegationRoutes(scope, scope.delegationConsent as DeloDelegationConsent)
  })
  ctx.inject(['homeAuth'], (scope) => {
    scope.effect(() => scope.homeAuth.registerComputerOnlySwitch(EXTERNAL_AGENT_CONSENT_SWITCH), 'delegation consent: computer-only switch')
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
      mounted = ctx.plugin({ name: 'delo-delegation-consent-mounted', apply: mountConsent }, config)
      return
    }
    // Disposal reports its own failures through the scope's logger; turning the switch off needs no answer from it.
    void mounted.dispose()
    mounted = undefined
  }
  follow()
  ctx.on('loader/volatile-update', follow)
}
