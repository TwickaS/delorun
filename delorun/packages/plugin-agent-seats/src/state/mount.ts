/**
 * Mounts the seat's logged state, its `agentSeat` projection, the model picks and the Host routes, and gives the
 * adapter the ports it takes: {@link SeatStateStore}, {@link SeatModelChoices} and {@link SeatAdapterEvents}.
 * @module @delorun/plugin-agent-seats/state/mount
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the ctx.sessionProjections merge.
import type {} from '@deepseek-ai/dsh-session-projection'
import { join } from 'node:path'
import type { SeatAdapterEvents, SeatModelChoices } from '../adapter/state-port.ts'
import type { SeatRun } from '../adapter/run.ts'
import type { CallRecordLedger } from '../executor/ledger.ts'
import type { SeatPrograms } from '../executor/types.ts'
import { loadModelChoices, MODEL_CHOICES_FILE } from './choices.ts'
import { partingNotice, programFailedNotice, unresumableNotice, type ProgramTailReader } from './parting.ts'
import { agentSeatProjection } from './projection.ts'
import { chooseModelRoute, resumeRoute, type SeatRoute } from './routes.ts'
import { SeatRecords, type AccountFigures, type SeatSessions, type StatusChange } from './store.ts'
import { seatPrograms } from './programs.ts'
import type { SeatAgent, SeatViewState } from './view.ts'

const NAMES: Readonly<Record<SeatAgent, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' }

/** What {@link mountSeatState} takes from the rest of the plugin. */
export interface SeatStateOptions {
  /** Where a seat child's Session is found; `ctx.sessions`. */
  readonly sessions: SeatSessions
  /**
   * The live seat of a child, over every seat route's adapter.
   * @param child - the seat child.
   * @returns the live seat, or undefined when no program session is open.
   */
  runOf(child: SessionId): SeatRun | undefined
  /**
   * The workspace key a child's model pick is kept under.
   * @param child - the seat child.
   * @returns the key, or undefined.
   */
  workspaceOf(child: SessionId): string | undefined
  /**
   * The workspace key of a child whose Session is not loaded, read from its stored header without loading it.
   * @param child - the seat child.
   * @returns the key, or undefined when the child has no stored Session.
   */
  coldWorkspaceOf?(child: SessionId): Promise<string | undefined>
  /** Delorun's own folder; the model picks are kept in a file in it. */
  readonly dir: string
  /** Reads a program session's newest message id for parting detection; absent switches the comparison off. */
  readonly tail?: ProgramTailReader
  /**
   * What the chat shows about the program.
   * @param agent - the agent.
   * @returns the program's version and a short name for its own settings, when known.
   */
  info?(agent: SeatAgent): { readonly version?: string, readonly ownSettings?: string }
  /**
   * The plan and limit figures the chat shows, read when a program starts and when a turn ends.
   * @param agent - the agent.
   * @returns the figures known for the agent's account; an unknown one is absent.
   */
  account?(agent: SeatAgent): Promise<AccountFigures>
  /** The clock, in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number
  /** Where a failure that cannot reach the person is reported. */
  readonly warn: (message: string) => void
}

/** The mounted seat state. */
export interface SeatStateMount {
  /** The seat children's logged state, for the adapter's `states` and for the relay and the chat. */
  readonly store: SeatRecords
  /** The model picks, for the adapter's `models`. */
  readonly choices: SeatModelChoices
  /** What the adapter reports; pass it as the adapter's `events`. */
  readonly events: SeatAdapterEvents
  /** The `seatPrograms` service the executor injects; also provided on `ctx`. */
  readonly programs: SeatPrograms
  /** The Host routes, for the entry to register behind its guards. */
  readonly routes: readonly SeatRoute[]
  /**
   * Stop a seat child's running program turn. A `closed` outcome means the program's process was closed to stop it, and
   * the next message resumes the program's session.
   * @param child - the seat child.
   * @returns `none` when no program is open, otherwise how the program stopped.
   */
  stop(child: SessionId): Promise<'none' | 'interrupted' | 'closed'>
  /**
   * Log that a seat has ended (archived, revoked or its program gone).
   * @param child - the seat child.
   * @param reason - the plain-words reason the chat shows.
   */
  end(child: SessionId, reason: string): void
  /**
   * Log whether a question of the agent waits.
   * @param child - the seat child.
   * @param since - when it began to wait, epoch milliseconds; undefined when none waits.
   */
  setPending(child: SessionId, since: number | undefined): void
  /** The ledger of call records the executor wrote; the relay waits on it. */
  readonly records: CallRecordLedger
  /** @returns resolves once every model pick so far is on disk. */
  settled(): Promise<void>
}

/**
 * Mount the seat's state in the calling plugin: register the `agentSeat` projection, read the model picks, follow turn
 * ends to remember the program's last message, and provide `seatPrograms`.
 * @param ctx - the plugin context with `sessionProjections`.
 * @param options - the ports.
 * @returns the mounted state.
 */
export async function mountSeatState(ctx: Context, options: SeatStateOptions): Promise<SeatStateMount> {
  const handle = await ctx.sessionProjections.register(agentSeatProjection())
  const store = new SeatRecords(options.sessions, handle)
  const choices = await loadModelChoices(join(options.dir, MODEL_CHOICES_FILE), (error) => {
    options.warn(`the model pick could not be saved: ${String(error)}`)
  })
  const programs = seatPrograms(child => options.runOf(child))
  ctx.effect(() => ctx.provide('seatPrograms', programs), 'delorun-agent-seats: seatPrograms')
  const now = options.now ?? Date.now
  // Children whose program is being resumed, not started, so the parting check runs once the program answers.
  const resuming = new Set<SessionId>()
  // The state each child showed when its start began, put back when the start ends without a program.
  const before = new Map<SessionId, { readonly state: SeatViewState, readonly change: StatusChange }>()
  const nameOf = (child: SessionId): string => NAMES[store.viewOf(child)?.agent ?? 'claude-code']

  const check = async (child: SessionId, agent: SeatAgent, programSessionId: string, stored: string | undefined): Promise<void> => {
    if (options.tail === undefined) return
    const notice = partingNotice(stored, await options.tail(agent, programSessionId), NAMES[agent])
    if (notice !== undefined) store.notice(child, notice.kind, notice.text)
  }

  // The figures arrive after the status record that starts or ends a turn, as one more record of the same state.
  const showAccount = (child: SessionId): void => {
    const agent = store.viewOf(child)?.agent
    if (agent === undefined || options.account === undefined) return
    options.account(agent).then((figures) => { store.setAccount(child, figures) }).catch((error: unknown) => {
      options.warn(`the account figures of ${child} were not shown: ${String(error)}`)
    })
  }

  const events: SeatAdapterEvents = {
    onStarting: (child, provider) => {
      const view = store.viewOf(child)
      if (view !== null && view.state !== 'starting') {
        before.set(child, {
          state: view.state,
          change: {
            ...view.resetAt === undefined ? {} : { resetAt: view.resetAt },
            ...view.endedReason === undefined ? {} : { endedReason: view.endedReason },
            ...view.modelPicker === undefined ? {} : { modelPicker: view.modelPicker },
          },
        })
      }
      if (store.read(child)?.programSessionId !== undefined) resuming.add(child)
      store.setStatus(child, 'starting', options.info?.(provider) ?? {})
      showAccount(child)
    },
    onStarted: (child, { sandboxUnavailable }) => {
      before.delete(child)
      store.setStatus(child, 'working', sandboxUnavailable ? { sandboxUnavailable } : {})
      if (!resuming.delete(child)) return
      const view = store.viewOf(child)
      const { programSessionId, programMessageId } = store.stateOf(child).logged
      if (view === null || programSessionId === null) return
      check(child, view.agent, programSessionId, programMessageId ?? undefined).catch((error: unknown) => {
        options.warn(`the parting check of ${child} failed: ${String(error)}`)
      })
    },
    onStartFailed: (child) => {
      resuming.delete(child)
      const previous = before.get(child)
      before.delete(child)
      // A failure the chat shows, such as a plan limit, sets its own state next.
      if (store.viewOf(child)?.state === 'starting') store.setStatus(child, previous?.state ?? 'idle', previous?.change)
    },
    onModelNotOffered: ({ child, configured, offered }) => {
      resuming.delete(child)
      const planDefault = offered.find(model => model.isDefault)?.id ?? offered[0]?.id ?? configured
      store.setStatus(child, 'model-needed', { modelPicker: { offered: offered.map(model => ({ id: model.id, label: model.displayName })), planDefault } })
    },
    onTurnFailure: (child, failure, stage) => {
      resuming.delete(child)
      switch (failure.category) {
        case 'limit':
          store.setStatus(child, 'limit', failure.resetsAt === undefined ? {} : { resetAt: failure.resetsAt })
          break
        case 'signed-out':
          store.setStatus(child, 'not-signed-in')
          break
        case 'resume-failed': {
          store.clearProgram(child)
          const notice = unresumableNotice(nameOf(child))
          store.notice(child, notice.kind, notice.text)
          break
        }
        case 'model-not-offered':
          // onModelNotOffered carries the picker.
          break
        case 'time-limit':
          // The turn ends with the fixed sentence; the chat returns to idle.
          break
        case 'program': {
          const notice = programFailedNotice(nameOf(child), stage, failure.exit)
          store.notice(child, notice.kind, notice.text)
          options.warn(`${child}: ${notice.text}`)
          break
        }
      }
    },
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const child = session.header.id
    const state = handle.stateOf(session)
    // A record cannot be appended while the turn end is being published.
    queueMicrotask(() => { if (state.shown.agent !== null) showAccount(child) })
    const { programSessionId, programMessageId } = state.logged
    if (state.shown.agent === null || programSessionId === null || options.tail === undefined) return
    const { agent } = state.shown
    const stopped = event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted'
    const remember = async (): Promise<void> => {
      // A record cannot be appended while the turn end is being published, so it waits for the listener to return.
      await Promise.resolve()
      // A stopped turn's program may still be writing, so its last message is not recorded.
      const id = stopped || options.tail === undefined ? undefined : (await options.tail(agent, programSessionId)).lastMessageId
      if (id !== undefined || programMessageId !== null) store.recordProgramMessage(child, id)
    }
    remember().catch((error: unknown) => {
      options.warn(`the program's last message of ${child} was not recorded: ${String(error)}`)
    })
  })

  const routeOptions = {
    records: store, choices, workspaceOf: options.workspaceOf, coldWorkspaceOf: options.coldWorkspaceOf ?? (child => Promise.resolve(options.workspaceOf(child))), now,
  }
  return {
    store,
    choices,
    events,
    programs,
    records: programs.records,
    routes: [resumeRoute(routeOptions), chooseModelRoute(routeOptions)],
    stop: async (child) => {
      const run = options.runOf(child)
      if (run === undefined) return 'none'
      await run.stop()
      return run.closed ? 'closed' : 'interrupted'
    },
    end: (child, reason) => { store.setStatus(child, 'ended', { endedReason: reason }) },
    setPending: (child, since) => { store.setPending(child, since) },
    settled: () => choices.settled(),
  }
}
