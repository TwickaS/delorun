/**
 * @delorun/agent-codex: Delorun's driver for Codex as a live external agent. It runs the pinned Codex app-server from
 * upstream's Codex pack as a seat's program through the start gate's spawn, maps its stream to program events, relays
 * its questions, and reads plan limits.
 *
 * The plugin ships dormant (L21): it registers the driver with the gate only while upstream's subagent provider
 * `codex` is registered, which is while the Codex pack is added, and withdraws it when the provider leaves.
 * @module @delorun/agent-codex
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import type {} from '@delorun/external-agents'
import { CodexDriver, codexLocator } from './driver.ts'

export { CodexDriver, appServerArgv, codexLocator, type CodexDriverOptions } from './driver.ts'
export { CodexSession, CodexSessionClosedError, CodexTurnRunningError, type CodexClosedReason } from './session.ts'
export { TESTED_CODEX_VERSION } from './protocol.ts'
export type { WireTap } from './rpc.ts'

/** The driver's configuration. */
export interface Config {
  /** How long one request may wait for Codex's answer, in whole seconds; a fresh thread can take 30 s. At least 1. */
  readonly requestTimeoutSeconds: number
  /** How long the app-server gets to exit after its input ends before it is terminated, in whole seconds; at least 1. */
  readonly closeWaitSeconds: number
}

/** The configuration schema, with the shipped defaults. */
export const Config: z<Partial<Config>, Config> = z.object({
  requestTimeoutSeconds: z.natural().min(1).default(120),
  closeWaitSeconds: z.natural().min(1).default(5),
})

/** Services wait in {@link apply}: the plugin loads in a profile with neither the gate nor the Codex pack. */
export const inject = []

/**
 * Register the Codex driver with the gate while upstream's `codex` provider is registered.
 * @param ctx - the scope that loads the plugin.
 * @param config - the row's validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['externalAgents', 'subagents', 'profileContext'], (scope) => {
    const profile: ProfileContext = scope.profileContext
    const driver = new CodexDriver({
      locate: codexLocator(profile.dir),
      requestTimeoutMs: config.requestTimeoutSeconds * 1_000,
      closeWaitMs: config.closeWaitSeconds * 1_000,
    })
    let registration: (() => void) | undefined
    const follow = (): void => {
      const present = scope.subagents.getProvider('codex') !== undefined
      if (present && registration === undefined) {
        registration = scope.externalAgents.registerDriver(driver)
      } else if (!present && registration !== undefined) {
        registration()
        registration = undefined
      }
    }
    scope.on('subagent/provider-added', follow)
    scope.on('subagent/provider-removed', follow)
    scope.effect(() => {
      follow()
      return () => {
        registration?.()
        registration = undefined
      }
    }, 'agent-codex: driver registration')
  })
}
