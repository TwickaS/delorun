/**
 * @delo/plugin-delegation-consent: Delo's consent before an external agent runs. It provides the
 * `delegationConsent` service of `@deepseek-ai/dsh-subagent`'s external-delegation seam ([service](./service.ts)),
 * the loopback-only routes the studio's approval card and Permissions section call ([routes](./routes.ts)), and a
 * tool guard that refuses the model's `plugin_manager` calls that would install, enable or reconfigure an external
 * agent's package. With `enabled` off, the schema's default and the C16 switch `external_agent_consent`'s parity
 * value, it mounts nothing: external providers start as upstream starts them and keep upstream's tool description.
 * @module @delo/plugin-delegation-consent
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { registerDelegationRoutes } from './routes.ts'
import { DeloDelegationConsent } from './service.ts'

export { DeloDelegationConsent, DelegationConsentError } from './service.ts'

/** The plugin's configuration. */
export interface Config {
  /** The C16 switch `external_agent_consent`: off, the plugin mounts nothing. */
  readonly enabled: boolean
  /** How long one external agent run may take before it is stopped, in whole minutes. */
  readonly runTimeoutMinutes: number
  /** Packages whose install, enabling or settings the model's `plugin_manager` calls may not change. */
  readonly modelRefusedPackages: readonly string[]
}

/** The schema of {@link Config}; `enabled` defaults to the switch's parity value, off. */
export const ConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  runTimeoutMinutes: z.number().int().min(1).max(24 * 60).default(30),
  modelRefusedPackages: z.array(z.string().min(1)).default(['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex']),
})

/** The model-facing refusal of a `plugin_manager` call that would bring in an external agent. */
export const PLUGIN_MANAGER_REFUSAL = 'Plugin management refused this change: it would install, enable or reconfigure an external agent '
  + '(such as Claude Code or Codex), which runs outside Delo\'s sandbox and uses the person\'s own account. Only the person can add it, '
  + 'from the Plugins page or the first-run setup; tell them, and do not retry.'

/**
 * The package name a `plugin_manager` target names: an npm spec without its version, or the name itself.
 * @param target - the tool call's target.
 * @returns the package name.
 */
export function packageOfTarget(target: string): string {
  const at = target.indexOf('@', target.startsWith('@') ? 1 : 0)
  return at === -1 ? target : target.slice(0, at)
}

/** The Loader rows the guard resolves an entry target against: each row's entry id, row id and module name. */
export interface GuardRow {
  readonly id: string
  readonly rowId: string | undefined
  readonly name: string
}

/**
 * Decide one tool call: refuse a `plugin_manager` call that installs or enables a refused package's bundle, or
 * enables or configures a row of a refused package. Disabling, removing and every other action pass.
 * @param exec - the tool call.
 * @param refused - the refused package names.
 * @param rows - the Loader's rows, read when the call names an entry.
 * @returns the refusal, or undefined.
 */
export function pluginManagerVerdict(exec: Pick<ToolExecution, 'name' | 'arguments'>, refused: ReadonlySet<string>, rows: () => readonly GuardRow[]): string | undefined {
  if (exec.name !== 'plugin_manager' || typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  const action: unknown = Reflect.get(exec.arguments, 'action')
  const target: unknown = Reflect.get(exec.arguments, 'target')
  const enabled: unknown = Reflect.get(exec.arguments, 'enabled')
  if (typeof target !== 'string') return undefined
  switch (action) {
    case 'install_bundle':
    case 'set_bundle':
      return enabled !== false && refused.has(packageOfTarget(target)) ? PLUGIN_MANAGER_REFUSAL : undefined
    case 'set_plugin':
    case 'configure': {
      if (action === 'set_plugin' && enabled === false) return undefined
      const row = rows().find(each => each.id === target || each.rowId === target)
      return row !== undefined && refused.has(packageOfTarget(row.name)) ? PLUGIN_MANAGER_REFUSAL : undefined
    }
    default:
      return undefined
  }
}

/**
 * Mount the plugin in the scope that loads it.
 * @param ctx - the scope.
 * @param config - the row's configuration, or undefined for a bare mount.
 */
export function apply(ctx: Context, config?: unknown): void {
  const parsed = ConfigSchema.parse(config ?? {})
  if (!parsed.enabled) return
  const refused: ReadonlySet<string> = new Set(parsed.modelRefusedPackages)
  const rows = (): readonly GuardRow[] => [...ctx.get('loader')?.entries() ?? []].map(entry => ({
    id: entry.id, rowId: entry.options.id, name: entry.options.name,
  }))
  ctx.plugin(DeloDelegationConsent, { timeoutMs: parsed.runTimeoutMinutes * 60_000, env: process.env, now: Date.now })
  ctx.inject(['tools'], (scope) => { scope.tools.guard(exec => pluginManagerVerdict(exec, refused, rows)) })
  ctx.inject(['connection', 'delegationConsent'], (scope) => {
    registerDelegationRoutes(scope, scope.delegationConsent as DeloDelegationConsent)
  })
}
