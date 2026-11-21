/**
 * The studio's Changes routes (contract C21, "Routes and the recovery screen"): what failed at the last start, the
 * recent changes and one change, read by any session the studio admits, and the actions: apply, discard and undo a
 * plugin's change or a change to Delorun itself, turn a plugin off or on, open and end a work session, safe mode, make
 * the person's copy of Delorun, and turn protection on or off.
 * Applying an agent's plugin request runs the plugin operation the Host names (`@delorun/changes`' shared operation) with
 * `applyInstallChange`, after a second confirmation that names its spec: what it installs is not shown before it runs.
 *
 * Every request is first admitted by Connection (`ctx.connection.admit`): the Host/Origin fence, then the studio's
 * signed cookie or the authenticator provider, so a caller without the studio's credential is answered 401 or 403 and
 * nothing else runs. A `POST` is then decided before its body is read, in this order: a browser request from another
 * site is answered `403 CROSS_SITE` (at the computer: `Sec-Fetch-Site`, or an `Origin` that is not the request's own
 * loopback origin; from a paired device: an `Origin` that is not the device's own studio address); then the control's
 * level ([access](./access.ts)) decides who may act. The person at the computer is attested with `attestStudio`: the
 * loopback listener under a loopback `Host`, admitted with the credential and not for a remote session. A paired device
 * is attested with `attestDevice` only when the control's level lets a device use it and the device holds a grant for
 * exactly the call or, for a control a device may take with an unlock, an unlock the person entered (a code or a PIN; the
 * approval grace never counts); otherwise it is answered `403 LOOPBACK_REQUIRED` or `403 ELEVATION_REQUIRED`. Only then is the body read, at most {@link MAX_BODY_BYTES}.
 * A proof is no barrier to code running inside the Host; it records where the person decided.
 *
 * `state` reads only the records: it writes nothing and reads no plugin's folder, so the studio's repeated reads and a
 * remote session's cost nothing. Only `show` reads folders and the person's copy of Delorun, computes diffs and stores
 * their content.
 *
 * A change to Delorun itself is decided on the harness routes against the running runtime's signed file list, which the
 * home process gives the Host (`changesHarness`); a Host without it, such as one run from a source checkout, answers
 * `409 HARNESS_UNAVAILABLE`. `harness-apply` takes the full content version the review showed and refuses another.
 * The plugin action routes refuse a change to Delorun itself with `409 HARNESS_ROUTE`. Turning protection off asks a
 * second time (`409 CONFIRM_PROTECTION` with what would load without review); that second ask stops a misclick, not an
 * attacker.
 *
 * Every answer is JSON with `cache-control: no-store`; file names, diffs, summaries and failures travel as JSON strings
 * that the screen renders as text. No answer names the Delorun home's path: a refusal or an unreadable part whose words
 * name it answers its code, or names the part, with {@link HOME_WITHHELD_SENTENCE}, and the Host log keeps the words; a recorded failure's
 * text names the home as {@link HOME_IN_ANSWERS}.
 *
 * @module @delorun/plugin-changes/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  applyChange,
  applyHarnessChange,
  applyInstallChange,
  attestDevice,
  attestStudio,
  changeProtection,
  countUnreviewedSinceOff,
  createHarnessCopy,
  discardHarnessChange,
  dismissNotice,
  harnessChanges,
  harnessCopyDirectory,
  pathExists,
  readNotices,
  showHarnessChange,
  undoHarnessChange,
  unreviewedSinceOff,
  CONTENT_VERSION_PATTERN,
  discardChange,
  finishWork,
  isAgentAction,
  isChangesError,
  isPluginRequest,
  listChanges,
  loggedHarnessChange,
  PACKAGE_NAME_PATTERN,
  parseChangeId,
  readBootRecord,
  readAgentLog,
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
  withAgentEntries,
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
  type HarnessContext,
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
} from '@delorun/changes'
import { isForeignFetchSite, isSameLoopbackOrigin, listenerOf, loopbackAddressOf, type LoopbackPort, type StampedRequest } from '@delorun/home'
import { GRANT_BODY_CAP_BYTES } from '@delorun/home-auth'
import { HOME_IN_ANSWERS, homeSpellings, withHomePlaceholder } from './home-words.ts'
import { accessView, CONTROL_LEVELS, mayUse, type FaceState } from './access.ts'
import { isProfileSafetyError, readSafeMode, recover } from '@delorun/profile-safety'
import {
  type AccessView,
  ACTION_PATHS,
  CHANGED_SINCE_REVIEW,
  CONFIRM_PROTECTION,
  CONFIRM_RISK,
  ELEVATION_REQUIRED,
  HARNESS_PATHS,
  HARNESS_ROUTE,
  HARNESS_UNAVAILABLE,
  LOOPBACK_REQUIRED,
  NOTICE_SEEN_PATH,
  PROTECTION_PATHS,
  SHOW_PATH,
  SETUP_PATHS,
  STATE_PATH,
  WORKSPACES_PATH,
  type ActionView,
  type ActorView,
  type ChangesAction,
  type ChangesControl,
  type ChangesStateView,
  type ChangeView,
  type CreatedView,
  type DiscardView,
  type DoneView,
  type EntryView,
  type HarnessActionView,
  type HarnessAction,
  type HarnessAvailableView,
  type HarnessCopyView,
  type HarnessDiscardView,
  type HarnessEffectView,
  type HarnessEntryView,
  type HarnessPendingView,
  type HarnessReviewView,
  type InstallView,
  type PendingListView,
  type PendingView,
  type ProtectionChangedView,
  type RequestedView,
  type RestartStateView,
  type RevealedView,
  type RiskView,
  type ShownView,
  type StartedView,
  type WorkReviewView,
  type WorkspacesView,
} from './wire.ts'
import { createAction, CreateRefusal, requestAction, revealAction, type ScaffoldTarget, type WorkspaceChoice } from './create-actions.ts'
import { applySetupImport } from '@delorun/changes/setup-transfer'
import { applySetup, exportSetup, HeldSetups, inspectSetup, listSetupPlugins, MAX_SETUP_FILE_BYTES, SetupRefusal } from './setup-actions.ts'

export { ACTION_PATHS, CHANGES_ROUTE_PREFIX, HARNESS_PATHS, NOTICE_SEEN_PATH, PROTECTION_PATHS, SETUP_PATHS, SHOW_PATH, STATE_PATH, WORKSPACES_PATH, type ChangesAction } from './wire.ts'

/** The largest body an action reads, in bytes; a body names one change or plugin. */
export const MAX_BODY_BYTES = 16 * 1024

/** How many logged changes `state` returns of a profile's log and of the log of changes to Delorun itself, newest first. */
export const RECENT_CHANGES = 20

/** The sentence a request that is not at the computer is answered with. */
export const LOOPBACK_REQUIRED_SENTENCE = 'This needs you at your computer.'

/** The sentence a paired device is answered with when an action needs its confirmation for that call. */
export const ELEVATION_REQUIRED_SENTENCE = 'Confirm this with Face ID or your PIN when asked, or do it at your computer.'

/** The sentence a device reads when a control needs Face ID or a PIN for this call. */
export const FACE_REQUIRED_SENTENCE = 'Confirm with Face ID or your PIN first.'

/** The sentence that stands for a failure's words when they name the Delorun home's path, which the Host log keeps. */
export const HOME_WITHHELD_SENTENCE = 'Its details name files Delorun keeps; the Host log has them.'

export { HOME_IN_ANSWERS }

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
  /**
   * The Delorun version a setup file names as its writer.
   * @returns the version.
   */
  readonly delorunVersion: () => string
  /** The paired devices, from the mounted `homeAuth` service. */
  readonly devices: RouteDevices
  /**
   * The running runtime's harness, which the home process gives the Host.
   * @returns it, or undefined when the Host does not run an installed release under `delorun start`.
   */
  readonly harness: () => HarnessContext | undefined
  /**
   * When a decided change to Delorun itself takes effect: live, or after a restart. Called after its log entry is written.
   * @param entry - the applied or undone entry.
   * @returns the effect.
   */
  readonly harnessEffect: (entry: ChangeEntry) => Promise<HarnessEffectView>
  /**
   * Whether a restart is needed, under way or failed ([restart route](./restart-route.ts)).
   * @returns the view, or undefined when none of these holds or this Host cannot restart itself.
   */
  readonly restartState: () => Promise<RestartStateView | undefined>
  /** Forget the last restart's failure, as each decision about a change to Delorun itself does. */
  readonly clearRestartFailure: () => void
}

/** A paired device as the routes see it. */
export interface RouteDevice {
  readonly id: string
  /** The name the person gave it. */
  readonly label: string
  /** `fresh`: an unlock the person entered (a code or a PIN page); `grace`: only the approval grace; `none`: locked. */
  readonly unlock: 'fresh' | 'grace' | 'none'
  /** Renew the device's sliding unlock after an action it was needed for. */
  readonly renew: () => void
  /** The device's Face ID grants. Absent while no `homeAuth` is mounted. */
  readonly face?: FaceAccess
}

/** What a route reads of the home's Face ID grants for one device. */
export interface FaceAccess {
  /** Whether the home keeps a grant store, so it asks for a grant. */
  readonly enabled: boolean
  /** Whether the device holds a passkey. A device with one is admitted by a grant alone. */
  readonly hasPasskey: boolean
  /**
   * Use up the grant for exactly one call.
   * @param action - the grant's action name.
   * @param call - the method, the path as received and the body bytes the route read itself.
   * @param grantId - the `Delorun-Grant` header's value.
   * @returns whether a live grant for this action and this method, path and body was used up and the header names it.
   */
  readonly take: (action: string, call: { readonly method: string, readonly path: string, readonly body: Uint8Array }, grantId: string | undefined) => boolean
}

/** What the routes read of paired devices. */
export interface RouteDevices {
  /**
   * The paired device a remote session speaks for.
   * @param peer - the admitted session.
   * @returns the device, or undefined for a session that is not a paired device's.
   */
  readonly deviceOf: (peer: object) => Promise<RouteDevice | undefined>
}

/** Where an admitted request came from. */
type Requester =
  | { readonly kind: 'computer' }
  | { readonly kind: 'device', readonly device: RouteDevice }
  | { readonly kind: 'other' }

/** A refusal a route answers with: its status, its code and the sentence the person reads. */
export class RouteRefusal extends Error {
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
  SETUP_REFUSED: 422,
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
 * Whether a paired device's browser sent the request from another site: its `Sec-Fetch-Site` names another site, or its
 * `Origin` is absent or is not the device's own studio address, `https://` and the `Host` the reach listener checked.
 * @param request - the request.
 * @returns true for a request the device's own studio page did not make.
 */
export function isCrossSiteDevice(request: IncomingMessage): boolean {
  if (isForeignFetchSite(header(request, 'sec-fetch-site'))) return true
  const origin = header(request, 'origin')
  const host = header(request, 'host')
  return origin === undefined || host === undefined || origin !== `https://${host}`
}

/**
 * Where an admitted request came from: the person at the computer, a paired device, or neither.
 * @param admission - the arrival and the admitted session.
 * @param devices - the paired devices.
 * @returns the requester.
 */
async function requesterOf(admission: { readonly arrival: StudioArrival, readonly peer: object }, devices: RouteDevices): Promise<Requester> {
  if (atComputer(admission.arrival)) return { kind: 'computer' }
  if (!admission.arrival.remoteSession) return { kind: 'other' }
  const device = await devices.deviceOf(admission.peer)
  return device === undefined ? { kind: 'other' } : { kind: 'device', device }
}

/**
 * @param requester - where a request came from.
 * @returns the actor `state` names.
 */
function actorOf(requester: Requester): ActorView {
  if (requester.kind === 'computer') return 'computer'
  if (requester.kind === 'other') return 'device-locked'
  return requester.device.unlock === 'fresh' ? 'device-unlocked' : requester.device.unlock === 'grace' ? 'device-grace' : 'device-locked'
}

/**
 * @param requester - where a request came from.
 * @returns what the home asks this requester for Face ID: whether the home keeps a grant store, and whether a device holds a passkey.
 */
function faceStateOf(requester: Requester): FaceState {
  const face = requester.kind === 'device' ? requester.device.face : undefined
  return { enabled: face?.enabled === true, hasPasskey: face?.hasPasskey === true }
}

/**
 * Decide a `POST` before its body is parsed: the site, then the control's class, then the proof. A `face` control with a grant store reads the raw body, at most the grant cap, to check the grant against it.
 * @param request - the request.
 * @param admission - the arrival and the admitted session.
 * @param control - the control the route is.
 * @param devices - the paired devices.
 * @returns the proof, and a renewal of the device's unlock to run once the action succeeded.
 * @throws {RouteRefusal} `403 CROSS_SITE`; `403 LOOPBACK_REQUIRED` when the control stays at the computer for this
 *   request; `403 ELEVATION_REQUIRED` for a device without a grant for this call, with `{ action }` naming the grant's
 *   action (`changes/<control>`) where a grant can lift it.
 */
async function gate(request: IncomingMessage, admission: { readonly arrival: StudioArrival, readonly peer: object }, control: ChangesControl, devices: RouteDevices): Promise<{ readonly presence: AtComputer, readonly renew: () => void }> {
  const requester = await requesterOf(admission, devices)
  if (requester.kind === 'device' ? isCrossSiteDevice(request) : isCrossSite(request)) throw new RouteRefusal(403, 'CROSS_SITE', 'Another site cannot change what your harness runs.')
  if (requester.kind === 'computer') return { presence: attestStudio(admission.arrival), renew: () => {} }
  if (requester.kind === 'other') throw new RouteRefusal(403, LOOPBACK_REQUIRED, LOOPBACK_REQUIRED_SENTENCE)
  const { device } = requester
  const face = device.face
  const may = mayUse(actorOf(requester), control, faceStateOf(requester))
  // A control that stays at the computer (the home keeps no grant store) is refused before any grant is looked up.
  if (!may.ok && may.needs === 'computer') throw new RouteRefusal(403, LOOPBACK_REQUIRED, LOOPBACK_REQUIRED_SENTENCE)
  // With a grant store, a grant for exactly this call admits any device; one for another body, path or control does not.
  if (CONTROL_LEVELS[control] === 'face' && face?.enabled === true) {
    const header = request.headers['delorun-grant']
    // A body over the grant cap cannot be hashed, so no grant covers it; its stream is left unread for the route's own limit.
    if (!oversized(request)) {
      const bytes = await bodyBytes(request, GRANT_BODY_CAP_BYTES)
      if (face.take(`changes/${control}`, { method: 'POST', path: pathAndQueryOf(request), body: bytes }, typeof header === 'string' ? header : undefined)) {
        return { presence: attestDevice({ remoteSession: true, device: { id: device.id, label: device.label }, freshUnlock: true }), renew: () => {} }
      }
    }
  }
  if (!may.ok) {
    throw may.needs === 'computer'
      ? new RouteRefusal(403, LOOPBACK_REQUIRED, LOOPBACK_REQUIRED_SENTENCE)
      // A face refusal names the grant's action, so the client knows what to confirm; the body holds no secret or hash.
      : may.needs === 'face' ? new RouteRefusal(403, ELEVATION_REQUIRED, FACE_REQUIRED_SENTENCE, oversized(request) ? {} : { action: `changes/${control}` }) : new RouteRefusal(403, ELEVATION_REQUIRED, ELEVATION_REQUIRED_SENTENCE)
  }
  return { presence: attestDevice({ remoteSession: true, device: { id: device.id, label: device.label }, freshUnlock: device.unlock === 'fresh', ...CONTROL_LEVELS[control] === 'free' ? { freeControl: true as const } : {} }), renew: device.renew }
}

/**
 * @param request - the request.
 * @returns whether its declared body is over the grant cap, so no grant can cover it.
 */
function oversized(request: IncomingMessage): boolean {
  return Number(request.headers['content-length'] ?? '0') > GRANT_BODY_CAP_BYTES
}

/**
 * @param request - the request.
 * @returns the path and query as received, which a grant is hashed over.
 */
function pathAndQueryOf(request: IncomingMessage): string {
  const url = new URL(String(request.url), 'http://studio.invalid')
  return url.pathname + url.search
}

/** The bodies a gate already read, so the route reads the same bytes the grant was checked against. */
const READ_BODIES = new WeakMap<IncomingMessage, Buffer>()

/**
 * Read a request's raw body once, at most `limit` bytes.
 * @param request - the request.
 * @param limit - the most bytes the body may hold.
 * @returns the bytes; a later call for the same request returns the same bytes.
 * @throws {RouteRefusal} `413 BODY_TOO_LARGE` when the body is larger than `limit`.
 */
async function bodyBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const known = READ_BODIES.get(request)
  if (known !== undefined) {
    if (known.length > limit) throw tooLarge(limit)
    return known
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw tooLarge(limit)
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  READ_BODIES.set(request, bytes)
  return bytes
}

/**
 * @param limit - the limit a body exceeded.
 * @returns the refusal.
 */
function tooLarge(limit: number): RouteRefusal {
  return new RouteRefusal(413, 'BODY_TOO_LARGE', tooLargeSentence(limit))
}

/**
 * @param limit - the limit a body exceeded.
 * @returns what the person reads: the limit of a request that names one change or plugin, of a setup file, or of the body a Face ID confirmation covers.
 */
function tooLargeSentence(limit: number): string {
  switch (limit) {
    case MAX_BODY_BYTES: return `A request names one change or plugin in at most ${String(MAX_BODY_BYTES)} bytes.`
    case MAX_SETUP_BODY_BYTES: return `A setup file larger than ${String(MAX_SETUP_FILE_BYTES / 1024 / 1024)} MiB is imported with delorun setup import.`
    default: return `A request over ${String(limit / 1024 / 1024)} MiB cannot carry a Face ID confirmation.`
  }
}

/**
 * Read a request's JSON object body, at most {@link MAX_BODY_BYTES} unless the route names another limit.
 * @param request - the request.
 * @param limit - the most bytes the body may hold.
 * @returns the object; an empty body reads as `{}`.
 * @throws {RouteRefusal} `413 BODY_TOO_LARGE` or `400 BAD_REQUEST` for a body that is not one JSON object.
 */
async function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Readonly<Record<string, unknown>>> {
  const text = (await bodyBytes(request, limit)).toString('utf8')
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
export function onlyFields(body: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
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
  throw new RouteRefusal(409, CONFIRM_RISK, `This change ${risk.kinds.map(kind => riskKindPhrase(kind).toLowerCase()).join('; ')}. A plugin's code can do anything Delorun can. Confirm again to apply it.`, {
    kinds: risk.kinds,
    notShown: risk.findings.filter(finding => finding.kind === 'not-shown').map(finding => finding.excerpt),
  })
}

/**
 * The second confirmation every agent's plugin request needs before the studio applies it: Delorun shows no content of
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
    : `This installs ${spec}, which the agent asked for, as pnpm resolves it; Delorun does not show its content before it runs. A plugin's code can do anything Delorun can. Confirm again to apply it.`, {
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
    ...entry.decidedOn === undefined ? {} : { decidedOn: entry.decidedOn.label },
    ...entry.lastFailure === undefined ? {} : { lastFailure: entry.lastFailure },
    ...entry.leftOut === undefined ? {} : { leftOut: entry.leftOut },
    undoable: entry.state === 'applied' && (entry.kind === 'plugin-off' || entry.kind === 'plugin-on' || isUndoableAgentAction(entry) || ((entry.kind === 'plugin-edit' || entry.kind === 'plugin-install') && !isPluginRequest(entry))),
  }
}

/**
 * @param entry - a log entry.
 * @returns whether it is an agent's action that `undoAgentAction` can restore: one that holds the profile versions on both sides of it.
 */
function isUndoableAgentAction(entry: ChangeEntry): boolean {
  return isAgentAction(entry) && entry.historyVersion !== undefined && entry.historyBefore !== undefined
}

/**
 * @param entry - an entry of the log of changes to Delorun itself.
 * @param running - the runtime this Host runs, whose applied changes the harness routes undo; undefined without one.
 * @returns what the person reads of it, or undefined when it is not a decided change to a named file of a runtime.
 */
function harnessEntryView(entry: ChangeEntry, running: string | undefined): HarnessEntryView | undefined {
  const { file, runtime } = entry.subject
  if (entry.kind !== 'harness-edit' || file === undefined || runtime === undefined || entry.state === 'pending') return undefined
  return {
    undoable: runtime === running && (entry.state === 'applied' || entry.state === 'left-out-at-start'),
    ...entry.decidedFrom === undefined ? {} : { decidedFrom: entry.decidedFrom },
    ...entry.decidedOn === undefined ? {} : { decidedOn: entry.decidedOn.label },
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

/** The spellings of the Delorun home's path an answer must not carry, and where words withheld from it are logged. */
interface HomeWords {
  readonly homes: readonly string[]
  readonly logger: RouteDependencies['logger']
}

/**
 * @param home - the Delorun home the Host names.
 * @param logger - the Host's log.
 * @returns the home as the Host names it and, when that differs, its real path.
 */
function homeWords(home: string, logger: RouteDependencies['logger']): HomeWords {
  return { homes: homeSpellings(home), logger }
}

/**
 * The words of a failure as an answer carries them: unchanged unless they name the Delorun home, otherwise
 * {@link HOME_WITHHELD_SENTENCE}, with the words in the Host log.
 * @param words - the failure's words.
 * @param code - the failure's code, or the part of the state that failed, for the log.
 * @param home - the home's spellings and the log; undefined before the route knows the profile.
 * @returns the words to answer with.
 */
function sayable(words: string, code: string, home: HomeWords | undefined): string {
  if (home === undefined || !home.homes.some(path => words.includes(path))) return words
  home.logger.warn(`changes route answered ${code} without its words, which name the Delorun home: ${words}`)
  return HOME_WITHHELD_SENTENCE
}

/**
 * Replace the Delorun home's path with {@link HOME_IN_ANSWERS} in every recorded failure's text of an answer.
 * @param value - the answer, or a part of it.
 * @param homes - the home's spellings.
 * @returns the answer with the same fields.
 */
function withoutHome(value: unknown, homes: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map(item => withoutHome(item, homes))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [
    key,
    FAILURE_FIELDS.has(key) && typeof field === 'string' ? withHomePlaceholder(field, homes) : withoutHome(field, homes),
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
 * changes to Delorun itself, the protection setting (the client says from it whether changes load without review), safe
 * mode, the work session, whether this Host can change Delorun's own files, how many changes loaded without review since
 * protection was turned off, the notices of a device's protection changes (to the computer only), and what this request
 * may use, so the screen says so before an action is refused. It reads the records only: nothing is written and no
 * plugin's folder or copy of Delorun is read.
 * @param ctx - the profile.
 * @param requester - where the request came from.
 * @param home - the home's spellings and the log.
 * @param dependencies - the running runtime's harness and the paired devices.
 * @returns the state.
 */
async function stateOf(ctx: ChangesContext, requester: Requester, home: HomeWords, dependencies: RouteDependencies): Promise<ChangesStateView> {
  const problems: string[] = []
  const boot = await part(problems, home, 'The record of the last start', () => readBootRecord(ctx.home, ctx.profile))
  const log = await part(problems, home, 'The change log', () => readChangeLog(ctx.home, ctx.profile))
  const agentLog = await part(problems, home, 'The log of the agent\'s plugin actions', () => readAgentLog(ctx.home, ctx.profile))
  const protection = await part(problems, home, 'The protection setting', () => readProtection(ctx.home))
  const safeMode = await part(problems, home, 'The safe mode record', () => readSafeMode(ctx.home, ctx.profile))
  const workSession = await part(problems, home, 'The work session', () => workSessionFact(ctx.home, ctx.profile))
  const recorded = await part(problems, home, 'The changes waiting for review', () => recordedChanges(ctx))
  const harnessLog = await part(problems, home, 'The log of changes to Delorun itself', () => readHarnessLog(ctx.home))
  const notices = requester.kind === 'computer' ? await part(problems, home, 'The notices', () => readNotices(ctx.home)) : []
  const harness = dependencies.harness()
  const restart = await part(problems, home, 'Whether Delorun needs a restart', () => dependencies.restartState())
  const entries = log === undefined ? agentLog?.entries ?? [] : withAgentEntries(log, agentLog?.entries ?? []).entries
  return {
    atComputer: requester.kind === 'computer',
    access: accessView(actorOf(requester), faceStateOf(requester)),
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
    harness: newestDecided(harnessLog?.entries ?? [], entry => harnessEntryView(entry, harness?.runtime)),
    harnessAvailable: harness === undefined ? { kind: 'unavailable' } : { kind: 'available', runtime: harness.runtime, copy: await pathExists(harnessCopyDirectory(harness.home, harness.runtime)) } satisfies HarnessAvailableView,
    unreviewedSinceOff: countUnreviewedSinceOff(entries, harnessLog?.entries ?? []),
    notices: (notices ?? []).map(notice => ({ id: notice.id, level: notice.level, at: notice.at, device: notice.device })),
    ...workSession === undefined ? {} : { workSession },
    ...restart === undefined ? {} : { restart },
    problems,
  }
}

/**
 * `GET show`: one change by `?id=`, the open work session's folder against the content it started from by
 * `?work=<plugin>`, or every change of a plugin's folder waiting for review by `?pending`. Each reads the folders it
 * names and stores their content, as `delorun changes list` and `show` do. `?pending` also lists the changes waiting in
 * the person's copy of Delorun, and `?id=` shows one of them.
 * @param ctx - the profile.
 * @param url - the request's URL.
 * @param home - the home's spellings and the log.
 * @param dependencies - the running runtime's harness.
 * @returns what the person reads.
 * @throws {RouteRefusal} `400 BAD_REQUEST` without exactly one well-formed query.
 */
async function shownOf(ctx: ChangesContext, url: URL, home: HomeWords, dependencies: RouteDependencies): Promise<ShownView | WorkReviewView | PendingListView> {
  const names = [...url.searchParams.keys()]
  if (names.length !== 1 || (names[0] !== 'id' && names[0] !== 'work' && !(names[0] === 'pending' && url.searchParams.get('pending') === ''))) {
    throw new RouteRefusal(400, 'BAD_REQUEST', 'Ask for one change with ?id=<id>, the work session with ?work=<plugin>, or the changes waiting for review with ?pending.')
  }
  if (names[0] === 'pending') return { kind: 'pending-list', pending: (await listChanges(ctx)).pending.map(pendingView), ...await harnessPendingOf(dependencies.harness(), home) }
  if (names[0] === 'work') return workView(await reviewWork(ctx, pluginOf(url.searchParams.get('work'))))
  const id = changeIdOf({ id: url.searchParams.get('id') })
  let shown: ShownChange
  try {
    shown = await showChange(ctx, id)
  } catch (error) {
    // An id no plugin's change has may name a change to Delorun itself, which only the log of those changes holds.
    const harness = isChangesError(error) && error.code === 'UNKNOWN_CHANGE' ? await harnessShown(ctx.home, id, dependencies.harness()) : undefined
    if (harness === undefined) throw error
    return harness
  }
  return shown.kind === 'pending' ? { kind: 'pending', change: changeView(shown.change) } : { kind: 'logged', entry: entryView(shown.entry) }
}

/**
 * A logged change to Delorun itself with its files, risk summary and bounded diff, read from the store, or one waiting in
 * the person's copy, whose two sides are stored first. Collection removes the content of a change that was discarded or
 * undone, and such a change is answered without its review.
 * @param home - the Delorun home.
 * @param id - the change id.
 * @param harness - the running runtime's harness, which reads the copy; undefined without one.
 * @returns what the person reads, or undefined when no decided or waiting change to Delorun itself has the id.
 * @throws {ChangesError} `RECORD_UNREADABLE` for a log that cannot be read; `STORE_CORRUPT` when the store lacks the
 *   content of a change that is neither discarded nor undone.
 */
async function harnessShown(home: string, id: ChangeId, harness: HarnessContext | undefined): Promise<ShownView | undefined> {
  const entry = (await readHarnessLog(home)).entries.find(candidate => candidate.id === id)
  const view = entry === undefined ? undefined : harnessEntryView(entry, harness?.runtime)
  if (entry === undefined || view === undefined) {
    const pending = harness === undefined ? undefined : await showHarnessChange(harness, id)
    if (pending === undefined) return undefined
    return { kind: 'harness-pending', change: harnessPendingView(pending), review: { kind: 'harness-edit', ...reviewView(pending) } }
  }
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
    ...review === undefined ? {} : { review: { kind: 'harness-edit', ...reviewView(review) } },
  }
}

/**
 * @param review - a review of a change to Delorun itself.
 * @returns its files, risk summary and bounded diff as the person reads them.
 */
function reviewView(review: HarnessReview): Omit<HarnessReviewView, 'kind'> {
  return {
    files: review.files.map(file => ({ path: file.path, status: file.status, binary: file.binary, dependency: file.dependency })),
    risk: riskView(review.risk),
    diff: { text: review.diff.text, truncated: review.diff.truncated, omitted: review.diff.omitted },
  }
}

/**
 * @param change - a change waiting in the person's copy of Delorun.
 * @returns the line `show?pending` lists for it, with the full content version an apply sends back.
 */
function harnessPendingView(change: Pick<HarnessReview, 'id' | 'file' | 'runtime' | 'status' | 'to'>): HarnessPendingView {
  return { id: change.id, file: change.file, runtime: change.runtime, status: change.status, to: change.to }
}

/**
 * The changes waiting in the person's copy of Delorun, for `show?pending`.
 * @param harness - the running runtime's harness; undefined without one, which lists none.
 * @param home - the home's spellings and the log, for a problem's words.
 * @returns the changes, or none and why the copy could not be read.
 */
async function harnessPendingOf(harness: HarnessContext | undefined, home: HomeWords): Promise<Pick<PendingListView, 'harness' | 'harnessProblem'>> {
  if (harness === undefined) return { harness: [] }
  try {
    return { harness: (await harnessChanges(harness)).changes.map(harnessPendingView) }
  } catch (error) {
    if (!isChangesError(error) || (error.code !== 'HARNESS_COPY_UNREADABLE' && error.code !== 'CHANGED_WHILE_READING')) throw error
    return { harness: [], harnessProblem: sayable(error.detail, error.code, home) }
  }
}

/**
 * Refuse a plugin action on a change to Delorun itself, which the harness routes decide with their own level. The
 * refusal comes before any action runs.
 * @param home - the Delorun home.
 * @param id - the change id the body names.
 * @throws {RouteRefusal} `409 HARNESS_ROUTE` when the log of changes to Delorun itself has the id;
 *   {@link ChangesError} `RECORD_UNREADABLE` for a log that cannot be read.
 */
async function refuseHarnessChange(home: string, id: ChangeId): Promise<void> {
  if (!(await readHarnessLog(home)).entries.some(entry => entry.id === id)) return
  throw new RouteRefusal(409, HARNESS_ROUTE, `Change ${id} changes Delorun itself; decide it under Changes to Delorun itself.`)
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
 * Run one of Create a plugin's actions for a request the route admitted (the computer, or a device with its grant).
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
 * Run one action for a request the route admitted (the computer, or a device with the grant its control needs).
 * @param action - the route.
 * @param body - the request's body.
 * @param ctx - the profile.
 * @param presence - the studio proof.
 * @param dependencies - the Host's reload and the installation's bundles.
 * @returns what the person reads.
 * @throws {RouteRefusal} for a body the action does not take, a change to Delorun itself, an unconfirmed risk or agent's
 *   plugin request, or safe mode without the installation's bundles; {@link ChangesError} for a refusal of Changes.
 */
async function act(action: ChangesAction, body: Readonly<Record<string, unknown>>, ctx: ChangesContext, presence: AtComputer, dependencies: RouteDependencies): Promise<ActionView | InstallView | DiscardView | StartedView | DoneView | CreatedView | RequestedView | RevealedView | { readonly lines: readonly string[], readonly skipped: readonly string[] | undefined }> {
  const options = { reload: dependencies.reload }
  switch (action) {
    case 'apply': {
      onlyFields(body, ['id', 'confirmedRisk'])
      const id = changeIdOf(body)
      const confirmed = confirmedRiskOf(body.confirmedRisk)
      await refuseHarnessChange(ctx.home, id)
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
      await refuseHarnessChange(ctx.home, id)
      return action === 'discard' ? { entry: entryView(await discardChange(ctx, id, presence)) } : actionView(await undoChange(ctx, id, presence, { ...options, run: dependencies.pluginOperation(ctx) }))
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
    case 'exit-safe-mode': {
      onlyFields(body, [])
      const report = await recover({
        profileDir: ctx.profileDir,
        homeDir: ctx.home,
        profile: ctx.profile,
        action: { kind: 'exit-safe-mode' },
        installationBundles: dependencies.installationBundles,
        changedBy: { kind: 'person' },
      })
      // The safe-mode overlay file the last start left is read only by a start in safe mode, which rewrites or removes it.
      return { lines: report.lines, skipped: [] }
    }
    default:
      return assertNever(action)
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
function admitted(request: IncomingMessage, response: ServerResponse, connection: RouteConnection, loopbackPort: LoopbackPort): { readonly arrival: StudioArrival, readonly peer: object, readonly setCookie?: string } | undefined {
  const admission = connection.admit(request)
  if ('rejection' in admission) {
    sendRefusal(response, admission.rejection === 401
      ? new RouteRefusal(401, 'NOT_SIGNED_IN', 'Open the studio with delorun open, then try again.')
      : new RouteRefusal(403, 'FORBIDDEN', 'The studio does not answer this address or page.'))
    return undefined
  }
  const arrival = arrivalOf(request, loopbackPort, true, connection.isReachPeer(admission.peer))
  return { arrival, peer: admission.peer, ...admission.setCookie === undefined ? {} : { setCookie: admission.setCookie } }
}

/**
 * Answer a failure of a route: a refusal with its status, a refusal of Changes or profile safety as a conflict or as
 * its own status, and anything else as `500 INTERNAL`, reported to the Host's log. A refusal whose words name the Delorun
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
  sendRefusal(response, new RouteRefusal(500, 'INTERNAL', 'Delorun could not answer; the Host log says why.'), setCookie)
}

/**
 * @param dependencies - what the routes reach.
 * @returns the profile.
 * @throws {RouteRefusal} `503 NO_PROFILE` when the Host runs no profile.
 */
function profileOf(dependencies: RouteDependencies): ChangesContext {
  const ctx = dependencies.profile()
  if (ctx === undefined) throw new RouteRefusal(503, 'NO_PROFILE', 'This harness runs no profile whose changes Delorun keeps.')
  return ctx
}

/**
 * `GET workspaces`: where Create a plugin may put a plugin. Creation is the computer's, so a remote session learns
 * no workspace and no path.
 * @param workspaces - the registry's workspaces, the default first.
 * @param atComputer - whether the request is at the computer.
 * @returns the answer.
 */
function workspacesOf(workspaces: readonly WorkspaceChoice[], atComputer: boolean): WorkspacesView {
  if (!atComputer) return { atComputer, workspaces: [] }
  return { atComputer, workspaces: workspaces.map(({ id, title, path }) => ({ id, title, path })) }
}

/**
 * Build a reading route: `state`, `show` or `workspaces`. Any admitted session reads, a remote one included.
 * @param read - what the route answers.
 * @param dependencies - what the routes reach.
 * @returns the handler.
 */
function readingRoute(read: (ctx: ChangesContext, url: URL, requester: Requester, home: HomeWords) => Promise<object>, dependencies: RouteDependencies): RouteHandler {
  return async (request, response) => {
    const admission = admitted(request, response, dependencies.connection, dependencies.loopbackPort)
    if (admission === undefined) return
    let home: HomeWords | undefined
    try {
      if (request.method !== 'GET') throw new RouteRefusal(405, 'METHOD_NOT_ALLOWED', 'Read Changes with a GET.')
      const ctx = profileOf(dependencies)
      home = homeWords(ctx.home, dependencies.logger)
      const requester = await requesterOf(admission, dependencies.devices)
      sendJson(response, 200, withoutHome(await read(ctx, new URL(String(request.url), 'http://studio.invalid'), requester, home), home.homes), admission.setCookie)
    } catch (error) {
      sendThrown(response, error, dependencies, home, admission.setCookie)
    }
  }
}

/** The control each plugin action route is. */
const ACTION_CONTROLS: Readonly<Record<ChangesAction, ChangesControl>> = {
  apply: 'plugin-apply',
  discard: 'plugin-discard',
  undo: 'plugin-undo',
  off: 'plugin-other',
  on: 'plugin-other',
  work: 'plugin-other',
  done: 'plugin-other',
  'safe-mode': 'plugin-other',
  'exit-safe-mode': 'plugin-other',
  create: 'plugin-other',
  request: 'plugin-other',
  reveal: 'plugin-other',
}

/**
 * Build one `POST` route that the {@link gate} decides before its body is read: the site, then the control's level for
 * the requester, then the proof. Only then is the body read and `run` called; a device's unlock is renewed after `run`
 * succeeds. The Restart route builds its handler with it, so it has Apply's fence and level.
 * @param control - the control the route is.
 * @param dependencies - what the routes reach.
 * @param run - the action, given the body, the profile and the proof.
 * @returns the handler.
 */
export function decidingRoute(control: ChangesControl, dependencies: RouteDependencies, run: (body: Readonly<Record<string, unknown>>, ctx: ChangesContext, presence: AtComputer) => Promise<object>): RouteHandler {
  return postRoute(dependencies, (request, admission) => gate(request, admission, control, dependencies.devices), run)
}

/**
 * Build one `POST` route for a control at level `open`: the site fence first, then any paired device or the computer,
 * unlocked or not, and a session that is neither is refused. No proof of presence is issued, so `run` can only read
 * and record what any session may see.
 * @param dependencies - what the routes reach.
 * @param run - the action, given the body and the profile.
 * @returns the handler.
 */
function openRoute(dependencies: RouteDependencies, run: (body: Readonly<Record<string, unknown>>, ctx: ChangesContext) => Promise<object>): RouteHandler {
  return postRoute(dependencies, async (request, admission) => {
    const requester = await requesterOf(admission, dependencies.devices)
    if (requester.kind === 'device' ? isCrossSiteDevice(request) : isCrossSite(request)) throw new RouteRefusal(403, 'CROSS_SITE', 'Another site cannot change what your harness runs.')
    if (requester.kind === 'other') throw new RouteRefusal(403, LOOPBACK_REQUIRED, LOOPBACK_REQUIRED_SENTENCE)
    return { presence: undefined, renew: () => {} }
  }, (body, ctx) => run(body, ctx))
}

/**
 * The shell every `POST` route shares: admit, decide before the body is read, read the body, run, renew, answer.
 * @param dependencies - what the routes reach.
 * @param decide - the decision for this request: what `run` receives as proof, and a renewal to run after success.
 * @param run - the action.
 * @returns the handler.
 */
function postRoute<P>(dependencies: RouteDependencies, decide: (request: IncomingMessage, admission: { readonly arrival: StudioArrival, readonly peer: object }) => Promise<{ readonly presence: P, readonly renew: () => void }>, run: (body: Readonly<Record<string, unknown>>, ctx: ChangesContext, presence: P) => Promise<object>): RouteHandler {
  return async (request, response) => {
    const admission = admitted(request, response, dependencies.connection, dependencies.loopbackPort)
    if (admission === undefined) return
    let home: HomeWords | undefined
    try {
      if (request.method !== 'POST') throw new RouteRefusal(405, 'METHOD_NOT_ALLOWED', 'Changes are made with a POST.')
      const { presence, renew } = await decide(request, admission)
      const ctx = profileOf(dependencies)
      home = homeWords(ctx.home, dependencies.logger)
      const body = await readBody(request)
      const answer = await run(body, ctx, presence)
      renew()
      sendJson(response, 200, withoutHome(answer, home.homes), admission.setCookie)
    } catch (error) {
      sendThrown(response, error, dependencies, home, admission.setCookie)
    }
  }
}

/**
 * Build one plugin action route.
 * @param action - the action.
 * @param dependencies - what the routes reach.
 * @returns the handler.
 */
function actionRoute(action: ChangesAction, dependencies: RouteDependencies): RouteHandler {
  return decidingRoute(ACTION_CONTROLS[action], dependencies, (body, ctx, presence) => act(action, body, ctx, presence, dependencies))
}

/**
 * @param dependencies - what the routes reach.
 * @returns the running runtime's harness.
 * @throws {RouteRefusal} `409 HARNESS_UNAVAILABLE` when this Host has none.
 */
function harnessOf(dependencies: RouteDependencies): HarnessContext {
  const harness = dependencies.harness()
  if (harness === undefined) throw new RouteRefusal(409, HARNESS_UNAVAILABLE, 'Delorun\'s own files change only in an installed release started with delorun start.')
  return harness
}

/** The control each harness route is. */
const HARNESS_CONTROLS: Readonly<Record<HarnessAction, ChangesControl>> = {
  apply: 'harness-apply',
  undo: 'harness-undo',
  discard: 'harness-discard',
  copy: 'make-copy',
}

/**
 * Run one harness action.
 * @param action - the route.
 * @param body - the request's body.
 * @param harness - the running runtime's harness.
 * @param presence - the proof.
 * @param dependencies - the effect of a decided change, and the log.
 * @returns what the person reads.
 * @throws {RouteRefusal} for a body the action does not take or an unconfirmed risk; {@link ChangesError} for a
 *   refusal of Changes.
 */
async function harnessAct(action: HarnessAction, body: Readonly<Record<string, unknown>>, harness: HarnessContext, presence: AtComputer, dependencies: RouteDependencies): Promise<HarnessActionView | HarnessDiscardView | HarnessCopyView> {
  switch (action) {
    case 'apply': {
      onlyFields(body, ['id', 'to', 'confirmedRisk'])
      const id = changeIdOf(body)
      if (typeof body.to !== 'string' || !CONTENT_VERSION_PATTERN.test(body.to)) throw new RouteRefusal(400, 'BAD_REQUEST', 'Name the content you were shown: the change\'s to from show?pending.')
      const confirmed = confirmedRiskOf(body.confirmedRisk)
      const review = await showHarnessChange(harness, id)
      if (review !== undefined) requireRiskConfirmation(review.risk, confirmed)
      const entry = await applyHarnessChange(harness, id, presence, { reviewedTo: body.to as ContentVersion })
      return { kind: 'harness', entry: harnessEntryView(entry, harness.runtime)!, effect: await dependencies.harnessEffect(entry) }
    }
    case 'undo': {
      onlyFields(body, ['id'])
      const entry = await undoHarnessChange(harness, changeIdOf(body), presence)
      return { kind: 'harness', entry: harnessEntryView(entry, harness.runtime)!, effect: await dependencies.harnessEffect(entry) }
    }
    case 'discard': {
      onlyFields(body, ['id'])
      const entry = await discardHarnessChange(harness, changeIdOf(body), presence)
      dependencies.clearRestartFailure()
      return { kind: 'harness', entry: harnessEntryView(entry, harness.runtime)! }
    }
    case 'copy': {
      onlyFields(body, [])
      const copy = await createHarnessCopy(harness, presence)
      return { kind: 'copy', created: copy.created, runtime: harness.runtime, place: withHomePlaceholder(copy.directory, homeSpellings(harness.home)) }
    }
    default:
      return assertNever(action)
  }
}

/**
 * Build one harness route.
 * @param action - the action.
 * @param dependencies - what the routes reach.
 * @returns the handler.
 */
function harnessRoute(action: HarnessAction, dependencies: RouteDependencies): RouteHandler {
  return decidingRoute(HARNESS_CONTROLS[action], dependencies, (body, _ctx, presence) => harnessAct(action, body, harnessOf(dependencies), presence, dependencies))
}

/**
 * What turning protection off lets load without review: the plugins whose folders hold changes waiting for review, and
 * the files waiting in the person's copy of Delorun.
 * @param ctx - the profile.
 * @param harness - the running runtime's harness, if any.
 * @returns the refusal that asks the second time.
 */
async function confirmProtectionOff(ctx: ChangesContext, harness: HarnessContext | undefined): Promise<RouteRefusal> {
  const plugins = [...new Set((await listChanges(ctx)).pending.map(change => change.plugin))].sort()
  let harnessFiles = 0
  if (harness !== undefined) {
    try {
      harnessFiles = (await harnessChanges(harness)).changes.length
    } catch (error) {
      // A copy that cannot be read applies nothing at a start either; the second ask names the plugins alone.
      if (!isChangesError(error) || (error.code !== 'HARNESS_COPY_UNREADABLE' && error.code !== 'CHANGED_WHILE_READING')) throw error
    }
  }
  return new RouteRefusal(409, CONFIRM_PROTECTION, 'With protection off, saved changes to your linked plugins load at once, your copy of Delorun applies at the next start, and the agent installs, removes, turns on, configures, undoes and restores plugins with the full-access approval alone. Confirm again to turn it off.', { willLoad: { plugins, harnessFiles } })
}

/**
 * Build one protection route.
 * @param level - the level the route sets.
 * @param dependencies - what the routes reach.
 * @returns the handler.
 */
function protectionRoute(level: 'on' | 'off', dependencies: RouteDependencies): RouteHandler {
  return decidingRoute(level === 'off' ? 'protection-off' : 'protection-on', dependencies, async (body, ctx, presence): Promise<ProtectionChangedView> => {
    if (level === 'on') {
      onlyFields(body, [])
      const loaded = await unreviewedSinceOff(ctx)
      await changeProtection(ctx, 'on', presence)
      return { protection: 'on', unreviewedSinceOff: loaded }
    }
    onlyFields(body, ['confirmed'])
    if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') throw new RouteRefusal(400, 'BAD_REQUEST', 'confirmed is true or false.')
    if (body.confirmed !== true) throw await confirmProtectionOff(ctx, dependencies.harness())
    await changeProtection(ctx, 'off', presence)
    return { protection: 'off', unreviewedSinceOff: 0 }
  })
}

/**
 * Build the route that dismisses a notice, at the computer only.
 * @param dependencies - what the routes reach.
 * @returns the handler.
 */
function noticeSeenRoute(dependencies: RouteDependencies): RouteHandler {
  return decidingRoute('notice-seen', dependencies, async (body, ctx, presence) => {
    onlyFields(body, ['id'])
    if (typeof body.id !== 'string') throw new RouteRefusal(400, 'BAD_REQUEST', 'Name the notice by its id.')
    return { dismissed: await dismissNotice(ctx.home, body.id, presence) }
  })
}

/**
 * A true-or-false field of a request body.
 * @param body - the body.
 * @param name - the field.
 * @param fallback - the value when the field is absent.
 * @returns the field.
 * @throws {RouteRefusal} `400 BAD_REQUEST` when the field is present and is not true or false.
 */
export function flag(body: Readonly<Record<string, unknown>>, name: string, fallback: boolean): boolean {
  const value = body[name]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new RouteRefusal(400, 'BAD_REQUEST', `${name} is true or false.`)
  return value
}

/** The most bytes a setup upload's JSON body holds: the largest file as base64, with the field around it. */
const MAX_SETUP_BODY_BYTES = Math.ceil(MAX_SETUP_FILE_BYTES * 4 / 3) + 1024

/**
 * Build one setup route. The arrival and the site are decided before the body is read, exactly as for an action: a
 * setup changes what the profile runs and a file leaves the computer, so only the person at their computer asks.
 * @param kind - `export`, `inspect` or `apply`.
 * @param dependencies - what the routes reach.
 * @param held - where an inspected file waits for its apply.
 * @returns the handler.
 */
function setupRoute(kind: keyof typeof SETUP_PATHS, dependencies: RouteDependencies, held: HeldSetups): RouteHandler {
  return async (request, response) => {
    const admission = admitted(request, response, dependencies.connection, dependencies.loopbackPort)
    if (admission === undefined) return
    let home: HomeWords | undefined
    try {
      if (request.method !== 'POST') throw new RouteRefusal(405, 'METHOD_NOT_ALLOWED', 'A setup is moved with a POST.')
      const { presence } = await gate(request, admission, 'plugin-other', dependencies.devices)
      const ctx = profileOf(dependencies)
      home = homeWords(ctx.home, dependencies.logger)
      const body = await readBody(request, kind === 'inspect' ? MAX_SETUP_BODY_BYTES : MAX_BODY_BYTES)
      let answer: object
      try {
        if (kind === 'export') {
          onlyFields(body, ['list', 'settings', 'localCode', 'plugins', 'note'])
          if (body['list'] === true) {
            answer = await listSetupPlugins(ctx)
          } else {
            const plugins = body['plugins']
            if (plugins !== undefined && !(Array.isArray(plugins) && plugins.every(name => typeof name === 'string'))) throw new RouteRefusal(400, 'BAD_REQUEST', 'plugins is a list of package names.')
            if (body['note'] !== undefined && typeof body['note'] !== 'string') throw new RouteRefusal(400, 'BAD_REQUEST', 'note is text.')
            answer = await exportSetup(ctx, dependencies.delorunVersion(), {
              settings: flag(body, 'settings', true), localCode: flag(body, 'localCode', true),
              ...plugins === undefined ? {} : { plugins: plugins as string[] }, ...body['note'] === undefined ? {} : { note: body['note'] },
            })
          }
        } else if (kind === 'inspect') {
          onlyFields(body, ['file', 'token', 'settings', 'removeOthers', 'endpointsConfirmed'])
          const source = typeof body['file'] === 'string' ? { file: body['file'] } : typeof body['token'] === 'string' ? { token: body['token'] } : undefined
          if (source === undefined) throw new RouteRefusal(400, 'BAD_REQUEST', 'The request names the file as base64 text, or a file already read by its token.')
          answer = await inspectSetup(ctx, source, held, { settings: flag(body, 'settings', true), removeOthers: flag(body, 'removeOthers', false), endpointsConfirmed: flag(body, 'endpointsConfirmed', false) })
        } else {
          onlyFields(body, ['token', 'settings', 'removeOthers', 'endpointsConfirmed'])
          if (typeof body['token'] !== 'string') throw new RouteRefusal(400, 'BAD_REQUEST', 'The request names the inspected file by its token.')
          const choices = { settings: flag(body, 'settings', true), removeOthers: flag(body, 'removeOthers', false), endpointsConfirmed: flag(body, 'endpointsConfirmed', false) }
          answer = await applySetup(ctx, body['token'], held, choices, opened => applySetupImport(ctx, opened.document, { presence, reload: dependencies.reload, run: dependencies.pluginOperation(ctx), readFile: opened.readFile, choices }))
        }
      } catch (error) {
        if (error instanceof SetupRefusal) throw new RouteRefusal(error.status, error.code, error.message)
        throw error
      }
      sendJson(response, 200, withoutHome(answer, home.homes), admission.setCookie)
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
  const held = new HeldSetups()
  return [
    { kind: 'exact', path: STATE_PATH, handler: readingRoute((ctx, _url, requester, home) => stateOf(ctx, requester, home, dependencies), dependencies) },
    { kind: 'exact', path: SHOW_PATH, handler: readingRoute((ctx, url, _requester, home) => shownOf(ctx, url, home, dependencies), dependencies) },
    { kind: 'exact', path: WORKSPACES_PATH, handler: readingRoute((_ctx, _url, requester) => Promise.resolve(workspacesOf(dependencies.workspaces(), requester.kind === 'computer')), dependencies) },
    ...(Object.keys(ACTION_PATHS) as ChangesAction[]).map((action): ChangesRoute => ({ kind: 'exact', path: ACTION_PATHS[action], handler: actionRoute(action, dependencies) })),
    ...(Object.keys(HARNESS_PATHS) as HarnessAction[]).map((action): ChangesRoute => ({ kind: 'exact', path: HARNESS_PATHS[action], handler: harnessRoute(action, dependencies) })),
    { kind: 'exact', path: PROTECTION_PATHS.on, handler: protectionRoute('on', dependencies) },
    { kind: 'exact', path: PROTECTION_PATHS.off, handler: protectionRoute('off', dependencies) },
    { kind: 'exact', path: NOTICE_SEEN_PATH, handler: noticeSeenRoute(dependencies) },
    ...(Object.keys(SETUP_PATHS) as (keyof typeof SETUP_PATHS)[]).map((kind): ChangesRoute => ({ kind: 'exact', path: SETUP_PATHS[kind], handler: setupRoute(kind, dependencies, held) })),
  ]
}

/**
 * The gated routes of this plugin, for another plugin's routes that need the same fence and levels: `@delorun/plugin-update`
 * registers the studio's update routes through it, so a request from another site, a device's level and its unlock are
 * decided by this module's rules and table ({@link CONTROL_LEVELS}) before the other plugin reads a body.
 */
export interface ChangesGate {
  /**
   * Build a `POST` route decided before its body is read, as {@link decidingRoute} does.
   * @param control - the control the route is; its level is in {@link CONTROL_LEVELS}.
   * @param run - the action, given the body, the profile and the proof; a {@link RouteRefusal} it throws answers with its status and code.
   * @returns the handler.
   */
  post(control: ChangesControl, run: (body: Readonly<Record<string, unknown>>, ctx: ChangesContext, presence: AtComputer) => Promise<object>): RouteHandler
  /**
   * Build a `POST` route for a control at level `open` (`update-check`): the site fence, then the computer or any paired device, unlocked or not.
   * @param run - the action, given the body and the profile; it receives no proof of presence.
   * @returns the handler.
   */
  open(run: (body: Readonly<Record<string, unknown>>, ctx: ChangesContext) => Promise<object>): RouteHandler
  /**
   * Build a `GET` route that any admitted session reads, as `state` does.
   * @param read - what the route answers, given the profile and every control's decision for this request.
   * @returns the handler.
   */
  get(read: (ctx: ChangesContext, access: AccessView) => Promise<object>): RouteHandler
}

/**
 * The gate over one set of route dependencies.
 * @param dependencies - what the routes reach.
 * @returns the gate.
 */
export function changesGate(dependencies: RouteDependencies): ChangesGate {
  return {
    post: (control, run) => decidingRoute(control, dependencies, run),
    open: run => openRoute(dependencies, run),
    get: read => readingRoute((ctx, _url, requester) => read(ctx, accessView(actorOf(requester), faceStateOf(requester))), dependencies),
  }
}
