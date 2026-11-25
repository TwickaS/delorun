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
 * - **Answer grants** are keyed by device, listener, {@link answerKey} (agent, call id and grants marker of the prompt)
 *   and the answer value, so Face ID for "Allow once" never admits a persistent allow, and a grant for one prompt never
 *   answers another that shares its call id.
 * - **Feature holds** are opened when a grant entry that names a terminal or picker id is consumed. A hold admits the
 *   events and reads of that exact id in that exact scope (the Session or global resource the call named) for the Peer
 *   that opened it, until it idles {@link HOLD_IDLE_MS}, lives {@link HOLD_ABSOLUTE_MS}, its device's session ends or
 *   that Peer is disposed ({@link GrantStore.endPeer}). A Peer is one device on one listener and one page unlock, so
 *   every page and tab of the device shares it: a reload or a second tab showing the same terminal rides the hold, and
 *   closing a tab does not end it. Another id, scope or Peer needs a new grant.
 * - **Passes** (A499, "sudo mode") are opened by a verified Face ID assertion when the home's pass setting is above 0
 *   ({@link GrantStore.openPass}). A pass is bound to one device on one listener (a device holds no page unlock, which
 *   `openPass` asserts), lasts a fixed number of minutes from the assertion and never slides. While it is live, the
 *   gates admit that device's `face` rows declared `admits` without a per-call grant (`passAdmitsRow` in
 *   `./auth-classes.ts`). It ends at its end time; after {@link PASS_IDLE_MS} with no request from that device on that
 *   listener ({@link GrantStore.touchPass}), an idle end that never extends it; by Lock now ({@link GrantStore.endPass}),
 *   which the studio also sends after its page was hidden {@link PASS_IDLE_MS}; when the pass setting changes
 *   ({@link GrantStore.endPasses}); with its Peer, its device's session, the device's removal, a rotation of every
 *   session, or a restart, since the store lives in memory. A PIN never opens one. Each start and end is logged as
 *   `home-auth: pass.started` and `home-auth: pass.ended reason=…`; an expired or idle pass is logged when the home next
 *   looks at it.
 *
 * @module @delorun/home-auth/grants
 */
import { createHash } from 'node:crypto'
import type { ReachListenerId } from '@delorun/contract-admission'
import { newSecret, type RandomBytes } from './secret.ts'

/** How long a minted grant stays usable: 30 seconds. */
export const GRANT_LIFE_MS = 30_000

/** The longest a Face ID pass lasts with no request from its device on its listener: 5 minutes. */
export const PASS_IDLE_MS = 5 * 60_000

/** The longest a feature hold idles before it ends: 5 minutes. */
export const HOLD_IDLE_MS = 5 * 60_000

/** The longest a feature hold lasts from the call that opened it: 60 minutes. */
export const HOLD_ABSOLUTE_MS = 60 * 60_000

/** The most bytes of a request body the home hashes for a grant; a larger body has no grant. */
export const GRANT_BODY_CAP_BYTES = 1024 * 1024

/** The most live grants and holds one device keeps; a mint past it ends the oldest. */
export const GRANTS_PER_DEVICE = 64

/** The features whose holds exist: an open terminal, a folder picker, and a chat's log download. */
export const HOLD_FEATURES = ['terminal', 'picker', 'export'] as const

/** One of {@link HOLD_FEATURES}. */
export type HoldFeature = (typeof HOLD_FEATURES)[number]

/**
 * The actions whose grant opens a hold, by the feature the hold is for: `terminal/create` opens the terminal it creates,
 * `terminal/retain` and `terminal/attach` the existing terminal they name (so a reloaded terminal tab confirms once,
 * whichever of its streams opens first), and `directoryPicker/list` opens the picker. The other actions of the feature are admitted by a live hold of the device (`./grants.ts`).
 */
export const HOLD_OPENERS: Readonly<Record<string, HoldFeature>> = {
  'terminal/create': 'terminal',
  'terminal/retain': 'terminal',
  'terminal/attach': 'terminal',
  'directoryPicker/list': 'picker',
  'commands/execute': 'export',
}

/** The feature whose hold admits an elevated action without a new grant, or undefined for an action no hold covers. */
export function holdFeatureOf(action: string): HoldFeature | undefined {
  if (action.startsWith('terminal/')) return 'terminal'
  if (action.startsWith('directoryPicker/')) return 'picker'
  // The `/export` command opens the hold its download route is admitted by, so one confirmation covers the command and
  // the archive it produces. Every other command opens nothing.
  if (action === 'commands/execute') return 'export'
  return undefined
}

/**
 * The action a device's removal of another device is confirmed under: its grant covers the JCS of the body sent, and
 * only a device that holds a passkey may mint it.
 */
export const DEVICE_REMOVE_ACTION = 'auth/devices/remove'

/**
 * The action a device's change of the Face ID pass setting is confirmed under: its grant covers the JCS of the body
 * sent, and only a device that holds a passkey may mint it.
 */
export const PASS_SETTING_ACTION = 'auth/passkey/pass'

/** The scope of a call on the global resource, such as the folder picker. */
export const GLOBAL_SCOPE = 'global'

/**
 * The scope a hold is bound to: the resource a call names.
 * @param resource - the resource the question named.
 * @returns `global`, or `<kind>:<id>` for a resource with an id.
 */
export function scopeOf(resource: { readonly kind: string; readonly id?: string }): string {
  return resource.id === undefined ? resource.kind === 'global' ? GLOBAL_SCOPE : resource.kind : `${resource.kind}:${resource.id}`
}

/**
 * The key an answer grant is minted and looked up under.
 * @param prompt - the Session (agent) id, the call id and the `grants` marker of the approval prompt.
 * @returns a key that two prompts share only when all three are equal.
 */
export function answerKey(prompt: { readonly agent: string; readonly callId: string; readonly grants: string }): string {
  return JSON.stringify([prompt.agent, prompt.callId, prompt.grants])
}

/** The terminal or picker a hold is for, in one scope. */
export interface HoldTarget {
  readonly feature: HoldFeature
  readonly id: string
  /** {@link scopeOf} of the resource the opening call named. */
  readonly scope: string
}

/** Which factor minted a grant. */
export type GrantFactor = 'passkey' | 'pin'

/** Why a pass ended. */
export type PassEndReason = 'expired' | 'idle' | 'lock-now' | 'setting-changed' | 'peer-ended' | 'session-ended' | 'device-removed' | 'sessions-rotated'

/** A live pass, as the home reports it to the device that holds it. */
export interface PassView {
  /** When the Face ID opened it, in milliseconds since the epoch. */
  readonly startedAt: number
  /** When it ends at the latest, in milliseconds since the epoch; it never moves. */
  readonly endsAt: number
  /** How long it has left by the home's clock when read, so a device with a skewed clock counts down from this. */
  readonly remainingMs: number
}

/**
 * The JCS (RFC 8785) text of a JSON value: object members sorted by their UTF-16 code units, no whitespace, numbers and
 * strings as `JSON.stringify` writes them, which is the ECMAScript form JCS names.
 * @param value - a JSON value.
 * @returns the canonical text.
 * @throws {TypeError} for a value JSON cannot hold: a non-finite number, `undefined`, a function, a symbol, or an object that is not plain, such as a Date or a Map.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('a non-finite number has no JSON form')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('only plain objects and arrays have a JSON form')
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
 * @param request - the method and the absolute path with its query string as the home received them, and the body bytes read, at most {@link GRANT_BODY_CAP_BYTES}.
 * @returns the lowercase hex SHA-256 over the method, the path with its query and the body's JCS text when it parses as JSON and its raw bytes otherwise; undefined for a body over the cap.
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
  /**
   * The page unlock the Peer was admitted under; with the device and listener it names the Peer. Action and answer
   * grants ignore it, and a hold is admitted only to the Peer that opened it.
   */
  readonly unlockId?: string | undefined
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
  readonly requestKey: string
  readonly answer: string
  readonly expiresAt: number
  readonly seq: number
}

/** What the store keeps for one hold. */
interface StoredHold {
  readonly holder: GrantHolder
  readonly feature: HoldFeature
  readonly id: string
  readonly scope: string
  readonly openedAt: number
  lastUsedAt: number
}

/** What the store keeps for one pass. */
interface StoredPass {
  readonly holder: GrantHolder
  readonly startedAt: number
  readonly endsAt: number
  /** The last request from the device on the listener; {@link PASS_IDLE_MS} after it the pass ends. */
  lastSeenAt: number
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
  private readonly log: (line: string) => void
  private grants: StoredGrant[] = []
  private answers: StoredAnswer[] = []
  private readonly holds = new Map<string, StoredHold>()
  private readonly passes = new Map<string, StoredPass>()
  private seq = 0
  /** How many times every grant and pass was ended at once; a ceremony that started before the last one may not mint after it. */
  private ended = 0

  /**
   * @param options - the clock, the random source and the log.
   * @param options.now - the clock in milliseconds since the epoch.
   * @param options.random - the source the grant ids come from.
   * @param options.log - records `passkey.used` after each grant is used; the line holds no challenge, key or signature.
   */
  constructor(options: { readonly now: () => number; readonly random: RandomBytes; readonly log?: (line: string) => void }) {
    this.now = options.now
    this.random = options.random
    this.log = options.log ?? (() => undefined)
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
   * @param holder - the device, listener and page unlock the call arrived on; the hold it opens belongs to that Peer.
   * @param action - the action.
   * @param hash - the hash of the call the home received.
   * @param opens - the terminal or picker (and scope) the call itself opens, as the home read it from the call; none for a call that opens nothing.
   * @returns the grant id and factor used, or undefined when none covers the call.
   */
  consume(holder: GrantHolder, action: string, hash: string, opens?: HoldTarget): { readonly grantId: string; readonly factor: GrantFactor } | undefined {
    const found = this.find(holder, action, hash)
    if (found === undefined) return undefined
    this.grants = this.grants.filter(stored => stored !== found)
    const hold = found.entry.hold
    if (hold !== undefined && opens !== undefined && hold.feature === opens.feature && hold.id === opens.id) this.openHold(holder, hold.feature, hold.id, opens.scope)
    this.log(`home-auth: passkey.used device=${holder.deviceId} listener=${holder.listener} action=${action} factor=${found.factor} grant=${found.grantId}`)
    return { grantId: found.grantId, factor: found.factor }
  }

  /**
   * Mint the grant to answer one prompt one way.
   * @param holder - the device and listener.
   * @param requestKey - the prompt's {@link answerKey}.
   * @param answer - the answer value the person confirmed, such as `allowed-once`.
   * @returns the grant's id and end.
   */
  mintAnswer(holder: GrantHolder, requestKey: string, answer: string): MintedGrant {
    this.sweep()
    const grantId = newSecret(8, this.random)
    const expiresAt = this.now() + GRANT_LIFE_MS
    this.answers = this.answers.filter(stored => !(sameHolder(stored.holder, holder) && stored.requestKey === requestKey && stored.answer === answer))
    this.answers.push({ grantId, holder, requestKey, answer, expiresAt, seq: this.seq++ })
    this.limit(holder)
    return { grantId, expiresAt }
  }

  /**
   * Use the grant that covers one answer.
   * @param holder - the device and listener the answer arrived on.
   * @param requestKey - the prompt's {@link answerKey}.
   * @param answer - the answer value.
   * @returns the grant id used, or undefined when no live grant covers exactly this prompt and answer.
   */
  consumeAnswer(holder: GrantHolder, requestKey: string, answer: string): string | undefined {
    const at = this.now()
    const found = this.answers.find(stored => sameHolder(stored.holder, holder) && stored.requestKey === requestKey && stored.answer === answer && stored.expiresAt > at)
    if (found === undefined) return undefined
    this.answers = this.answers.filter(stored => stored !== found)
    this.log(`home-auth: passkey.used device=${holder.deviceId} listener=${holder.listener} answer=${answer} grant=${found.grantId}`)
    return found.grantId
  }

  /**
   * Whether a hold admits a stream or read of one terminal or picker; an admitted use counts as activity.
   * @param holder - the device and listener.
   * @param feature - the feature.
   * @param id - the terminal or picker id the call names.
   * @param scope - {@link scopeOf} of the resource the call names.
   * @returns whether a live hold for exactly this id in this scope exists.
   */
  holdAdmits(holder: GrantHolder, feature: HoldFeature, id: string, scope: string): boolean {
    const key = holdKey(holder, feature, id, scope)
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
   * @param scope - {@link scopeOf} of the resource the call names.
   * @returns whether at least one live hold in this scope exists.
   */
  holdsAny(holder: GrantHolder, feature: HoldFeature, scope: string): boolean {
    let found = false
    for (const hold of [...this.holds.values()]) {
      if (hold.feature === feature && hold.scope === scope && samePeer(hold.holder, holder) && this.holdAdmits(holder, feature, hold.id, scope)) found = true
    }
    return found
  }

  /**
   * Open the hold of a terminal or picker whose opening call the device's live pass admitted, so the terminal stays
   * open under the hold's own idle and total limits after the pass ends. Without a live pass nothing opens.
   * @param holder - the device, listener and page unlock of the call.
   * @param opens - the terminal or picker (and scope) the call opens, as the home read it from the call.
   */
  openHoldByPass(holder: GrantHolder, opens: HoldTarget): void {
    if (this.passOf(holder) !== undefined) this.openHold(holder, opens.feature, opens.id, opens.scope)
  }

  /**
   * End one hold. Nothing in this package calls it; a hold ends by idling, its cap, its Peer or its device.
   * @param holder - the device and listener.
   * @param feature - the feature.
   * @param id - the terminal or picker id.
   * @param scope - {@link scopeOf} of the resource it was opened on.
   */
  closeHold(holder: GrantHolder, feature: HoldFeature, id: string, scope: string): void {
    this.holds.delete(holdKey(holder, feature, id, scope))
  }

  /**
   * End every hold of one Peer, as its disposal does.
   * @param peer - the device and listener of the Peer, and its page unlock.
   */
  endPeer(peer: GrantHolder): void {
    for (const [key, hold] of [...this.holds]) if (samePeer(hold.holder, peer)) this.holds.delete(key)
    this.dropPass(peerKey(peer), 'peer-ended')
  }

  /**
   * End every hold, grant and pass of a device: its session ended, or it was removed.
   * @param deviceId - the device.
   * @param reason - why, for the `pass.ended` line; `session-ended` by default.
   */
  endDevice(deviceId: string, reason: PassEndReason = 'session-ended'): void {
    this.grants = this.grants.filter(stored => stored.holder.deviceId !== deviceId)
    this.answers = this.answers.filter(stored => stored.holder.deviceId !== deviceId)
    for (const [key, hold] of [...this.holds]) if (hold.holder.deviceId === deviceId) this.holds.delete(key)
    for (const [key, pass] of [...this.passes]) if (pass.holder.deviceId === deviceId) this.dropPass(key, reason)
  }

  /**
   * End every live pass: the pass setting changed, so no pass keeps a length the person no longer chose.
   * @param reason - why.
   */
  endPasses(reason: PassEndReason): void {
    for (const key of [...this.passes.keys()]) this.dropPass(key, reason)
  }

  /**
   * Record a request from a device on a listener: the pass of that device on that listener stays live while requests
   * keep coming, up to its fixed end. A pass already idle {@link PASS_IDLE_MS} ends here and is not revived.
   * @param holder - the device and listener the request arrived on.
   */
  touchPass(holder: GrantHolder): void {
    const at = this.now()
    for (const [key, pass] of [...this.passes]) {
      if (!sameHolder(pass.holder, holder)) continue
      if (at - pass.lastSeenAt >= PASS_IDLE_MS) this.dropPass(key, 'idle')
      else pass.lastSeenAt = at
    }
  }

  /**
   * How many times {@link GrantStore.endAll} has run. A confirmation reads it before its first await and compares it
   * before it mints a grant or opens a pass, so one that was in flight when every session ended mints nothing.
   * @returns the count.
   */
  get generation(): number {
    return this.ended
  }

  /** End every hold, grant and pass of every device: all sessions were rotated. */
  endAll(): void {
    this.ended += 1
    this.grants = []
    this.answers = []
    this.holds.clear()
    for (const key of [...this.passes.keys()]) this.dropPass(key, 'sessions-rotated')
  }

  /**
   * Open a pass for one device on one listener after a verified Face ID assertion. A pass that is already live stays as
   * it is: a pass is fixed from the Face ID that opened it and never slides.
   * @param holder - the device and listener the assertion came from. A device holds no page unlock, so the pass is keyed
   *   without one; a call that carries a page unlock matches no pass.
   * @param minutes - the pass setting; 0 opens none.
   * @returns the live pass, or undefined when the setting is 0.
   */
  openPass(holder: Pick<GrantHolder, 'deviceId' | 'listener'>, minutes: number): PassView | undefined {
    const device = { deviceId: holder.deviceId, listener: holder.listener }
    const live = this.passOf(device)
    if (live !== undefined) return live
    if (!(minutes > 0)) return undefined
    const startedAt = this.now()
    const pass: StoredPass = { holder: device, startedAt, endsAt: startedAt + minutes * 60_000, lastSeenAt: startedAt }
    this.passes.set(peerKey(device), pass)
    this.log(`home-auth: pass.started device=${holder.deviceId} listener=${holder.listener} minutes=${String(minutes)}`)
    return viewOf(pass, startedAt)
  }

  /**
   * The live pass of one device on one listener; another device or listener, or a call with a page unlock, has none.
   * @param holder - the device and listener the call arrived on.
   * @returns the pass, or undefined when none is live: past its end, or idle {@link PASS_IDLE_MS}.
   */
  passOf(holder: GrantHolder): PassView | undefined {
    const key = peerKey(holder)
    const pass = this.passes.get(key)
    if (pass === undefined) return undefined
    const at = this.now()
    if (pass.endsAt <= at) {
      this.dropPass(key, 'expired')
      return undefined
    }
    if (at - pass.lastSeenAt >= PASS_IDLE_MS) {
      this.dropPass(key, 'idle')
      return undefined
    }
    return viewOf(pass, at)
  }

  /**
   * End the pass of one device on one listener, as Lock now does; every page unlock of it is ended.
   * @param holder - the device and listener.
   * @param reason - why.
   * @returns whether a live pass ended.
   */
  endPass(holder: GrantHolder, reason: PassEndReason): boolean {
    let ended = false
    for (const [key, pass] of [...this.passes]) {
      if (sameHolder(pass.holder, holder)) ended = this.dropPass(key, reason) || ended
    }
    return ended
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
  private openHold(holder: GrantHolder, feature: HoldFeature, id: string, scope: string): void {
    const at = this.now()
    this.holds.set(holdKey(holder, feature, id, scope), { holder, feature, id, scope, openedAt: at, lastUsedAt: at })
  }

  /**
   * Forget one pass and log its end.
   * @param key - its {@link peerKey}.
   * @param reason - why it ended; a pass past its end time is logged as `expired` whatever the caller says.
   * @returns whether the pass was still live.
   */
  private dropPass(key: string, reason: PassEndReason): boolean {
    const pass = this.passes.get(key)
    if (pass === undefined) return false
    this.passes.delete(key)
    const live = pass.endsAt > this.now()
    this.log(`home-auth: pass.ended device=${pass.holder.deviceId} listener=${pass.holder.listener} reason=${live ? reason : 'expired'}`)
    return live
  }

  /** Drop what expired. */
  private sweep(): void {
    const at = this.now()
    for (const [key, pass] of [...this.passes]) {
      if (pass.endsAt <= at) this.dropPass(key, 'expired')
      else if (at - pass.lastSeenAt >= PASS_IDLE_MS) this.dropPass(key, 'idle')
    }
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
 * Whether two holders are one Peer: the same device, listener and page unlock.
 * @param left - one holder.
 * @param right - another.
 * @returns whether they are the same Peer.
 */
function samePeer(left: GrantHolder, right: GrantHolder): boolean {
  return sameHolder(left, right) && left.unlockId === right.unlockId
}

/**
 * What the home reports of a pass.
 * @param pass - the stored pass.
 * @param at - the home's clock now.
 * @returns its start, end and what is left.
 */
function viewOf(pass: StoredPass, at: number): PassView {
  return { startedAt: pass.startedAt, endsAt: pass.endsAt, remainingMs: Math.max(0, pass.endsAt - at) }
}

/**
 * The map key of one device's pass on one listener.
 * @param holder - the device, listener and page unlock.
 * @returns the key.
 */
function peerKey(holder: GrantHolder): string {
  return JSON.stringify([holder.deviceId, holder.listener, holder.unlockId ?? null])
}

/**
 * The map key of one hold.
 * @param holder - the device and listener.
 * @param feature - the feature.
 * @param id - the terminal or picker id.
 * @param scope - {@link scopeOf} of the resource.
 * @returns the key.
 */
function holdKey(holder: GrantHolder, feature: HoldFeature, id: string, scope: string): string {
  return JSON.stringify([holder.deviceId, holder.listener, holder.unlockId ?? null, feature, scope, id])
}
