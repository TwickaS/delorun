/**
 * Page unlocks of PIN mode (C14, "PIN mode"): the PIN or passcode a person types on an approved device mints a page
 * unlock, an {@link ElevationRecord} marked `page` that only the Peer admitted under its id holds (never the device-wide
 * `elevationOf`), and a 32-byte token the page keeps in memory.
 *
 * - **The token.** It is returned once and kept only as a SHA-256 digest. It is bound to the unlock's device, listener
 *   and session: a presentation from another device, listener or session ends the unlock ({@link PinUnlocks.resolve}),
 *   because a token that moved is a token that leaked.
 * - **It ends.** At the idle end, which activity ({@link PinUnlocks.touch}) pushes forward but never past the absolute cap;
 *   on the lock route; when the PIN changes or the mode turns off; and with every ending of an elevation (session end,
 *   device removal, listener or Host stop).
 * - **Wrong tries.** The device's fifth miss removes it as a removal at the computer does; ten misses across the home
 *   within 24 hours pause PIN unlocks until the computer resumes them. Both are {@link PinModeStore}'s counts.
 *
 * @module @delo/home-auth/pin-unlocks
 */
import type { DeviceId, ReachListenerId } from '@delo/contract-admission'
import { REACH_OPTION_LISTENERS } from '@delo/contract-reach-providers'
import { PIN_MODE_LIMITS, type PinKind, type PinModeState } from '@delo/contract-oidc-passkeys'
import type { SecretSink } from '@delo/contract-operational-logs'
import { type ElevationChange, type ElevationRecord, type Elevations } from './elevation.ts'
import { HomeAuthError } from './errors.ts'
import type { PinModeStore} from './pin-mode.ts';
import { type PinModeSummary } from './pin-mode.ts'
import { hashSecret, newSecret, type RandomBytes } from './secret.ts'

/** The only listener a PIN unlocks on in v1: the Tailscale private address. */
export const PIN_LISTENER: ReachListenerId = REACH_OPTION_LISTENERS['tailscale-private']

/** The device and session a request to unlock arrived with. */
export interface UnlockAsker {
  readonly deviceId: DeviceId
  readonly listener: ReachListenerId
  readonly sessionId: string
}

/** What the page receives when it unlocks; the token is not available again. */
export interface PageUnlock {
  readonly token: string
  readonly unlockId: string
  readonly endsAt: number
  readonly idleEndsAt: number
}

/** A PIN event the provider logs; none carries the secret. */
export type PinEvent =
  | { readonly kind: 'wrong'; readonly deviceId: string; readonly triesLeft: number }
  | { readonly kind: 'lockout'; readonly deviceId: string }
  | { readonly kind: 'paused' }
  | { readonly kind: 'resumed' }
  | { readonly kind: 'set'; readonly secret: PinKind }
  | { readonly kind: 'off' }

/** What {@link PinUnlocks} uses of its home. */
export interface PinUnlocksOptions {
  readonly store: PinModeStore
  readonly elevations: Elevations
  readonly now: () => number
  readonly random: RandomBytes
  /** Where a minted token is registered while its unlock lives, so no log holds it. */
  readonly secrets?: SecretSink | undefined
  /**
   * Remove a device exactly as the computer's removal does.
   * @param deviceId - the device.
   */
  readonly removeDevice: (deviceId: DeviceId) => Promise<unknown>
  /**
   * Whether a presented session id is the bound session or the one it rolled from, which still admits requests in flight.
   * @param presented - the session id the request arrived with.
   * @param bound - the session id the unlock is bound to.
   * @returns whether they are one session.
   */
  readonly sameSession: (presented: string, bound: string) => boolean
  readonly stillAdmitted: (asker: UnlockAsker) => boolean
  /**
   * Called with each PIN event.
   * @param event - what happened.
   */
  readonly report: (event: PinEvent) => void
}

/** The page unlocks of one home. */
export class PinUnlocks {
  private readonly options: PinUnlocksOptions
  /** Digest of a token to the id of its elevation and the drop of the token's registration with the redactor. */
  private readonly tokens = new Map<string, { readonly id: string; readonly release: () => void }>()

  /**
   * @param options - the store, the elevations, the clock and the reporting.
   */
  constructor(options: PinUnlocksOptions) {
    this.options = options
  }

  /**
   * What PIN mode is, for the computer.
   * @returns the store's summary.
   */
  summary(): PinModeSummary {
    return this.options.store.summary()
  }

  /**
   * What PIN mode is for one device's own studio, with the device's running unlock when its token is given.
   * @param deviceId - the device.
   * @param listener - the listener its session lives on.
   * @param token - the page's token, when it holds one.
   * @returns the state.
   */
  stateOf(deviceId: DeviceId, listener: ReachListenerId, token: string | undefined): PinModeState {
    const summary = this.options.store.summary()
    if (!summary.enabled || summary.kind === undefined) return { kind: 'off' }
    const id = token === undefined ? undefined : this.tokens.get(hashSecret(token))?.id
    const record = id === undefined ? undefined : this.options.elevations.get(id)
    const mine = record?.deviceId === deviceId && record.listener === listener ? record : undefined
    return {
      kind: 'on', secret: summary.kind, idleMinutes: summary.idleMinutes, lockWhenHidden: summary.lockWhenHidden, paused: summary.paused,
      unlock: mine === undefined ? null : { unlockId: mine.id, endsAt: mine.startedAt + PIN_MODE_LIMITS.absoluteCapMs, idleEndsAt: mine.endsAt },
    }
  }

  /**
   * Unlock one page with a PIN or passcode.
   * @param asker - the device, listener and session that asked.
   * @param secret - what the person typed.
   * @returns the unlock, with the token the page keeps.
   * @throws {HomeAuthError} `PIN_NOT_ALLOWED_ON_ADDRESS` off the private address; `PIN_MODE_OFF`; `PIN_UNLOCKS_PAUSED`;
   *   `PIN_INVALID` for a wrong secret, and for the fifth miss, after the device was removed.
   */
  async unlock(asker: UnlockAsker, secret: string): Promise<PageUnlock> {
    if (asker.listener !== PIN_LISTENER) {
      throw new HomeAuthError('PIN_NOT_ALLOWED_ON_ADDRESS', 'A PIN unlocks only on the Tailscale private address. Use the computer on this address')
    }
    const outcome = await this.options.store.check(asker.deviceId, secret)
    switch (outcome.kind) {
      case 'ok':
        // The comparison awaited: a removal, a session end or a listener stop in that time leaves nothing to unlock.
        if (!this.options.stillAdmitted(asker)) throw new HomeAuthError('UNLOCK_INVALID', 'This page is locked. Unlock it again')
        return this.mint(asker)
      case 'paused':
        throw new HomeAuthError('PIN_UNLOCKS_PAUSED', 'PIN unlocks are paused after too many wrong tries. Resume them at your computer', { paused: true })
      case 'lockout':
        this.options.report({ kind: 'lockout', deviceId: asker.deviceId })
        if (this.options.store.summary().paused) this.options.report({ kind: 'paused' })
        await this.options.removeDevice(asker.deviceId)
        throw new HomeAuthError('PIN_INVALID', 'That is the last wrong try. This device is signed out. Approve it again at your computer', { triesLeft: 0, removed: true })
      case 'wrong': {
        this.options.report({ kind: 'wrong', deviceId: asker.deviceId, triesLeft: outcome.triesLeft })
        if (this.options.store.summary().paused) this.options.report({ kind: 'paused' })
        const left = outcome.triesLeft
        throw new HomeAuthError('PIN_INVALID', `That is not right. ${String(left)} ${left === 1 ? 'try' : 'tries'} left before this device is signed out`, { triesLeft: left, removed: false })
      }
      default:
        return assertNever(outcome)
    }
  }

  /**
   * Whether PIN mode is on.
   * @returns whether it is.
   */
  enabled(): boolean {
    return this.options.store.summary().enabled
  }

  /**
   * The running page unlock an id names.
   * @param unlockId - the id in a page Peer's principal.
   * @returns the unlock, or undefined once it ended or for an id that names a computer-approved elevation.
   */
  pageUnlock(unlockId: string): ElevationRecord | undefined {
    const record = this.options.elevations.get(unlockId)
    return record?.page === true ? record : undefined
  }

  /**
   * Find the unlock a token names for one asker.
   * @param token - the token the page presented.
   * @param asker - the device, listener and session the request arrived with.
   * @returns the unlock's elevation.
   * @throws {HomeAuthError} `UNLOCK_INVALID` for an unknown or ended token, and for one presented by another device,
   *   listener or session, which also ends the unlock.
   */
  resolve(token: string, asker: UnlockAsker): ElevationRecord {
    const digest = hashSecret(token)
    const id = this.tokens.get(digest)?.id
    const record = id === undefined ? undefined : this.options.elevations.get(id)
    if (id === undefined || record === undefined) {
      this.drop(digest)
      throw new HomeAuthError('UNLOCK_INVALID', 'This page is locked. Unlock it again')
    }
    if (record.deviceId !== asker.deviceId || record.listener !== asker.listener || !this.options.sameSession(asker.sessionId, record.sessionId)) {
      this.options.elevations.endById(id, 'token-refused')
      throw new HomeAuthError('UNLOCK_INVALID', 'This page is locked. Unlock it again')
    }
    return record
  }

  /**
   * Record activity on an unlocked page: the idle end moves forward, never past the cap.
   * @param token - the page's token.
   * @param asker - the device, listener and session.
   * @returns the unlock's new end of idling and its cap.
   * @throws {HomeAuthError} `UNLOCK_INVALID` as {@link PinUnlocks.resolve}.
   */
  touch(token: string, asker: UnlockAsker): { readonly unlockId: string; readonly idleEndsAt: number; readonly endsAt: number } {
    const record = this.resolve(token, asker)
    const cap = record.startedAt + PIN_MODE_LIMITS.absoluteCapMs
    const idleEndsAt = Math.min(this.options.now() + this.idleMs(), cap)
    if (idleEndsAt > record.endsAt) this.options.elevations.moveEnd(record.id, idleEndsAt)
    return { unlockId: record.id, idleEndsAt: Math.max(idleEndsAt, record.endsAt), endsAt: cap }
  }

  /**
   * Lock one page.
   * @param token - the page's token.
   * @param asker - the device, listener and session.
   * @throws {HomeAuthError} `UNLOCK_INVALID` as {@link PinUnlocks.resolve}.
   */
  lock(token: string, asker: UnlockAsker): void {
    const record = this.resolve(token, asker)
    this.options.elevations.endById(record.id, 'locked-from-device')
  }

  /**
   * Set or replace the PIN at the computer: every unlock ends.
   * @param secret - the PIN or passcode.
   * @param options - the idle minutes and the lock-when-hidden choice.
   * @returns the kind of secret set.
   * @throws {HomeAuthError} as {@link PinModeStore.set}.
   */
  async set(secret: string, options: { readonly idleMinutes?: number | undefined; readonly lockWhenHidden?: boolean | undefined }): Promise<PinKind> {
    const kind = await this.options.store.set(secret, options)
    this.endAll('pin-changed')
    this.options.report({ kind: 'set', secret: kind })
    return kind
  }

  /**
   * Turn PIN mode off at the computer: every unlock ends.
   */
  async off(): Promise<void> {
    await this.options.store.off()
    this.endAll('pin-mode-off')
    this.options.report({ kind: 'off' })
  }

  /**
   * Resume PIN unlocks after a home-wide pause, at the computer.
   */
  async resume(): Promise<void> {
    await this.options.store.resume()
    this.options.report({ kind: 'resumed' })
  }

  /**
   * Forget a token whose elevation ended.
   * @param change - the elevation change the home reports.
   */
  elevationChanged(change: ElevationChange): void {
    if (change.kind !== 'ended') return
    for (const [digest, { id }] of [...this.tokens]) {
      if (id === change.elevation.id) this.drop(digest)
    }
  }

  /**
   * Mint the unlock of a correct secret.
   * @param asker - the device, listener and session.
   * @returns the unlock.
   */
  private mint(asker: UnlockAsker): PageUnlock {
    const at = this.options.now()
    const idleEndsAt = at + this.idleMs()
    const record = this.options.elevations.start(asker, Math.min(idleEndsAt, at + PIN_MODE_LIMITS.absoluteCapMs))
    const token = newSecret(PIN_MODE_LIMITS.tokenBytes, this.options.random)
    this.tokens.set(hashSecret(token), { id: record.id, release: this.options.secrets?.register(token, 'session-secret') ?? (() => undefined) })
    return { token, unlockId: record.id, endsAt: at + PIN_MODE_LIMITS.absoluteCapMs, idleEndsAt: record.endsAt }
  }

  /**
   * End every unlock.
   * @param reason - why they end.
   */
  private endAll(reason: 'pin-changed' | 'pin-mode-off'): void {
    for (const { id } of [...this.tokens.values()]) this.options.elevations.endById(id, reason)
    for (const digest of [...this.tokens.keys()]) this.drop(digest)
  }

  /**
   * Forget a token and its registration.
   * @param digest - the token's digest.
   */
  private drop(digest: string): void {
    this.tokens.get(digest)?.release()
    this.tokens.delete(digest)
  }

  /**
   * The idle time of an unlock.
   * @returns milliseconds.
   */
  private idleMs(): number {
    return this.options.store.summary().idleMinutes * 60_000
  }
}

/**
 * Fail at compile time when a case of a closed union is not handled.
 * @param value - the value no case handled.
 * @throws {Error} always.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled PIN outcome ${JSON.stringify(value)}`)
}
