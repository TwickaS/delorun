/**
 * The studio's Restart (contract C21, "Routes and the recovery screen"; contract C19, "The restart"): the routes that
 * restart Delorun on the release it runs, so the changes to Delorun itself that wait for a restart run, and the
 * `restart` part of `state`. Both routes are built with {@link decidingRoute} for the control `restart`, so they have
 * Apply's fence and level: a request from another site is refused before anything else, a paired device needs a grant
 * for the call (a PIN grant where it holds no passkey), and only then is the body read. The restart itself is the home
 * process's (the `changesRestart` service): it waits for running chats, or cancels them with `stopChats`, starts a new
 * Host and keeps this one when the new one fails. The answer comes before this Host stops.
 *
 * @module @delorun/plugin-changes/restart-route
 */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { harnessDrift, type ChangesRestartHost, type HarnessContext } from '@delorun/changes'
import { decidingRoute, flag, onlyFields, RouteRefusal, type ChangesRoute, type RouteDependencies } from './routes.ts'
import { RESTART_IN_PROGRESS, RESTART_PATHS, RESTART_UNAVAILABLE, UPDATE_IN_PROGRESS, type RestartBegunView, type RestartCancelView, type RestartStateView } from './wire.ts'

/** What the restart routes reach besides the shared route dependencies. */
export interface RestartRouteDependencies {
  /**
   * The home process's restart.
   * @returns it, or undefined when no home process of an installed release runs this Host.
   */
  readonly restart: () => ChangesRestartHost | undefined
  /** The longest wait for running chats before a restart gives up, in seconds. */
  readonly waitSeconds: number
}

/** The home process's refusals a restart answers, by code. */
const REFUSALS: Readonly<Record<string, { readonly code: string, readonly sentence: string }>> = {
  RESTART_IN_PROGRESS: { code: RESTART_IN_PROGRESS, sentence: 'Delorun is already restarting.' },
  UPDATE_IN_PROGRESS: { code: UPDATE_IN_PROGRESS, sentence: 'An update of Delorun is running; restart once it has ended.' },
  NO_RUNTIME_STORE: { code: RESTART_UNAVAILABLE, sentence: 'Delorun restarts itself only as an installed release started with delorun start.' },
}

/**
 * @param restart - the home process's restart.
 * @returns it.
 * @throws {RouteRefusal} `409 RESTART_UNAVAILABLE` when this Host has none.
 */
function restartOf(restart: ChangesRestartHost | undefined): ChangesRestartHost {
  if (restart === undefined) throw new RouteRefusal(409, RESTART_UNAVAILABLE, REFUSALS.NO_RUNTIME_STORE!.sentence)
  return restart
}

/**
 * Begin a restart and answer the chats it waits for.
 * @param body - `{ stopChats? }`.
 * @param restart - the home process's restart.
 * @param waitSeconds - the longest wait for running chats.
 * @returns the answer.
 * @throws {RouteRefusal} `409 RESTART_IN_PROGRESS`, `409 UPDATE_IN_PROGRESS` or `409 RESTART_UNAVAILABLE`, before anything changed.
 */
async function beginRestart(body: Readonly<Record<string, unknown>>, restart: ChangesRestartHost | undefined, waitSeconds: number): Promise<RestartBegunView> {
  onlyFields(body, ['stopChats'])
  const stopChats = flag(body, 'stopChats', false)
  const host = restartOf(restart)
  try {
    const { runningChats } = await host.begin({ stopChats, drainTimeoutS: waitSeconds })
    return { kind: 'restarting', runningChats }
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    const refusal = code === undefined ? undefined : REFUSALS[code]
    if (refusal !== undefined) throw new RouteRefusal(409, refusal.code, refusal.sentence)
    throw error
  }
}

/**
 * The Restart routes.
 * @param dependencies - what the routes reach.
 * @param restart - the home process's restart and the wait for running chats.
 * @returns `restart` and `restart-cancel`.
 */
export function restartRoutes(dependencies: RouteDependencies, restart: RestartRouteDependencies): readonly ChangesRoute[] {
  return [
    { kind: 'exact', path: RESTART_PATHS.restart, handler: decidingRoute('restart', dependencies, body => beginRestart(body, restart.restart(), restart.waitSeconds)) },
    {
      kind: 'exact',
      path: RESTART_PATHS.cancel,
      handler: decidingRoute('restart', dependencies, async (body): Promise<RestartCancelView> => {
        onlyFields(body, [])
        return { cancelled: await restartOf(restart.restart()).cancel() }
      }),
    },
  ]
}

/**
 * The `restart` part of `state`: the restart under way or the last one's failure, or whether the changes to Delorun
 * itself the records hold differ from what this Host runs in a file that is not live.
 * @param restart - the home process's restart, or undefined.
 * @param harness - the running runtime's harness, or undefined.
 * @returns the view, or undefined when nothing waits for a restart or this Host cannot change Delorun's own files.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the harness's record or log is not one Delorun wrote.
 */
export async function restartStateOf(restart: ChangesRestartHost | undefined, harness: HarnessContext | undefined): Promise<RestartStateView | undefined> {
  if (restart === undefined || harness === undefined) return undefined
  const view = restart.view()
  switch (view.kind) {
    case 'restarting':
      return { kind: 'restarting', since: view.since, phase: view.phase, runningChats: view.runningChats }
    case 'failed':
      return { kind: 'failed', at: view.at, failure: view.failure, reason: view.reason, ...view.leftOut === undefined ? {} : { leftOut: { id: view.leftOut.id, file: view.leftOut.file } } }
    case 'idle': {
      const drift = await harnessDrift(harness.home, harness.runtime, restart.running)
      if (!drift.unknown && drift.restart.length === 0) return undefined
      return { kind: 'needed', changes: Math.max(drift.restart.length, 1), runningChats: restart.runningChats(), available: true }
    }
    default:
      return assertNever(view)
  }
}
