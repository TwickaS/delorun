/**
 * @delo/plugin-chat-states — which chats the person snoozed or settled, kept
 * on the harness so every studio, on any browser or phone, shows the same
 * sidebar. The plugin stores each chat's state in the harness's storage
 * ({@link chatStatesDomain}), outside the session log, so the model never
 * sees it, and serves it to the studio over exact Connection Fetch routes
 * ({@link CHAT_STATE_PATHS}). A sweep forgets the states of chats that no
 * longer exist and bounds the store. A snooze that ended by its time becomes a
 * waking (`wokeAt`) when the studio next lists the states, kept until the
 * person sees the chat.
 *
 * The harness half does not depend on the Delo look: states stay stored while
 * the stock look is on, so switching back restores them.
 * @module @delo/plugin-chat-states
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the ctx.sessionQuery merge, whose complete session list says which chats exist.
import type {} from '@deepseek-ai/dsh-session-query'
import { TRASH_RETENTION_DAYS } from '@delo/contract-archive-and-trash'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the ctx.settings merge.
import type {} from '@deepseek-ai/dsh-settings'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { Config as ChatStatesConfig } from './config.ts'
import {
  CHAT_STATE_PATHS, ChatStateRequest, MAX_SNOOZE_MS, StoredChatState,
  type ChatState, type ChatStateRefusal, type ChatStateRefusalCode, type ChatStatesResponse,
} from './wire.ts'

export { CHAT_STATE_PATHS, CHAT_STATE_REFUSAL_CODES, ChatState, ChatStateRefusal, ChatStateRequest, ChatStatesResponse, MAX_SNOOZE_MS, StoredChatState } from './wire.ts'
export type { ChatStateRefusalCode } from './wire.ts'

export {
  AUTO_SETTLE_DAYS, CHAT_STATES_ROW_ID, Config, DEFAULT_CHAT_STATES_SETTINGS, MAX_RECORDS, PRESET_DAYS, PRUNE_MINUTES, REFRESH_SECONDS,
  SNOOZE_PRESET_LIMITS, type ChatStatesSettings,
} from './config.ts'

/** The plugin's name in logs. */
export const name = 'delo-chat-states'

/** Required services: the Connection for the routes and the harness's storage. */
export const inject = ['connection', 'storageDomain']

/**
 * Each chat's state, by session id. The table accepts any stored value and {@link ChatStates} validates each record
 * against {@link StoredChatState} when it reads it, so one malformed record is reported and skipped and never keeps the
 * plugin from starting or the list from answering.
 */
export const chatStatesDomain = defineDomain({
  name: 'delo_chat_states',
  version: 1,
  tables: {
    chats: domainTable<SessionId, unknown>(z.unknown()),
  },
})

/** How long a chat may be missing from the session list before its state is forgotten: the trash retention, since a trashed chat can be restored until then. */
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** What each refusal answers: its HTTP status and a sentence for the person that carries no internal details. */
const REFUSALS: Readonly<Record<ChatStateRefusalCode, { readonly status: number; readonly message: string }>> = {
  'invalid-request': { status: 400, message: 'The request does not name a chat and a change.' },
  'snooze-out-of-range': { status: 400, message: 'A snooze ends between now and a year from now.' },
  'failed': { status: 500, message: 'The chat states could not be stored.' },
}

/** A change the plugin refuses, with a stable code the route turns into its answer. */
export class ChatStateRefusedError extends Error {
  /** Why the change was refused. */
  readonly code: Exclude<ChatStateRefusalCode, 'failed'>

  /** @param code - why the change was refused. */
  constructor(code: Exclude<ChatStateRefusalCode, 'failed'>) {
    super(REFUSALS[code].message)
    this.code = code
    this.name = 'ChatStateRefusedError'
  }
}

/** A state's fields, any of which may be unset. */
type StateFields = { readonly [K in keyof ChatState]?: number | undefined }

/** The state's set fields: a snooze needs both of its times, and an unset field is left out. */
function keep(state: StateFields): ChatState {
  return {
    ...(state.settledAt === undefined ? {} : { settledAt: state.settledAt }),
    ...(state.snoozedAt === undefined || state.snoozedUntil === undefined ? {} : { snoozedAt: state.snoozedAt, snoozedUntil: state.snoozedUntil }),
    ...(state.wokeAt === undefined ? {} : { wokeAt: state.wokeAt }),
    ...(state.keptAt === undefined ? {} : { keptAt: state.keptAt }),
  }
}

/** When a state last changed, in epoch milliseconds; 0 for a chat without a valid state. */
function lastChange(state: StoredChatState | undefined): number {
  return Math.max(0, state?.settledAt ?? 0, state?.snoozedAt ?? 0, state?.wokeAt ?? 0, state?.keptAt ?? 0)
}

/** The stored states and the changes the studio asks for. */
export class ChatStates {
  /** Sessions whose stored record was reported as malformed, so each is reported once. */
  readonly #reported = new Set<string>()
  /** The last operation: operations run one after another, since each reads and then writes the same records. */
  #last: Promise<unknown> = Promise.resolve()

  /** The storage table, by session id. */
  private readonly table: KvTable<SessionId, unknown>
  /** The harness's clock, in epoch milliseconds. */
  private readonly now: () => number
  /** Called once for each session whose stored record is malformed and therefore left out. */
  private readonly report: (session: SessionId, problem: string) => void

  /**
   * @param table - the storage table, by session id.
   * @param now - the harness's clock, in epoch milliseconds.
   * @param report - called once for each session whose stored record is malformed and therefore left out.
   */
  constructor(
    table: KvTable<SessionId, unknown>,
    now: () => number,
    report: (session: SessionId, problem: string) => void,
  ) {
    this.table = table
    this.now = now
    this.report = report
  }

  /**
   * Every chat that is settled, snoozed or woke now; a snooze that ended by its time becomes a waking.
   * @returns the states by session id; a stored record that is not a valid state is left out.
   */
  list(): Promise<ChatStatesResponse> {
    return this.serial(() => this.read())
  }

  /**
   * Apply one change: settling ends a snooze and snoozing ends a settle, since a chat sits on one shelf at a time;
   * either also clears a waking, and `seen` clears only that.
   * @param request - the change.
   * @returns every chat's state after it.
   * @throws {ChatStateRefusedError} for a snooze that does not end in the next year.
   */
  apply(request: ChatStateRequest): Promise<ChatStatesResponse> {
    return this.serial(async () => {
      const now = this.now()
      const current = this.stateOf(request.session) ?? {}
      switch (request.action) {
        case 'settle':
          await this.write(request.session, keep({ settledAt: now }))
          break
        case 'unsettle':
          await this.write(request.session, keep({ ...current, settledAt: undefined, keptAt: now }))
          break
        case 'snooze':
          if (request.until <= now || request.until > now + MAX_SNOOZE_MS) {
            throw new ChatStateRefusedError('snooze-out-of-range')
          }
          await this.write(request.session, keep({ snoozedAt: now, snoozedUntil: request.until }))
          break
        case 'wake':
          await this.write(request.session, keep({ ...current, snoozedAt: undefined, snoozedUntil: undefined }))
          break
        case 'seen':
          await this.write(request.session, keep({ ...current, wokeAt: undefined }))
          break
        default:
          // A defect, not a refusal: the route validated the request against these actions.
          throw new Error(`${name}: unreachable action ${JSON.stringify(request satisfies never)}`)
      }
      return this.read()
    })
  }

  /**
   * Keep the states of chats that are no longer in the session list for their retention, then forget them. A chat moved
   * to the trash is missing from the list but can be restored, so the first sweep that finds a stored chat missing
   * records `missingSince` on its record, a sweep that finds it again clears the mark, and a sweep forgets the record
   * only once the chat has been missing for `retentionMs`. A record that is not valid is left to {@link enforceLimit}.
   * The list is read inside the queue of changes, so a change cannot land for a chat the list was read too early to
   * contain. Nothing changes when the list cannot be read, fails midway, or comes back empty (an empty answer cannot be
   * told from a corpus that has not loaded yet).
   * @param listChats - reads the ids of every chat that exists; it must reject rather than answer a partial list.
   * @param retentionMs - how long a chat may stay missing before its state is forgotten.
   * @returns how many states were forgotten.
   * @throws whatever `listChats` rejects with, after changing nothing.
   */
  forgetGone(listChats: () => Promise<readonly SessionId[]>, retentionMs: number): Promise<number> {
    return this.serial(async () => {
      const existing = new Set(await listChats())
      if (existing.size === 0) return 0
      const now = this.now()
      const forgotten: SessionId[] = []
      for (const session of [...this.table.keys()]) {
        const state = this.stateOf(session)
        if (state === undefined) continue
        if (existing.has(session)) {
          if (state.missingSince !== undefined) await this.write(session, keep(state))
        } else if (state.missingSince === undefined) {
          await this.write(session, { ...keep(state), missingSince: now })
        } else if (now - state.missingSince >= retentionMs) {
          forgotten.push(session)
        }
      }
      return this.table.deleteMany(forgotten)
    })
  }

  /**
   * Forget the states with the oldest changes until at most `limit` remain; a record that is not valid counts as the
   * oldest.
   * @param limit - the most states to keep.
   * @returns how many states were forgotten.
   */
  enforceLimit(limit: number): Promise<number> {
    return this.serial(async () => {
      const excess = this.table.size - limit
      if (excess <= 0) return 0
      const oldestFirst = [...this.table.keys()].map(session => ({ session, changed: lastChange(this.stateOf(session)) })).sort((a, b) => a.changed - b.changed)
      return this.table.deleteMany(oldestFirst.slice(0, excess).map(entry => entry.session))
    })
  }

  /** Run one operation after the earlier ones settle; a failed operation does not stop the later ones. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#last.then(operation)
    this.#last = result.catch(() => undefined)
    return result
  }

  /** The valid stored state of a chat, or undefined when it has none or its record is malformed (reported once). */
  private stateOf(session: SessionId): StoredChatState | undefined {
    const stored = this.table.get(session)
    if (stored === undefined) return undefined
    const parsed = StoredChatState.safeParse(stored)
    if (parsed.success) {
      this.#reported.delete(session)
      return parsed.data
    }
    if (!this.#reported.has(session)) {
      this.#reported.add(session)
      this.report(session, parsed.error.message)
    }
    return undefined
  }

  /** Read every valid state, turning each snooze that ended into a waking. */
  private async read(): Promise<ChatStatesResponse> {
    const now = this.now()
    const chats: Record<string, ChatState> = {}
    for (const session of [...this.table.keys()]) {
      const state = this.stateOf(session)
      if (state === undefined) continue
      if (state.snoozedUntil !== undefined && state.snoozedUntil <= now) {
        const woke = keep({ settledAt: state.settledAt, wokeAt: state.snoozedUntil, keptAt: state.keptAt })
        await this.write(session, woke)
        chats[session] = woke
        continue
      }
      chats[session] = keep(state)
    }
    return { chats }
  }

  /** Store a chat's state, or forget a chat that has none. */
  private async write(session: SessionId, kept: StoredChatState): Promise<void> {
    if (Object.keys(kept).length === 0) await this.table.delete(session)
    else await this.table.put(session, kept)
  }
}

const NO_STORE = { 'cache-control': 'no-store' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...NO_STORE } })
}

/** The answer for a refused request; the message never carries internal details. */
function refusal(code: ChatStateRefusalCode): Response {
  const { status, message } = REFUSALS[code]
  return json({ code, message } satisfies ChatStateRefusal, status)
}

/**
 * Open the storage, serve the routes and sweep the stored states. Disposing the plugin closes the storage and stops
 * the sweeps.
 * @param ctx - the plugin context with the injected services.
 * @param config - the validated live configuration.
 */
export async function apply(ctx: Context, config: ChatStatesConfig): Promise<void> {
  const domain = await ctx.storageDomain.open(chatStatesDomain)
  ctx.effect(() => () => domain.close(), `${name}: storage`)
  const states = new ChatStates(domain.table('chats'), Date.now, (session, problem) => {
    ctx.logger.warn(`${name}: the stored state of chat ${session} is not valid and is left out until the chat changes: ${problem}`)
  })
  sweepPeriodically(ctx, states, config)
  // Settings → Sidebar → Snooze and idle chats edits the settings in the studio, so the settings service builds no form for them.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })

  const answer = (route: string, handle: (request: Request) => Promise<Response>) => async (request: Request): Promise<Response> => {
    try {
      return await handle(request)
    } catch (error) {
      if (error instanceof ChatStateRefusedError) return refusal(error.code)
      ctx.logger.error(`${name}: ${route} failed: ${String(error)}`)
      return refusal('failed')
    }
  }

  ctx.connection.fetch.register({
    path: CHAT_STATE_PATHS.list, methods: ['GET'], requestBody: 'buffered',
    fetch: answer(CHAT_STATE_PATHS.list, async () => json(await states.list())),
  })
  ctx.connection.fetch.register({
    path: CHAT_STATE_PATHS.set, methods: ['POST'], requestBody: 'buffered',
    fetch: answer(CHAT_STATE_PATHS.set, async (request) => {
      const parsed = ChatStateRequest.safeParse(await request.json().catch(() => undefined))
      if (!parsed.success) return refusal('invalid-request')
      return json(await states.apply(parsed.data))
    }),
  })
}

/**
 * Sweep at start and then every `pruneMinutes` (read again before each wait): forget the states of chats the session
 * list no longer holds, then enforce `maxRecords`. A sweep that cannot read the whole list forgets no chat's state and
 * logs why; the limit still applies.
 * @param ctx - the plugin context; the sweeps stop with its fiber.
 * @param states - the stored states.
 * @param config - the live configuration.
 */
function sweepPeriodically(ctx: Context, states: ChatStates, config: ChatStatesConfig): void {
  const sweep = async (signal: AbortSignal): Promise<void> => {
    try {
      const query = ctx.get('sessionQuery')
      if (query !== undefined) {
        const gone = await states.forgetGone(async () => (await query.listSessions(signal)).map(record => record.header.id), TRASH_RETENTION_MS)
        if (gone > 0) ctx.logger.info(`${name}: forgot the states of ${gone} chats that no longer exist`)
      }
    } catch (error) {
      ctx.logger.warn(`${name}: no state of a deleted chat was forgotten, because the session list could not be read or the states could not be stored: ${String(error)}`)
    }
    try {
      const over = await states.enforceLimit(config.maxRecords.get())
      if (over > 0) ctx.logger.info(`${name}: forgot ${over} states with the oldest changes, beyond the limit of ${config.maxRecords.get()}`)
    } catch (error) {
      ctx.logger.error(`${name}: the limit could not be enforced: ${String(error)}`)
    }
  }
  ctx.effect(() => {
    const stop = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = (): void => {
      void sweep(stop.signal).then(() => {
        if (!stop.signal.aborted) timer = setTimeout(run, config.pruneMinutes.get() * 60_000)
      })
    }
    run()
    return () => {
      stop.abort()
      clearTimeout(timer)
    }
  }, `${name}: sweeps`)
}
