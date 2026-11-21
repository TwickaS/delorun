/**
 * The studio's update routes (contract C19, "The studio's update"; contract C3, "Applying an update"). Every route
 * is built through the Changes gate, so the site fence, the device's level and its unlock are decided before a body
 * is read. The home process verifies, installs, switches and rolls back; the Host only asks it over the update channel,
 * holds the prepared report in memory and shows the page a handle for it. The answer to apply, rollback and stop comes
 * before this Host stops, as Restart's does.
 *
 * @module @delorun/plugin-update/routes
 */
import { dirname } from 'node:path'
import type { HomeStatus } from '@delorun/contract-home-process'
import type { UpdateNotice } from '@delorun/contract-update-report'
import { journalPath, readJournal, readUpdateResult, removeUpdateResult, updateResultPath, type ResponseLine, type UpdateChannelAccess } from '@delorun/home-process'
import { flag, onlyFields, RouteRefusal, type ChangesGate, type RouteHandler } from '@delorun/plugin-changes'
import { begin, finish } from './home-channel.ts'
import { notesBetween } from './notes.ts'
import type { UpdateChats } from './chats.ts'
import { clearStopped, readStopped, stoppedPath, stoppedView, withStoppedLock, writeStopped } from './stopped.ts'
import { hold, holds, isUpdateReport, missingTicks, viewOf, type HeldUpdate } from './report-view.ts'
import {
  canContinueByHand, UPDATE_PATHS,
  type ChatChoice, type ContinueChatView, type RollbackStateView, type RunningChatView, type StoppedChatState, type StopBegunView, type StopChatsView, type UpdateAccessView, type UpdateBegunView, type UpdateCancelView, type UpdateCheckedView,
  type UpdatePhaseView, type UpdateProgressView, type UpdateResultView, type UpdateStateView,
} from './wire.ts'

/** What the routes reach besides the gate. */
export interface UpdateRouteDependencies {
  readonly gate: ChangesGate
  /**
   * The home process's update channel.
   * @returns it, or undefined when no home process of an installed release runs this Host.
   */
  readonly channel: () => UpdateChannelAccess | undefined
  /**
   * The release check, when it is on.
   * @returns its state and a way to run it, or undefined while the check is off.
   */
  readonly check: () => UpdateCheckAccess | undefined
  /** The shortest time between two release checks that reach the network, in milliseconds; a request inside it gets the last answer. */
  readonly checkGapMs: number
  /** The longest wait for running chats before an update or a rollback gives up, in seconds. */
  readonly waitSeconds: number
  /** The release this Host runs. */
  readonly release: () => { readonly delorun: string, readonly dsh: string }
  /** The Host's log. */
  readonly logger: { info(message: string): void, warn(message: string): void }
  /** The time, in milliseconds since the epoch. */
  readonly now: () => number
  /** Read the installed release's `changelog.json`, parsed; `undefined` when it is absent or unreadable. */
  readonly changelog?: () => Promise<unknown>
  /** The Host's running chats; `undefined` while no Host source is attached. */
  readonly chats?: () => UpdateChats | undefined
  /** Whether stopped chats continue by themselves after an update (the setting now). */
  readonly continueAutomatically: () => boolean
  /**
   * Send the one continue message to a chat.
   * @param sessionId - the chat.
   * @returns how it stands afterwards: `continued`, `skipped-missing`, `skipped-running` or `failed`.
   */
  readonly sendContinue: (sessionId: string) => Promise<StoppedChatState>
}

/** The release check as the routes use it. */
export interface UpdateCheckAccess {
  /** What the home holds now. */
  state(): Promise<{ readonly checked?: number, readonly failed?: boolean, readonly notice?: UpdateNotice } | undefined>
  /** Run one check now. */
  checkNow(): Promise<{ readonly checked?: number, readonly failed?: boolean, readonly notice?: UpdateNotice } | undefined>
}

/** One route as the web server registers it. */
export interface UpdateRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: RouteHandler
}

/** The longest line of install progress the page keeps, and how many. */
const MAX_LINES = 40
const MAX_LINE_LENGTH = 200

const PHASES: ReadonlySet<string> = new Set(['checking', 'installing', 'reporting', 'snapshot', 'waiting', 'switching', 'health-check', 'committed', 'rolling-back'])

/**
 * @param value - a phase the home process named.
 * @returns it when it is one the page shows.
 */
function phaseOf(value: unknown): UpdatePhaseView | undefined {
  return typeof value === 'string' && PHASES.has(value) ? value as UpdatePhaseView : undefined
}

/**
 * @param body - a request body.
 * @returns how running chats are treated.
 * @throws {RouteRefusal} `400 BAD_REQUEST` unless `chats` is `wait` or `stop`.
 */
function chatsOf(body: Readonly<Record<string, unknown>>): ChatChoice {
  if (body.chats !== 'wait' && body.chats !== 'stop') throw new RouteRefusal(400, 'BAD_REQUEST', 'Say whether to wait for chats or stop them.')
  return body.chats
}

/**
 * @param value - a body field.
 * @returns the strings of a list of at most 200 strings of at most 64 characters.
 * @throws {RouteRefusal} `400 BAD_REQUEST` for anything else.
 */
function ticksOf(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 200 || value.some(entry => typeof entry !== 'string' || entry.length > 64)) throw new RouteRefusal(400, 'BAD_REQUEST', 'acknowledged is a list of the keys the report asks for.')
  return value as string[]
}

/**
 * @param home - the Delorun home.
 * @param profile - the profile's name.
 * @returns the path of the record of the chats an update stopped, beside the update result record.
 */
function stoppedFile(home: string, profile: string): string {
  return stoppedPath(dirname(updateResultPath(home, profile)))
}

/**
 * Build the update routes.
 * @param dependencies - what the routes reach.
 * @returns every route: `state` and the controls.
 */
export function updateRoutes(dependencies: UpdateRouteDependencies): readonly UpdateRoute[] {
  const { gate, channel, check, checkGapMs, waitSeconds, release, logger, now } = dependencies
  let held: HeldUpdate | undefined
  let preparing: { phase: UpdatePhaseView | undefined, readonly lines: string[] } | undefined
  let begun: 'update' | 'rollback' | undefined
  let applying = false
  let checking: Promise<UpdateCheckedView> | undefined
  let checkedAtMs: number | undefined
  let lastChecked: UpdateCheckedView | undefined

  const access = (): UpdateChannelAccess => {
    const found = channel()
    if (found === undefined) throw new RouteRefusal(409, 'UPDATE_UNAVAILABLE', 'Delorun updates itself only as an installed release started with delorun start.')
    return found
  }
  const statusOf = async (): Promise<HomeStatus> => (await finish(access(), { op: 'status' })).status as HomeStatus
  const drainOf = (chats: ChatChoice): { readonly wait: 'drain' | 'cancel', readonly drainTimeoutS: number } => ({ wait: chats === 'wait' ? 'drain' : 'cancel', drainTimeoutS: waitSeconds })
  const actorOf = (presence: { readonly device?: { readonly id: string } }): string => presence.device === undefined ? 'the computer' : `device ${presence.device.id}`
  const watch = (what: string, done: Promise<ResponseLine[]>): void => {
    done.then((lines) => {
      // The exchange ended with this Host still running: the update or rollback failed, was cancelled or went back.
      if (what !== 'stop') begun = undefined
      const last = lines.at(-1)
      logger.info(`${what} ended: ${JSON.stringify({ outcome: last?.outcome, reason: last?.reason, criterion: last?.criterion })}`)
    }, () => { logger.info(`${what}: the channel closed before the home process's last line, as it does when the Host stops`) })
  }

  const stateRoute = gate.get(async (ctx, accessView) => {
    const may = accessView.may
    const view: UpdateAccessView = {
      actor: accessView.actor,
      may: { 'update-check': may['update-check'], 'update-begin': may['update-begin'], 'update-cancel': may['update-cancel'], 'update-rollback': may['update-rollback'], 'update-dismiss': may['update-dismiss'], 'update-continue': may['update-continue'], stop: may.stop },
    }
    const channelOpen = channel()
    const checked = await check()?.state()
    const checkView: UpdateCheckedView = {
      enabled: check() !== undefined,
      ...checked?.checked === undefined ? {} : { checkedAt: checked.checked },
      ...checked?.failed === undefined ? {} : { failed: checked.failed },
      ...checked?.notice === undefined ? {} : { notice: checked.notice },
    }
    let progress: UpdateProgressView = preparing === undefined ? { kind: 'idle' } : { kind: 'preparing', ...preparing.phase === undefined ? {} : { phase: preparing.phase }, lines: [...preparing.lines] }
    let chats = 0
    if (channelOpen !== undefined) {
      const status = await statusOf().then(answer => answer, () => undefined)
      chats = status?.chats ?? 0
      if (status?.update !== undefined && preparing === undefined) {
        const phase = status.update.phase
        const kind = begun === 'rollback' || phase === 'rolling-back' ? 'rolling-back' : 'applying'
        progress = ['checking', 'installing', 'reporting'].includes(phase) && begun === undefined
          ? { kind: 'preparing', phase, lines: [] }
          : { kind, phase, target: status.update.target, runningChats: chats }
      }
    }
    const resultRecord = await readUpdateResult(updateResultPath(ctx.home, ctx.profile))
    const result: UpdateResultView | undefined = resultRecord === undefined ? undefined : {
      kind: resultRecord.kind, outcome: resultRecord.outcome, from: resultRecord.from, to: resultRecord.to, at: resultRecord.at,
      ...resultRecord.reason === undefined ? {} : { reason: resultRecord.reason },
      ...resultRecord.criterion === undefined ? {} : { criterion: resultRecord.criterion },
      ...resultRecord.rowChanges === undefined ? {} : { rowChanges: resultRecord.rowChanges },
    }
    const notes = result?.kind === 'update' && result.outcome === 'committed' && dependencies.changelog !== undefined
      ? notesBetween(await dependencies.changelog().catch(() => undefined), result.from, result.to)
      : undefined
    const stoppedRecord = await readStopped(stoppedFile(ctx.home, ctx.profile))
    const mayBegin = may['update-begin'].ok
    // An attempt that ended without a restart (cancelled, or stopped waiting for chats) leaves its chats to continue now, not at a later start.
    if (stoppedRecord?.automatic === true && progress.kind === 'idle' && begun === undefined && result !== undefined && result.to === stoppedRecord.to
      && (result.outcome === 'aborted' || result.outcome === 'failed') && stoppedRecord.chats.some(chat => chat.state === 'stopped')) {
      settleStopped(stoppedFile(ctx.home, ctx.profile)).catch((error: unknown) => { logger.warn(`the chats the update stopped were not continued: ${error instanceof Error ? error.message : String(error)}`) })
    }
    const stopped = stoppedRecord === undefined ? undefined : stoppedView(mayBegin ? stoppedRecord : { ...stoppedRecord, chats: stoppedRecord.chats.map(chat => ({ ...chat, title: '' })) })
    const runningChats = mayBegin && progress.kind === 'applying' && progress.phase === 'waiting' ? dependencies.chats?.()?.list() : undefined
    const journal = await readJournal(journalPath(ctx.home, ctx.profile)).catch(() => undefined)
    const running = release()
    const rollback: RollbackStateView = journal?.phase === 'committed' && journal.to === running.delorun && channelOpen !== undefined
      ? { available: true, to: journal.from, ...journal.dataDiffers && !journal.copy ? { dataCopyMissing: true } : {} }
      : { available: false }
    // The report names plugins and harness diffs: only a request that may begin an update reads it.
    const prepared = may['update-begin'].ok && held !== undefined && held.expiresAt > now()
      ? viewOf(held, running.delorun, checked?.notice?.release.delorun === held.report.to.delorun ? checked.notice.release.summary : undefined, chats)
      : undefined
    const answer: UpdateStateView = {
      release: running, available: channelOpen !== undefined, access: view, check: checkView, progress, rollback,
      ...prepared === undefined ? {} : { prepared },
      ...result === undefined ? {} : { result },
      ...notes === undefined ? {} : { notes },
      ...stopped === undefined ? {} : { stopped },
      ...runningChats === undefined ? {} : { runningChats, runningJobs: dependencies.chats?.()?.jobs() ?? 0 },
      continueStopped: dependencies.continueAutomatically(),
    }
    return answer
  })

  /**
   * Act on the record of stopped chats once their update attempt has ended without a Host restart: with the setting on
   * when they were stopped, each chat gets its continue message (after it has gone idle) and leaves the record; a chat
   * that could not be continued stays in it for its Continue button. With the setting off the record stays whole.
   * @param path - the record's path.
   */
  const settleStopped = (path: string): Promise<void> => withStoppedLock(path, async () => {
    const record = await readStopped(path)
    if (record === undefined || !record.automatic) return
    let chats = record.chats
    for (const chat of record.chats) {
      if (chat.state !== 'stopped') continue
      chats = chats.map(each => each.sessionId === chat.sessionId ? { ...each, state: 'continued' as const } : each)
      await writeStopped(path, { ...record, chats })
      const state = await dependencies.sendContinue(chat.sessionId)
      if (state !== 'continued') chats = chats.map(each => each.sessionId === chat.sessionId ? { ...each, state } : each)
    }
    // A chat that no longer exists is gone; a chat still running or not continued keeps its Continue button.
    chats = chats.filter(chat => chat.state !== 'continued' && chat.state !== 'skipped-missing')
    if (chats.length === 0) await clearStopped(path)
    else await writeStopped(path, { ...record, chats })
  })

  const checkRoute = gate.open(async (body) => {
    onlyFields(body, [])
    const service = check()
    if (service === undefined) throw new RouteRefusal(409, 'UPDATE_UNAVAILABLE', 'The release check is off. Turn it on in Settings → General → Updates.')
    if (checking !== undefined) return checking
    if (lastChecked !== undefined && checkedAtMs !== undefined && now() - checkedAtMs < checkGapMs) return lastChecked
    checkedAtMs = now()
    checking = service.checkNow().then((state) => {
      const answer: UpdateCheckedView = {
        enabled: true,
        ...state?.checked === undefined ? {} : { checkedAt: state.checked },
        ...state?.failed === undefined ? {} : { failed: state.failed },
        ...state?.notice === undefined ? {} : { notice: state.notice },
      }
      lastChecked = answer
      return answer
    }).finally(() => { checking = undefined })
    return checking
  })

  const prepareRoute = gate.post('update-begin', async (body, _ctx, presence) => {
    onlyFields(body, [])
    const home = access()
    if (preparing !== undefined) throw new RouteRefusal(409, 'UPDATE_IN_PROGRESS', 'Delorun is already preparing an update.')
    const lines: string[] = []
    preparing = { phase: undefined, lines }
    logger.info(`update prepare asked from ${actorOf(presence)}`)
    try {
      const last = await finish(home, { op: 'update.prepare', args: {} }, (line) => {
        const phase = phaseOf(line.phase)
        if (phase !== undefined && preparing !== undefined) preparing.phase = phase
        if (typeof line.line === 'string') {
          lines.push(line.line.replace(/\s+$/u, '').slice(0, MAX_LINE_LENGTH))
          if (lines.length > MAX_LINES) lines.shift()
        }
      })
      if (typeof last.reportId !== 'string' || !isUpdateReport(last.report)) throw new RouteRefusal(502, 'UPDATE_FAILED', 'The home process answered with a report this Host does not read.')
      held = hold(last.reportId, last.report, now())
      const status = await statusOf().then(answer => answer, () => undefined)
      return { prepared: viewOf(held, release().delorun, undefined, status?.chats ?? 0) }
    } finally {
      preparing = undefined
    }
  })

  const applyRoute = gate.post('update-begin', async (body, _ctx, presence): Promise<UpdateBegunView> => {
    onlyFields(body, ['handle', 'chats', 'dataCopy', 'acknowledged'])
    const home = access()
    if (applying) throw new RouteRefusal(409, 'UPDATE_IN_PROGRESS', 'An update is already starting from another request.')
    const chats = chatsOf(body)
    const dataCopy = flag(body, 'dataCopy', true)
    const acknowledged = ticksOf(body.acknowledged ?? [])
    if (!holds(held, body.handle, now())) throw new RouteRefusal(409, 'REPORT_EXPIRED', 'The report is older than ten minutes, or this Delorun never showed it. Check what the update changes again.')
    const update = held
    if (update.confirm.blocked !== undefined) throw new RouteRefusal(409, 'REPORT_BLOCKED', update.confirm.blocked === 'harness-conflict' ? 'A change you made to Delorun itself conflicts with the new release, so it cannot update here.' : 'The release log check failed, so Delorun does not update to this release.')
    const missing = missingTicks(update, acknowledged, dataCopy)
    if (missing.length > 0) throw new RouteRefusal(409, 'ACKNOWLEDGEMENT_MISSING', 'The report holds changes you have not accepted.', { missing })
    applying = true
    let started: Awaited<ReturnType<typeof begin>>
    let status: HomeStatus | undefined
    try {
      status = await statusOf().then(answer => answer, () => undefined)
      logger.info(`update to ${update.report.to.delorun} begun from ${actorOf(presence)}`)
      started = await begin(home, { op: 'update.apply', args: { reportId: update.reportId, ...drainOf(chats), dataCopy } })
    } finally {
      applying = false
    }
    held = undefined
    begun = 'update'
    watch('update', started.done)
    return { kind: 'update-begun', target: update.report.to.delorun, runningChats: status?.chats ?? 0 }
  })

  const cancelRoute = gate.post('update-cancel', async (body, ctx): Promise<UpdateCancelView> => {
    onlyFields(body, [])
    const status = await statusOf()
    const waiting = status.update !== undefined
    await finish(access(), { op: 'update.cancel' })
    // The Host stays up, so the chats the update stopped cannot wait for a later start: settle them now.
    if (waiting) await settleStopped(stoppedFile(ctx.home, ctx.profile))
    return { cancelled: waiting }
  })

  const rollbackRoute = gate.post('update-rollback', async (body, ctx, presence): Promise<UpdateBegunView> => {
    onlyFields(body, ['chats', 'profileOnly'])
    const home = access()
    const chats = chatsOf(body)
    const profileOnly = flag(body, 'profileOnly', false)
    const journal = await readJournal(journalPath(ctx.home, ctx.profile)).catch(() => undefined)
    const status = await statusOf().then(answer => answer, () => undefined)
    logger.info(`rollback begun from ${actorOf(presence)}`)
    const started = await begin(home, { op: 'rollback', args: { ...drainOf(chats), profileOnly } })
    begun = 'rollback'
    watch('rollback', started.done)
    return { kind: 'rollback-begun', target: journal?.from ?? '', runningChats: status?.chats ?? 0 }
  })

  const dismissRoute = gate.post('update-dismiss', async (body, ctx) => {
    onlyFields(body, [])
    await removeUpdateResult(updateResultPath(ctx.home, ctx.profile))
    const path = stoppedFile(ctx.home, ctx.profile)
    await withStoppedLock(path, () => clearStopped(path))
    return {}
  })

  // Class `update-begin`: ending running chats is what lets the update go on, so it needs what beginning the update needs.
  const stopChatsRoute = gate.post('update-begin', async (body, ctx, presence): Promise<StopChatsView> => {
    onlyFields(body, [])
    access()
    const path = stoppedFile(ctx.home, ctx.profile)
    const stopped = await withStoppedLock(path, async (): Promise<readonly RunningChatView[]> => {
      const status = await statusOf()
      if (status.update === undefined || status.update.phase !== 'waiting' || begun === 'rollback') {
        throw new RouteRefusal(409, 'NO_UPDATE_PENDING', 'No update is waiting for chats, so there is nothing to stop.')
      }
      const source = dependencies.chats?.()
      const chats = source?.list() ?? []
      logger.info(`stop of ${String(chats.length)} running chat(s) for the update asked from ${actorOf(presence)}`)
      if (source === undefined || chats.length === 0) return []
      // Recorded before anything is cancelled: the update restarts the Host, and a stop that left no record would lose the chats.
      const before = await readStopped(path)
      const kept = (before?.chats ?? []).filter(chat => !chats.some(running => running.sessionId === chat.sessionId))
      await writeStopped(path, {
        v: 1, to: status.update.target, automatic: dependencies.continueAutomatically(), at: new Date().toISOString(),
        chats: [...kept, ...chats.map(chat => ({ ...chat, state: 'stopped' as const }))],
      })
      await source.cancelAll()
      return chats
    })
    // A cancel that landed while the chats were being recorded ended the update first: settle them now.
    if (stopped.length > 0 && (await statusOf().then(answer => answer, () => undefined))?.update === undefined) await settleStopped(path)
    return { chats: stopped }
  })

  // Class `update-continue` (free): it sends one fixed message to a chat the update itself stopped, at most once per chat.
  const continueChatRoute = gate.post('update-continue', async (body, ctx): Promise<ContinueChatView> => {
    onlyFields(body, ['sessionId'])
    if (typeof body.sessionId !== 'string' || body.sessionId.length > 200) throw new RouteRefusal(400, 'BAD_REQUEST', 'sessionId names a chat the update stopped.')
    const sessionId = body.sessionId
    const path = stoppedFile(ctx.home, ctx.profile)
    // The chats are still being stopped, and a new turn is refused while the update waits or applies.
    if (begun !== undefined || preparing !== undefined || applying) throw new RouteRefusal(409, 'UPDATE_IN_PROGRESS', 'The update is still running. Continue the chat once it has ended.')
    // Fails closed: a status that cannot be read is not "no update".
    const status = await statusOf().then(answer => answer, () => undefined)
    if (status === undefined) throw new RouteRefusal(409, 'CHANNEL_UNREACHABLE', 'Delorun could not tell whether the update has ended. Try again in a moment.')
    if (status.update !== undefined) throw new RouteRefusal(409, 'UPDATE_IN_PROGRESS', 'The update is still running. Continue the chat once it has ended.')
    const change = (state: StoppedChatState) => async (): Promise<boolean> => {
      const record = await readStopped(path)
      const entry = record?.chats.find(chat => chat.sessionId === sessionId)
      if (record === undefined || entry === undefined || !canContinueByHand(record.automatic, entry.state)) return false
      await writeStopped(path, { ...record, chats: record.chats.map(chat => chat.sessionId === sessionId ? { ...chat, state } : chat) })
      return true
    }
    // Marked before the send, under the record's lock: a second press, or the start's own continuation, finds it taken.
    if (!await withStoppedLock(path, change('continued'))) throw new RouteRefusal(409, 'NOT_STOPPED_BY_UPDATE', 'The update did not stop this chat, it continues by itself, or it was already continued.')
    const state = await dependencies.sendContinue(sessionId)
    if (state !== 'continued') {
      await withStoppedLock(path, async () => {
        const record = await readStopped(path)
        if (record !== undefined) await writeStopped(path, { ...record, chats: record.chats.map(chat => chat.sessionId === sessionId ? { ...chat, state } : chat) })
      })
    }
    return { state }
  })

  const stopRoute = gate.post('stop', async (body, _ctx, presence): Promise<StopBegunView> => {
    onlyFields(body, ['chats'])
    const home = access()
    const chats = chatsOf(body)
    const status = await statusOf().then(answer => answer, () => undefined)
    logger.info(`stop asked from ${actorOf(presence)}`)
    const started = await begin(home, { op: 'stop', args: { mode: chats === 'wait' ? 'drain' : 'cancel' } })
    watch('stop', started.done)
    return { kind: 'stopping', runningChats: status?.chats ?? 0 }
  })

  return [
    { kind: 'exact', path: UPDATE_PATHS.state, handler: stateRoute },
    { kind: 'exact', path: UPDATE_PATHS.check, handler: checkRoute },
    { kind: 'exact', path: UPDATE_PATHS.prepare, handler: prepareRoute },
    { kind: 'exact', path: UPDATE_PATHS.apply, handler: applyRoute },
    { kind: 'exact', path: UPDATE_PATHS.cancel, handler: cancelRoute },
    { kind: 'exact', path: UPDATE_PATHS.rollback, handler: rollbackRoute },
    { kind: 'exact', path: UPDATE_PATHS.dismiss, handler: dismissRoute },
    { kind: 'exact', path: UPDATE_PATHS.stop, handler: stopRoute },
    { kind: 'exact', path: UPDATE_PATHS.stopChats, handler: stopChatsRoute },
    { kind: 'exact', path: UPDATE_PATHS.continueChat, handler: continueChatRoute },
  ]
}
