/**
 * The Host half of the "How Delorun runs" section: how much Delorun asks, running in the background, the studio's port
 * and phone access, served as routes under `/api/delorunRun.*` over the writes of `@delorun/setup-apply`, the ones
 * `delorun setup` makes. Every change takes the profile's write lock, so it does not interleave with a plugin
 * installation or another change.
 *
 * Who may ask, by route (the table is `PLUGIN_ROUTE_ACCESS` in `@delorun/home-auth`):
 * - `state` answers any signed-in studio.
 * - `prompts` to `safer` answers any signed-in studio, because it only tightens; to `stock` and `background` they
 *   answer a device that confirms the call with Face ID or its PIN, which a device without a PIN cannot do.
 * - Every other route answers only the home's own computer: the request must arrive on the loopback listener under a
 *   loopback `Host`, and a paired device is refused `403 LOOPBACK_REQUIRED` whatever it has unlocked, in dangerous mode
 *   too. Turning dangerous mode on takes two requests, which the home checks itself: `dangerousBegin` answers the
 *   warning and a single-use code, `dangerousConfirm` takes the code, a yes and the typed phrase, and writes nothing
 *   unless all three match. Turning phone access on takes a ticket that `reachPreview` issued for the Tailscale name
 *   it read, because turning it on changes Tailscale.
 *
 * Every state-changing request must come from the studio's own page ({@link fromStudioPage}). A profile whose setup has
 * not run has no answers record, and every change is refused `409 NOT_SET_UP`.
 *
 * @module @delorun/bundle-local/run-settings
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge and its `connection/request` event.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the `ctx.hmr` service, whose presence says the profile's patch file is watched and reloaded.
import type {} from '@deepseek-ai/dsh-hmr'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { DEFAULT_SERVE_PORT } from '@delorun/contract-reach-providers'
import { DANGEROUS_PHRASE, SETUP_DEFAULT_PORT } from '@delorun/contract-setup-answers'
import { admitApprovedDevice, gateByClass, requireComputer, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { dangerousGrantPath, readDangerousGrant, removeDangerousGrant, writeDangerousGrant } from '@delorun/plugin-permission-defaults/store'
import {
  checkServeAccess, isPortFree, ReachError, readTailscale, removeServe, serveTarget, systemTailscale, tailscaleAddress,
  type ReachStatus, type TailscaleRunner,
} from '@delorun/reach'
import {
  backgroundOf, DANGEROUS_WARNING_LINES, listenerPortFor, promptsOf, readAnswersRecord, readPatchRow, readReachRowAt, reachRowsOf, runsAsRoot, SetupApplyError,
  setPatchRow, STUDIO_ROW_ID, studioRow, TRUST_STATEMENT, updateAnswersRecord, writeMayAskAt, writePromptRows, writeReachRowAt,
  type AnswersRecord, type TailscalePrivateRow,
} from '@delorun/setup-apply'
import { z } from 'zod'
import {
  MAX_RUN_REQUEST_BYTES, RUN_ROUTES,
  type BackgroundWritten, type DangerousBegun, type DangerousConfirmed, type DangerousKind, type PortWritten, type PromptsWritten, type ReachPreview, type ReachWritten, type RunState,
  type SettablePrompts,
} from './client/run-settings-api.ts'
import { fromStudioPage } from './studio-page.ts'

/** The plugin's name in the loader's diagnostics. */
export const name = 'delorun-run-settings'

/** The refusals the routes add to the home's own. */
export type RunRefusal =
  | 'BAD_REQUEST' | 'NOT_SET_UP' | 'NO_PROFILE' | 'FOREIGN_ORIGIN' | 'ROOT_REFUSED' | 'NOT_CONFIRMED' | 'PHRASE_WRONG' | 'CODE_EXPIRED'
  | 'PORT_BUSY' | 'PORT_UNCHANGED' | 'TICKET_INVALID' | 'TAILSCALE_UNAVAILABLE'

/** The HTTP status of each refusal. */
export const RUN_REFUSAL_STATUS: Readonly<Record<RunRefusal, number>> = {
  BAD_REQUEST: 400,
  NOT_SET_UP: 409,
  NO_PROFILE: 404,
  FOREIGN_ORIGIN: 403,
  ROOT_REFUSED: 422,
  NOT_CONFIRMED: 422,
  PHRASE_WRONG: 422,
  CODE_EXPIRED: 409,
  PORT_BUSY: 409,
  PORT_UNCHANGED: 409,
  TICKET_INVALID: 409,
  TAILSCALE_UNAVAILABLE: 422,
}

/** How long the code of `dangerousBegin` and the ticket of `reachPreview` stay valid, in milliseconds. */
export const CONFIRMATION_MS = 5 * 60_000

/** How long a change waits for the profile's write lock, in milliseconds. */
const LOCK_WAIT_MS = 10_000

/**
 * Whether each change applies only after Delorun restarts, for the changes that do not depend on the running home. The
 * background answer is read by the next start and the port is bound at start; phone access is applied to the running
 * home. The prompts rows are read by plugins that the hot-reload service restarts when the patch file changes, so they
 * need a restart exactly when no such service is mounted: see {@link RunDependencies.hotReload}.
 */
export const RESTART_NEEDED = { background: false, port: true, reach: false } as const

/** The sentence a request that is not the computer's own is told. */
const ACTION = 'Changing how Delorun runs'

/** A refusal the routes answer with its code. */
export class RunError extends Error {
  readonly code: RunRefusal

  /**
   * @param code - the refusal.
   * @param message - the sentence the person reads.
   * @param options - the cause, when one exists.
   */
  constructor(code: RunRefusal, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = 'RunError'
  }
}

/** Where the profile lives. */
export interface RunWhere {
  /** The profile's name. */
  readonly profile: string
  /** The profile directory, which holds `cordis.patch.yml`, `package.json` and `setup-answers.json`. */
  readonly profileDir: string
  /** The Delorun home. */
  readonly homeDir: string
}

/** The reach service as the routes use it. */
export interface RunReach {
  /** Whether the service holds the phone listener. */
  readonly mounted: boolean
  /** Restarts every option from rows. @param rows - the rows. @returns the options' states, or undefined when the service cannot apply. */
  apply(rows: ReturnType<typeof reachRowsOf>): Promise<readonly ReachStatus[] | undefined>
}

/** What the service reads from the home and changes in it; a spec supplies fakes. */
export interface RunDependencies {
  /** @returns where the profile is, or undefined while the Host has no profile. */
  where(): RunWhere | undefined
  /** @returns the port the studio listens on now, if the web server reports one. */
  runningPort(): number | undefined
  /** @returns the reach service, or undefined when the profile does not load it. */
  reach(): RunReach | undefined
  /** @returns whether the hot-reload service is mounted, so a change to the profile's patch file reaches running plugins without a restart. */
  hotReload(): boolean
  /** Whether a port is free on this computer. @param port - the port. @returns whether nothing listens on it. */
  isPortFree(port: number): Promise<boolean>
  /** Runs `tailscale`. */
  readonly tailscale: TailscaleRunner
  /** @returns the time in milliseconds since the epoch. */
  now(): number
  /** @returns a fresh random code that cannot be guessed. */
  newCode(): string
  /** Whether this process runs as root. @returns whether it does. */
  runsAsRoot(): boolean
  /** Runs a change under the profile's write lock. @param profileDir - the profile directory. @param run - the change. @returns what it returned. */
  locked<T>(profileDir: string, run: () => Promise<T>): Promise<T>
}

/** The dependencies of a running Host. */
export function systemDependencies(ctx: Pick<Context, 'get'>): RunDependencies {
  return {
    where: () => {
      const profile = ctx.get('profileContext')
      return profile === undefined ? undefined : { profile: profile.name, profileDir: profile.dir, homeDir: profile.home }
    },
    runningPort: () => ctx.get('webServer')?.port,
    reach: () => ctx.get('reach'),
    hotReload: () => ctx.get('hmr') !== undefined,
    isPortFree,
    tailscale: systemTailscale(),
    now: () => Date.now(),
    newCode: () => randomBytes(24).toString('base64url'),
    runsAsRoot,
    locked: (profileDir, run) => withFileLock(join(profileDir, 'package.json'), run, { waitMs: LOCK_WAIT_MS }),
  }
}

/** One pending confirmation: when it expires and, for a ticket, the Tailscale name it names. */
interface Pending {
  readonly expiresAt: number
  readonly dnsName?: string
}

/** The service the routes call. */
export class RunSettings {
  private readonly dependencies: RunDependencies
  /** The code of the latest `dangerousBegin`; a new one replaces it. */
  private begun: { readonly code: string, readonly pending: Pending } | undefined
  /** The ticket of the latest `reachPreview`; a new one replaces it. */
  private ticket: { readonly code: string, readonly pending: Pending } | undefined

  /**
   * @param dependencies - what the service reads and changes.
   */
  constructor(dependencies: RunDependencies) {
    this.dependencies = dependencies
  }

  /**
   * What the profile answered and what runs now.
   * @returns the state.
   * @throws {RunError} `NO_PROFILE` while the Host has no profile.
   */
  async state(): Promise<RunState> {
    const where = this.located()
    const record = readAnswersRecord(where.profileDir)
    const prompts = promptsOf(record)
    return {
      recorded: record !== undefined,
      prompts,
      dangerous: await this.dangerousKind(where, prompts),
      background: backgroundOf(record),
      port: { chosen: chosenPort(where), running: this.dependencies.runningPort() ?? null },
      reach: reachOf(readReachRowAt(patchOf(where))),
    }
  }

  /**
   * Set how much Delorun asks, in the order `delorun setup prompts` writes: the rows, the dangerous-mode grant file, then the record.
   * @param answer - `safer` or `stock`; either one removes the dangerous-mode grant.
   * @returns the answer and whether a restart is needed.
   * @throws {RunError} `NOT_SET_UP` for a profile with no answers record.
   */
  async prompts(answer: SettablePrompts): Promise<PromptsWritten> {
    const where = this.located()
    return this.dependencies.locked(where.profileDir, async () => {
      this.recorded(where)
      writePromptRows(patchOf(where), answer)
      await removeDangerousGrant(where.homeDir)
      await updateAnswersRecord(where.profileDir, record => ({ ...record, prompts: answer }))
      return { prompts: answer, restartNeeded: !this.dependencies.hotReload() }
    })
  }

  /**
   * Start turning dangerous mode on. Changes nothing; a later `dangerousConfirm` with the code does.
   * @returns the warning, a single-use code, and when it expires.
   * @throws {RunError} `ROOT_REFUSED` for a root user, `NOT_SET_UP` for a profile with no answers record.
   */
  dangerousBegin(): DangerousBegun {
    const where = this.located()
    this.refuseRoot()
    this.recorded(where)
    const code = this.dependencies.newCode()
    const expiresAt = this.dependencies.now() + CONFIRMATION_MS
    this.begun = { code, pending: { expiresAt } }
    return { warning: DANGEROUS_WARNING_LINES, nonce: code, expiresAt, phrase: DANGEROUS_PHRASE }
  }

  /**
   * Finish turning dangerous mode on. Checks the root user, the yes, the code and the phrase, all before it writes; the
   * code works once, whatever the outcome. Staying on dangerous mode with a valid grant file changes nothing.
   * @param request - the code, whether the person answered yes to the first question, and what they typed.
   * @returns whether dangerous mode now holds.
   * @throws {RunError} `ROOT_REFUSED`, `NOT_CONFIRMED`, `CODE_EXPIRED` for a code that is wrong, spent or past its time, `PHRASE_WRONG`, `NOT_SET_UP`.
   */
  async dangerousConfirm(request: { readonly nonce: string, readonly understood: boolean, readonly phrase: string }): Promise<DangerousConfirmed> {
    const where = this.located()
    this.refuseRoot()
    if (!request.understood) throw new RunError('NOT_CONFIRMED', 'Dangerous mode stays off: the first question was not answered yes.')
    const issued = this.begun
    this.begun = undefined
    this.redeem(issued, request.nonce, 'Start again: the code for turning dangerous mode on was not issued, was used already or has run out.')
    if (request.phrase !== DANGEROUS_PHRASE) throw new RunError('PHRASE_WRONG', `Dangerous mode stays off: the phrase was not typed exactly as ${DANGEROUS_PHRASE}.`)
    return this.dependencies.locked(where.profileDir, async () => {
      const record = this.recorded(where)
      if (promptsOf(record) === 'dangerous' && (await readDangerousGrant(dangerousGrantPath(where.homeDir))).kind === 'valid') return { dangerous: 'on', restartNeeded: false }
      writePromptRows(patchOf(where), 'dangerous')
      await writeDangerousGrant(where.homeDir, new Date(this.dependencies.now()))
      await updateAnswersRecord(where.profileDir, current => ({ ...current, prompts: 'dangerous' }))
      return { dangerous: 'on', restartNeeded: !this.dependencies.hotReload() }
    })
  }

  /**
   * Choose whether Delorun keeps running after the terminal that started it closes.
   * @param on - the answer.
   * @returns the answer now recorded.
   * @throws {RunError} `NOT_SET_UP` for a profile with no answers record.
   */
  async background(on: boolean): Promise<BackgroundWritten> {
    const where = this.located()
    return this.dependencies.locked(where.profileDir, async () => {
      this.recorded(where)
      await updateAnswersRecord(where.profileDir, record => ({ ...record, background: on }))
      return { background: on, restartNeeded: RESTART_NEEDED.background }
    })
  }

  /**
   * Choose the studio's port for the next start.
   * @param port - the port, from 1024 to 65535.
   * @returns the port and the studio's address after the restart.
   * @throws {RunError} `NOT_SET_UP`, `PORT_UNCHANGED` for the port the studio uses now or has chosen, `PORT_BUSY` for a port another program holds.
   */
  async port(port: number): Promise<PortWritten> {
    const where = this.located()
    return this.dependencies.locked(where.profileDir, async () => {
      this.recorded(where)
      if (port === chosenPort(where) || port === this.dependencies.runningPort()) throw new RunError('PORT_UNCHANGED', `The studio already uses port ${String(port)}.`)
      if (!await this.dependencies.isPortFree(port)) throw new RunError('PORT_BUSY', `Port ${String(port)} is in use on this computer. Choose another.`)
      setPatchRow(patchOf(where), studioRow(port))
      await updateAnswersRecord(where.profileDir, record => ({ ...record, profile: { ...isRecord(record['profile']) ? record['profile'] : {}, port: port === SETUP_DEFAULT_PORT ? null : port } }))
      return { port, origin: `http://127.0.0.1:${String(port)}`, restartNeeded: RESTART_NEEDED.port }
    })
  }

  /**
   * Read what turning phone access on would do, and issue the ticket that confirms it. Changes nothing.
   * @returns the private address, the trust statement and the ticket.
   * @throws {RunError} `NOT_SET_UP`, `TAILSCALE_UNAVAILABLE` with what to fix.
   */
  async reachPreview(): Promise<ReachPreview> {
    this.recorded(this.located())
    const { dnsName } = await this.tailscaleFacts()
    const code = this.dependencies.newCode()
    const expiresAt = this.dependencies.now() + CONFIRMATION_MS
    this.ticket = { code, pending: { expiresAt, dnsName } }
    return { address: tailscaleAddress(dnsName, DEFAULT_SERVE_PORT), trust: TRUST_STATEMENT, ticket: code, expiresAt }
  }

  /**
   * Turn phone access on with the ticket of a preview, or off. Turning it on changes Tailscale, as `delorun reach on
   * tailscale` does: the serve access check runs first, and a failed check writes nothing.
   * @param request - `{ on: false }`, or `{ on: true, ticket }`.
   * @returns the state of the phone listener.
   * @throws {RunError} `NOT_SET_UP`, `TICKET_INVALID` for a missing, wrong, spent or expired ticket or one for another Tailscale name, `TAILSCALE_UNAVAILABLE`.
   */
  async reach(request: { readonly on: false } | { readonly on: true, readonly ticket: string }): Promise<ReachWritten> {
    const where = this.located()
    this.recorded(where)
    return request.on ? this.reachOn(where, request.ticket) : this.reachOff(where)
  }

  private async reachOn(where: RunWhere, ticket: string): Promise<ReachWritten> {
    const issued = this.ticket
    this.ticket = undefined
    const { dnsName } = this.redeem(issued, ticket, 'Check phone access again: the ticket was not issued, was used already or has run out.', 'TICKET_INVALID')
    if (dnsName === undefined) throw new RunError('TICKET_INVALID', 'Check phone access again: the ticket names no Tailscale name.')
    const row = readReachRowAt(patchOf(where))
    const reach = this.dependencies.reach()
    const holds = row.enabled && reach?.mounted === true
    let listenerPort: number
    try {
      const facts = await readTailscale(this.dependencies.tailscale)
      if (facts.dnsName !== dnsName) throw new RunError('TICKET_INVALID', 'Check phone access again: this computer\'s Tailscale name changed since the check.')
      listenerPort = await listenerPortFor(row.listenerPort, holds)
      await checkServeAccess(this.dependencies.tailscale, { host: facts.dnsName, servePort: DEFAULT_SERVE_PORT, listenerPort, keepOwn: holds, next: 'then try again' })
    } catch (error) {
      throw unavailable(error)
    }
    const address = tailscaleAddress(dnsName, DEFAULT_SERVE_PORT)
    const next: TailscalePrivateRow = { ...row, enabled: true, address, servePort: DEFAULT_SERVE_PORT, listenerPort }
    await this.dependencies.locked(where.profileDir, () => {
      writeReachRowAt(patchOf(where), next)
      // Who may ask to pair without an approval window goes back to the safe default; only a terminal widens it.
      writeMayAskAt(patchOf(where), 'own-user')
      return Promise.resolve()
    })
    return this.applied(reach, next, true)
  }

  private async reachOff(where: RunWhere): Promise<ReachWritten> {
    const row = readReachRowAt(patchOf(where))
    const next: TailscalePrivateRow = { ...row, enabled: false }
    await this.dependencies.locked(where.profileDir, () => {
      writeReachRowAt(patchOf(where), next)
      return Promise.resolve()
    })
    let stillServed: string | undefined
    try {
      const host = URL.parse(row.address)?.hostname ?? (await readTailscale(this.dependencies.tailscale)).dnsName
      await removeServe(this.dependencies.tailscale, host, row.servePort, serveTarget(row.listenerPort))
    } catch (error) {
      // Tailscale that is not installed serves nothing; any other failure leaves a rule the person must remove.
      if (!(error instanceof ReachError)) throw error
      if (error.code !== 'TAILSCALE_NOT_INSTALLED') stillServed = error.detail
    }
    const answer = await this.applied(this.dependencies.reach(), next, false)
    return stillServed === undefined ? answer : { ...answer, stillServed }
  }

  private async applied(reach: RunReach | undefined, row: TailscalePrivateRow, on: boolean): Promise<ReachWritten> {
    const states = await reach?.apply(reachRowsOf(row))
    const ready = on && states?.some(state => state.option === 'tailscale-private' && state.state === 'ready') === true
    return { on, address: on ? row.address : '', ready, restartNeeded: states === undefined || RESTART_NEEDED.reach }
  }

  private async tailscaleFacts(): Promise<{ readonly dnsName: string }> {
    try {
      return await readTailscale(this.dependencies.tailscale)
    } catch (error) {
      throw unavailable(error)
    }
  }

  private async dangerousKind(where: RunWhere, prompts: string): Promise<DangerousKind> {
    if (prompts !== 'dangerous') return 'off'
    return (await readDangerousGrant(dangerousGrantPath(where.homeDir))).kind === 'valid' ? 'on' : 'inactive'
  }

  private refuseRoot(): void {
    if (this.dependencies.runsAsRoot()) throw new RunError('ROOT_REFUSED', 'Dangerous mode is refused when Delorun runs as root, because full access then reaches the whole computer, not one user\'s account. Run Delorun as an ordinary user.')
  }

  /**
   * Check a code against the one issued, and its time.
   * @param issued - the code issued last, if any.
   * @param code - the code the request names.
   * @param message - the sentence when it does not hold.
   * @param refusal - the refusal's code.
   * @returns what the issued code stands for.
   * @throws {RunError} when no code was issued, it differs, or it has run out.
   */
  private redeem(issued: { readonly code: string, readonly pending: Pending } | undefined, code: string, message: string, refusal: 'CODE_EXPIRED' | 'TICKET_INVALID' = 'CODE_EXPIRED'): Pending {
    if (issued === undefined || issued.code !== code || this.dependencies.now() > issued.pending.expiresAt) throw new RunError(refusal, message)
    return issued.pending
  }

  private located(): RunWhere {
    const where = this.dependencies.where()
    if (where === undefined) throw new RunError('NO_PROFILE', 'This studio runs without a profile, so it has no setup choices.')
    return where
  }

  private recorded(where: RunWhere): AnswersRecord {
    const record = readAnswersRecord(where.profileDir)
    if (record === undefined) throw new RunError('NOT_SET_UP', 'This profile has not been through setup, so there is no answer to change. Run delorun setup in a terminal first.')
    return record
  }
}

/**
 * @param where - where the profile is.
 * @returns the profile's patch file.
 */
function patchOf(where: RunWhere): string {
  return join(where.profileDir, 'cordis.patch.yml')
}

/**
 * @param where - where the profile is.
 * @returns the port the profile's patch chooses for the studio, or setup's default when it sets none the studio can read.
 */
function chosenPort(where: RunWhere): number {
  let port: unknown
  try {
    port = readPatchRow(patchOf(where), STUDIO_ROW_ID, 'delorun')?.['port']
  } catch (error) {
    // A patch the studio cannot read leaves the default shown; the section's other rows report the same file.
    if (!(error instanceof SetupApplyError)) throw error
    return SETUP_DEFAULT_PORT
  }
  return typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : SETUP_DEFAULT_PORT
}

/**
 * @param row - the Tailscale private option.
 * @returns whether phone access is on and its address.
 */
function reachOf(row: TailscalePrivateRow): RunState['reach'] {
  return { on: row.enabled, address: row.enabled ? row.address : '' }
}

/**
 * @param value - a parsed value.
 * @returns whether it is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The refusal of a Tailscale check that did not pass.
 * @param error - what the check threw.
 * @returns the refusal for a {@link ReachError} or a refusal already made; any other error is thrown.
 * @throws whatever else the check threw.
 */
function unavailable(error: unknown): RunError {
  if (error instanceof RunError) return error
  if (error instanceof ReachError) return new RunError('TAILSCALE_UNAVAILABLE', `${error.detail} Phone access stays off.`, { cause: error })
  throw error
}

const PromptsBody = z.strictObject({ answer: z.enum(['safer', 'stock']) })
const EmptyBody = z.strictObject({})
const ConfirmBody = z.strictObject({ nonce: z.string().min(1).max(256), understood: z.boolean(), phrase: z.string().max(256) })
const BackgroundBody = z.strictObject({ on: z.boolean() })
const PortBody = z.strictObject({ port: z.number().int().min(1024).max(65_535) })
const ReachBody = z.discriminatedUnion('on', [z.strictObject({ on: z.literal(false) }), z.strictObject({ on: z.literal(true), ticket: z.string().min(1).max(256) })])

/**
 * The JSON response of a status and a body, never cached.
 * @param status - the HTTP status.
 * @param body - the body.
 * @returns the response.
 */
function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Parse a bounded JSON body against a schema.
 * @param request - the request.
 * @param schema - the message.
 * @returns the message, or undefined for a body over {@link MAX_RUN_REQUEST_BYTES}, not JSON or not the message.
 */
async function bodyOf<T>(request: Request, schema: z.ZodType<T>): Promise<T | undefined> {
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_RUN_REQUEST_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch (_notJson) {
    // The parser's message quotes the body; the request is only refused.
    return undefined
  }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

/**
 * Parse the body and run the call, answering a {@link RunError} as its refusal.
 * @param request - the request.
 * @param schema - the route's message.
 * @param call - the call, given the message.
 * @returns the response.
 * @throws whatever else the call throws, which upstream's connection answers as a failure.
 */
async function answered<T>(request: Request, schema: z.ZodType<T>, call: (body: T) => object | Promise<object>): Promise<Response> {
  const body = await bodyOf(request, schema)
  if (body === undefined) return refusal('BAD_REQUEST', 'The request must be JSON in the form the route takes, and at most 2048 bytes.')
  return run(() => call(body))
}

/**
 * @param code - the refusal.
 * @param message - the sentence.
 * @returns the response.
 */
function refusal(code: RunRefusal, message: string): Response {
  return json(RUN_REFUSAL_STATUS[code], { error: code, message })
}

/**
 * Run a call and answer it, turning a {@link RunError} into its refusal.
 * @param call - the call.
 * @returns the response.
 * @throws whatever else the call throws.
 */
async function run(call: () => object | Promise<object>): Promise<Response> {
  try {
    return json(200, await call())
  } catch (error) {
    if (error instanceof RunError) return refusal(error.code, error.message)
    throw error
  }
}

/**
 * Wrap a class gate so a request the home reads as `free` skips it: the gate decides every other request, and hashes
 * the same bytes, so a free call cannot carry what the gate would have asked about.
 * @param gate - the class gate.
 * @param free - decides, from a copy of the request, whether the call only tightens.
 * @param handler - the route's own handler.
 * @returns the `admitPeer` and `fetch` of the route.
 */
function tightenFree(gate: ReturnType<typeof gateByClass>, free: (request: Request) => Promise<boolean>, handler: (request: Request) => Promise<Response>): Pick<ReturnType<typeof gateByClass>, 'admitPeer' | 'fetch'> {
  return { admitPeer: gate.admitPeer, fetch: async request => ((await free(request.clone())) ? handler(request) : gate.fetch(request)) }
}

/** The routes only the home's own computer may call. */
const COMPUTER_PATHS: ReadonlySet<string> = new Set([RUN_ROUTES.dangerousBegin, RUN_ROUTES.dangerousConfirm, RUN_ROUTES.port, RUN_ROUTES.reachPreview, RUN_ROUTES.reach])

/** The routes a paired device may also call, behind the unlock of its own level. */
const DEVICE_PATHS: ReadonlySet<string> = new Set([RUN_ROUTES.state, RUN_ROUTES.prompts, RUN_ROUTES.background])

/**
 * Register the routes on a context that holds the Connection. The arrival and origin checks run on the Connection's
 * `connection/request` hook, before the route reads anything.
 * @param ctx - the context, whose disposal removes the routes and the hook.
 * @param service - the service the routes call.
 */
export function registerRunRoutes(ctx: Context, service: RunSettings): void {
  ctx.on('connection/request', async (request, response, next) => {
    const path = routedPathname(request.url)
    const homeAuth = ctx.get('homeAuth')
    if (COMPUTER_PATHS.has(path) && !requireComputer(request, response, homeAuth, ACTION)) return
    if (DEVICE_PATHS.has(path)) {
      if (!requireComputerOrDevice(request, response, homeAuth, ACTION)) return
      if (path !== RUN_ROUTES.state && !fromStudioPage(request, homeAuth?.arrivalOf(request).listener === 'loopback')) {
        response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: 'FOREIGN_ORIGIN', message: `${ACTION} must come from the studio's own page.` }))
        return
      }
    } else if (COMPUTER_PATHS.has(path) && !fromStudioPage(request, true)) {
      response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'FOREIGN_ORIGIN', message: `${ACTION} must come from the studio's own page.` }))
      return
    }
    await next()
  })
  const anyDevice = admitApprovedDevice()
  const setPrompts = (request: Request): Promise<Response> => answered(request, PromptsBody, body => service.prompts(body.answer))
  const saferOnly = async (request: Request): Promise<boolean> => (await bodyOf(request, PromptsBody))?.answer === 'safer'
  ctx.connection.fetch.register({
    path: RUN_ROUTES.state, methods: ['GET'], requestBody: 'buffered', admitPeer: anyDevice,
    fetch: () => run(() => service.state()),
  })
  // `safer` only tightens, so any approved device may; `stock` turns questions off, so a device confirms it with Face ID or its PIN.
  // The home reads the body to tell them apart: a body that is not `safer` takes the class gate, which hashes the same bytes.
  ctx.connection.fetch.register({
    path: RUN_ROUTES.prompts, methods: ['POST'], requestBody: 'buffered',
    ...tightenFree(gateByClass(() => ctx.get('homeAuth'), setPrompts, { row: 'route:bundle-local/src/run-settings.ts#RUN_ROUTES.prompts', action: 'bundle-local/run-prompts', legacy: { grace: false, renews: true } }), saferOnly, setPrompts),
  })
  ctx.connection.fetch.register({
    path: RUN_ROUTES.background, methods: ['POST'], requestBody: 'buffered',
    ...gateByClass(() => ctx.get('homeAuth'), request => answered(request, BackgroundBody, body => service.background(body.on)), { row: 'route:bundle-local/src/run-settings.ts#RUN_ROUTES.background', action: 'bundle-local/run-background', legacy: { grace: false, renews: true } }),
  })
  // The rest admit no paired device: the Connection refuses a device, and the hook above answers it `LOOPBACK_REQUIRED` first.
  ctx.connection.fetch.register({
    path: RUN_ROUTES.dangerousBegin, methods: ['POST'], requestBody: 'buffered',
    fetch: request => answered(request, EmptyBody, () => service.dangerousBegin()),
  })
  ctx.connection.fetch.register({
    path: RUN_ROUTES.dangerousConfirm, methods: ['POST'], requestBody: 'buffered',
    fetch: request => answered(request, ConfirmBody, body => service.dangerousConfirm(body)),
  })
  ctx.connection.fetch.register({
    path: RUN_ROUTES.port, methods: ['POST'], requestBody: 'buffered',
    fetch: request => answered(request, PortBody, body => service.port(body.port)),
  })
  ctx.connection.fetch.register({
    path: RUN_ROUTES.reachPreview, methods: ['POST'], requestBody: 'buffered',
    fetch: request => answered(request, EmptyBody, () => service.reachPreview()),
  })
  ctx.connection.fetch.register({
    path: RUN_ROUTES.reach, methods: ['POST'], requestBody: 'buffered',
    fetch: request => answered(request, ReachBody, body => service.reach(body)),
  })
}

/**
 * Mount the routes once the Connection is up. The writes are `@delorun/setup-apply`'s, so the row keeps no store.
 * @param ctx - the row's scope.
 */
export function apply(ctx: Context): void {
  ctx.inject(['connection'], (scope) => {
    registerRunRoutes(scope, new RunSettings(systemDependencies(scope)))
  })
}
