/**
 * @delorun/agent-claude-code: the Claude Code driver of `@delorun/external-agents`. It ships dormant and registers with
 * the gate only while upstream's `claude-code` subagent provider is registered, which the Claude Code pack brings. The
 * SDK is loaded from that pack at each open or limits check, never at load.
 * @module @delorun/agent-claude-code
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import { ClaudeCodeDriver } from './driver.ts'
import { loadPackSdk } from './sdk.ts'

/** Upstream's provider name for Claude Code. */
const PROVIDER = 'claude-code'

/** The driver's configuration. */
export interface Config {
  /** How long Claude Code waits for one harness tool call before it gives up, in whole seconds; at least 1. */
  readonly harnessToolTimeoutSeconds: number
}

/** The configuration schema, with the shipped default. */
export const Config: z<Partial<Config>, Config> = z.object({
  harnessToolTimeoutSeconds: z.natural().min(1).default(900)
    .description('How long Claude Code waits for one harness tool call before it gives up, in seconds.'),
})

/**
 * Register one driver with the gate for as long as this scope lives.
 * @param ctx - the scope.
 * @param driver - the driver.
 */
function registerDriver(ctx: Context, driver: ClaudeCodeDriver): void {
  ctx.effect(() => ctx.externalAgents.registerDriver(driver), 'claude code: driver registered with the gate')
}

/**
 * Mount the driver once the gate and the subagent registry are present, registered while upstream's Claude Code
 * provider is.
 * @param ctx - the scope that loads the plugin.
 * @param config - the row's validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['externalAgents', 'subagents'], (scope) => {
    const driver = new ClaudeCodeDriver({
      sdk: () => loadPackSdk(scope.get('profileContext')?.dir),
      harnessToolTimeoutMs: () => config.harnessToolTimeoutSeconds * 1000,
    })
    let mounted: Fiber | undefined
    const follow = (): void => {
      const present = scope.subagents.getProvider('claude-code') !== undefined
      if (present === (mounted !== undefined)) return
      if (mounted === undefined) {
        mounted = scope.plugin({ name: 'delorun-agent-claude-code-registered', apply: registerDriver }, driver)
        return
      }
      // Disposal reports its own failures through the scope's logger; the provider is gone either way.
      void mounted.dispose()
      mounted = undefined
    }
    scope.on('subagent/provider-added', (provider) => { if (provider.name === PROVIDER) follow() })
    scope.on('subagent/provider-removed', (name) => { if (name === PROVIDER) follow() })
    follow()
  })
}
