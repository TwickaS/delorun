/**
 * What a start does for Changes before a profile boots: a fresh start from C1's runtime store first runs the store's
 * start check of the runtime, in every protection setting, and refuses a runtime whose files differ from the signed
 * release, or a composed tree it runs from that differs from the signed release with the approved harness files in
 * place ([harness start](./harness-start.ts)); then each plugin the profile links from a folder, other than the harness's own packages, is made to load
 * the content Changes allows ([`@delorun/changes`](../../../../packages/changes/src/enforce.ts)), and what the profile
 * leaves out is printed. A start of the home process first ends a work session that a home process which did not stop
 * left open. Both run as the pre-start step `changes` ([pre-start](../pre-start.ts)) of `delorun start` and `delorun
 * headless`. After upstream prepared the profile, the composition's approved plugin content step holds it to every
 * invariant Changes keeps ([compose](../compose.ts)). After the profile booted, or failed to, the start records which
 * plugins under Changes loaded (`run/<profile>/changes-boot.json`), which `delorun doctor` reads; after it booted, the
 * home process follows work sessions ([work watch](./work-watch.ts)) until its Host stops, ending one at its end time,
 * and stopping ends the open one; while protection is off it also reloads each linked plugin live when its folder
 * changes ([unreviewed watch](./unreviewed-watch.ts)). A session ended here ends without the person, so it approves nothing: the version it
 * started from stays approved and what the folder holds waits for review.
 *
 * @module @delorun/cli/changes/start
 */
import { resolve } from 'node:path'
import { getDelorunRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { checkChangesInvariants, enforceApprovedContent, followApprovedContent, isChangesError, markShownAtUpgrade, PROFILE_LOCK_WAIT_MS, recordsOf, repointActiveCopies, revertDecisions, startNotice, workFinishedLine, writeBootRecord, type BootRow, type DecisionRecords, type ReloadHost, type StartChanges, type UpdateBaseline } from '@delorun/changes'
import { finishWorkWithoutPerson } from '@delorun/changes/stop'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { DelorunLogger } from '@delorun/logs'
import { hostPacksEnvironment } from '@delorun/plugin-packs/environment'
import { RuntimeStoreError } from '@delorun/runtime-store'
import type { CompositionDraft } from '../compose.ts'
import { carriedPackageDirectory } from '../delorun-bundles.ts'
import { CliError, EXIT } from '../exit.ts'
import type { PreStartContext, StoredRuntime } from '../pre-start.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { printable, printableText } from '../terminal-text.ts'
import { updateBaselineOf } from './update-baseline.ts'
import { watchUnreviewed } from './unreviewed-watch.ts'
import { watchWork } from './work-watch.ts'

/** The profile a start is about to boot. */
export interface ChangesStartRequest {
  /** The Delorun home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** Set for a fresh start from the store; absent for an update's successor, whose runtime the update checked. */
  readonly runtime?: StoredRuntime
  /**
   * Set when this process holds the profile's home lock, as the home process does: a work session open now was left by
   * a home process that did not stop, so the start ends it first. Absent for `delorun headless`.
   */
  readonly ownsHome?: true
  /**
   * Whether `output` reaches a terminal the person reads. Only then are the plugins approved at upgrade recorded as
   * shown; `delorun status` and `delorun changes list` name them until one did. By default, whether this process's
   * standard output and standard error both are terminals: `delorun start` runs the home process with its output in
   * the log only, so its start shows nothing.
   */
  readonly terminal?: boolean
  /**
   * The signed pack files of an update's two releases, set only by {@link repointForSuccessor} for the first boot of the
   * successor of an update to a newer release ([update baseline](./update-baseline.ts)): a pack whose approved content
   * differs from its folder only by the release's own files is replaced, not left waiting.
   */
  readonly updateBaseline?: UpdateBaseline
}

/**
 * The installed release this process runs from, for the Changes request: a link in an active directory into the
 * runtime store holds only when it names this release's packages.
 * @returns `{ runningRelease }` from `DELORUN_VERSION`, or nothing when this process runs from a source checkout.
 */
export function runningRelease(): { readonly runningRelease?: string } {
  const release = getDelorunRuntimeVersion()
  return release === undefined ? {} : { runningRelease: release }
}

/**
 * Whether a link names the directory this installation of `delorun` itself carries for the package name, as a source
 * checkout's setup links Delorun's bundles ([delorun-bundles](../delorun-bundles.ts)): the harness's own package, which Changes
 * leaves alone.
 * @param name - the package name.
 * @param target - the folder the link names, absolute.
 * @returns true when the installation resolves the name to that folder.
 */
export function isCarriedPackage(name: string, target: string): boolean {
  const carried = carriedPackageDirectory(name)
  return carried !== undefined && resolve(carried) === resolve(target)
}

/**
 * Run Changes' part of a start: the stored runtime's check, the end of a work session a home process that did not stop
 * left open, then the linked plugins' content. A profile without a `package.json` has nothing linked and is left alone.
 * @param request - the home, the profile, whether this process holds its home lock and, for a fresh start from the
 *   store, its runtime check.
 * @param output - where the lines about left-out or unreviewed changes go.
 * @throws {CliError} when the stored runtime's files differ from the signed release, or its composed tree from the
 *   approved composition, a record of Changes cannot be
 *   read, a folder cannot be stored, or the profile history cannot record the profile's change: the profile does not
 *   boot.
 */
export async function startChanges(request: ChangesStartRequest, output: (text: string) => void): Promise<void> {
  const { home, profile, runtime } = request
  if (runtime !== undefined) {
    try {
      await runtime.check()
    } catch (error) {
      if (isChangesError(error)) throw new CliError(EXIT.failed, `delorun: Delorun ${runtime.version} was not started with your changes to it: ${error.detail}`)
      if (!(error instanceof RuntimeStoreError)) throw error
      throw new CliError(EXIT.failed, `delorun: Delorun ${runtime.version} was not started, because its files differ from the signed release: ${error.detail}. See what differs with: delorun verify`)
    }
  }
  if (!hasCliProfile(home, profile)) return
  const profileDir = profileDirectory(home, profile)
  let notice = ''
  let enforced: StartChanges
  try {
    const ended = request.ownsHome === true ? await finishWorkWithoutPerson({ home, profile, profileDir }, 'stopped') : undefined
    if (ended !== undefined) notice = `Your work session on ${ended.plugin} ended when Delorun stopped. ${workFinishedLine(ended)}\n`
    enforced = await enforceApprovedContent({ home, profile, profileDir, harnessLink: isCarriedPackage, ...runningRelease(), ...request.updateBaseline === undefined ? {} : { updateBaseline: request.updateBaseline } })
  } catch (error) {
    const detail = isChangesError(error) ? error.detail : String(error)
    throw new CliError(EXIT.failed, `delorun: the profile ${profile} was not started, because the plugins it links from folders could not be prepared: ${detail}`)
  }
  notice += startNotice(enforced)
  if (notice !== '') output(printableText(notice.trimEnd()).map(line => `${line}\n`).join(''))
  const shown = enforced.approvedAtUpgrade.map(({ plugin }) => plugin)
  if (shown.length === 0 || !(request.terminal ?? (process.stdout.isTTY && process.stderr.isTTY))) return
  try {
    await markShownAtUpgrade({ home, profile, profileDir, lockWaitMs: PROFILE_LOCK_WAIT_MS }, shown, new Date().toISOString())
  } catch (error) {
    // The record only stops the notice from repeating; the start goes on and the next one names the plugins again.
    output(`Delorun could not record that you saw this, so the next start says it again: ${printable(isChangesError(error) ? error.detail : String(error))}\n`)
  }
}

/**
 * Whether a Host boot first re-points the recorded active copies to this process's release: a successor's first boot,
 * whose copies name its predecessor's release, and every boot after a process's first, which follows a failed switch
 * that left the copies naming the release that failed. A fresh start's first boot has the pre-start steps instead.
 * @param successor - whether this process is an update's successor.
 * @param bootsBefore - how many Hosts this process has booted already.
 * @returns true when the copies are re-pointed first.
 */
export function repointsBeforeBoot(successor: boolean, bootsBefore: number): boolean {
  return successor || bootsBefore > 0
}

/**
 * Wrap a profile's Host boot so that it re-points the active copies first when {@link repointsBeforeBoot} says so, and
 * on a boot after the first, first makes them follow the approved record ({@link followApprovedContent}). The wrapper
 * also gives the Host runner's `abandon`, which undoes what an update's baseline advanced
 * ({@link repointForSuccessor}).
 * @param request - the home and the profile, and for an update's successor the release it left.
 * @param successor - whether this process is an update's successor.
 * @param boot - boots the Host.
 * @param repoint - re-points the copies; {@link repointForSuccessor} by default.
 * @returns the Host runner: the wrapped boot, which counts the boots it has run, and the undo of the first boot's
 *   baseline, which does nothing when the boot applied none or after it ran once.
 */
export function repointingBoot<A extends unknown[], T>(request: SuccessorRequest, successor: boolean, boot: (...args: A) => Promise<T>, repoint: (request: SuccessorRequest, afterFailedSwitch: boolean) => Promise<UndoBaseline | undefined> = repointForSuccessor): { readonly boot: (...args: A) => Promise<T>, readonly abandon: () => Promise<void> } {
  let booted = 0
  let undo: UndoBaseline | undefined
  return {
    boot: async (...args) => {
      const afterFailedSwitch = booted > 0
      if (repointsBeforeBoot(successor, booted++)) undo ??= await repoint(request, afterFailedSwitch)
      return boot(...args)
    },
    abandon: async () => {
      const run = undo
      undo = undefined
      await run?.()
    },
  }
}

/** Undoes what an update's baseline advanced in Changes' records ({@link repointForSuccessor}). */
export type UndoBaseline = () => Promise<void>

/** What re-pointing a successor's active copies needs to know about the start. */
export interface SuccessorRequest {
  /** The Delorun home. */
  readonly home: string
  /** The profile about to boot. */
  readonly profile: string
  /** The release an update left, set only for the successor of an update ({@link updateSource}). */
  readonly updatedFrom?: RuntimeVersion
  /** Where the lines about the update's pack files go; the home process's log. */
  readonly write?: (text: string) => void
}

/**
 * An update's successor boots without the pre-start steps, so before its first Host boots it runs Changes' part of a
 * start for the profile ({@link startChanges}) with the signed pack files of the update, which replaces a pack's
 * approved content that differs from its folder only by the release's own files ({@link verifiedUpdateBaseline}); then
 * it re-points each recorded active copy's links into the runtime store to its own release
 * ({@link repointActiveCopies}); otherwise a plugin pack copy written under the previous release fails the load check of
 * the new one and the update rolls back. The baseline is applied once per update: a boot after a failed switch, which
 * the predecessor or a restarted successor makes, never applies it, and first makes the copies that load approved
 * content follow the approved record, which the failed switch's rollback restored while `active.json` kept the failed
 * release's decision ({@link followApprovedContent}); with protection on, the previous release would otherwise refuse
 * to resume.
 *
 * The same update's failed health check leaves the records of the baseline behind, and a predecessor older than
 * {@link followApprovedContent} cannot follow them back: the successor then reports the failure only after it has put
 * every approved-record and `active.json` entry the baseline changed back to what the predecessor left
 * ({@link revertDecisions}, through the Host runner's `abandon`), so the predecessor's rollback and resume find nothing
 * advanced. The same undo runs when the boot's own steps throw after the baseline applied.
 * @param request - the home and the profile about to boot, and the release an update left.
 * @param afterFailedSwitch - whether a Host of this process booted before.
 * @returns the undo of what the baseline advanced in the approved record and `active.json`, which the Host runner's
 *   `abandon` runs when the successor's health check fails ({@link repointingBoot}); `undefined` when no baseline applied or
 *   for a home without the profile.
 * @throws {CliError} when Changes cannot prepare the profile or a copy cannot be re-pointed: the successor does not
 *   boot, so the update rolls back.
 */
export async function repointForSuccessor(request: SuccessorRequest, afterFailedSwitch = false): Promise<UndoBaseline | undefined> {
  const { home, profile } = request
  if (!hasCliProfile(home, profile)) return undefined
  const enforce = { home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage, ...runningRelease() }
  const write = request.write ?? (() => undefined)
  const updateBaseline = afterFailedSwitch || request.updatedFrom === undefined ? undefined : await verifiedUpdateBaseline(request.updatedFrom, write)
  // Without a verified baseline there is nothing to apply, and the successor boots as it did before.
  const before = updateBaseline === undefined ? undefined : await recordsOf(enforce)
  let after: DecisionRecords | undefined
  const undo: UndoBaseline | undefined = before === undefined ? undefined : async () => { await revertDecisions(enforce, before, after ?? await recordsOf(enforce)) }
  try {
    if (updateBaseline !== undefined) {
      try {
        await startChanges({ home, profile, updateBaseline }, write)
      } finally {
        after = await recordsOf(enforce)
      }
    }
    try {
      if (afterFailedSwitch) await followApprovedContent(enforce)
      await repointActiveCopies(enforce)
    } catch (error) {
      throw new CliError(EXIT.failed, `delorun: the profile ${profile} was not started, because its plugin copies could not be pointed at this release: ${isChangesError(error) ? error.detail : String(error)}`)
    }
  } catch (error) {
    // The Host does not boot, so no health check reports it: the predecessor resumes at once, and it needs the records as it left them.
    await undo?.().catch((undoError: unknown) => { write(`Delorun could not put the plugin records back after the update's pack files were applied: ${printable(isChangesError(undoError) ? undoError.detail : String(undoError))}\n`) })
    throw error
  }
  return undo
}

/**
 * The pre-start step `changes` ([pre-start](../pre-start.ts)): {@link startChanges} for the profile about to boot, with
 * the stored runtime's check when a fresh start runs from the store. A fresh start of the CLI profile holds the home
 * lock, so it ends a work session a home process that did not stop left open; `delorun headless` holds no lock and ends
 * none. Its lines go to standard output for the CLI profile and to standard error for `delorun headless`, whose
 * standard output carries the task's answer.
 * @param context - the start.
 * @returns when the profile's linked plugins load what Changes allows.
 * @throws {CliError} as {@link startChanges} does.
 */
export async function changesPreStartStep(context: PreStartContext): Promise<void> {
  const { home, profile, kind, successor, output, storedRuntime } = context
  const write = (text: string): void => {
    if (kind === 'headless') output.stderr(text)
    else output.stdout(text)
  }
  return startChanges({
    home,
    profile,
    ...storedRuntime === undefined ? {} : { runtime: storedRuntime },
    ...kind === 'cli' && !successor ? { ownsHome: true } as const : {},
  }, write)
}

/**
 * The signed pack files of the update this process is the successor of ({@link repointForSuccessor} asks for them). A release whose files cannot be verified
 * replaces nothing: its packs' changes wait for review as they would without an update.
 * @param from - the release the update left.
 * @param write - where the line about a failed check goes.
 * @returns the baseline, or `undefined` when there is none to use.
 */
async function verifiedUpdateBaseline(from: RuntimeVersion, write: (text: string) => void): Promise<UpdateBaseline | undefined> {
  try {
    const environment = await hostPacksEnvironment(process.env)
    if ('unsupported' in environment) return undefined
    return await updateBaselineOf(environment, from)
  } catch (error) {
    write(`Delorun could not check the plugin packs of the update against the signed release, so changes to them wait for your review: ${printable(error instanceof Error ? error.message : String(error))}\n`)
    return undefined
  }
}

/**
 * The composition's approved plugin content step ([compose](../compose.ts)), which Changes provides: after upstream
 * prepared the profile, it holds the profile to every invariant Changes keeps (`checkChangesInvariants` of
 * `@delorun/changes`) and refuses the start when one is broken. It adds no overlay. A profile the home does not have as a
 * CLI profile, such as upstream's `headless` profile in a home without it, has nothing under Changes.
 * @param draft - the composition so far.
 * @returns no overlay files.
 * @throws {CliError} naming each broken invariant.
 */
export async function changesApprovedContent(draft: Pick<CompositionDraft, 'request'>): Promise<readonly string[]> {
  const { home, profile } = draft.request
  if (!hasCliProfile(home, profile)) return []
  const broken = await checkChangesInvariants({ home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage, ...runningRelease() })
  if (broken.length === 0) return []
  throw new CliError(EXIT.failed, [
    `delorun: the profile ${profile} was not started, because what it would load is not what Changes keeps for it:`,
    ...broken.map(line => `  ${printable(line)}`),
  ].join('\n'))
}

/** The profile a start booted, and where a failure to record it is logged. */
export interface ChangesBootRequest {
  /** The Delorun home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The home process's logger. */
  readonly logger: DelorunLogger
}

/**
 * Record which plugins under Changes loaded at this start, for `delorun doctor`. The record is a help for that report,
 * so a failure to write it is logged as a warning and the start goes on.
 * @param request - the home, the profile and the logger.
 * @param rows - the Loader's rows after startup settled; empty when the profile did not boot.
 * @param failure - what the profile's boot failed with, when it failed.
 * @param insertedRows - the ids of the rows each bundle layer inserts, by package name.
 */
export async function recordChangesBoot(request: ChangesBootRequest, rows: readonly BootRow[], failure?: unknown, insertedRows?: Readonly<Record<string, readonly string[]>>): Promise<void> {
  const { home, profile, logger } = request
  try {
    await writeBootRecord({ home, profile, profileDir: profileDirectory(home, profile), rows, ...insertedRows === undefined ? {} : { insertedRows }, ...failure === undefined ? {} : { failure: failure instanceof Error ? failure.message : String(failure) } })
  } catch (error) {
    logger.warn(`Changes could not record which plugins loaded at this start: ${isChangesError(error) ? error.detail : String(error)}`)
  }
}

/**
 * Follow work sessions in the booted Host until Delorun stops ([work watch](./work-watch.ts)), and while protection is off,
 * reload each linked plugin live when its folder changes ([unreviewed watch](./unreviewed-watch.ts)).
 * @param request - the home, the profile and the logger.
 * @param booted - the booted profile's reload.
 * @returns what the Host's `close` and `suspend` call before they stop the profile: it stops both watchers and ends the
 *   open work session without the person, which approves nothing. A failure to end it is logged; the next start ends
 *   it.
 */
export function afterChangesBoot(request: ChangesBootRequest, booted: { readonly reload: ReloadHost }): () => Promise<void> {
  const { home, profile, logger } = request
  const profileDir = profileDirectory(home, profile)
  const ctx = { home, profile, profileDir }
  const reload: ReloadHost = () => booted.reload()
  const watcher = watchWork({ ...ctx, reload, logger, expire: () => finishWorkWithoutPerson(ctx, 'expired', reload) })
  const live = watchUnreviewed({ ...ctx, reload, logger })
  return async () => {
    await live.close()
    await watcher.close()
    try {
      const ended = await finishWorkWithoutPerson(ctx, 'stopped')
      if (ended !== undefined) logger.info(`Your work session on ${ended.plugin} ended as Delorun stopped. ${workFinishedLine(ended)}`)
    } catch (error) {
      logger.warn(`Delorun could not end your work session as it stopped; the next start ends it: ${isChangesError(error) ? error.detail : String(error)}`)
    }
  }
}
