/**
 * @delorun/plugin-trash — contract C8's trash in the studio. Deleting a chat or a
 * workspace moves it to the trash instead of destroying it: the plugin adds a
 * "Move to trash" action to each chat's and each workspace's menu, which
 * archives the chats with their running work stopped and moves them into the
 * trash under the home. The Trash section in Settings lists what was deleted,
 * restores an item, and deletes one or every item forever from every store
 * C8 names. At each start the plugin moves in the chats a live writer held
 * when they were deleted, then purges every item older than 30 days.
 *
 * Upstream offers no way to delete a chat, so the action adds one. Upstream's
 * own workspace Delete removes the registration and keeps the folder and
 * every chat, so it destroys no content and stays as it is.
 *
 * The harness half serves the {@link TRASH_PATHS} routes to the owner only;
 * the studio half (`./client`) adds the actions and the Trash section.
 * @module @delorun/plugin-trash
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-spill'
import type {} from '@deepseek-ai/dsh-workspace'
import schema from '@deepseek-ai/schemastery'
import { admitApprovedDevice, gateByUnlock } from '@delorun/home-auth'
import { TrashError, type ProjectionCachePurge, type SessionIndexPurge, type TrashStores } from '@delorun/trash'
import { TrashOperationError, TrashOperations } from './operations.ts'
import { TRASH_PATHS, type TrashRefusal, type TrashRefusalCode } from './wire.ts'

export { TrashOperationError, TrashOperations, entryOf, type TrashOperationsConfig, type TrashRegistry } from './operations.ts'
export { TRASH_PATHS, type EmptyOutcome, type PurgeOutcome, type TrashEntry, type TrashListing, type TrashRefusal, type TrashRefusalCode } from './wire.ts'

/** Stable Cordis plugin name. */
export const name = 'delorun-trash'

/** Required services: the workspace registry, whose chats a delete archives, and the Connection for the routes. */
export const inject = ['workspaceRegistry', 'connection']

/** Where the trash and the stores its purge reaches live in the home. */
export interface Config {
  /** The trash root, `<home>/trash`. */
  readonly trashRoot: string
  /** The JSONL session-persistence root, `<home>/sessions`. */
  readonly sessionsRoot: string
  /** The storage backend's root, `<home>/storages`, which holds the projection cache's documents. */
  readonly storagesRoot: string
  /** The versioned attachment root, `<home>/attachments/v1`, whose attachments a purge removes when no other chat names them. */
  readonly attachmentsRoot: string
  /** The Delorun home whose operational logs the clear-logs offer deletes. */
  readonly logsHome: string
}

/** An absolute POSIX path without a trailing separator. */
const ABSOLUTE = /^\/\S*[^/]$/

/** Validated configuration. */
export const Config: schema<Config> = schema.object({
  trashRoot: schema.string().pattern(ABSOLUTE).required().description('The trash root, <home>/trash.'),
  sessionsRoot: schema.string().pattern(ABSOLUTE).required().description('The JSONL session-persistence root, <home>/sessions.'),
  storagesRoot: schema.string().pattern(ABSOLUTE).required().description('The storage backend\'s root, <home>/storages.'),
  attachmentsRoot: schema.string().pattern(ABSOLUTE).required().description('The versioned attachment root, <home>/attachments/v1.'),
  logsHome: schema.string().pattern(ABSOLUTE).required().description('The Delorun home whose operational logs the clear-logs offer deletes.'),
})

/** The longest session, workspace or item id a route accepts. */
const MAX_ID_LENGTH = 256

/** The longest chat name a delete records. */
const MAX_LABEL_LENGTH = 500

/** The full-text index engine method a purge calls, present on session-query-sqlite's engine. */
interface ForgettingIndex {
  forgetSessions(ids: readonly SessionId[]): Promise<void>
}

/**
 * Whether a session-query engine can forget sessions.
 * @param engine - the mounted engine.
 * @returns whether it has `forgetSessions`.
 */
function canForget(engine: object): engine is ForgettingIndex {
  return typeof (engine as Partial<ForgettingIndex>).forgetSessions === 'function'
}

/**
 * Register the routes and run the start pass.
 * @param ctx - the plugin context with the injected services.
 * @param config - where the trash and the stores live.
 */
export function apply(ctx: Context, config: Config): void {
  let sessionIndex: SessionIndexPurge | undefined
  let projectionCache: ProjectionCachePurge | undefined
  let spillRoots: readonly string[] = []
  ctx.inject(['sessionQuery'], (child) => {
    const engine = child.sessionQuery
    if (!canForget(engine)) return
    sessionIndex = { forgetSessions: ids => engine.forgetSessions(ids.map(id => SessionId(id))) }
    child.effect(() => () => { sessionIndex = undefined }, `${name}: the full-text index seam`)
  })
  ctx.inject(['sessionProjectionCache'], (child) => {
    const cache = child.sessionProjectionCache
    projectionCache = { forget: id => cache.forget(SessionId(id)) }
    child.effect(() => () => { projectionCache = undefined }, `${name}: the projection cache seam`)
  })
  ctx.inject(['spillStore'], (child) => {
    const root = (child.spillStore as Partial<{ readonly root: string }>).root
    if (typeof root !== 'string') return
    spillRoots = [root]
    child.effect(() => () => { spillRoots = [] }, `${name}: the spill root`)
  })
  const stores = (): TrashStores => ({
    sessionsRoot: config.sessionsRoot,
    storagesRoot: config.storagesRoot,
    attachmentsRoot: config.attachmentsRoot,
    spillRoots,
    logsHome: config.logsHome,
    ...(sessionIndex === undefined ? {} : { sessionIndex }),
    ...(projectionCache === undefined ? {} : { projectionCache }),
  })
  const operations = new TrashOperations({
    trashRoot: config.trashRoot,
    stores,
    registry: ctx.workspaceRegistry,
    warn: message => { ctx.logger.warn(`${name}: ${message}`) },
  })

  operations.start().then((outcome) => {
    if (outcome.paused !== undefined) {
      ctx.logger.warn(`${name}: the trash's retention purged nothing at this start, because the clock is not trustworthy (${outcome.paused}); it runs again at the next start`)
    } else if (outcome.purged.length > 0) {
      ctx.logger.info(`${name}: deleted ${String(outcome.purged.length)} item(s) whose 30 days in the trash ended`)
    }
  }, (error: unknown) => {
    ctx.logger.warn(`${name}: the trash's start pass failed, so expired items stay until the next start: ${String(error)}`)
  })

  // Listing, deleting to the trash and restoring need no unlock; deleting forever does.
  const route = (path: string, handle: (body: Readonly<Record<string, unknown>>) => Promise<unknown>, needsUnlock = false): void => {
    const answerTo = async (request: Request): Promise<Response> => {
      let body: unknown
      try {
        body = await request.json()
      } catch (error: unknown) {
        return refusal('BAD_REQUEST', `the request body is not JSON: ${String(error)}`)
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return refusal('BAD_REQUEST', 'the request body is not a JSON object')
      try {
        return Response.json(await handle(body as Readonly<Record<string, unknown>>), { headers: NO_STORE })
      } catch (error: unknown) {
        if (error instanceof RequestError) return refusal('BAD_REQUEST', error.message)
        if (error instanceof TrashOperationError) return refusal(error.code, error.message)
        if (error instanceof TrashError && (error.code === 'TRASH_ITEM_NOT_FOUND' || error.code === 'TRASH_RESTORE_CONFLICT')) return refusal(error.code, error.message)
        ctx.logger.warn(`${name}: ${path} failed: ${String(error)}`)
        return refusal('TRASH_FAILED', 'the trash operation failed; the harness log names the cause')
      }
    }
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods: ['POST'], requestBody: 'buffered',
      ...needsUnlock ? gateByUnlock(() => ctx.get('homeAuth'), answerTo) : { admitPeer: admitApprovedDevice(), fetch: answerTo },
    }), `${name}: ${path}`)
  }
  route(TRASH_PATHS.list, () => operations.list())
  route(TRASH_PATHS.deleteChat, body => operations.deleteChat(SessionId(id(body, 'sessionId')), label(body)))
  route(TRASH_PATHS.deleteWorkspace, body => operations.deleteWorkspace(id(body, 'workspaceId')))
  route(TRASH_PATHS.restore, body => operations.restore(id(body, 'itemId')))
  route(TRASH_PATHS.purge, body => operations.purge(id(body, 'itemId'), flag(body, 'clearLogs')), true)
  route(TRASH_PATHS.empty, body => operations.empty(flag(body, 'clearLogs')), true)
}

/** The cache header every answer carries. */
const NO_STORE = { 'cache-control': 'no-store' } as const

/** The status each refusal answers with. */
const STATUS: Readonly<Record<TrashRefusalCode, number>> = {
  BAD_REQUEST: 400,
  TRASH_ITEM_NOT_FOUND: 404,
  WORKSPACE_NOT_FOUND: 404,
  TRASH_RESTORE_CONFLICT: 409,
  TRASH_FAILED: 500,
}

/**
 * One refusal answer.
 * @param code - the refusal code.
 * @param message - one sentence for the log.
 * @returns the response.
 */
function refusal(code: TrashRefusalCode, message: string): Response {
  return Response.json({ code, message } satisfies TrashRefusal, { status: STATUS[code], headers: NO_STORE })
}

/** A request body field that is missing or malformed. */
class RequestError extends Error {}

/**
 * One required id field.
 * @param body - the request body.
 * @param field - the field's name.
 * @returns the id.
 * @throws {RequestError} when the field is not a non-empty string of at most 256 characters.
 */
function id(body: Readonly<Record<string, unknown>>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) throw new RequestError(`${field} is not an id`)
  return value
}

/**
 * The optional chat name field.
 * @param body - the request body.
 * @returns the name, or `undefined` when absent.
 * @throws {RequestError} when the field is present and not a string of at most 500 characters.
 */
function label(body: Readonly<Record<string, unknown>>): string | undefined {
  const value = body.label
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > MAX_LABEL_LENGTH) throw new RequestError('label is not a chat name')
  return value
}

/**
 * One boolean field, false when absent.
 * @param body - the request body.
 * @param field - the field's name.
 * @returns the value.
 * @throws {RequestError} when the field is present and not a boolean.
 */
function flag(body: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = body[field]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new RequestError(`${field} is not a boolean`)
  return value
}
