/**
 * @delorun/plugin-update: the studio's update. Once the web server and the Changes gate are present, the plugin registers
 * the routes under `/delorun/update/` ([routes](./routes.ts)): check now, prepare an update and read C3's report, apply
 * it, cancel a wait, go back, forget the outcome, and stop Delorun. Every step that verifies, installs, switches, rolls
 * back or stops goes to the home process over its update channel, with the Host's token that never reaches the page;
 * a Host that no home process of an installed release runs answers `available: false` and refuses each control.
 * @module @delorun/plugin-update
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { getDelorunRuntimeVersion, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { DRAIN_TIMEOUT_DEFAULT_S, DRAIN_TIMEOUT_MAX_S, DRAIN_TIMEOUT_MIN_S } from '@delorun/contract-home-process'
import type { UpdateChannelAccess } from '@delorun/home-process'
// Types only, resolved through the workspace paths: a declared dependency would close a cycle, since bundle-local depends on this package.
// Types only, resolved through the workspace paths: a declared dependency would close a cycle, since bundle-local depends on this package.
import type {} from '@delorun/bundle-local/update-check'
import type {} from '@delorun/plugin-changes'
import { dirname } from 'node:path'
import { readUpdateResult, updateResultPath } from '@delorun/home-process'
import { UpdateChatsService } from './chats.ts'
import { clearStopped, CONTINUE_SOURCE, CONTINUE_TEXT, readStopped, stoppedPath, withStoppedLock, writeStopped } from './stopped.ts'
import type { StoppedChatState } from './wire.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { updateRoutes } from './routes.ts'
import { UPDATE_ROUTE_PREFIX } from './wire.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The one message the update sends to a chat it stopped, after the update. */
    'delorun-update': { kind: 'delorun-update' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Host's way to the home process's update channel, which `delorun start` provides; absent outside an installed release. */
    updateChannel?: UpdateChannelAccess
  }
}

/**
 * The page global upstream's boot page reads the update routes' prefix from (`dshRecoveryUpdateRoutes` in
 * `@deepseek-ai/dsh-client-web`'s boot page); without it the recovery screen offers no Roll back.
 */
export const RECOVERY_UPDATE_ROUTES_GLOBAL = 'dshRecoveryUpdateRoutes'

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
  /** Whether chats stopped for an update continue by themselves, with one message each, once the updated Host starts. Settings → Updates. */
  readonly continueStoppedChats: Volatile<boolean>
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  waitSeconds: z.natural().min(DRAIN_TIMEOUT_MIN_S).max(DRAIN_TIMEOUT_MAX_S).default(DRAIN_TIMEOUT_DEFAULT_S),
  checkGapSeconds: z.natural().min(1).max(3600).default(10),
  continueStoppedChats: z.boolean().default(true).volatile(),
})

/**
 * Register the update routes.
 * @param ctx - the plugin context.
 * @param config - the wait for running chats.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(UpdateChatsService)
  // Once chats can be opened, the updated Host continues the chats the update stopped.
  ctx.inject(['sessionController', 'sessions'], (scope) => {
    scope.effect(() => {
      void continueAfterUpdate(scope, continueSender(scope, config.waitSeconds * 1000), config.continueStoppedChats.get()).catch((error: unknown) => {
        scope.logger.warn(`the chats the update stopped were not continued: ${error instanceof Error ? error.message : String(error)}`)
      })
      return undefined
    }, 'plugin-update: continue the chats the update stopped')
  })
  ctx.inject(['webServer', 'changesGate'], (scope) => {
    const gate = scope.changesGate
    if (gate === undefined) return
    const sendContinue = continueSender(scope, config.waitSeconds * 1000)
    const routes = updateRoutes({
      chats: () => scope.get('delorunUpdateChats'),
      continueAutomatically: () => config.continueStoppedChats.get(),
      sendContinue,
      gate,
      channel: () => scope.get('updateChannel'),
      check: () => scope.get('delorunUpdateCheck'),
      checkGapMs: config.checkGapSeconds * 1000,
      waitSeconds: config.waitSeconds,
      release: () => ({ delorun: getDelorunRuntimeVersion() ?? 'unknown', dsh: getDshRuntimeVersion() ?? 'unknown' }),
      logger: scope.logger,
      now: Date.now,
      changelog: readInstalledChangelog,
    })
    scope.effect(() => {
      const registered = routes.map(route => scope.webServer.register(route))
      return () => {
        for (const off of registered) off()
      }
    }, 'plugin-update: studio routes')
    // The recovery screen, which runs without any client plugin, reads whether a rollback is on offer from these routes.
    scope.on('webserver/index-inject', (table) => { table.push({ kind: 'global', name: RECOVERY_UPDATE_ROUTES_GLOBAL, value: UPDATE_ROUTE_PREFIX }) })
  })
}

/** Where the release's changelog data sits, relative to this package's `src` or `lib` folder in the release tree. */
const CHANGELOG_URL = new URL('../../../changelog/changelog.json', import.meta.url)

/**
 * Read the installed release's `changelog.json`.
 * @returns the parsed file, or `undefined` when the release does not hold it or it is not JSON.
 */
async function readInstalledChangelog(): Promise<unknown> {
  const text = await readFile(fileURLToPath(CHANGELOG_URL), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    // A damaged file is the same as no file: the card shows no highlights.
    void error
    return undefined
  }
}

/**
 * Build the sender of the one continue message.
 * @param scope - the context holding the session controller and the sessions.
 * @param idleWaitMs - the longest wait for a chat that is still stopping to go idle.
 * @returns a function that sends the message to a chat and says how the chat stands afterwards.
 */
function continueSender(scope: Context, idleWaitMs: number): (sessionId: string) => Promise<StoppedChatState> {
  return async (sessionId) => {
    const controller = scope.get('sessionController')
    if (controller === undefined) return 'failed'
    let agent: Agent
    try {
      const resolved = await controller.resolveAgent(SessionId(sessionId))
      if ('error' in resolved) return 'skipped-missing'
      agent = resolved.agent
    } catch (error) {
      scope.logger.warn(`the chat ${sessionId} could not be opened to continue it: ${error instanceof Error ? error.message : String(error)}`)
      return 'skipped-missing'
    }
    // A cancelled turn takes a moment to end; a chat the person has started again, or that will not stop, is left to its Continue button.
    if (agent.status !== 'idle') {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, idleWaitMs) })
      await Promise.race([agent.whenIdle(), timeout])
      clearTimeout(timer)
    }
    if (agent.status !== 'idle') return 'skipped-running'
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: CONTINUE_TEXT }], source: { kind: CONTINUE_SOURCE } }))
      return (await scope.sessions.flush(agent.session)) ? 'continued' : 'failed'
    } catch (error) {
      scope.logger.warn(`the continue message to chat ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
  }
}

/**
 * Once the updated Host starts: when the chats stopped for the update are to continue by themselves, and the update
 * attempt they belong to has ended (its outcome record names the same target), send each one's continue message, once.
 * Each chat is marked before its send, under the record's lock, so a start that dies in between, or a Continue press
 * meanwhile, never sends twice. A chat that could not be continued keeps its Continue button.
 * @param scope - the context.
 * @param send - the continue sender.
 * @param automatic - whether the setting is on now.
 * @returns when every chat has been handled.
 */
export async function continueAfterUpdate(scope: Context, send: (sessionId: string) => Promise<StoppedChatState>, automatic: boolean): Promise<void> {
  const profile = scope.get('profileContext')
  if (profile === undefined) return
  const path = stoppedPath(dirname(updateResultPath(profile.home, profile.name)))
  await withStoppedLock(path, async () => {
    const record = await readStopped(path)
    if (record === undefined || !record.automatic) return
    // A record whose attempt has no outcome yet belongs to an update still running: it is not this start's to act on.
    const outcome = await readUpdateResult(updateResultPath(profile.home, profile.name)).catch(() => undefined)
    if (outcome === undefined || outcome.to !== record.to) return
    // Only an update that restarted the Host continues the chats by itself; any other end leaves each chat its Continue button.
    // The setting switched off since the stop, or any end but a restart: each chat gets its Continue button and nothing is sent.
    if (!automatic || (outcome.outcome !== 'committed' && outcome.outcome !== 'rolled-back')) {
      await writeStopped(path, { ...record, chats: record.chats.map(chat => chat.state === 'stopped' ? { ...chat, state: 'skipped-running' as const } : chat) })
      return
    }
    let chats = record.chats
    for (const chat of record.chats) {
      if (chat.state !== 'stopped') continue
      chats = chats.map(each => each.sessionId === chat.sessionId ? { ...each, state: 'continued' as const } : each)
      await writeStopped(path, { ...record, chats })
      const state = await send(chat.sessionId)
      if (state !== 'continued') chats = chats.map(each => each.sessionId === chat.sessionId ? { ...each, state } : each)
    }
    chats = chats.filter(chat => chat.state !== 'continued' && chat.state !== 'skipped-missing')
    if (chats.length === 0) await clearStopped(path)
    else await writeStopped(path, { ...record, chats })
  })
}
