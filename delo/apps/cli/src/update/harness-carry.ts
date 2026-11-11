/**
 * The person's approved changes to the harness itself across an update of the CLI home (contracts C3, C19 and C21):
 * the home process's {@link HarnessCarry} over `@delo/changes`'s `carryHarness`. Both runtimes' signed installations
 * are read through the runtime store's start check under the anchored root. A change waiting for review refuses the
 * update with C19's `HARNESS_CHANGES_PENDING`, at prepare and again right before the switch, and a copy whose scan
 * fails refuses it with `HARNESS_COPY_UNREADABLE` and the commands that clear it. Right before the switch the merge
 * runs again under the harness lock, and any difference from the harness items of the report the person confirmed
 * refuses the update with `HARNESS_REPORT_STALE`.
 *
 * @module @delo/cli/update/harness-carry
 */
import { sep } from 'node:path'
import { carryHarness, harnessChanges, harnessCopyDirectory, isChangesError, type HarnessCarryPlan, type HarnessContext, type SignedRuntime } from '@delo/changes'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { UpdateReport } from '@delo/contract-update-report'
import { HomeProcessError, type HarnessCarry } from '@delo/home-process'
import type { RuntimeStore, TrustedRootSource } from '@delo/runtime-store'
import type { HarnessFact } from '@delo/update'
import { harnessFacts } from './harness-items.ts'
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

/** The remedies of a copy whose scan failed, as the refusal's detail names them. */
const COPY_REMEDIES = 'take back every change in it with delorun changes edit-harness --discard, or fix the copy and see its changes with delorun changes list'

/**
 * What failed in a scan of the running runtime's copy, when the error is one: `CONTENT_TOO_LARGE` over the scan's
 * limits, `CHANGED_WHILE_READING` for a file that changed while it was read, or a filesystem error at a path in the copy,
 * such as an entry that cannot be read.
 * @param error - the error the scan, or the carry around it, threw.
 * @param copy - the running runtime's copy directory.
 * @returns the failure's own words, or `undefined` for an error that is not a failed scan of the copy.
 */
export function scanFailure(error: unknown, copy: string): string | undefined {
  if (isChangesError(error)) return error.code === 'CONTENT_TOO_LARGE' || error.code === 'CHANGED_WHILE_READING' ? error.detail : undefined
  if (!(error instanceof Error) || !('path' in error) || typeof error.path !== 'string' || !('code' in error) || typeof error.code !== 'string') return undefined
  return error.path === copy || error.path.startsWith(copy + sep) ? `${error.code} at ${error.path}` : undefined
}

/**
 * Run a harness step, with a change waiting for review and a failed scan of the running runtime's copy as C19's
 * refusals.
 * @param home - the Delo home.
 * @param from - the running version.
 * @param step - the step.
 * @returns what the step returns.
 * @throws {HomeProcessError} `HARNESS_CHANGES_PENDING` with the files when a change waits for review;
 *   `HARNESS_COPY_UNREADABLE` with what failed and the commands that clear it when the copy's scan fails; any other
 *   error unchanged.
 */
async function refusing<T>(home: string, from: RuntimeVersion, step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    if (isChangesError(error) && error.code === 'HARNESS_CHANGES_PENDING') throw new HomeProcessError('HARNESS_CHANGES_PENDING', error.detail)
    const failure = scanFailure(error, harnessCopyDirectory(home, from))
    if (failure !== undefined) {
      throw new HomeProcessError('HARNESS_COPY_UNREADABLE', `Delo could not scan your copy of Delo ${from} itself (${failure}), so it cannot tell whether changes there wait for review; ${COPY_REMEDIES}`)
    }
    throw error
  }
}

/**
 * The harness facts of the report the person confirmed, by file.
 * @param report - the report `update.prepare` built and the home process kept.
 * @returns each `harness` item's file, merge and result.
 */
function confirmedFacts(report: UpdateReport): ReadonlyMap<string, HarnessFact> {
  const facts = new Map<string, HarnessFact>()
  for (const item of report.items) {
    if (item.kind !== 'harness' || item.detail.merge === undefined) continue
    facts.set(item.subject.file, { file: item.subject.file, merge: item.detail.merge, ...item.detail.result === undefined ? {} : { result: item.detail.result } })
  }
  return facts
}

/**
 * Whether two facts of one file state the same outcome and, for a carried file, the same result.
 * @param a - one fact.
 * @param b - the other.
 * @returns whether they agree.
 */
function sameFact(a: HarnessFact, b: HarnessFact): boolean {
  return a.merge === b.merge && a.result?.sha256 === b.result?.sha256 && a.result?.executable === b.result?.executable
}

/**
 * The check of a plan made under the harness lock against the report the person confirmed.
 * @param report - the confirmed report.
 * @returns the check, which throws when a file is in one and not the other, or its merge or result differs.
 * @throws {HomeProcessError} `HARNESS_REPORT_STALE` naming the files whose merge differs, from the returned check.
 */
export function confirmedPlan(report: UpdateReport): (plan: HarnessCarryPlan) => void {
  const confirmed = confirmedFacts(report)
  return (plan) => {
    const planned = new Map(harnessFacts(plan).map(fact => [fact.file, fact]))
    const differ = [...new Set([...confirmed.keys(), ...planned.keys()])].filter((file) => {
      const a = confirmed.get(file)
      const b = planned.get(file)
      return a === undefined || b === undefined || !sameFact(a, b)
    }).sort()
    if (differ.length > 0) {
      throw new HomeProcessError('HARNESS_REPORT_STALE', `what Delo would now do with your changes to ${differ.join(', ')} differs from the report you confirmed, so nothing was switched; read the new report with delorun update`)
    }
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
      const pending = await refusing(home, from, async () => harnessChanges(context(from), { cache: false }))
      if (pending.changes.length > 0) {
        throw new HomeProcessError('HARNESS_CHANGES_PENDING', `your changes to Delo ${from} itself wait for review (${pending.changes.map(change => change.file).join(', ')}), and an update would leave them behind; apply or discard them first: delorun changes list`)
      }
    },
    async carry(from, to, report, switchRuntime) {
      // The home process keeps the report this process's sources built at `update.prepare`; the client sends none.
      const confirm = confirmedPlan(report as UpdateReport)
      await refusing(home, from, async () => carryHarness({ from: context(from), to, signed: async () => signed(to), confirm }, switchRuntime, options.now))
    },
  }
}
