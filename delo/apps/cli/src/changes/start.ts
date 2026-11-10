/**
 * What a start does for Changes before a profile boots: a fresh start from C1's runtime store first runs the store's
 * start check of the runtime, in every protection setting, and refuses a runtime whose files differ from the signed
 * release; then each plugin the profile links from a folder, other than the harness's own packages, is made to load
 * the content Changes allows ([`@delo/changes`](../../../../packages/changes/src/enforce.ts)), and what the profile
 * leaves out is printed. Both run as the pre-start step `changes` ([pre-start](../pre-start.ts)) of `delorun start` and
 * `delorun headless`. After upstream prepared the profile, the composition's approved plugin content step holds it to
 * every invariant Changes keeps ([compose](../compose.ts)).
 *
 * @module @delo/cli/changes/start
 */
import { resolve } from 'node:path'
import { checkChangesInvariants, enforceApprovedContent, isChangesError, startNotice } from '@delo/changes'
import { RuntimeStoreError } from '@delo/runtime-store'
import type { CompositionDraft } from '../compose.ts'
import { carriedPackageDirectory } from '../delo-bundles.ts'
import { CliError, EXIT } from '../exit.ts'
import type { PreStartContext, StoredRuntime } from '../pre-start.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { printable } from '../terminal-text.ts'

/** The profile a start is about to boot. */
export interface ChangesStartRequest {
  /** The Delo home. */
  readonly home: string
  /** The profile's name. */
  readonly profile: string
  /** Set for a fresh start from the store; absent for an update's successor, whose runtime the update checked. */
  readonly runtime?: StoredRuntime
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
 * Run Changes' part of a start: the stored runtime's check, then the linked plugins' content. A profile without a
 * `package.json` has nothing linked and is left alone.
 * @param request - the home, the profile and, for a fresh start from the store, its runtime check.
 * @param output - where the lines about left-out or unreviewed changes go.
 * @throws {CliError} when the stored runtime's files differ from the signed release, a record of Changes cannot be
 *   read, a folder cannot be stored, or the profile history cannot record the profile's change: the profile does not
 *   boot.
 */
export async function startChanges(request: ChangesStartRequest, output: (text: string) => void): Promise<void> {
  const { home, profile, runtime } = request
  if (runtime !== undefined) {
    try {
      await runtime.check()
    } catch (error) {
      if (!(error instanceof RuntimeStoreError)) throw error
      throw new CliError(EXIT.failed, `delorun: Delo ${runtime.version} was not started, because its files differ from the signed release: ${error.detail}. See what differs with: delorun verify`)
    }
  }
  if (!hasCliProfile(home, profile)) return
  let notice: string
  try {
    notice = startNotice(await enforceApprovedContent({ home, profile, profileDir: profileDirectory(home, profile), harnessLink: isCarriedPackage }))
  } catch (error) {
    const detail = isChangesError(error) ? error.detail : String(error)
    throw new CliError(EXIT.failed, `delorun: the profile ${profile} was not started, because the plugins it links from folders could not be prepared: ${detail}`)
  }
  if (notice !== '') output(notice)
}

/**
 * The pre-start step `changes` ([pre-start](../pre-start.ts)): {@link startChanges} for the profile about to boot, with
 * the stored runtime's check when a fresh start runs from the store. Its lines go to standard output for the CLI
 * profile and to standard error for `delorun headless`, whose standard output carries the task's answer.
 * @param context - the start.
 * @returns when the profile's linked plugins load what Changes allows.
 * @throws {CliError} as {@link startChanges} does.
 */
export function changesPreStartStep(context: PreStartContext): Promise<void> {
  const { home, profile, kind, output, storedRuntime } = context
  return startChanges({ home, profile, ...storedRuntime === undefined ? {} : { runtime: storedRuntime } }, (text) => {
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
