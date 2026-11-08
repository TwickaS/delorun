/**
 * The start check of contract C18 (`Behaviour per client`): the CLI launcher, the headless home and the desktop updater
 * verify the installed release's stored bundle offline at every start and, with a network, run the online check. The
 * result is one of the contract's three states with what a start does about it:
 *
 * - `verified`: the bundle verified and the online check passed; the start goes on.
 * - `unchecked`: the offline check passed but the online check did not run — no network, the distributor was
 *   unreachable, or the newest witnessed checkpoint is over 24 hours old. The start goes on and prints
 *   {@link uncheckedWarning}, which names the release, and the check runs again at the next connection.
 * - `failed`: a verifiable failure. The start stops in every verification mode (R5) and the person is offered a
 *   rollback.
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
import { checkOnline, type ReleaseLogTransport } from './online.ts'

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
  /** The client's clock, in Unix seconds. */
  readonly now: number
  /** The verified checkpoint the client stored, when it holds one. */
  readonly stored: StoredCheckpoint | undefined
  /** The transport to the log and the distributor; `undefined` when the client has no network. */
  readonly transport: ReleaseLogTransport | undefined
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
}

/**
 * The warning a start prints when it could not check the release against the release log, in the contract's words.
 * @param version - the release's version.
 * @returns the warning text.
 */
export function uncheckedWarning(version: string): string {
  return `Release ${version} has not been checked against the release log; Delo checks it at the next connection.`
}

/**
 * Run the start check.
 * @param input - the trusted root, the release, its manifest and bundle, the stored checkpoint, the clock, the transport
 * and the verification mode.
 * @returns the state, the warning a start prints, whether the start stops, and the checkpoint to store.
 */
export async function checkAtStart(input: StartCheckInput): Promise<StartCheckResult> {
  if (input.bundle === undefined) {
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
  const online = await checkOnline({ root: input.root, bundle: verdict.bundle, stored: input.stored, transport: input.transport, now: input.now })
  if (online.ok) return { state: 'verified', checkpoint: online.checkpoint, stop: false }
  if (online.kind === 'failed') return { state: 'failed', refusal: online.refusal, detail: online.detail, stop: true }
  return { state: 'unchecked', detail: online.detail, warning: uncheckedWarning(input.version), stop: false }
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
