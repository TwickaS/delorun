/**
 * @delorun/plugin-update: the studio's update. Once the web server and the Changes gate are present, the plugin registers
 * the routes under `/delorun/update/` ([routes](./routes.ts)): check now, prepare an update and read C3's report, apply
 * it, cancel a wait, go back, forget the outcome, and stop Delorun. Every step that verifies, installs, switches, rolls
 * back or stops goes to the home process over its update channel, with the Host's token that never reaches the page;
 * a Host that no home process of an installed release runs answers `available: false` and refuses each control.
 * @module @delorun/plugin-update
 */
import type { Context } from '@deepseek-ai/cordis'
import { getDelorunRuntimeVersion, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { DRAIN_TIMEOUT_DEFAULT_S, DRAIN_TIMEOUT_MAX_S, DRAIN_TIMEOUT_MIN_S } from '@delorun/contract-home-process'
import type { UpdateChannelAccess } from '@delorun/home-process'
// Types only, resolved through the workspace paths: a declared dependency would close a cycle, since bundle-local depends on this package.
import type {} from '@delorun/bundle-local/update-check'
import type {} from '@delorun/plugin-changes'
import { updateRoutes } from './routes.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Host's way to the home process's update channel, which `delorun start` provides; absent outside an installed release. */
    updateChannel?: UpdateChannelAccess
  }
}

/** The plugin's name in the loader's diagnostics. */
export const name = 'plugin-update'

/** The plugin's configuration. */
export interface Config {
  /**
   * How long an update or a rollback from the studio waits for running chats before it gives up and keeps Delorun
   * running as it is, in seconds. New turns are refused while it waits.
   */
  readonly waitSeconds: number
  /** The shortest time between two release checks that reach the network, in seconds. Requests inside it, and while one check runs, get that check's answer. */
  readonly checkGapSeconds: number
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  waitSeconds: z.natural().min(DRAIN_TIMEOUT_MIN_S).max(DRAIN_TIMEOUT_MAX_S).default(DRAIN_TIMEOUT_DEFAULT_S),
  checkGapSeconds: z.natural().min(1).max(3600).default(10),
})

/**
 * Register the update routes.
 * @param ctx - the plugin context.
 * @param config - the wait for running chats.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['webServer', 'changesGate'], (scope) => {
    const gate = scope.changesGate
    if (gate === undefined) return
    const routes = updateRoutes({
      gate,
      channel: () => scope.get('updateChannel'),
      check: () => scope.get('delorunUpdateCheck'),
      checkGapMs: config.checkGapSeconds * 1000,
      waitSeconds: config.waitSeconds,
      release: () => ({ delorun: getDelorunRuntimeVersion() ?? 'unknown', dsh: getDshRuntimeVersion() ?? 'unknown' }),
      logger: scope.logger,
      now: Date.now,
    })
    scope.effect(() => {
      const registered = routes.map(route => scope.webServer.register(route))
      return () => {
        for (const off of registered) off()
      }
    }, 'plugin-update: studio routes')
  })
}
