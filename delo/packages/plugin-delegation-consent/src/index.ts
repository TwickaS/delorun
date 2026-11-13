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
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { guardProfile, pluginManagerVerdict, type GuardRow } from './guard.ts'
import { registerDelegationRoutes } from './routes.ts'
import { DeloDelegationConsent } from './service.ts'
import { RUN_TIMEOUT_MINUTES, type DelegationConsentSettings } from './wire.ts'

export { DeloDelegationConsent, DelegationConsentError } from './service.ts'
export { isExternalAgentPackage, PLUGIN_MANAGER_REFUSAL, pluginManagerVerdict, targetPackageNames } from './guard.ts'

/** The plugin's configuration: the fields Settings, Permissions writes. */
export interface Config extends DelegationConsentSettings {
  /**
   * The C16 switch `external_agent_consent`: off, the plugin mounts nothing. Delo's composition turns it on; the
   * person turns it off in Settings, Permissions on the home's own computer.
   */
  readonly enabled: boolean
}

/** The schema of {@link Config}; `enabled` defaults to the switch's parity value, off. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  runTimeoutMinutes: z.natural().min(RUN_TIMEOUT_MINUTES.min).max(RUN_TIMEOUT_MINUTES.max).default(RUN_TIMEOUT_MINUTES.default),
})

/**
 * Mount the plugin in the scope that loads it.
 * @param ctx - the scope.
 * @param config - the row's validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const rows = (): readonly GuardRow[] => [...ctx.get('loader')?.entries() ?? []].map(entry => ({
    id: entry.id, rowId: entry.options.id, name: entry.options.name,
  }))
  ctx.plugin(DeloDelegationConsent, { timeoutMs: config.runTimeoutMinutes * 60_000, env: process.env, now: Date.now })
  const profile = () => guardProfile(ctx.get('profileContext')?.dir)
  ctx.inject(['tools'], (scope) => { scope.tools.guard(exec => pluginManagerVerdict(exec, rows, profile)) })
  ctx.inject(['connection', 'delegationConsent'], (scope) => {
    registerDelegationRoutes(scope, scope.delegationConsent as DeloDelegationConsent)
  })
}
