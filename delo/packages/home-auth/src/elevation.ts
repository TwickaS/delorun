/**
 * Elevation, "sudo mode": the short time a device may take the ordinary work of the home's computer that C14 refuses a
 * device without one, approved at that computer (C14, "Elevation").
 *
 * - **A device asks, the computer answers.** The device's studio posts a request under its own session; the home records
 *   it against the device, the listener and the session it arrived on, and shows the device an 8-digit code. Only the
 *   person at the home's computer approves it, by typing that code, so a request from a device the person is not holding
 *   is never approved by mistake. A wrong code counts, and the third cancels the request.
 * - **One device, one listener, one profile.** An elevation names its device and listener, and lives in the memory of
 *   the one profile's Host that approved it, so it admits nothing on another listener or in another profile.
 * - **It ends.** At its expiry, on its own timer; when the person revokes it at the computer; when the device locks it
 *   from its own studio; when the session that asked ends; when the device is removed; when its listener stops; and when
 *   the home stops. Every start and every ending is reported with the device, the listener, the elevation id and the
 *   reason, so the log says who ended it.
 * - **Nothing is stored.** A restart ends every elevation, which is what a person expects of a reboot.
 *
 * Nothing here extends an elevation: a new one is a new request approved at the computer, and it replaces the one the
 * device held.
 *
 * @module @delo/home-auth/elevation
 */
import { timingSafeEqual } from 'node:crypto'
import type { DeviceId, ReachListenerId } from '@delo/contract-admission'
import { ELEVATION_LIMITS, type ElevationEndReason, type ElevationState } from '@delo/contract-oidc-passkeys'
import { HomeAuthError } from './errors.ts'
import { newSecret, type RandomBytes } from './secret.ts'

/** Who asked for an elevation: the device, the listener and the session its request arrived on. */
export interface ElevationAsker {
  readonly deviceId: DeviceId
  readonly listener: ReachListenerId
  /** The session that asked; the elevation ends with it. */
  readonly sessionId: string
  /** The device's name, so a person reading the log or the computer's list knows which device it was. */
  readonly label: string
}

/** One running elevation. */
export interface ElevationRecord extends ElevationAsker {
  /** The elevation's id, which every action it admits logs. */
  readonly id: string
  readonly startedAt: number
  readonly endsAt: number
}

/** One request to elevate, waiting for the person at the computer. */
export interface ElevationRequest extends ElevationAsker {
  readonly requestId: string
  /** The 8 digits the device shows and the person types at the computer. */
  readonly code: string
  readonly requestedAt: number
  readonly expiresAt: number
}

/** A pending request as the computer lists it: without the code, which the person reads from the device. */
export type PendingElevation = Omit<ElevationRequest, 'code'>

/** One elevation that started or ended, as the log records it. */
export type ElevationChange =
  | { readonly kind: 'started'; readonly elevation: ElevationRecord }
  | { readonly kind: 'ended'; readonly elevation: ElevationRecord; readonly reason: ElevationEndReason }

/** The clock, the random source and the listener of an {@link Elevations}. */
export interface ElevationsOptions {
  readonly now: () => number
  readonly random: RandomBytes
  /**
   * Called once when an elevation starts and once when it ends, after the change; the home logs it and recomputes the
   * device's access snapshot.
   * @param change - what changed.
   */
  readonly changed: (change: ElevationChange) => void
}

/** A pending request and the wrong codes typed for it. */
interface Pending {
  readonly request: ElevationRequest
  wrongCodes: number
}

/** A running elevation and its expiry timer. */
interface Running {
  readonly record: ElevationRecord
  readonly timer: NodeJS.Timeout
}

/**
 * Whether a number of minutes is one an elevation may last.
 * @param minutes - the candidate.
 * @returns whether it is a whole number from 1 to {@link ELEVATION_LIMITS.maxMinutes}.
 */
export function isElevationMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= ELEVATION_LIMITS.maxMinutes
}

/** The elevations and pending elevation requests of one profile's home. */
export class Elevations {
  private readonly running = new Map<string, Running>()
  private readonly requests = new Map<string, Pending>()
  private readonly options: ElevationsOptions

  /**
   * @param options - the clock, the random source and the listener.
   */
  constructor(options: ElevationsOptions) {
    this.options = options
  }

  /**
   * Record a device's request to elevate, replacing any request it already has on that listener.
   * @param asker - the device, the listener, the session and the device's label.
   * @returns the request, with the code the device shows.
   * @throws {HomeAuthError} `APPROVAL_PENDING_LIMIT` when the home holds its limit of requests from other devices.
   */
  request(asker: ElevationAsker): ElevationRequest {
    this.cancelFor(asker.deviceId, asker.listener)
    const at = this.options.now()
    this.prune(at)
    if (this.requests.size >= ELEVATION_LIMITS.pendingPerHome) {
      throw new HomeAuthError('APPROVAL_PENDING_LIMIT', `This home holds ${String(ELEVATION_LIMITS.pendingPerHome)} requests to unlock already. Answer one at the computer first`)
    }
    const request: ElevationRequest = {
      ...asker,
      requestId: newSecret(ELEVATION_LIMITS.idBytes, this.options.random),
      code: this.newCode(),
      requestedAt: at,
      expiresAt: at + ELEVATION_LIMITS.requestLifetimeMs,
    }
    this.requests.set(request.requestId, { request, wrongCodes: 0 })
    return request
  }

  /**
   * The requests waiting for the person at the computer, oldest first, without their codes.
   * @returns the requests.
   */
  pending(): readonly PendingElevation[] {
    this.prune(this.options.now())
    return [...this.requests.values()]
      .map(({ request: { code: _code, ...rest } }) => rest)
      .sort((left, right) => left.requestedAt - right.requestedAt)
  }

  /**
   * The request one device has waiting on one listener, with its code, for that device's own studio.
   * @param deviceId - the device.
   * @param listener - the listener.
   * @returns the request, or undefined.
   */
  requestOf(deviceId: string, listener: ReachListenerId): ElevationRequest | undefined {
    this.prune(this.options.now())
    return [...this.requests.values()].find(({ request }) => request.deviceId === deviceId && request.listener === listener)?.request
  }

  /**
   * Approve one request at the home's computer with the code the person typed, which starts the elevation and ends any
   * other the device held on that listener.
   * @param requestId - the request.
   * @param typedCode - the 8 digits the person typed from the device's screen, spaces and hyphens allowed.
   * @param minutes - how long it lasts, the minutes of the listener the request arrived on.
   * @returns the elevation that started.
   * @throws {HomeAuthError} `APPROVAL_EXPIRED` for an unknown or expired request; `APPROVAL_CODE_MISMATCH` for a wrong
   *   code, the third of which cancels the request; `BAD_REQUEST` for minutes outside C14's limits.
   */
  approve(requestId: string, typedCode: string, minutes: number): ElevationRecord {
    if (!isElevationMinutes(minutes)) {
      throw new HomeAuthError('BAD_REQUEST', `an elevation lasts a whole number of minutes from 1 to ${String(ELEVATION_LIMITS.maxMinutes)}, got ${String(minutes)}`)
    }
    const at = this.options.now()
    this.prune(at)
    const pending = this.requests.get(requestId)
    if (pending === undefined) throw new HomeAuthError('APPROVAL_EXPIRED', 'That request to unlock expired or was answered. Ask again from the device')
    if (!codeMatches(typedCode, pending.request.code)) {
      pending.wrongCodes += 1
      const cancelled = pending.wrongCodes >= ELEVATION_LIMITS.wrongCodesPerRequest
      if (cancelled) this.requests.delete(requestId)
      throw new HomeAuthError('APPROVAL_CODE_MISMATCH', cancelled
        ? 'That code does not match, and the request was cancelled. Ask again from the device'
        : 'That code does not match the one the device shows. Type it again')
    }
    this.requests.delete(requestId)
    const { request } = pending
    this.endFor(request.deviceId, request.listener, 'replaced')
    const record: ElevationRecord = {
      id: newSecret(ELEVATION_LIMITS.idBytes, this.options.random),
      deviceId: request.deviceId,
      listener: request.listener,
      sessionId: request.sessionId,
      label: request.label,
      startedAt: at,
      endsAt: at + minutes * 60_000,
    }
    const running: Running = { record, timer: setTimeout(() => { this.end(running, 'expired') }, record.endsAt - at) }
    running.timer.unref()
    this.running.set(record.id, running)
    this.options.changed({ kind: 'started', elevation: record })
    return record
  }

  /**
   * Decline one pending request at the computer.
   * @param requestId - the request.
   * @returns whether it was pending.
   */
  decline(requestId: string): boolean {
    return this.requests.delete(requestId)
  }

  /**
   * The elevation a device holds on one listener; an elevation past its end is ended here as `expired`, in case its
   * timer has not fired yet.
   * @param deviceId - the device.
   * @param listener - the listener its Peer sits on.
   * @returns the elevation, or undefined.
   */
  of(deviceId: string, listener: ReachListenerId): ElevationRecord | undefined {
    const at = this.options.now()
    for (const running of [...this.running.values()]) {
      const { record } = running
      if (record.deviceId !== deviceId || record.listener !== listener) continue
      if (record.endsAt > at) return record
      this.end(running, 'expired')
    }
    return undefined
  }

  /**
   * What one device's own studio shows on one listener: its elevation, else its waiting request with the code, else none.
   * @param deviceId - the device.
   * @param listener - the listener.
   * @returns the state.
   */
  stateOf(deviceId: string, listener: ReachListenerId): ElevationState {
    const elevation = this.of(deviceId, listener)
    if (elevation !== undefined) return { kind: 'elevated', elevationId: elevation.id, endsAt: elevation.endsAt }
    const request = this.requestOf(deviceId, listener)
    if (request !== undefined) return { kind: 'pending', requestId: request.requestId, code: request.code, expiresAt: request.expiresAt }
    return { kind: 'none' }
  }

  /**
   * Every running elevation, for the computer's list.
   * @returns the elevations, oldest first.
   */
  list(): readonly ElevationRecord[] {
    return [...this.running.values()].map(({ record }) => record).filter(record => this.of(record.deviceId, record.listener) !== undefined)
  }

  /**
   * End the elevation of one device on one listener and cancel its waiting request: what the device's own Lock does.
   * @param deviceId - the device.
   * @param listener - the listener.
   * @param reason - why it ended.
   * @returns how many elevations ended, zero or one.
   */
  endFor(deviceId: string, listener: ReachListenerId, reason: ElevationEndReason): number {
    this.cancelFor(deviceId, listener)
    return this.endWhere(record => record.deviceId === deviceId && record.listener === listener, reason)
  }

  /**
   * End one elevation by its id, which the person's revoke at the computer names.
   * @param elevationId - the elevation.
   * @param reason - why it ended.
   * @returns whether it was running.
   */
  endById(elevationId: string, reason: ElevationEndReason): boolean {
    return this.endWhere(record => record.id === elevationId, reason) > 0
  }

  /**
   * End every elevation and request of one device, whatever its listener.
   * @param deviceId - the device.
   * @param reason - why it ended.
   */
  endDevice(deviceId: string, reason: ElevationEndReason): void {
    this.dropRequests(request => request.deviceId === deviceId)
    this.endWhere(record => record.deviceId === deviceId, reason)
  }

  /**
   * End the elevations and requests of one session.
   * @param sessionId - the session.
   * @param reason - why it ended.
   */
  endSession(sessionId: string, reason: ElevationEndReason): void {
    this.dropRequests(request => request.sessionId === sessionId)
    this.endWhere(record => record.sessionId === sessionId, reason)
  }

  /**
   * End the elevations and requests of one listener.
   * @param listener - the listener.
   * @param reason - why it ended.
   */
  endListener(listener: ReachListenerId, reason: ElevationEndReason): void {
    this.dropRequests(request => request.listener === listener)
    this.endWhere(record => record.listener === listener, reason)
  }

  /**
   * End every elevation and request.
   * @param reason - why they ended.
   */
  endAll(reason: ElevationEndReason): void {
    this.requests.clear()
    this.endWhere(() => true, reason)
  }

  /**
   * End the running elevations a predicate picks.
   * @param picks - the predicate.
   * @param reason - why they ended.
   * @returns how many ended.
   */
  private endWhere(picks: (record: ElevationRecord) => boolean, reason: ElevationEndReason): number {
    let ended = 0
    for (const running of [...this.running.values()]) {
      if (!picks(running.record)) continue
      this.end(running, reason)
      ended += 1
    }
    return ended
  }

  /**
   * End one running elevation, clear its timer and report it.
   * @param running - the elevation and its timer.
   * @param reason - why it ended.
   */
  private end(running: Running, reason: ElevationEndReason): void {
    clearTimeout(running.timer)
    this.running.delete(running.record.id)
    this.options.changed({ kind: 'ended', elevation: running.record, reason })
  }

  /**
   * Cancel the request one device has waiting on one listener.
   * @param deviceId - the device.
   * @param listener - the listener.
   */
  private cancelFor(deviceId: string, listener: ReachListenerId): void {
    this.dropRequests(request => request.deviceId === deviceId && request.listener === listener)
  }

  /**
   * Drop the requests a predicate picks.
   * @param picks - the predicate.
   */
  private dropRequests(picks: (request: ElevationRequest) => boolean): void {
    for (const [id, { request }] of [...this.requests]) {
      if (picks(request)) this.requests.delete(id)
    }
  }

  /**
   * Drop the requests that expired.
   * @param at - the time, in milliseconds since the epoch.
   */
  private prune(at: number): void {
    this.dropRequests(request => request.expiresAt <= at)
  }

  /**
   * A new 8-digit code, uniform over every value.
   * @returns the digits.
   */
  private newCode(): string {
    for (;;) {
      const value = Buffer.from(this.options.random(4)).readUInt32BE(0)
      // 4_200_000_000 is the largest multiple of 10^8 below 2^32, so every code is equally likely.
      if (value < 4_200_000_000) return String(value % 100_000_000).padStart(8, '0')
    }
  }
}

/**
 * Whether a typed code is the request's code.
 * @param typed - what the person typed, with or without spaces and hyphens.
 * @param expected - the request's 8 digits.
 * @returns whether they are the same digits, compared in constant time.
 */
function codeMatches(typed: string, expected: string): boolean {
  const digits = typed.replace(/[\s-]/g, '')
  return digits.length === expected.length && timingSafeEqual(Buffer.from(digits), Buffer.from(expected))
}
