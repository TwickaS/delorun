/**
 * What a start does for Changes before a profile boots: a fresh start from C1's runtime store first runs the store's
 * start check of the runtime, in every protection setting, and refuses a runtime whose files differ from the signed
 * release, or a composed tree it runs from that differs from the signed release with the approved harness files in
 * place ([harness start](./harness-start.ts)); then each plugin the profile links from a folder, other than the harness's own packages, is made to load
 * the content Changes allows ([`@delo/changes`](../../../../packages/changes/src/enforce.ts)), and what the profile
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
 * @module @delo/cli/changes/start
 */
import { resolve } from 'node:path'
import { checkChangesInvariants, enforceApprovedContent, isChangesError, markShownAtUpgrade, PROFILE_LOCK_WAIT_MS, startNotice, workFinishedLine, writeBootRecord, type BootRow, type ReloadHost, type StartChanges } from '@delo/changes'
import { finishWorkWithoutPerson } from '@delo/changes/stop'
import type { DeloLogger } from '@delo/logs'
import { RuntimeStoreError } from '@delo/runtime-store'
import type { CompositionDraft } from '../compose.ts'
import { carriedPackageDirectory } from '../delo-bundles.ts'
import { CliError, EXIT } from '../exit.ts'
import type { PreStartContext, StoredRuntime } from '../pre-start.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { printable, printableText } from '../terminal-text.ts'
import { watchUnreviewed } from './unreviewed-watch.ts'
import { watchWork } from './work-watch.ts'

/** The profile a start is about to boot. */
export interface ChangesStartRequest {
  /** The Delo home. */
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
}

/**
 * Whether a link names the directory this installation of `delorun` itself carries for the package name, as a source
 * checkout's setup links Delo's bundles ([delo-bundles](../delo-bundles.ts)): the harness's own package, which Changes
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
      if (isChangesError(error)) throw new CliError(EXIT.failed, `delorun: Delo ${runtime.version} was not started with your changes to it: ${error.detail}`)
      if (!(error instanceof RuntimeStoreError)) throw error
      throw new CliError(EXIT.failed, `delorun: Delo ${runtime.version} was not started, because its files differ from the signed release: ${error.detail}. See what differs with: delorun verify`)
    }
  }
  if (!hasCliProfile(home, profile)) return
  const profileDir = profileDirectory(home, profile)
  let notice = ''
  let enforced: StartChanges
  try {
    const ended = request.ownsHome === true ? await finishWorkWithoutPerson({ home, profile, profileDir }, 'stopped') : undefined
    if (ended !== undefined) notice = `Your work session on ${ended.plugin} ended when Delo stopped. ${workFinishedLine(ended)}\n`
    enforced = await enforceApprovedContent({ home, profile, profileDir, harnessLink: isCarriedPackage })
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
    output(`Delo could not record that you saw this, so the next start says it again: ${printable(isChangesError(error) ? error.detail : String(error))}\n`)
  }
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
export function changesPreStartStep(context: PreStartContext): Promise<void> {
  const { home, profile, kind, successor, output, storedRuntime } = context
  return startChanges({
    home,
    profile,
    ...storedRuntime === undefined ? {} : { runtime: storedRuntime },
    ...kind === 'cli' && !successor ? { ownsHome: true } as const : {},
  }, (text) => {
    if (kind === 'headless') output.stderr(text)
    else output.stdout(text)
  })
}

/**
 * The composition's approved plugin content step ([compose](../compose.ts)), which Changes provides: after upstream
 * prepared the profile, it holds the profile to every invariant Changes keeps (`checkChangesInvariants` of
 * `@delo/changes`) and refuses the start when one is broken. It adds no overlay. A profile the home does not have as a
 * CLI profile, such as upstream's `headless` profile in a home without it, has nothing under Changes.
 * @param draft - the composition so far.
 * @returns no overlay files.
 * @throws {CliError} naming each broken invariant.
 */
export async function changesApprovedContent(draft: Pick<CompositionDraft, 'request'>): Promise<readonly string[]> {
  const { home, profile } = draft.request
  if (!hasCliProfile(home, profile)) return []
  const broken = await checkChangesInvariants({ home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage })
  if (broken.length === 0) return []
  throw new CliError(EXIT.failed, [
    `delorun: the profile ${profile} was not started, because what it would load is not what Changes keeps for it:`,
    ...broken.map(line => `  ${printable(line)}`),
  ].join('\n'))
}

/** The profile a start booted, and where a failure to record it is logged. */
export interface ChangesBootRequest {
  /** The Delo home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** The home process's logger. */
  readonly logger: DeloLogger
}

/**
 * Record which plugins under Changes loaded at this start, for `delorun doctor`. The record is a help for that report,
 * so a failure to write it is logged as a warning and the start goes on.
 * @param request - the home, the profile and the logger.
 * @param rows - the Loader's rows after startup settled; empty when the profile did not boot.
 * @param failure - what the profile's boot failed with, when it failed.
 */
export async function recordChangesBoot(request: ChangesBootRequest, rows: readonly BootRow[], failure?: unknown): Promise<void> {
  const { home, profile, logger } = request
  try {
    await writeBootRecord({ home, profile, profileDir: profileDirectory(home, profile), rows, ...failure === undefined ? {} : { failure: failure instanceof Error ? failure.message : String(failure) } })
  } catch (error) {
    logger.warn(`Changes could not record which plugins loaded at this start: ${isChangesError(error) ? error.detail : String(error)}`)
  }
}

/**
 * Follow work sessions in the booted Host until Delo stops ([work watch](./work-watch.ts)), and while protection is off,
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
      if (ended !== undefined) logger.info(`Your work session on ${ended.plugin} ended as Delo stopped. ${workFinishedLine(ended)}`)
    } catch (error) {
      logger.warn(`Delo could not end your work session as it stopped; the next start ends it: ${isChangesError(error) ? error.detail : String(error)}`)
    }
  }
}
