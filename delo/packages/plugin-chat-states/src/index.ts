/**
 * @delo/plugin-chat-states — which chats the person snoozed or settled, kept
 * on the harness so every studio, on any browser or phone, shows the same
 * sidebar. The plugin stores each chat's state in the harness's storage
 * ({@link chatStatesDomain}), outside the session log, so the model never
 * sees it, and serves it to the studio over exact Connection Fetch routes
 * ({@link CHAT_STATE_PATHS}). A snooze that ended by its time becomes a
 * waking (`wokeAt`) when the studio next lists the states, kept until the
 * person sees the chat.
 *
 * The harness half does not depend on the Delo look: states stay stored while
 * the stock look is on, so switching back restores them.
 * @module @delo/plugin-chat-states
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the ctx.settings merge.
import type {} from '@deepseek-ai/dsh-settings'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  CHAT_STATE_PATHS, ChatState, ChatStateRequest, MAX_SNOOZE_MS,
  type ChatStateRefusal, type ChatStateRefusalCode, type ChatStatesResponse,
} from './wire.ts'

export { CHAT_STATE_PATHS, CHAT_STATE_REFUSAL_CODES, ChatState, ChatStateRefusal, ChatStateRequest, ChatStatesResponse, MAX_SNOOZE_MS } from './wire.ts'
export type { ChatStateRefusalCode } from './wire.ts'

export {
  AUTO_SETTLE_DAYS, CHAT_STATES_ROW_ID, Config, DEFAULT_CHAT_STATES_SETTINGS, PRESET_DAYS, REFRESH_SECONDS, SNOOZE_PRESET_LIMITS,
  type ChatStatesSettings,
} from './config.ts'

/** The plugin's name in logs. */
export const name = 'delo-chat-states'

/** Required services: the Connection for the routes and the harness's storage. */
export const inject = ['connection', 'storageDomain']

/**
 * Each chat's state, by session id. The table accepts any stored value and {@link ChatStates} validates each record
 * against {@link ChatState} when it reads it, so one malformed record is reported and skipped and never keeps the
 * plugin from starting or the list from answering.
 */
export const chatStatesDomain = defineDomain({
  name: 'delo_chat_states',
  version: 1,
  tables: {
    chats: domainTable<SessionId, unknown>(z.unknown()),
  },
})

/** What each refusal answers: its HTTP status and a sentence for the person that carries no internal details. */
const REFUSALS: Readonly<Record<ChatStateRefusalCode, { readonly status: number; readonly message: string }>> = {
  'invalid-request': { status: 400, message: 'The request does not name a chat and a change.' },
  'snooze-out-of-range': { status: 400, message: 'A snooze ends between now and a year from now.' },
  'failed': { status: 500, message: 'The chat states could not be stored.' },
}

/** A change the plugin refuses, with a stable code the route turns into its answer. */
export class ChatStateRefusedError extends Error {
  /** @param code - why the change was refused. */
  constructor(readonly code: Exclude<ChatStateRefusalCode, 'failed'>) {
    super(REFUSALS[code].message)
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

/** The stored states and the changes the studio asks for. */
export class ChatStates {
  /** Sessions whose stored record was reported as malformed, so each is reported once. */
  readonly #reported = new Set<string>()
  /** The last operation: operations run one after another, since each reads and then writes the same records. */
  #last: Promise<unknown> = Promise.resolve()

  /**
   * @param table - the storage table, by session id.
   * @param now - the harness's clock, in epoch milliseconds.
   * @param report - called once for each session whose stored record is malformed and therefore left out.
   */
  constructor(
    private readonly table: KvTable<SessionId, unknown>,
    private readonly now: () => number,
    private readonly report: (session: SessionId, problem: string) => void,
  ) {}

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

  /** Run one operation after the earlier ones settle; a failed operation does not stop the later ones. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#last.then(operation)
    this.#last = result.catch(() => undefined)
    return result
  }

  /** The valid stored state of a chat, or undefined when it has none or its record is malformed (reported once). */
  private stateOf(session: SessionId): ChatState | undefined {
    const stored = this.table.get(session)
    if (stored === undefined) return undefined
    const parsed = ChatState.safeParse(stored)
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
      chats[session] = state
    }
    return { chats }
  }

  /** Store a chat's state, or forget a chat that has none. */
  private async write(session: SessionId, kept: ChatState): Promise<void> {
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
 * Open the storage and serve the routes. Disposing the plugin closes the storage.
 * @param ctx - the plugin context with the injected services.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(chatStatesDomain)
  ctx.effect(() => () => domain.close(), `${name}: storage`)
  const states = new ChatStates(domain.table('chats'), Date.now, (session, problem) => {
    ctx.logger.warn(`${name}: the stored state of chat ${session} is not valid and is left out until the chat changes: ${problem}`)
  })
  // Settings → Snooze and settle edits the settings in the studio, so the settings service builds no form for them.
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
