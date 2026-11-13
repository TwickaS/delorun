/**
 * The studio's Changes routes (contract C21, "Routes and the recovery screen"): what failed at the last start, the
 * recent changes and one change, read by any session the studio admits, and the actions a person takes at their
 * computer: apply, discard and undo a change, turn a plugin off or on, open and end a work session, and safe mode.
 * Applying an agent's plugin request runs the plugin operation the Host names (`@delo/changes`' shared operation) with
 * `applyInstallChange`, after a second confirmation that names its spec: what it installs is not shown before it runs.
 *
 * Every request is first admitted by Connection (`ctx.connection.admit`): the Host/Origin fence, then the studio's
 * signed cookie or the authenticator provider, so a caller without the studio's credential is answered 401 or 403 and
 * nothing else runs. A `POST` then needs the person at their computer, decided from where the request arrived before
 * its body is read: the loopback listener under a loopback `Host` (`@delo/home`'s arrival helpers), admitted with
 * the credential, and not admitted for a remote session. No reach listener accepts a loopback `Host`, so such a request
 * did not come through a remote session; otherwise it is answered `403 LOOPBACK_REQUIRED`. A browser request from
 * another site (`Sec-Fetch-Site`, or an `Origin` that is not the request's own loopback origin) is answered
 * `403 CROSS_SITE`, also before the body is read. Only then is the body read, at most {@link MAX_BODY_BYTES}, and the
 * route attests the request with `attestStudio`, the only proof a studio request carries; no route changes the
 * protection setting, which only `delorun changes protection` changes.
 *
 * `state` reads only the records: it writes nothing and reads no plugin's folder, so the studio's repeated reads and a
 * remote session's cost nothing. Only `show` reads folders, computes diffs and stores their content.
 *
 * A change to Delo itself is decided only at a terminal, which knows the signed file list of the runtime it runs: the
 * routes read its log entry and its diff from the store and refuse `apply`, `discard` and `undo` for it with
 * `409 DECIDE_AT_TERMINAL` and the command, before any action runs. No route calls an action on Delo's own files.
 *
 * Every answer is JSON with `cache-control: no-store`; file names, diffs, summaries and failures travel as JSON strings
 * that the screen renders as text. No answer names the Delo home's path: a refusal or an unreadable part whose words
 * name it answers its code, or names the part, with {@link HOME_WITHHELD_SENTENCE}, and the Host log keeps the words; a recorded failure's
 * text names the home as {@link HOME_IN_ANSWERS}.
 *
 * @module @delo/plugin-changes/routes
 */
import { realpathSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  applyChange,
  applyInstallChange,
  attestStudio,
  CONTENT_VERSION_PATTERN,
  discardChange,
  finishWork,
  isChangesError,
  isPluginRequest,
  listChanges,
  loggedHarnessChange,
  PACKAGE_NAME_PATTERN,
  parseChangeId,
  readBootRecord,
  readChangeLog,
  readHarnessLog,
  readProtection,
  recordedChanges,
  reviewHarnessChange,
  reviewWork,
  riskKindPhrase,
  showChange,
  startWork,
  turnOff,
  turnOn,
  undoChange,
  workSessionFact,
  WORK_SESSION_DEFAULT_MINUTES,
  WORK_SESSION_MAX_MINUTES,
  type ActionResult,
  type AtComputer,
  type ChangeEntry,
  type ChangeId,
  type ChangesCode,
  type ChangesContext,
  type ContentVersion,
  type HarnessReview,
  type InstallResult,
  type ListedChange,
  type PluginOperation,
  type ReloadHost,
  type RiskSummary,
  type ShownChange,
  type StudioArrival,
  type WorkDone,
  type WorkReview,
  type WorkStarted,
} from '@delo/changes'
import { isForeignFetchSite, isSameLoopbackOrigin, listenerOf, loopbackAddressOf, type LoopbackPort, type StampedRequest } from '@delo/home'
import { isProfileSafetyError, readSafeMode, recover } from '@delo/profile-safety'
import {
  ACTION_PATHS,
  CHANGED_SINCE_REVIEW,
  CONFIRM_RISK,
  DECIDE_AT_TERMINAL,
  LOOPBACK_REQUIRED,
  SHOW_PATH,
  STATE_PATH,
  WORKSPACES_PATH,
  type ActionView,
  type ChangesAction,
  type ChangesStateView,
  type ChangeView,
  type CreatedView,
  type DiscardView,
  type DoneView,
  type EntryView,
  type HarnessEntryView,
  type InstallView,
  type PendingListView,
  type PendingView,
  type RequestedView,
  type RevealedView,
  type RiskView,
  type ShownView,
  type StartedView,
  type WorkReviewView,
  type WorkspacesView,
} from './wire.ts'
import { createAction, CreateRefusal, requestAction, revealAction, type ScaffoldTarget, type WorkspaceChoice } from './create-actions.ts'

export { ACTION_PATHS, CHANGES_ROUTE_PREFIX, SHOW_PATH, STATE_PATH, WORKSPACES_PATH, type ChangesAction } from './wire.ts'

/** The largest body an action reads, in bytes; a body names one change or plugin. */
export const MAX_BODY_BYTES = 16 * 1024

/** How many logged changes `state` returns of a profile's log and of the log of changes to Delo itself, newest first. */
export const RECENT_CHANGES = 20

/** The sentence a request that is not at the computer is answered with. */
export const LOOPBACK_REQUIRED_SENTENCE = 'This needs you at your computer.'

/** The sentence that stands for a failure's words when they name the Delo home's path, which the Host log keeps. */
export const HOME_WITHHELD_SENTENCE = 'Its details name files Delo keeps; the Host log has them.'

/** What a recorded failure's text in an answer says in place of the Delo home's path. */
export const HOME_IN_ANSWERS = '<Delo home>'

/** The fields of an answer that carry a recorded failure's text: a failed load, start or reload. */
const FAILURE_FIELDS: ReadonlySet<string> = new Set(['failure', 'error'])

/** A request handler, as the web server takes it. */
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

/** Connection's admission as the routes use it; `ctx.connection` provides it. */
export interface RouteConnection {
  /**
   * Admit one request: the Host/Origin fence, then the studio's credential.
   * @param request - the request.
   * @returns the admitted session, with a rolled cookie to set, or the refusal's status.
   */
  admit(request: IncomingMessage): { readonly peer: object, readonly setCookie?: string } | { readonly rejection: 401 | 403 }
  /**
   * Whether a reach listener's dispatcher admitted the session, which makes it remote.
   * @param peer - the admitted session.
   * @returns true for a remote session.
   */
  isReachPeer(peer: object): boolean
}

/** What the routes reach outside themselves. */
export interface RouteDependencies {
  readonly connection: RouteConnection
  /**
   * The profile the Host runs.
   * @returns it, or undefined when the Host runs no profile under Changes.
   */
  readonly profile: () => ChangesContext | undefined
  /** Reloads the running Host in its own process: upstream's hot reload. */
  readonly reload: ReloadHost
  /**
   * The plugin operation applying an agent's plugin request runs in the Host.
   * @param ctx - the profile the request is applied to.
   * @returns the operation.
   */
  readonly pluginOperation: (ctx: ChangesContext) => PluginOperation
  /** The bundles the installation itself ships, which safe mode keeps loading; empty when the composition names none. */
  readonly installationBundles: readonly string[]
  /** The Host's log, which names a failure the person sees only as `INTERNAL`, and words withheld from an answer. */
  readonly logger: { warn(message: string): void }
  /** The loopback listener's bound port, the web server's `port` in the Host: an unstamped request is on the loopback listener only when it arrived on that socket. */
  readonly loopbackPort: LoopbackPort
  /** What Create a plugin targets: the running release and the installation. */
  readonly scaffold: () => ScaffoldTarget
  /**
   * The workspaces a plugin may be created in.
   * @returns the registry's workspaces, the default first.
   */
  readonly workspaces: () => readonly WorkspaceChoice[]
  /**
   * Show a folder in the computer's file manager.
   * @param folder - a created plugin's folder.
   */
  readonly reveal: (folder: string) => void
}

/** A refusal a route answers with: its status, its code and the sentence the person reads. */
class RouteRefusal extends Error {
  /** The HTTP status. */
  readonly status: number
  /** The stable code. */
  readonly code: string
  /** Person-facing fields the screen shows with it. */
  readonly details: Readonly<Record<string, unknown>>

  /**
   * @param status - the HTTP status.
   * @param code - the stable code.
   * @param message - the sentence.
   * @param details - person-facing fields the screen shows with it.
   */
  constructor(status: number, code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/** The HTTP status of each refusal of Changes. */
const CHANGES_STATUS: Readonly<Record<ChangesCode, number>> = {
  RECORD_UNREADABLE: 500,
  STORE_CORRUPT: 500,
  CHANGED_WHILE_READING: 409,
  CHANGED_SINCE_REVIEW: 409,
  UNKNOWN_CHANGE: 404,
  NOT_ALLOWED: 409,
  NOT_AT_COMPUTER: 403,
  NOT_LINKED: 409,
  WORK_SESSION_OPEN: 409,
  NO_WORK_SESSION: 409,
  RUNTIME_CHANGED: 409,
  INVALID_REQUEST: 400,
  OPERATION_FAILED: 409,
  CONTENT_TOO_LARGE: 409,
  LOAD_REFUSED: 409,
  HARNESS_CHANGED: 409,
  HARNESS_CHANGES_PENDING: 409,
  HARNESS_COPY_UNREADABLE: 409,
}

/**
 * @param response - the response.
 * @param status - the status.
 * @param body - the JSON body.
 * @param setCookie - a rolled credential the admission issued.
 */
function sendJson(response: ServerResponse, status: number, body: unknown, setCookie?: string): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...setCookie === undefined ? {} : { 'set-cookie': setCookie },
  })
  response.end(text)
}

/**
 * @param response - the response.
 * @param refusal - the refusal.
 * @param setCookie - a rolled credential the admission issued.
 */
function sendRefusal(response: ServerResponse, refusal: RouteRefusal, setCookie?: string): void {
  sendJson(response, refusal.status, { code: refusal.code, message: refusal.message, ...refusal.details }, setCookie)
}

/**
 * @param request - the request.
 * @param name - a header name in lower case.
 * @returns the header's value, or undefined when it is absent or repeated.
 */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Where a request arrived, decided from its listener, its `Host` and its admission, before its body is read.
 * @param request - the request.
 * @param loopbackPort - the loopback listener's bound port.
 * @param credential - whether Connection admitted it.
 * @param remote - whether a reach listener admitted it.
 * @returns the facts `attestStudio` decides from.
 */
export function arrivalOf(request: IncomingMessage & StampedRequest, loopbackPort: LoopbackPort, credential: boolean, remote: boolean): StudioArrival {
  const loopback = listenerOf(request, loopbackPort) === 'loopback' && loopbackAddressOf(header(request, 'host')) !== undefined
  return { loopback, credential, remoteSession: remote || !loopback }
}

/**
 * Whether a request may act for the person at their computer, as `attestStudio` decides: it arrived on the loopback
 * listener under a loopback `Host`, with the credential, and not for a remote session.
 * @param arrival - where the request arrived.
 * @returns whether the routes attest it.
 */
function atComputer(arrival: StudioArrival): boolean {
  return arrival.loopback && arrival.credential && !arrival.remoteSession
}

/**
 * Whether a browser sent the request from another site: its `Sec-Fetch-Site` says so, or its `Origin` is not the
 * request's own loopback origin. A program sends neither and carries no cookie a page could borrow.
 * @param request - the request.
 * @returns true for a request another site made.
 */
export function isCrossSite(request: IncomingMessage): boolean {
  if (isForeignFetchSite(header(request, 'sec-fetch-site'))) return true
  const origin = request.headers.origin
  return origin !== undefined && !isSameLoopbackOrigin(origin, header(request, 'host'))
}

/**
 * Read a request's JSON object body, at most {@link MAX_BODY_BYTES}.
 * @param request - the request.
 * @returns the object; an empty body reads as `{}`.
 * @throws {RouteRefusal} `413 BODY_TOO_LARGE` or `400 BAD_REQUEST` for a body that is not one JSON object.
 */
async function readBody(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RouteRefusal(413, 'BODY_TOO_LARGE', `A request names one change or plugin in at most ${String(MAX_BODY_BYTES)} bytes.`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_notJson) {
    // The refusal below names what the body must be.
    value = undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RouteRefusal(400, 'BAD_REQUEST', 'The body is one JSON object.')
  return value as Readonly<Record<string, unknown>>
}

/**
 * Refuse a body with a field the route does not take.
 * @param body - the body.
 * @param allowed - the fields the route takes.
 * @throws {RouteRefusal} `400 BAD_REQUEST`.
 */
function onlyFields(body: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter(key => !allowed.includes(key))
  if (extra.length > 0) throw new RouteRefusal(400, 'BAD_REQUEST', `This request takes ${allowed.length === 0 ? 'no fields' : allowed.join(', ')}; it does not take ${extra.join(', ')}.`)
}

/**
 * @param body - the body.
 * @returns the change id it names.
 * @throws {RouteRefusal} `400 BAD_REQUEST` for a missing or malformed id.
 */
function changeIdOf(body: Readonly<Record<string, unknown>>): ChangeId {
  const id = typeof body.id === 'string' ? parseChangeId(body.id) : undefined
  if (id === undefined) throw new RouteRefusal(400, 'BAD_REQUEST', 'Name the change by its id, such as c0123456789.')
  return id
}

/**
 * @param value - a field.
 * @returns the plugin's package name.
 * @throws {RouteRefusal} `400 BAD_REQUEST` for anything that is not a package name, before any path is built from it.
 */
function pluginOf(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME_PATTERN.test(value)) throw new RouteRefusal(400, 'BAD_REQUEST', 'Name the plugin by its package name.')
  return value
}

/**
 * @param value - the `confirmedRisk` field.
 * @returns whether the person confirmed the risk a second time.
 * @throws {RouteRefusal} `400 BAD_REQUEST` for a value that is not a boolean.
 */
function confirmedRiskOf(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw new RouteRefusal(400, 'BAD_REQUEST', 'confirmedRisk is true or false.')
  return value === true
}

/**
 * The second confirmation a change the checks flagged needs.
 * @param risk - the change's risk summary.
 * @param confirmed - whether the person confirmed it.
 * @throws {RouteRefusal} `409 CONFIRM_RISK` with the kinds and each file the diff does not show, until confirmed.
 */
function requireRiskConfirmation(risk: RiskSummary, confirmed: boolean): void {
  if (!risk.needsSecondConfirmation || confirmed) return
  throw new RouteRefusal(409, CONFIRM_RISK, `This change ${risk.kinds.map(kind => riskKindPhrase(kind).toLowerCase()).join('; ')}. A plugin's code can do anything Delo can. Confirm again to apply it.`, {
    kinds: risk.kinds,
    notShown: risk.findings.filter(finding => finding.kind === 'not-shown').map(finding => finding.excerpt),
  })
}

/**
 * The second confirmation every agent's plugin request needs before the studio applies it: Delo shows no content of
 * what it installs, which pnpm resolves from the spec when it runs, and an install, update or removal changes the
 * profile's dependencies.
 * @param entry - the request.
 * @param confirmed - whether the person confirmed it.
 * @throws {RouteRefusal} `409 CONFIRM_RISK` naming the spec, until confirmed.
 */
function requireRequestConfirmation(entry: ChangeEntry, confirmed: boolean): void {
  if (confirmed) return
  const spec = entry.subject.spec!
  const removes = entry.kind === 'plugin-remove'
  throw new RouteRefusal(409, CONFIRM_RISK, removes
    ? `This removes ${spec}, which the agent asked for. Confirm again to apply it.`
    : `This installs ${spec}, which the agent asked for, as pnpm resolves it; Delo does not show its content before it runs. A plugin's code can do anything Delo can. Confirm again to apply it.`, {
    kinds: removes ? ['dependency-or-build'] : ['dependency-or-build', 'not-shown'],
    notShown: removes ? [] : [spec],
  })
}

/**
 * @param risk - a risk summary.
 * @returns what the person reads of it.
 */
function riskView(risk: RiskSummary): RiskView {
  return {
    kinds: risk.kinds,
    phrases: risk.kinds.map(riskKindPhrase),
    needsSecondConfirmation: risk.needsSecondConfirmation,
    findings: risk.findings.map(finding => ({ kind: finding.kind, file: finding.file, ...finding.line === undefined ? {} : { line: finding.line }, excerpt: finding.excerpt })),
  }
}

/**
 * @param change - a change computed from a folder.
 * @returns what the person reads of it: no content version, path under the home or store name.
 */
function changeView(change: Omit<ListedChange, 'lastFailure'> & { readonly lastFailure?: ListedChange['lastFailure'] }): ChangeView {
  return {
    id: change.id,
    kind: change.kind,
    plugin: change.plugin,
    source: change.source,
    files: change.files.map(file => ({ path: file.path, status: file.status, binary: file.binary, dependency: file.dependency })),
    skipped: change.skipped,
    risk: riskView(change.risk),
    diff: { text: change.diff.text, truncated: change.diff.truncated, omitted: change.diff.omitted },
    ...change.lastFailure === undefined ? {} : { lastFailure: change.lastFailure },
  }
}

/**
 * @param entry - a logged change.
 * @returns what the person reads of it.
 */
function entryView(entry: ChangeEntry): EntryView {
  return {
    id: entry.id,
    kind: entry.kind,
    state: entry.state,
    summary: entry.summary,
    ...entry.subject.plugin === undefined ? {} : { plugin: entry.subject.plugin },
    ...entry.subject.spec === undefined ? {} : { spec: entry.subject.spec },
    createdAt: entry.createdAt,
    ...entry.decidedAt === undefined ? {} : { decidedAt: entry.decidedAt },
    ...entry.decidedFrom === undefined ? {} : { decidedFrom: entry.decidedFrom },
    ...entry.lastFailure === undefined ? {} : { lastFailure: entry.lastFailure },
    ...entry.leftOut === undefined ? {} : { leftOut: entry.leftOut },
    undoable: entry.state === 'applied' && (entry.kind === 'plugin-off' || entry.kind === 'plugin-on' || ((entry.kind === 'plugin-edit' || entry.kind === 'plugin-install') && !isPluginRequest(entry))),
  }
}

/**
 * @param entry - an entry of the log of changes to Delo itself.
 * @returns what the person reads of it, or undefined when it is not a decided change to a named file of a runtime.
 */
function harnessEntryView(entry: ChangeEntry): HarnessEntryView | undefined {
  const { file, runtime } = entry.subject
  if (entry.kind !== 'harness-edit' || file === undefined || runtime === undefined || entry.state === 'pending') return undefined
  return {
    id: entry.id,
    state: entry.state,
    file,
    runtime,
    summary: entry.summary,
    createdAt: entry.createdAt,
    ...entry.decidedAt === undefined ? {} : { decidedAt: entry.decidedAt },
    ...entry.leftOut === undefined ? {} : { leftOut: entry.leftOut },
  }
}

/**
 * The newest {@link RECENT_CHANGES} decided entries of a log, newest first; of two decided at the same time, the one
 * logged later first.
 * @param entries - the log's entries.
 * @param view - what the person reads of an entry; undefined leaves it out.
 * @returns the views.
 */
function newestDecided<V>(entries: readonly ChangeEntry[], view: (entry: ChangeEntry) => V | undefined): V[] {
  return entries
    .flatMap((entry, index) => {
      const shown = entry.state === 'pending' ? undefined : view(entry)
      return shown === undefined ? [] : [{ shown, index, at: Date.parse(entry.decidedAt ?? entry.createdAt) }]
    })
    .sort((left, right) => right.at - left.at || right.index - left.index)
    .slice(0, RECENT_CHANGES)
    .map(({ shown }) => shown)
}

/**
 * @param error - a thrown value.
 * @returns its words for the person.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The spellings of the Delo home's path an answer must not carry, and where words withheld from it are logged. */
interface HomeWords {
  readonly homes: readonly string[]
  readonly logger: RouteDependencies['logger']
}

/**
 * @param home - the Delo home the Host names.
 * @param logger - the Host's log.
 * @returns the home as the Host names it and, when that differs, its real path.
 */
function homeWords(home: string, logger: RouteDependencies['logger']): HomeWords {
  let real: string | undefined
  try {
    real = realpathSync(home)
  } catch (_unresolved) {
    // A home that does not resolve has only the spelling the Host names, which every failure under it carries.
    real = undefined
  }
  // The longer spelling first, so one that contains the other is replaced whole.
  return { homes: real === undefined || real === home ? [home] : [home, real].sort((a, b) => b.length - a.length), logger }
}

/**
 * The words of a failure as an answer carries them: unchanged unless they name the Delo home, otherwise
 * {@link HOME_WITHHELD_SENTENCE}, with the words in the Host log.
 * @param words - the failure's words.
 * @param code - the failure's code, or the part of the state that failed, for the log.
 * @param home - the home's spellings and the log; undefined before the route knows the profile.
 * @returns the words to answer with.
 */
function sayable(words: string, code: string, home: HomeWords | undefined): string {
  if (home === undefined || !home.homes.some(path => words.includes(path))) return words
  home.logger.warn(`changes route answered ${code} without its words, which name the Delo home: ${words}`)
  return HOME_WITHHELD_SENTENCE
}

/**
 * Replace the Delo home's path with {@link HOME_IN_ANSWERS} in every recorded failure's text of an answer.
 * @param value - the answer, or a part of it.
 * @param homes - the home's spellings.
 * @returns the answer with the same fields.
 */
function withoutHome(value: unknown, homes: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map(item => withoutHome(item, homes))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [
    key,
    FAILURE_FIELDS.has(key) && typeof field === 'string' ? homes.reduce((text, home) => text.replaceAll(home, HOME_IN_ANSWERS), field) : withoutHome(field, homes),
  ]))
}

/**
 * Read one part of the state; a part that cannot be read becomes a problem the screen names, so the rest still shows.
 * @param problems - where a failure is noted.
 * @param home - the home's spellings and the log.
 * @param what - the part, for the problem's sentence.
 * @param read - the reader.
 * @returns the part, or undefined when it cannot be read.
 */
async function part<T>(problems: string[], home: HomeWords, what: string, read: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    problems.push(`${what} cannot be read: ${sayable(messageOf(error), `"${what}"`, home)}`)
    return undefined
  }
}

/**
 * `GET state`: what failed at the last start, the changes left out at it, the plugins under Changes and the agent's
 * plugin requests waiting for review, the recent changes newest first with whether each can be undone, the recent
 * changes to Delo itself, the protection setting (the client says from it whether changes load without review), safe
 * mode, the work session, and whether the request is at the
 * computer, so the screen says so before an action is refused. It reads the records only: nothing is written and no
 * plugin's folder is read.
 * @param ctx - the profile.
 * @param atComputer - whether the request could act.
 * @param home - the home's spellings and the log.
 * @returns the state.
 */
async function stateOf(ctx: ChangesContext, atComputer: boolean, home: HomeWords): Promise<ChangesStateView> {
  const problems: string[] = []
  const boot = await part(problems, home, 'The record of the last start', () => readBootRecord(ctx.home, ctx.profile))
  const log = await part(problems, home, 'The change log', () => readChangeLog(ctx.home, ctx.profile))
  const protection = await part(problems, home, 'The protection setting', () => readProtection(ctx.home))
  const safeMode = await part(problems, home, 'The safe mode record', () => readSafeMode(ctx.home, ctx.profile))
  const workSession = await part(problems, home, 'The work session', () => workSessionFact(ctx.home, ctx.profile))
  const recorded = await part(problems, home, 'The changes waiting for review', () => recordedChanges(ctx))
  const harnessLog = await part(problems, home, 'The log of changes to Delo itself', () => readHarnessLog(ctx.home))
  const entries = log?.entries ?? []
  return {
    atComputer,
    profile: ctx.profile,
    ...protection === undefined ? {} : { protection },
    ...safeMode === undefined ? {} : { safeMode: { since: safeMode.since, reason: safeMode.reason, skipped: safeMode.skipped } },
    ...boot === undefined ? {} : {
      lastStart: {
        at: boot.at,
        ...boot.failure === undefined ? {} : { failure: boot.failure },
        plugins: boot.plugins.map(plugin => ({ plugin: plugin.plugin, loaded: plugin.loaded, ...plugin.error === undefined ? {} : { error: plugin.error } })),
      },
    },
    leftOut: entries.filter(entry => entry.state === 'left-out-at-start').map(entryView),
    folders: (recorded?.folders ?? []).map(({ plugin, source, kind }) => ({ plugin, source, kind })),
    requests: (recorded?.requests ?? []).map(entryView),
    recent: newestDecided(entries, entryView),
    harness: newestDecided(harnessLog?.entries ?? [], harnessEntryView),
    ...workSession === undefined ? {} : { workSession },
    problems,
  }
}

/**
 * `GET show`: one change by `?id=`, the open work session's folder against the content it started from by
 * `?work=<plugin>`, or every change of a plugin's folder waiting for review by `?pending`. Each reads the folders it
 * names and stores their content, as `delorun changes list` and `show` do.
 * @param ctx - the profile.
 * @param url - the request's URL.
 * @returns what the person reads.
 * @throws {RouteRefusal} `400 BAD_REQUEST` without exactly one well-formed query.
 */
async function shownOf(ctx: ChangesContext, url: URL): Promise<ShownView | WorkReviewView | PendingListView> {
  const names = [...url.searchParams.keys()]
  if (names.length !== 1 || (names[0] !== 'id' && names[0] !== 'work' && !(names[0] === 'pending' && url.searchParams.get('pending') === ''))) {
    throw new RouteRefusal(400, 'BAD_REQUEST', 'Ask for one change with ?id=<id>, the work session with ?work=<plugin>, or the changes waiting for review with ?pending.')
  }
  if (names[0] === 'pending') return { kind: 'pending-list', pending: (await listChanges(ctx)).pending.map(pendingView) }
  if (names[0] === 'work') return workView(await reviewWork(ctx, pluginOf(url.searchParams.get('work'))))
  const id = changeIdOf({ id: url.searchParams.get('id') })
  let shown: ShownChange
  try {
    shown = await showChange(ctx, id)
  } catch (error) {
    // An id no plugin's change has may name a change to Delo itself, which only the log of those changes holds.
    const harness = isChangesError(error) && error.code === 'UNKNOWN_CHANGE' ? await harnessShown(ctx.home, id) : undefined
    if (harness === undefined) throw error
    return harness
  }
  return shown.kind === 'pending' ? { kind: 'pending', change: changeView(shown.change) } : { kind: 'logged', entry: entryView(shown.entry) }
}

/**
 * A logged change to Delo itself with its files, risk summary and bounded diff, read from the store. Collection removes
 * the content of a change that was discarded or undone, and such a change is answered without its review.
 * @param home - the Delo home.
 * @param id - the change id.
 * @returns what the person reads, or undefined when the log of changes to Delo itself has no such decided change.
 * @throws {ChangesError} `RECORD_UNREADABLE` for a log that cannot be read; `STORE_CORRUPT` when the store lacks the
 *   content of a change that is neither discarded nor undone.
 */
async function harnessShown(home: string, id: ChangeId): Promise<ShownView | undefined> {
  const entry = (await readHarnessLog(home)).entries.find(candidate => candidate.id === id)
  const view = entry === undefined ? undefined : harnessEntryView(entry)
  if (entry === undefined || view === undefined) return undefined
  const change = loggedHarnessChange(entry)
  let review: HarnessReview | undefined
  try {
    review = change === undefined ? undefined : await reviewHarnessChange(home, change)
  } catch (error) {
    // The content of a discarded or undone change may be collected; anything else is a failure of the store.
    if (!isChangesError(error) || error.code !== 'STORE_CORRUPT' || (entry.state !== 'discarded' && entry.state !== 'undone')) throw error
  }
  return {
    kind: 'harness',
    entry: view,
    ...review === undefined ? {} : {
      review: {
        kind: 'harness-edit',
        files: review.files.map(file => ({ path: file.path, status: file.status, binary: file.binary, dependency: file.dependency })),
        risk: riskView(review.risk),
        diff: { text: review.diff.text, truncated: review.diff.truncated, omitted: review.diff.omitted },
      },
    },
  }
}

/**
 * Refuse an action on a change to Delo itself: only a terminal, which knows the signed file list of the runtime it
 * runs, applies, discards or undoes one. The refusal comes before any action runs.
 * @param home - the Delo home.
 * @param id - the change id the body names.
 * @param action - the action asked for.
 * @throws {RouteRefusal} `409 DECIDE_AT_TERMINAL` with the command when the log of changes to Delo itself has the id;
 *   {@link ChangesError} `RECORD_UNREADABLE` for a log that cannot be read.
 */
async function refuseHarnessChange(home: string, id: ChangeId, action: 'apply' | 'discard' | 'undo'): Promise<void> {
  if (!(await readHarnessLog(home)).entries.some(entry => entry.id === id)) return
  throw new RouteRefusal(409, DECIDE_AT_TERMINAL, `Change ${id} changes Delo itself, which you ${action} at a terminal: delorun changes ${action} ${id}`)
}

/**
 * @param change - a change computed from a folder.
 * @returns the line `show?pending` lists for it.
 */
function pendingView(change: ListedChange): PendingView {
  return {
    id: change.id,
    kind: change.kind,
    plugin: change.plugin,
    source: change.source,
    files: change.files.length,
    riskKinds: change.risk.kinds,
    ...change.lastFailure === undefined ? {} : { lastFailure: change.lastFailure },
  }
}

/**
 * @param review - what `done` shows.
 * @returns what the person reads of it; `version` is what `done` approves.
 */
function workView(review: WorkReview): WorkReviewView {
  return {
    kind: 'work',
    plugin: review.session.plugin,
    source: review.session.source,
    startedAt: review.session.startedAt,
    endsAt: review.session.endsAt,
    ...review.folder === undefined ? {} : { version: review.folder },
    failedToLoad: review.failedToLoad,
    ...review.change === undefined ? {} : { change: changeView(review.change) },
  }
}

/**
 * @param result - what an action that changes what the Host runs did.
 * @returns what the person reads.
 */
function actionView(result: ActionResult): ActionView {
  return { entry: entryView(result.entry), reload: result.reload }
}

/**
 * @param result - what applying an agent's plugin request did.
 * @returns what the person reads.
 */
function installView(result: InstallResult): InstallView {
  return { entry: entryView(result.entry), reload: result.reload, ...result.folderChange === undefined ? {} : { folderChange: result.folderChange } }
}

/**
 * @param started - what opening a work session did.
 * @returns what the person reads.
 */
function startedView(started: WorkStarted): StartedView {
  const { plugin, source, startedAt, endsAt } = started.session
  return { session: { plugin, source, startedAt, endsAt }, load: started.load.kind === 'went-back' ? { kind: 'went-back', failure: started.load.failure } : { kind: started.load.kind } }
}

/**
 * @param done - what ending a work session did.
 * @returns what the person reads.
 */
function doneView(done: WorkDone): DoneView {
  if (done.kind === 'went-back') return { kind: 'went-back', plugin: done.plugin, failure: done.load.failure }
  return { kind: 'ended', plugin: done.plugin, ...done.entry === undefined ? {} : { entry: entryView(done.entry) } }
}

/**
 * Run one of Create a plugin's actions for a request at the computer.
 * @param action - the route.
 * @param body - the request's body.
 * @param ctx - the profile.
 * @param dependencies - the release the scaffold targets and the file manager.
 * @returns what the person reads.
 * @throws {RouteRefusal} for a body the action does not take, a refused name or a plugin the studio did not create.
 */
async function createActionOf(action: 'create' | 'request' | 'reveal', body: Readonly<Record<string, unknown>>, ctx: ChangesContext, dependencies: RouteDependencies): Promise<CreatedView | RequestedView | RevealedView> {
  try {
    if (action === 'create') {
      onlyFields(body, ['name', 'kind', 'workspace'])
      return await createAction(dependencies.workspaces(), body as { readonly name: unknown, readonly kind: unknown, readonly workspace?: unknown }, dependencies.scaffold())
    }
    onlyFields(body, ['name', 'workspace'])
    const named = body as { readonly name: unknown, readonly workspace?: unknown }
    return action === 'request' ? await requestAction(ctx, dependencies.workspaces(), named, entryView) : await revealAction(dependencies.workspaces(), named, dependencies.reveal)
  } catch (error) {
    if (error instanceof CreateRefusal) throw new RouteRefusal(error.status, error.code, error.message)
    throw error
  }
}

/**
 * Run one action for a request at the computer.
 * @param action - the route.
 * @param body - the request's body.
 * @param ctx - the profile.
 * @param presence - the studio proof.
 * @param dependencies - the Host's reload and the installation's bundles.
 * @returns what the person reads.
 * @throws {RouteRefusal} for a body the action does not take, a change to Delo itself, an unconfirmed risk or agent's
 *   plugin request, or safe mode without the installation's bundles; {@link ChangesError} for a refusal of Changes.
 */
async function act(action: ChangesAction, body: Readonly<Record<string, unknown>>, ctx: ChangesContext, presence: AtComputer, dependencies: RouteDependencies): Promise<ActionView | InstallView | DiscardView | StartedView | DoneView | CreatedView | RequestedView | RevealedView | { readonly lines: readonly string[], readonly skipped: readonly string[] | undefined }> {
  const options = { reload: dependencies.reload }
  switch (action) {
    case 'apply': {
      onlyFields(body, ['id', 'confirmedRisk'])
      const id = changeIdOf(body)
      const confirmed = confirmedRiskOf(body.confirmedRisk)
      await refuseHarnessChange(ctx.home, id, action)
      const shown = await showChange(ctx, id)
      if (shown.kind === 'logged' && isPluginRequest(shown.entry)) {
        requireRequestConfirmation(shown.entry, confirmed)
        return installView(await applyInstallChange(ctx, id, presence, { reload: dependencies.reload, run: dependencies.pluginOperation(ctx) }))
      }
      if (shown.kind === 'pending') requireRiskConfirmation(shown.change.risk, confirmed)
      return actionView(await applyChange(ctx, id, presence, options))
    }
    case 'discard':
    case 'undo': {
      onlyFields(body, ['id', 'confirmedRisk'])
      const id = changeIdOf(body)
      confirmedRiskOf(body.confirmedRisk)
      await refuseHarnessChange(ctx.home, id, action)
      return action === 'discard' ? { entry: entryView(await discardChange(ctx, id, presence)) } : actionView(await undoChange(ctx, id, presence, options))
    }
    case 'off':
    case 'on':
      onlyFields(body, ['plugin'])
      return actionView(await (action === 'off' ? turnOff : turnOn)(ctx, pluginOf(body.plugin), presence, options))
    case 'work': {
      onlyFields(body, ['plugin', 'minutes'])
      const minutes = body.minutes ?? WORK_SESSION_DEFAULT_MINUTES
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > WORK_SESSION_MAX_MINUTES) {
        throw new RouteRefusal(400, 'BAD_REQUEST', `A work session lasts whole minutes from 1 to ${String(WORK_SESSION_MAX_MINUTES)}.`)
      }
      return startedView(await startWork(ctx, pluginOf(body.plugin), presence, { ...options, minutes }))
    }
    case 'done': {
      onlyFields(body, ['plugin', 'version', 'confirmedRisk'])
      const plugin = pluginOf(body.plugin)
      if (typeof body.version !== 'string' || !CONTENT_VERSION_PATTERN.test(body.version)) throw new RouteRefusal(400, 'BAD_REQUEST', 'Name the version you were shown: the work session\'s version from show?work=<plugin>.')
      const version = body.version as ContentVersion
      const confirmed = confirmedRiskOf(body.confirmedRisk)
      const review = await reviewWork(ctx, plugin)
      if (review.folder !== version) throw new RouteRefusal(409, CHANGED_SINCE_REVIEW, `The folder of ${plugin} changed since you were shown it; look at it again.`)
      if (review.change !== undefined) requireRiskConfirmation(review.change.risk, confirmed)
      return doneView(await finishWork(ctx, plugin, presence, { ...options, approve: version }))
    }
    case 'create':
    case 'request':
    case 'reveal':
      return createActionOf(action, body, ctx, dependencies)
    case 'safe-mode': {
      onlyFields(body, [])
      if (dependencies.installationBundles.length === 0) throw new RouteRefusal(503, 'SAFE_MODE_UNAVAILABLE', 'This composition names no bundles of the installation, so safe mode starts from a terminal: delorun recover safe-mode')
      const report = await recover({
        profileDir: ctx.profileDir,
        homeDir: ctx.home,
        profile: ctx.profile,
        action: { kind: 'safe-mode', reason: 'the person asked for safe mode in the studio' },
        installationBundles: dependencies.installationBundles,
        changedBy: { kind: 'person' },
      })
      return { lines: report.lines, skipped: report.skipped }
    }
  }
}

/**
 * Admit a request and decide where it arrived; refuse one without the studio's credential.
 * @param request - the request.
 * @param response - the response.
 * @param connection - Connection's admission.
 * @param loopbackPort - the loopback listener's bound port.
 * @returns the arrival and a rolled credential, or undefined when the request was answered.
 */
function admitted(request: IncomingMessage, response: ServerResponse, connection: RouteConnection, loopbackPort: LoopbackPort): { readonly arrival: StudioArrival, readonly setCookie?: string } | undefined {
  const admission = connection.admit(request)
  if ('rejection' in admission) {
    sendRefusal(response, admission.rejection === 401
      ? new RouteRefusal(401, 'NOT_SIGNED_IN', 'Open the studio with delorun open, then try again.')
      : new RouteRefusal(403, 'FORBIDDEN', 'The studio does not answer this address or page.'))
    return undefined
  }
  const arrival = arrivalOf(request, loopbackPort, true, connection.isReachPeer(admission.peer))
  return { arrival, ...admission.setCookie === undefined ? {} : { setCookie: admission.setCookie } }
}

/**
 * Answer a failure of a route: a refusal with its status, a refusal of Changes or profile safety as a conflict or as
 * its own status, and anything else as `500 INTERNAL`, reported to the Host's log. A refusal whose words name the Delo
 * home answers its code and {@link HOME_WITHHELD_SENTENCE}.
 * @param response - the response.
 * @param error - what was thrown.
 * @param dependencies - the log.
 * @param home - the home's spellings, once the route knows the profile.
 * @param setCookie - a rolled credential the admission issued.
 */
function sendThrown(response: ServerResponse, error: unknown, dependencies: RouteDependencies, home: HomeWords | undefined, setCookie?: string): void {
  if (error instanceof RouteRefusal) return sendRefusal(response, error, setCookie)
  if (isChangesError(error)) return sendRefusal(response, new RouteRefusal(CHANGES_STATUS[error.code], error.code, sayable(error.detail, error.code, home)), setCookie)
  if (isProfileSafetyError(error)) return sendRefusal(response, new RouteRefusal(409, error.code, sayable(error.message, error.code, home)), setCookie)
  dependencies.logger.warn(`changes route failed: ${messageOf(error)}`)
  sendRefusal(response, new RouteRefusal(500, 'INTERNAL', 'Delo could not answer; the Host log says why.'), setCookie)
}

/**
 * @param dependencies - what the routes reach.
 * @returns the profile.
 * @throws {RouteRefusal} `503 NO_PROFILE` when the Host runs no profile.
 */
function profileOf(dependencies: RouteDependencies): ChangesContext {
  const ctx = dependencies.profile()
  if (ctx === undefined) throw new RouteRefusal(503, 'NO_PROFILE', 'This harness runs no profile whose changes Delo keeps.')
  return ctx
}

/**
 * `GET workspaces`: where Create a plugin may put a plugin.
 * @param workspaces - the registry's workspaces, the default first.
 * @param atComputer - whether the request is at the computer.
 * @returns the answer.
 */
function workspacesOf(workspaces: readonly WorkspaceChoice[], atComputer: boolean): WorkspacesView {
  return { atComputer, workspaces: workspaces.map(({ id, title, path }) => ({ id, title, path })) }
}

/**
 * Build a reading route: `state` or `show`. Any admitted session reads, a remote one included.
 * @param read - what the route answers.
 * @param dependencies - what the routes reach.
 * @returns the handler.
 */
function readingRoute(read: (ctx: ChangesContext, url: URL, atComputer: boolean, home: HomeWords) => Promise<object>, dependencies: RouteDependencies): RouteHandler {
  return async (request, response) => {
    const admission = admitted(request, response, dependencies.connection, dependencies.loopbackPort)
    if (admission === undefined) return
    let home: HomeWords | undefined
    try {
      if (request.method !== 'GET') throw new RouteRefusal(405, 'METHOD_NOT_ALLOWED', 'Read Changes with a GET.')
      const ctx = profileOf(dependencies)
      home = homeWords(ctx.home, dependencies.logger)
      sendJson(response, 200, withoutHome(await read(ctx, new URL(String(request.url), 'http://studio.invalid'), atComputer(admission.arrival), home), home.homes), admission.setCookie)
    } catch (error) {
      sendThrown(response, error, dependencies, home, admission.setCookie)
    }
  }
}

/**
 * Build one action route. The arrival and the site are decided before the body is read.
 * @param action - the action.
 * @param dependencies - what the routes reach.
 * @returns the handler.
 */
function actionRoute(action: ChangesAction, dependencies: RouteDependencies): RouteHandler {
  return async (request, response) => {
    const admission = admitted(request, response, dependencies.connection, dependencies.loopbackPort)
    if (admission === undefined) return
    let home: HomeWords | undefined
    try {
      if (request.method !== 'POST') throw new RouteRefusal(405, 'METHOD_NOT_ALLOWED', 'Changes are made with a POST.')
      if (!atComputer(admission.arrival)) throw new RouteRefusal(403, LOOPBACK_REQUIRED, LOOPBACK_REQUIRED_SENTENCE)
      const presence = attestStudio(admission.arrival)
      if (isCrossSite(request)) throw new RouteRefusal(403, 'CROSS_SITE', 'Another site cannot change what your harness runs.')
      const ctx = profileOf(dependencies)
      home = homeWords(ctx.home, dependencies.logger)
      const body = await readBody(request)
      sendJson(response, 200, withoutHome(await act(action, body, ctx, presence, dependencies), home.homes), admission.setCookie)
    } catch (error) {
      sendThrown(response, error, dependencies, home, admission.setCookie)
    }
  }
}

/** One route and its handler, as the web server registers it. */
export interface ChangesRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: RouteHandler
}

/**
 * Every Changes route.
 * @param dependencies - what the routes reach.
 * @returns the routes, `state` and `show` first.
 */
export function changesRoutes(dependencies: RouteDependencies): readonly ChangesRoute[] {
  return [
    { kind: 'exact', path: STATE_PATH, handler: readingRoute((ctx, _url, atComputer, home) => stateOf(ctx, atComputer, home), dependencies) },
    { kind: 'exact', path: SHOW_PATH, handler: readingRoute((ctx, url) => shownOf(ctx, url), dependencies) },
    { kind: 'exact', path: WORKSPACES_PATH, handler: readingRoute((_ctx, _url, atComputer) => Promise.resolve(workspacesOf(dependencies.workspaces(), atComputer)), dependencies) },
    ...(Object.keys(ACTION_PATHS) as ChangesAction[]).map((action): ChangesRoute => ({ kind: 'exact', path: ACTION_PATHS[action], handler: actionRoute(action, dependencies) })),
  ]
}
