/**
 * The typed failure of every runtime-store operation: contract C1's store codes, C19's `NO_PREVIOUS`, and the codes
 * this package adds where the contracts name none, each with the path it concerns and the remedies the launcher
 * offers.
 *
 * @module @delo/runtime-store/errors
 */
import type { HomeLayoutErrorCode } from '@delo/contract-home-layout'

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
 */
export type RuntimeStoreErrorCode = StoreLayoutCode | 'NO_PREVIOUS' | 'RUNTIME_CHANGED' | 'POINTER_CHANGED' | 'NOT_INSTALLED'

/** What the launcher offers after a refused start. */
export type RuntimeRemedy = 'reinstall' | 'rollback' | 'update' | 'launcher-update'

/** A refusal or failure of the runtime store. */
export class RuntimeStoreError extends Error {
  override readonly name = 'RuntimeStoreError'

  /**
   * @param code - the failure's code.
   * @param path - the absolute path the failure concerns.
   * @param detail - what is wrong, naming the path or version; the message is the code and this.
   * @param remedies - what the launcher offers the person, in order; empty when nothing is offered.
   * @param options - the underlying error.
   */
  constructor(
    readonly code: RuntimeStoreErrorCode,
    readonly path: string,
    readonly detail: string,
    readonly remedies: readonly RuntimeRemedy[] = [],
    options?: ErrorOptions,
  ) {
    super(`${code}: ${detail}`, options)
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
