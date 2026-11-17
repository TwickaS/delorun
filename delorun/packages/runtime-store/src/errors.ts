/**
 * The typed failure of every runtime-store operation: contract C1's store codes, C19's `NO_PREVIOUS`, and the codes
 * this package adds where the contracts name none, each with the path it concerns and the remedies the launcher
 * offers.
 *
 * @module @delorun/runtime-store/errors
 */
import type { HomeLayoutErrorCode } from '@delorun/contract-home-layout'

/** The C1 codes the runtime store raises. */
export type StoreLayoutCode = Extract<HomeLayoutErrorCode, 'STORE_BUSY' | 'NO_ACTIVE_RUNTIME' | 'POINTER_REPLACE_FAILED' | 'RUNTIME_INCOMPATIBLE' | 'INSTALL_VERIFY_FAILED'>

/**
 * Every code a {@link RuntimeStoreError} carries.
 *
 * - C1's store codes ({@link StoreLayoutCode}).
 * - `NO_PREVIOUS` (C19): a rollback was requested and no installed `previous` exists.
 * - `RUNTIME_CHANGED`: the start check found a missing, changed or extra file, or a stored manifest or file list that
 *   does not verify. C2 requires the stop and names no code for it.
 * - `POINTER_CHANGED`: a switch's `from` is not the version `current` names, so the caller acted on a stale read.
 * - `NOT_INSTALLED`: a pointer write names a version with no installed directory.
 * - `ROOT_NOT_ANCHORED`: the trusted root `trust/root.json` could not be anchored on the release roots the launcher
 *   ships, because the process was not started by the launcher (which names its roots in `DELORUN_LAUNCHER_ROOTS`), the
 *   shipped roots do not read, or no shipped root leads to the stored one. Nothing is installed, switched to or rolled
 *   back to under such a root.
 * - `TARGET_LOWER`: an update's target is lower than the version `current` names. An update never goes to a lower
 *   version; `delorun recover rollback` is the only way back, and it reaches only the version `previous` names.
 */
export type RuntimeStoreErrorCode = StoreLayoutCode | 'NO_PREVIOUS' | 'RUNTIME_CHANGED' | 'POINTER_CHANGED' | 'NOT_INSTALLED' | 'ROOT_NOT_ANCHORED' | 'TARGET_LOWER'

/** What the launcher offers after a refused start. */
export type RuntimeRemedy = 'reinstall' | 'rollback' | 'update' | 'launcher-update' | 'recover-packs'

/** A refusal or failure of the runtime store. */
export class RuntimeStoreError extends Error {
  override readonly name = 'RuntimeStoreError'

  /** The failure's code. */
  readonly code: RuntimeStoreErrorCode
  /** The absolute path the failure concerns. */
  readonly path: string
  /** What is wrong, naming the path or version; the message is the code and this. */
  readonly detail: string
  /** What the launcher offers the person, in order; empty when nothing is offered. */
  readonly remedies: readonly RuntimeRemedy[]

  /**
   * @param code - the failure's code.
   * @param path - the absolute path the failure concerns.
   * @param detail - what is wrong, naming the path or version; the message is the code and this.
   * @param remedies - what the launcher offers the person, in order; empty when nothing is offered.
   * @param options - the underlying error.
   */
  constructor(
    code: RuntimeStoreErrorCode,
    path: string,
    detail: string,
    remedies: readonly RuntimeRemedy[] = [],
    options?: ErrorOptions,
  ) {
    super(`${code}: ${detail}`, options)
    this.code = code
    this.path = path
    this.detail = detail
    this.remedies = remedies
  }
}

/**
 * Whether a value is a {@link RuntimeStoreError} with one of the given codes.
 * @param error - the value.
 * @param codes - the codes.
 * @returns true when it is one.
 */
export function isStoreError(error: unknown, ...codes: readonly RuntimeStoreErrorCode[]): error is RuntimeStoreError {
  return error instanceof RuntimeStoreError && (codes.length === 0 || codes.includes(error.code))
}
