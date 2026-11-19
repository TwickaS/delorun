/**
 * The grants a home keeps for Face ID and PIN unlocks: single-use permissions for one action with one set of
 * arguments, single-use permissions to answer one prompt one way, and the narrow holds a terminal or a folder picker
 * keeps after the person approved opening it. Nothing here travels with a request: the policy asks the store about the
 * call it is deciding, and the store answers from what a verified assertion or a correct PIN minted.
 *
 * - **Action grants** are keyed by device, listener, action and the SHA-256 of the JCS form of the arguments the home
 *   received ({@link hashArgs}). They live {@link GRANT_LIFE_MS} and are used once. The policy reads one with
 *   {@link GrantStore.has} while it decides and uses it with {@link GrantStore.consume} only after the whole decision
 *   allows, so a refused call or a question without arguments never spends one.
 * - **Answer grants** are keyed by device, listener, request id and the answer value, so Face ID for "Allow once"
 *   never admits a persistent allow.
 * - **Feature holds** are opened when a grant entry that names a terminal or picker id is consumed. A hold admits the
 *   events and reads of that exact id until it idles {@link HOLD_IDLE_MS}, lives {@link HOLD_ABSOLUTE_MS}, its
 *   connection ends or the picker's close route is called. Another id needs a new grant.
 *
 * @module @delorun/home-auth/grants
 */
import { createHash } from 'node:crypto'
import type { ReachListenerId } from '@delorun/contract-admission'
import { newSecret, type RandomBytes } from './secret.ts'

/** How long a minted grant stays usable: 30 seconds. */
export const GRANT_LIFE_MS = 30_000

/** The longest a feature hold idles before it ends: 5 minutes. */
export const HOLD_IDLE_MS = 5 * 60_000

/** The longest a feature hold lasts from the call that opened it: 60 minutes. */
export const HOLD_ABSOLUTE_MS = 60 * 60_000

/** The most bytes of a request body the home hashes for a grant; a larger body has no grant. */
export const GRANT_BODY_CAP_BYTES = 1024 * 1024

/** The most live grants and holds one device keeps; a mint past it ends the oldest. */
export const GRANTS_PER_DEVICE = 64

/** The features whose holds exist: an open terminal and a folder picker. */
export const HOLD_FEATURES = ['terminal', 'picker'] as const

/** One of {@link HOLD_FEATURES}. */
export type HoldFeature = (typeof HOLD_FEATURES)[number]

/**
 * The actions whose grant opens a hold, by the feature the hold is for: `terminal/create` opens the terminal it creates
 * and `directoryPicker/list` opens the picker. The other actions of the feature are admitted by a live hold of the
 * device (`./grants.ts`).
 */
export const HOLD_OPENERS: Readonly<Record<string, HoldFeature>> = {
  'terminal/create': 'terminal',
  'directoryPicker/list': 'picker',
}

/** The feature whose hold admits an elevated action without a new grant, or undefined for an action no hold covers. */
export function holdFeatureOf(action: string): HoldFeature | undefined {
  if (action.startsWith('terminal/')) return 'terminal'
  if (action.startsWith('directoryPicker/')) return 'picker'
  return undefined
}

/** Which factor minted a grant. */
export type GrantFactor = 'passkey' | 'pin'

/**
 * The JCS (RFC 8785) text of a JSON value: object members sorted by their UTF-16 code units, no whitespace, numbers and
 * strings as `JSON.stringify` writes them, which is the ECMAScript form JCS names.
 * @param value - a JSON value.
 * @returns the canonical text.
 * @throws {TypeError} for a value JSON cannot hold: a non-finite number, `undefined`, a function or a symbol.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('a non-finite number has no JSON form')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, member]) => member !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`
  }
  throw new TypeError('a value of this type has no JSON form')
}

/**
 * The hash a grant for a call's arguments is keyed by.
 * @param args - the arguments as the home received them.
 * @returns the lowercase hex SHA-256 of their JCS text, or undefined when they cannot be written as JSON.
 */
export function hashArgs(args: unknown): string | undefined {
  let text: string
  try {
    text = canonicalJson(args)
  } catch (_notJson) {
    // Arguments JSON cannot hold name no call a grant could cover.
    return undefined
  }
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The hash a grant for a Fetch route is keyed by: method, path and the body the home read itself.
 * @param request - the method and absolute path as the home received them, and the body bytes read, at most {@link GRANT_BODY_CAP_BYTES}.
 * @returns the lowercase hex SHA-256 over the method, the path and the body's JCS text when it parses as JSON and its raw bytes otherwise; undefined for a body over the cap.
 */
export function hashRequest(request: { readonly method: string; readonly path: string; readonly body: Uint8Array }): string | undefined {
  if (request.body.byteLength > GRANT_BODY_CAP_BYTES) return undefined
  let canonical: Uint8Array
  try {
    const parsed: unknown = JSON.parse(Buffer.from(request.body).toString('utf8'))
    canonical = Buffer.from(canonicalJson(parsed), 'utf8')
  } catch (_notJson) {
    // A body that is not JSON is hashed as the bytes the home received.
    canonical = request.body
  }
  const hash = createHash('sha256')
  hash.update(`${request.method.toUpperCase()}\u0000${request.path}\u0000`, 'utf8').update(canonical)
  return hash.digest('hex')
}

/** One action a grant covers. */
export interface GrantEntry {
  /** The elevated action's name. */
  readonly action: string
  /** {@link hashArgs} of the arguments, or {@link hashRequest} of a Fetch call. */
  readonly hash: string
  /** The terminal or picker this entry opens a hold for when it is used; none for an action with no stream. */
  readonly hold?: { readonly feature: HoldFeature; readonly id: string } | undefined
}

/** Who a grant speaks for. */
export interface GrantHolder {
  readonly deviceId: string
  readonly listener: ReachListenerId
}

/** What the store keeps for one action grant entry. */
interface StoredGrant {
  readonly grantId: string
  readonly holder: GrantHolder
  readonly entry: GrantEntry
  readonly factor: GrantFactor
  readonly expiresAt: number
  readonly seq: number
}

/** What the store keeps for one answer grant. */
interface StoredAnswer {
  readonly grantId: string
  readonly holder: GrantHolder
  readonly requestId: string
  readonly answer: string
  readonly expiresAt: number
  readonly seq: number
}

/** What the store keeps for one hold. */
interface StoredHold {
  readonly holder: GrantHolder
  readonly feature: HoldFeature
  readonly id: string
  readonly openedAt: number
  lastUsedAt: number
}

/** What a grant mint returns. */
export interface MintedGrant {
  /** The grant's id, for the log; it is no credential. */
  readonly grantId: string
  /** When its entries stop being usable. */
  readonly expiresAt: number
}

/** The grants of one home, in memory: a restart ends them all. */
export class GrantStore {
  private readonly now: () => number
  private readonly random: RandomBytes
  private grants: StoredGrant[] = []
  private answers: StoredAnswer[] = []
  private readonly holds = new Map<string, StoredHold>()
  private seq = 0

  /**
   * @param options - the clock and the random source.
   * @param options.now - the clock in milliseconds since the epoch.
   * @param options.random - the source the grant ids come from.
   */
  constructor(options: { readonly now: () => number; readonly random: RandomBytes }) {
    this.now = options.now
    this.random = options.random
  }

  /**
   * Mint one grant holding one entry per action the person confirmed. Each entry is used once and the grant ends
   * {@link GRANT_LIFE_MS} from now; an entry for the same device, listener, action and hash replaces its predecessor.
   * @param holder - the device and listener.
   * @param entries - the actions confirmed.
   * @param factor - what the person proved: a passkey or the PIN.
   * @returns the grant's id and end.
   */
  mint(holder: GrantHolder, entries: readonly GrantEntry[], factor: GrantFactor): MintedGrant {
    this.sweep()
    const grantId = newSecret(8, this.random)
    const expiresAt = this.now() + GRANT_LIFE_MS
    this.grants = this.grants.filter(stored => !(sameHolder(stored.holder, holder) && entries.some(entry => entry.action === stored.entry.action && entry.hash === stored.entry.hash)))
    for (const entry of entries) this.grants.push({ grantId, holder, entry, factor, expiresAt, seq: this.seq++ })
    this.limit(holder)
    return { grantId, expiresAt }
  }

  /**
   * Whether a live grant covers a call; nothing is used.
   * @param holder - the device and listener the call arrived on.
   * @param action - the action.
   * @param hash - the hash of the arguments the home received.
   * @returns whether one does.
   */
  has(holder: GrantHolder, action: string, hash: string): boolean {
    return this.find(holder, action, hash) !== undefined
  }

  /**
   * The live grant that covers a call, without using it; a route gate compares its id with the `Delorun-Grant` header.
   * @param holder - the device and listener the call arrived on.
   * @param action - the action.
   * @param hash - the hash of the call the home received.
   * @returns the grant id and factor, or undefined when none covers the call.
   */
  peek(holder: GrantHolder, action: string, hash: string): { readonly grantId: string; readonly factor: GrantFactor } | undefined {
    const found = this.find(holder, action, hash)
    return found === undefined ? undefined : { grantId: found.grantId, factor: found.factor }
  }

  /**
   * Use the grant that covers a call. When the entry names a hold and the call opens that same terminal or picker, the
   * hold opens; a hold the entry names for any other id is dropped, so a grant for one action never opens a hold the
   * action does not open.
   * @param holder - the device and listener the call arrived on.
   * @param action - the action.
   * @param hash - the hash of the call the home received.
   * @param opens - the terminal or picker the call itself opens, as the home read it from the call; none for a call that opens nothing.
   * @returns the grant id and factor used, or undefined when none covers the call.
   */
  consume(holder: GrantHolder, action: string, hash: string, opens?: { readonly feature: HoldFeature; readonly id: string }): { readonly grantId: string; readonly factor: GrantFactor } | undefined {
    const found = this.find(holder, action, hash)
    if (found === undefined) return undefined
    this.grants = this.grants.filter(stored => stored !== found)
    const hold = found.entry.hold
    if (hold !== undefined && opens !== undefined && hold.feature === opens.feature && hold.id === opens.id) this.openHold(holder, hold.feature, hold.id)
    return { grantId: found.grantId, factor: found.factor }
  }

  /**
   * Mint the grant to answer one prompt one way.
   * @param holder - the device and listener.
   * @param requestId - the prompt's request id.
   * @param answer - the answer value the person confirmed, such as `allowed-once`.
   * @returns the grant's id and end.
   */
  mintAnswer(holder: GrantHolder, requestId: string, answer: string): MintedGrant {
    this.sweep()
    const grantId = newSecret(8, this.random)
    const expiresAt = this.now() + GRANT_LIFE_MS
    this.answers = this.answers.filter(stored => !(sameHolder(stored.holder, holder) && stored.requestId === requestId && stored.answer === answer))
    this.answers.push({ grantId, holder, requestId, answer, expiresAt, seq: this.seq++ })
    this.limit(holder)
    return { grantId, expiresAt }
  }

  /**
   * Use the grant that covers one answer.
   * @param holder - the device and listener the answer arrived on.
   * @param requestId - the prompt's request id.
   * @param answer - the answer value.
   * @returns the grant id used, or undefined when no live grant covers exactly this request and answer.
   */
  consumeAnswer(holder: GrantHolder, requestId: string, answer: string): string | undefined {
    const at = this.now()
    const found = this.answers.find(stored => sameHolder(stored.holder, holder) && stored.requestId === requestId && stored.answer === answer && stored.expiresAt > at)
    if (found === undefined) return undefined
    this.answers = this.answers.filter(stored => stored !== found)
    return found.grantId
  }

  /**
   * Whether a hold admits a stream or read of one terminal or picker; an admitted use counts as activity.
   * @param holder - the device and listener.
   * @param feature - the feature.
   * @param id - the terminal or picker id the call names.
   * @returns whether a live hold for exactly this id exists.
   */
  holdAdmits(holder: GrantHolder, feature: HoldFeature, id: string): boolean {
    const key = holdKey(holder, feature, id)
    const hold = this.holds.get(key)
    if (hold === undefined) return false
    const at = this.now()
    if (at - hold.lastUsedAt >= HOLD_IDLE_MS || at - hold.openedAt >= HOLD_ABSOLUTE_MS) {
      this.holds.delete(key)
      return false
    }
    hold.lastUsedAt = at
    return true
  }

  /**
   * Whether a device holds any live hold of a feature, for a read that names no id, such as listing the terminals; it
   * counts as activity for each hold it finds.
   * @param holder - the device and listener.
   * @param feature - the feature.
   * @returns whether at least one live hold exists.
   */
  holdsAny(holder: GrantHolder, feature: HoldFeature): boolean {
    let found = false
    for (const hold of [...this.holds.values()]) {
      if (hold.feature === feature && sameHolder(hold.holder, holder) && this.holdAdmits(holder, feature, hold.id)) found = true
    }
    return found
  }

  /**
   * End one hold, as a terminal's or picker's close does.
   * @param holder - the device and listener.
   * @param feature - the feature.
   * @param id - the terminal or picker id.
   */
  closeHold(holder: GrantHolder, feature: HoldFeature, id: string): void {
    this.holds.delete(holdKey(holder, feature, id))
  }

  /**
   * End every hold and grant of a device: its connection ended, or it was removed.
   * @param deviceId - the device.
   */
  endDevice(deviceId: string): void {
    this.grants = this.grants.filter(stored => stored.holder.deviceId !== deviceId)
    this.answers = this.answers.filter(stored => stored.holder.deviceId !== deviceId)
    for (const [key, hold] of [...this.holds]) if (hold.holder.deviceId === deviceId) this.holds.delete(key)
  }

  /**
   * How many live holds a device has.
   * @param deviceId - the device.
   * @returns the count, after expired holds are dropped.
   */
  holdCount(deviceId: string): number {
    this.sweep()
    return [...this.holds.values()].filter(hold => hold.holder.deviceId === deviceId).length
  }

  /** @returns the live grant that covers a call, or undefined. */
  private find(holder: GrantHolder, action: string, hash: string): StoredGrant | undefined {
    const at = this.now()
    return this.grants.find(stored => sameHolder(stored.holder, holder) && stored.entry.action === action && stored.entry.hash === hash && stored.expiresAt > at)
  }

  /** Open or refresh the hold of one terminal or picker. */
  private openHold(holder: GrantHolder, feature: HoldFeature, id: string): void {
    const at = this.now()
    this.holds.set(holdKey(holder, feature, id), { holder, feature, id, openedAt: at, lastUsedAt: at })
  }

  /** Drop what expired. */
  private sweep(): void {
    const at = this.now()
    this.grants = this.grants.filter(stored => stored.expiresAt > at)
    this.answers = this.answers.filter(stored => stored.expiresAt > at)
    for (const [key, hold] of [...this.holds]) {
      if (at - hold.lastUsedAt >= HOLD_IDLE_MS || at - hold.openedAt >= HOLD_ABSOLUTE_MS) this.holds.delete(key)
    }
  }

  /** End the oldest grants of a device that holds more than {@link GRANTS_PER_DEVICE}. */
  private limit(holder: GrantHolder): void {
    const mine = this.grants.filter(stored => sameHolder(stored.holder, holder))
    const over = mine.length + this.answers.filter(stored => sameHolder(stored.holder, holder)).length - GRANTS_PER_DEVICE
    if (over <= 0) return
    const oldest = new Set(mine.sort((left, right) => left.seq - right.seq).slice(0, over))
    this.grants = this.grants.filter(stored => !oldest.has(stored))
  }
}

/**
 * Whether two holders are one device on one listener.
 * @param left - one holder.
 * @param right - another.
 * @returns whether they are the same.
 */
function sameHolder(left: GrantHolder, right: GrantHolder): boolean {
  return left.deviceId === right.deviceId && left.listener === right.listener
}

/**
 * The map key of one hold.
 * @param holder - the device and listener.
 * @param feature - the feature.
 * @param id - the terminal or picker id.
 * @returns the key.
 */
function holdKey(holder: GrantHolder, feature: HoldFeature, id: string): string {
  return JSON.stringify([holder.deviceId, holder.listener, feature, id])
}
