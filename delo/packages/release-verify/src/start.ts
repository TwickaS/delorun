/**
 * The start check of contract C18 (`Behaviour per client`): the CLI launcher, the headless home and the desktop updater
 * verify the installed release's stored bundle offline at every start and, with a network, run the online check. The
 * result is one of the contract's three states with what a start does about it:
 *
 * - `verified`: the bundle verified and the online check passed; the start goes on.
 * - `unchecked`: the offline check passed but the online check did not run — no network, the distributor was
 *   unreachable, or the newest witnessed checkpoint is over 24 hours old. The start goes on and prints
 *   {@link uncheckedWarning}, which names the release, and the check runs again at the next connection.
 * - `failed`: a verifiable failure, or no stored bundle for a release the runtime store installed. The start stops in
 *   every verification mode (R5) and the person is offered a rollback.
 *
 * Under `integrity.mode: off` (contract C15) the online check does not run, so a release whose bundle verifies stays
 * `unchecked` with no warning and no retry; the offline check still runs at every start and a verified failure still
 * stops it.
 *
 * @module @delo/release-verify/start
 */
import { VERIFICATION_MODE_SETTING, type VerificationMode } from '@delo/contract-verification-checks'
import type { ReleaseLogCheckState } from '@delo/contract-release-log'
import type { RootMetadata } from '@delo/contract-release-manifest'
import { checkBundle } from './bundle.ts'
import type { StoredCheckpoint } from './checkpoint.ts'
import type { ReleaseLogRefusal } from './errors.ts'
import { checkOnline, type LegacyCheckpoint, type ReleaseLogTransport } from './online.ts'

/** What the start check reads. */
export interface StartCheckInput {
  /** The trusted root; it alone names the log and the witnesses (R6). */
  readonly root: RootMetadata
  /** The installed release's version. */
  readonly version: string
  /** The manifest file the client verified under contract C2. */
  readonly manifest: Uint8Array
  /** The release's stored release-log bundle, when the client holds one. */
  readonly bundle: Uint8Array | undefined
  /**
   * What an absent {@link StartCheckInput.bundle} makes the release. `failed` for a release the runtime store installed,
   * the first install and every update included: each such install keeps the bundle it verified beside the release, so
   * a missing one was removed after the install. `unchecked` only for a client that fetches the bundle after it
   * installed, such as a desktop app installed from a downloaded installer.
   */
  readonly missingBundle: 'failed' | 'unchecked'
  /** The client's clock, in Unix seconds. */
  readonly now: number
  /** The verified checkpoint the client stored, when it holds one. */
  readonly stored: StoredCheckpoint | undefined
  /** A stored checkpoint of the installer's earlier record format, which the online check proves or replaces. */
  readonly legacy?: LegacyCheckpoint
  /** The transport to the log; `undefined` when the client has no network. */
  readonly transport: ReleaseLogTransport | undefined
  /** The deadline of the online check; contract C18's 90 seconds by default. */
  readonly signal?: AbortSignal
  /** Contract C15's `integrity.mode`. */
  readonly mode: VerificationMode
}

/** What a start does about the state. */
export interface StartCheckResult {
  /** The state the start records. */
  readonly state: ReleaseLogCheckState
  /** Present when the state is `failed`. */
  readonly refusal?: ReleaseLogRefusal
  /** Present when the state is `failed`, or `unchecked` because no bundle is stored yet. */
  readonly detail?: string
  /** Present when the state is `unchecked` and the start warns; absent under `integrity.mode: off`. */
  readonly warning?: string
  /** Whether the start stops: true for `failed`, whatever the verification mode is. */
  readonly stop: boolean
  /** The verified checkpoint to store, when the online check verified one. */
  readonly checkpoint?: StoredCheckpoint
  /** What the check noticed that a person should know without it being a failure, such as a stored floor it replaced. */
  readonly notices?: readonly string[]
}

/**
 * The warning a start prints when it could not check the release against the release log, in the contract's words.
 * @param version - the release's version.
 * @returns the warning text.
 */
export function uncheckedWarning(version: string): string {
  return `Release ${version} has not been checked against the release log; Delorun checks it at the next connection.`
}

/**
 * Run the start check.
 * @param input - the trusted root, the release, its manifest and bundle, the stored checkpoint, the clock, the transport
 * and the verification mode.
 * @returns the state, the warning a start prints, whether the start stops, and the checkpoint to store.
 */
export async function checkAtStart(input: StartCheckInput): Promise<StartCheckResult> {
  if (input.bundle === undefined) {
    if (input.missingBundle === 'failed') {
      // `bundle-malformed` keeps the refusal inside the set the previous release reads from `trust/release-log.json`.
      return { state: 'failed', refusal: 'bundle-malformed', detail: 'no release-log bundle is stored beside this release, and every install through the runtime store keeps the one it verified, so it was removed after the install', stop: true }
    }
    // No bundle is stored yet — the first start of a desktop app installed from a downloaded installer fetches it. The
    // release is not checked, so it is `unchecked` and the start warns, as it does without a network.
    return { state: 'unchecked', detail: 'no release-log bundle is stored for this release yet', warning: uncheckedWarning(input.version), stop: false }
  }
  const verdict = checkBundle(input.root, input.version, input.manifest, input.bundle)
  if (!verdict.ok) return { state: 'failed', refusal: verdict.refusal, detail: verdict.detail, stop: true }
  if (input.mode === 'off') {
    // C18: with the online check off, a bundle that verifies leaves the release `unchecked`, and neither the warning
    // nor the retries apply. The offline check above still ran, and still stops the start when it fails.
    return { state: 'unchecked', stop: false }
  }
  if (input.transport === undefined) {
    return { state: 'unchecked', warning: uncheckedWarning(input.version), stop: false }
  }
  const online = await checkOnline({
    root: input.root,
    bundle: verdict.bundle,
    stored: input.stored,
    transport: input.transport,
    now: input.now,
    ...input.legacy === undefined ? {} : { legacy: input.legacy },
    ...input.signal === undefined ? {} : { signal: input.signal },
  })
  const notices = online.notices.length === 0 ? {} : { notices: online.notices }
  if (online.ok) return { state: 'verified', checkpoint: online.checkpoint, stop: false, ...notices }
  // Only a verifiable failure stops a start; a check that did not complete never does, in any mode.
  if (online.kind === 'failed') return { state: 'failed', refusal: online.refusal, detail: online.detail, stop: true, ...notices }
  return { state: 'unchecked', detail: online.detail, warning: uncheckedWarning(input.version), stop: false, ...notices }
}

/**
 * Whether the online check may run at all, which names the setting a person turns off.
 * @param mode - contract C15's `integrity.mode`.
 * @returns `true` unless the mode is `off`.
 */
export function onlineCheckEnabled(mode: VerificationMode): boolean {
  return mode !== 'off'
}

/** The setting whose `off` value stops the online check, for a message that names it. */
export const INTEGRITY_MODE_SETTING = VERIFICATION_MODE_SETTING
