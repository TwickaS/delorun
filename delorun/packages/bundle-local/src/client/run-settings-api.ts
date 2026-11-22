/**
 * Requests to the home's "How Delorun runs" routes and the validation of their JSON answers. The Host serves `state` to
 * any signed-in studio, `prompts` and `background` to a device that confirms the call, and the rest to the home's own
 * computer only. The route names and answer fields are shared with [`../run-settings.ts`](../run-settings.ts), which
 * serves them; requests go through [`./host-api.ts`](./host-api.ts).
 * @module @delorun/bundle-local/client/run-settings-api
 */
import { PROTECTION_PATHS, RESTART_PATHS, STATE_PATH } from '@delorun/plugin-changes/wire'
import { call, fields, isBoolean, isRecord, isString, isTime, listOf, optional, orNull, type Check, type HostFetch } from './host-api.ts'

/** The routes under `/api`. */
export const RUN_ROUTES = {
  /** `GET`: the answers and what runs now, as {@link RunState}. */
  state: '/api/delorunRun.state',
  /** `POST` `{ answer: 'safer' | 'stock' }`: set how much Delorun asks; a device confirms `stock` with Face ID or its PIN. */
  prompts: '/api/delorunRun.prompts',
  /** `POST` `{}`: start turning dangerous mode on, as {@link DangerousBegun}; the computer only. */
  dangerousBegin: '/api/delorunRun.dangerousBegin',
  /** `POST` `{ nonce, understood, phrase }`: finish turning dangerous mode on; the computer only. */
  dangerousConfirm: '/api/delorunRun.dangerousConfirm',
  /** `POST` `{ on }`: keep Delorun running after the terminal closes, or not; a device confirms it. */
  background: '/api/delorunRun.background',
  /** `POST` `{ port }`: the port the studio opens on at the next start; the computer only. */
  port: '/api/delorunRun.port',
  /** `POST` `{}`: what turning phone access on would do, as {@link ReachPreview}; the computer only. */
  reachPreview: '/api/delorunRun.reachPreview',
  /** `POST` `{ on: false }` or `{ on: true, ticket }`: turn phone access off or on; the computer only. */
  reach: '/api/delorunRun.reach',
} as const

/** The largest request body a route reads, in bytes. */
export const MAX_RUN_REQUEST_BYTES = 2048

/** The answers `prompts` takes: the third answer, dangerous mode, has its own two routes. */
export type SettablePrompts = 'safer' | 'stock'

/** How much Delorun asks, as setup records it. */
export type PromptsChoice = SettablePrompts | 'dangerous'

/** Whether dangerous mode holds: `off`, `on` with a valid grant file, or `inactive` for the answer without a valid grant. */
export type DangerousKind = 'off' | 'on' | 'inactive'

/** What `GET /api/delorunRun.state` answers. */
export interface RunState {
  /** Whether the profile has an answers record; without one the controls cannot change an answer, because setup has not run. */
  readonly recorded: boolean
  readonly prompts: PromptsChoice
  readonly dangerous: DangerousKind
  /** Whether Delorun keeps running after the terminal that started it closes. */
  readonly background: boolean
  readonly port: {
    /** The port the studio opens on at the next start. */
    readonly chosen: number
    /** The port the studio runs on now, or null when the home does not report one. */
    readonly running: number | null
  }
  readonly reach: {
    /** Whether the profile's phone access is on. */
    readonly on: boolean
    /** The private address when it is on; an empty string otherwise. */
    readonly address: string
  }
}

/** What a write that changes the profile answers, besides its own fields. */
export interface RunWritten {
  /** Whether the change applies only after Delorun restarts. */
  readonly restartNeeded: boolean
}

/** What `POST /api/delorunRun.prompts` answers. */
export interface PromptsWritten extends RunWritten {
  readonly prompts: PromptsChoice
}

/** What `POST /api/delorunRun.dangerousBegin` answers. */
export interface DangerousBegun {
  /** The warning, one paragraph per entry. */
  readonly warning: readonly string[]
  /** The single-use code the confirmation names. */
  readonly nonce: string
  /** When the code stops working, in milliseconds since the epoch. */
  readonly expiresAt: number
  /** The phrase to type, so the studio shows what the server compares. */
  readonly phrase: string
}

/** What `POST /api/delorunRun.dangerousConfirm` answers. */
export interface DangerousConfirmed extends RunWritten {
  readonly dangerous: DangerousKind
}

/** What `POST /api/delorunRun.background` answers. */
export interface BackgroundWritten extends RunWritten {
  readonly background: boolean
}

/** What `POST /api/delorunRun.port` answers. */
export interface PortWritten extends RunWritten {
  readonly port: number
  /** The address the studio opens on after the restart; the sign-in address changes with the port. */
  readonly origin: string
}

/** What `POST /api/delorunRun.reachPreview` answers: what turning phone access on changes, to be confirmed with its ticket. */
export interface ReachPreview {
  /** The private address Tailscale would serve the studio at. */
  readonly address: string
  /** What phone access lets a device do and what protects the home, one sentence per entry. */
  readonly trust: readonly string[]
  /** The single-use ticket bound to this address, which `reach` takes with `on: true`. */
  readonly ticket: string
  readonly expiresAt: number
}

/** What `POST /api/delorunRun.reach` answers. */
export interface ReachWritten extends RunWritten {
  readonly on: boolean
  readonly address: string
  /** Whether the home's phone listener is ready now. */
  readonly ready: boolean
  /** When turning it off, what Tailscale said it could not remove: it may still serve the studio until the person removes the rule. */
  readonly stillServed?: string
}

const isPrompts: Check = value => value === 'safer' || value === 'stock' || value === 'dangerous'
const isDangerousKind: Check = value => value === 'off' || value === 'on' || value === 'inactive'
const isNumber: Check = isTime
const isRestart = fields({ restartNeeded: isBoolean })
const all = (...checks: readonly Check[]): Check => value => checks.every(check => check(value))

const isRunState: Check = fields({
  recorded: isBoolean,
  prompts: isPrompts,
  dangerous: isDangerousKind,
  background: isBoolean,
  port: fields({ chosen: isNumber, running: orNull(isNumber) }),
  reach: fields({ on: isBoolean, address: isString }),
})
const isPromptsWritten = all(isRestart, fields({ prompts: isPrompts }))
const isDangerousBegun = fields({ warning: listOf(isString), nonce: isString, expiresAt: isTime, phrase: isString })
const isDangerousConfirmed = all(isRestart, fields({ dangerous: isDangerousKind }))
const isBackgroundWritten = all(isRestart, fields({ background: isBoolean }))
const isPortWritten = all(isRestart, fields({ port: isNumber, origin: isString }))
const isReachPreview = fields({ address: isString, trust: listOf(isString), ticket: isString, expiresAt: isTime })
const isReachWritten = all(isRestart, fields({ on: isBoolean, address: isString, ready: isBoolean, stillServed: optional(isString) }))

/**
 * Read the answers and what runs now.
 * @param fetch - the request function.
 * @returns the state.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export function readRunState(fetch: HostFetch): Promise<RunState> {
  return call<RunState>(fetch, RUN_ROUTES.state, isRunState)
}

/**
 * Set how much Delorun asks to `safer` or `stock`.
 * @param fetch - the request function.
 * @param answer - the answer.
 * @returns the answer now recorded and whether a restart is needed.
 * @throws {HostRequestError} for a refusal (`ELEVATION_REQUIRED` for `stock` on a device without a confirmation, `NOT_SET_UP`), an unreachable Host or an unreadable answer.
 */
export function setPrompts(fetch: HostFetch, answer: SettablePrompts): Promise<PromptsWritten> {
  return call<PromptsWritten>(fetch, RUN_ROUTES.prompts, isPromptsWritten, { answer })
}

/**
 * Start turning dangerous mode on.
 * @param fetch - the request function.
 * @returns the warning, the code and when it expires.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED` away from the home's computer, `ROOT_REFUSED`, `NOT_SET_UP`), an unreachable Host or an unreadable answer.
 */
export function beginDangerous(fetch: HostFetch): Promise<DangerousBegun> {
  return call<DangerousBegun>(fetch, RUN_ROUTES.dangerousBegin, isDangerousBegun, {})
}

/**
 * Finish turning dangerous mode on.
 * @param fetch - the request function.
 * @param nonce - the code `beginDangerous` answered.
 * @param understood - whether the person answered yes to the first question.
 * @param phrase - what the person typed.
 * @returns whether dangerous mode now holds.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `NOT_CONFIRMED`, `PHRASE_WRONG`, `CODE_EXPIRED`), an unreachable Host or an unreadable answer.
 */
export function confirmDangerous(fetch: HostFetch, nonce: string, understood: boolean, phrase: string): Promise<DangerousConfirmed> {
  return call<DangerousConfirmed>(fetch, RUN_ROUTES.dangerousConfirm, isDangerousConfirmed, { nonce, understood, phrase })
}

/**
 * Choose whether Delorun keeps running after the terminal that started it closes.
 * @param fetch - the request function.
 * @param on - the answer.
 * @returns the answer now recorded.
 * @throws {HostRequestError} for a refusal (`ELEVATION_REQUIRED` on a device without a confirmation, `NOT_SET_UP`), an unreachable Host or an unreadable answer.
 */
export function setBackground(fetch: HostFetch, on: boolean): Promise<BackgroundWritten> {
  return call<BackgroundWritten>(fetch, RUN_ROUTES.background, isBackgroundWritten, { on })
}

/**
 * Choose the studio's port for the next start.
 * @param fetch - the request function.
 * @param port - the port, from 1024 to 65535.
 * @returns the port and the address the studio opens on after the restart.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `PORT_BUSY`, `PORT_UNCHANGED`, `NOT_SET_UP`), an unreachable Host or an unreadable answer.
 */
export function setPort(fetch: HostFetch, port: number): Promise<PortWritten> {
  return call<PortWritten>(fetch, RUN_ROUTES.port, isPortWritten, { port })
}

/**
 * Read what turning phone access on would do, changing nothing.
 * @param fetch - the request function.
 * @returns the address, the trust statement and the ticket that confirms it.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `TAILSCALE_UNAVAILABLE`), an unreachable Host or an unreadable answer.
 */
export function previewReach(fetch: HostFetch): Promise<ReachPreview> {
  return call<ReachPreview>(fetch, RUN_ROUTES.reachPreview, isReachPreview, {})
}

/**
 * Turn phone access on with the ticket of a preview, or off.
 * @param fetch - the request function.
 * @param request - `{ on: false }`, or `{ on: true, ticket }`.
 * @returns the state of the phone listener.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `TICKET_INVALID`, `TAILSCALE_UNAVAILABLE`, `NOT_SET_UP`), an unreachable Host or an unreadable answer.
 */
export function setReach(fetch: HostFetch, request: { readonly on: false } | { readonly on: true; readonly ticket: string }): Promise<ReachWritten> {
  return call<ReachWritten>(fetch, RUN_ROUTES.reach, isReachWritten, request)
}

/**
 * Restart Delorun, as the Changes section's restart does: the home waits for running chats first.
 * @param fetch - the request function.
 * @returns how many chats the restart waits for.
 * @throws {HostRequestError} for a refusal (`RESTART_IN_PROGRESS`, `UPDATE_IN_PROGRESS`), an unreachable Host or an unreadable answer.
 */
export async function restartHome(fetch: HostFetch): Promise<number> {
  const begun = await call<{ readonly runningChats: number }>(fetch, RESTART_PATHS.restart, fields({ kind: value => value === 'restarting', runningChats: isTime }), {})
  return begun.runningChats
}

/**
 * Read whether the Changes protection setting holds plugin changes for review.
 * @param fetch - the request function.
 * @returns `on` or `off`, or undefined when the home does not report the setting.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export async function readProtection(fetch: HostFetch): Promise<'on' | 'off' | undefined> {
  const state = await call<{ readonly protection?: 'on' | 'off' }>(fetch, STATE_PATH, value => isRecord(value) && (value['protection'] === undefined || value['protection'] === 'on' || value['protection'] === 'off'))
  return state.protection
}

/**
 * Turn the Changes protection setting on, so plugin changes wait for the person's review. Turning it off stays in the Changes section.
 * @param fetch - the request function.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export async function turnProtectionOn(fetch: HostFetch): Promise<void> {
  await call<object>(fetch, PROTECTION_PATHS.on, isRecord, {})
}
