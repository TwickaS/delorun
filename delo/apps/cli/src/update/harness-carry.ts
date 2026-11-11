/**
 * The person's approved changes to the harness itself across an update of the CLI home (contracts C3, C19 and C21):
 * the home process's {@link HarnessCarry} over `@delo/changes`'s `carryHarness`. Both runtimes' signed installations
 * are read through the runtime store's start check under the anchored root. A change waiting for review refuses the
 * update with C19's `HARNESS_CHANGES_PENDING`, at prepare and again right before the switch.
 *
 * @module @delo/cli/update/harness-carry
 */
import { carryHarness, harnessChanges, isChangesError, type HarnessContext, type SignedRuntime } from '@delo/changes'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { HomeProcessError, type HarnessCarry } from '@delo/home-process'
import type { RuntimeStore, TrustedRootSource } from '@delo/runtime-store'
import { signedRuntimeOf } from './signed-runtime.ts'

/** What {@link storeHarnessCarry} reads. */
export interface HarnessCarryOptions {
  /** The resolved Delo home. */
  readonly home: string
  /** C1's runtime store. */
  readonly store: RuntimeStore
  /** The stored root, anchored on the launcher's roots. */
  readonly root: TrustedRootSource
  /** The clock for the records' times. */
  readonly now: () => Date
}

/**
 * Run a harness step, with a change waiting for review as C19's refusal.
 * @param step - the step.
 * @returns what the step returns.
 * @throws {HomeProcessError} `HARNESS_CHANGES_PENDING` with the files when a change waits for review; any other error
 *   unchanged.
 */
async function refusingPending<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    if (isChangesError(error) && error.code === 'HARNESS_CHANGES_PENDING') throw new HomeProcessError('HARNESS_CHANGES_PENDING', error.detail)
    throw error
  }
}

/**
 * The harness carry of a home process that runs from the store.
 * @param options - the home, the store, the anchored root and the clock.
 * @returns the carry.
 */
export function storeHarnessCarry(options: HarnessCarryOptions): HarnessCarry {
  const { home, store } = options
  const signed = async (version: RuntimeVersion): Promise<SignedRuntime> => signedRuntimeOf(store.paths.version(version), await store.checkRuntime(version, await options.root()))
  const context = (runtime: RuntimeVersion): HarnessContext => {
    let read: Promise<SignedRuntime> | undefined
    return { home, runtime, signed: () => (read ??= signed(runtime)), now: options.now }
  }
  return {
    async check(from) {
      const pending = await harnessChanges(context(from), { cache: false })
      if (pending.changes.length > 0) {
        throw new HomeProcessError('HARNESS_CHANGES_PENDING', `your changes to Delo ${from} itself wait for review (${pending.changes.map(change => change.file).join(', ')}), and an update would leave them behind; apply or discard them first: delorun changes list`)
      }
    },
    async carry(from, to, switchRuntime) {
      await refusingPending(async () => carryHarness({ from: context(from), to, signed: async () => signed(to) }, switchRuntime, options.now))
    },
  }
}
