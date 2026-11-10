/**
 * What `delorun` prints when a command fails: `@delo/home`'s refusal format, the one the npm launcher shares. This
 * module composes the describer each package exports next to its errors, and describes the error classes of the
 * packages that do not depend on `@delo/home` (`@delo/profile-safety`, `@delo/update`, `@delo/trash`,
 * `@delo/bundle-local` and `@delo/release-formats`) and of `delorun` itself. Every refusal passes `@delo/logs`'s redactor
 * before it is printed; [last-resort](./last-resort.ts) reports a failure no command caught in the same format.
 *
 * @module @delo/cli/refusals
 */
import { archiveDescriber, dshImportDescriber } from '@delo/archive'
import { UpdatePendingError } from '@delo/bundle-local/update-gate'
import { codedReason, describeFailure, homeLayoutDescriber, profileOption, refusalDescriber, renderRefusal, type Refusal, type RefusalContext, type RefusalDescriber, type TextRedactor } from '@delo/home'
import { HomeProcessError, homeProcessDescriber, HostNotStoppedError, hostStopFailure, openedHomeLog } from '@delo/home-process'
import { installDescriber } from '@delo/install'
import { logsDescriber, Redactor } from '@delo/logs'
import { ProfileSafetyError, type ProfileSafetyRemedy } from '@delo/profile-safety'
import { LogVerificationError } from '@delo/release-formats/log/bundle'
import { TileError } from '@delo/release-formats/log/tiles'
import { VerificationError } from '@delo/release-formats/sign/verify'
import { RELEASE_VERIFY_DESCRIBERS } from '@delo/release-verify/refusal'
import { runtimeStoreDescriber } from '@delo/runtime-store'
import { engineDescriber, supervisorDescriber } from '@delo/supervisor'
import { TrashError } from '@delo/trash'
import { DataSafetyError, UpdateReportError } from '@delo/update'
import { CliError, EXIT, type ExitCode } from './exit.ts'
import { DataInUseError } from './home-exclusion.ts'
import { SetupCancelled } from './setup/prompts.ts'
import { BundleReadError } from './update/bundle-layers.ts'
import { DeloVersionError } from './version.ts'

/**
 * A profile-safety remedy as the person reads it.
 * @param remedy - the remedy.
 * @param context - the profile a remedy's command names.
 * @returns the sentence.
 */
function profileSafetyRemedy(remedy: ProfileSafetyRemedy, context: RefusalContext): string {
  const profile = profileOption(context)
  switch (remedy) {
    case 'skip-update':
      return 'Do not take this update.'
    case 'keep':
      return 'Keep what the message names in place and wait for a release that carries it.'
    case 'update-plugin':
      return 'Update the plugin to a version the new release runs.'
    case 'keep-disabled':
      return 'Keep the plugin disabled.'
    case 'eject':
      return 'Eject the plugin, which keeps its rows and configuration in the profile.'
    case 'restore':
      return `Restore a profile history version: delorun recover restore <version>${profile}`
    case 'rollback':
      return `Switch back to the previous release: delorun recover rollback${profile}`
    case 'safe-mode':
      return `Start in safe mode: delorun recover safe-mode${profile}`
    case 'repair-profile':
      return 'Repair the profile file the message names, then run the same command again.'
  }
}

/** How a {@link ProfileSafetyError} reads: whether the profile was left as it was, the code and detail, and its remedies. */
const profileSafetyDescriber = refusalDescriber(ProfileSafetyError, (error, context) => ({
  lead: error.refused ? 'Delo refused the change and left the profile as it was.' : 'Delo could not write the profile snapshot it takes before a change.',
  reason: codedReason(error.code, error.detail),
  remedies: error.remedies.map(remedy => profileSafetyRemedy(remedy, context)),
}))

/**
 * The refusal of a session-data copy, restore or rollback.
 * @param error - the refusal.
 * @param context - the profile a remedy's command names.
 * @returns the refusal; the codes the home process also raises read as its refusals.
 */
function dataSafetyRefusal(error: DataSafetyError, context: RefusalContext): Refusal {
  const recoverStatus = `See where the profile stands: delorun recover status${profileOption(context)}`
  const reason = codedReason(error.code, error.detail)
  switch (error.code) {
    case 'DATA_COPY_NO_SPACE':
    case 'ROLLBACK_NEEDS_DATA_COPY':
      return homeProcessDescriber.describe(new HomeProcessError(error.code, error.detail), context)
    case 'DATA_RESTORE_INCONSISTENT':
      return { lead: 'Delo did not restore the chat data: the restore\'s journal or directories are not in a state a restore leaves.', reason, remedies: [recoverStatus] }
    case 'NOT_KEPT_DATA':
      return { lead: 'Delo did not remove that path: it is not a copy or set-aside directory of this home.', reason, remedies: [`See what Delo keeps: delorun recover status${profileOption(context)}`] }
    case 'DATA_NOT_A_DIRECTORY':
      return { lead: 'Delo did not copy the chat data: sessions/ or storages/ is a symbolic link or not a directory.', reason, remedies: [] }
    case 'DATA_IN_USE':
      return { lead: 'Delo did not remove or replace the copy: a restore or rollback runs, or an update record refers to it.', reason, remedies: [recoverStatus] }
  }
}

/**
 * What Delo did when the pre-update report was refused.
 * @param error - the refusal.
 * @returns the refusal.
 */
function updateReportRefusal(error: UpdateReportError): Refusal {
  const reason = codedReason(error.code, error.detail)
  switch (error.code) {
    case 'REPORT_TARGET_UNVERIFIED':
      return { lead: 'Delo made no update report: the release did not verify.', reason, remedies: ['See every check: delorun verify'] }
    case 'REPORT_VERSION_INVALID':
      return { lead: 'Delo made no update report: the version is not a semantic version.', reason, remedies: [] }
    case 'REPORT_DISPOSED':
      return { lead: 'Delo stopped before the update report was ready.', reason, remedies: [] }
  }
}

/**
 * The describers of every typed error a `delorun` command can raise, its own and those of the packages it runs.
 * Subclasses come before their base classes; no class here extends another.
 */
export const CLI_DESCRIBERS: readonly RefusalDescriber[] = [
  refusalDescriber(CliError, error => ({ lead: error.message, remedies: [] })),
  refusalDescriber(SetupCancelled, error => ({ lead: error.message, remedies: [] })),
  refusalDescriber(DeloVersionError, error => ({ lead: 'Delo could not read its own version.', reason: error.message, remedies: [] })),
  refusalDescriber(DataInUseError, error => ({ lead: 'Delo did not go ahead: another process uses the chat data.', reason: error.detail, remedies: ['Wait for it to end, then run the same command again.'] })),
  refusalDescriber(BundleReadError, error => ({ lead: `Delo could not read the metadata of the bundle ${error.bundle}.`, reason: codedReason(error.code, error.detail), remedies: [] })),
  refusalDescriber(HostNotStoppedError, (error, context) => {
    // The refusal reads as it would alone, and the teardown that did not finish joins its reason.
    const refusal = describeFailure(error.cause, CLI_DESCRIBERS, context)
    const teardown = `the refused Host ${hostStopFailure(error.outcome)} and may still run, so this process ends without rolling anything back or starting again`
    return { ...refusal, reason: refusal.reason === undefined ? teardown : `${refusal.reason}; ${teardown}` }
  }),
  homeLayoutDescriber,
  homeProcessDescriber,
  runtimeStoreDescriber,
  installDescriber,
  logsDescriber,
  archiveDescriber,
  dshImportDescriber,
  supervisorDescriber,
  engineDescriber,
  ...RELEASE_VERIFY_DESCRIBERS,
  profileSafetyDescriber,
  refusalDescriber(DataSafetyError, dataSafetyRefusal),
  refusalDescriber(UpdateReportError, updateReportRefusal),
  refusalDescriber(TrashError, (error, context) => ({
    lead: 'Delo did not change the trash.',
    reason: codedReason(error.code, error.message),
    remedies: error.code === 'TRASH_ITEM_NOT_FOUND' ? [`See what the trash holds: delorun trash list${profileOption(context)}`] : [],
  })),
  refusalDescriber(UpdatePendingError, error => ({ lead: 'Delo started no new turn: an update is waiting for running chats.', reason: error.message, remedies: ['Send it again once Delo is back.'] })),
  refusalDescriber(VerificationError, error => ({ lead: 'Delo refused a release file that did not verify.', reason: error.message, remedies: ['See every check: delorun verify'] })),
  refusalDescriber(LogVerificationError, error => ({ lead: 'Delo refused the release: its release-log bundle did not verify.', reason: codedReason(error.failure, error.message), remedies: ['See every check: delorun verify'] })),
  refusalDescriber(TileError, error => ({ lead: 'The release log served a tile that does not hold together.', reason: error.message, remedies: ['Report this if it repeats.'] })),
]

/**
 * The profile the command line names with `--profile <name>` or `--profile=<name>` before any `--`, which a remedy's
 * command repeats.
 * @param argv - the arguments after the script.
 * @returns the name, or `undefined` when the command line names none.
 */
export function namedProfile(argv: readonly string[]): string | undefined {
  for (const [index, argument] of argv.entries()) {
    if (argument === '--') return undefined
    if (argument === '--profile') return argv[index + 1]
    if (argument.startsWith('--profile=')) return argument.slice('--profile='.length)
  }
  return undefined
}

/**
 * What a remedy may name for a command line.
 * @param argv - the arguments after the script.
 * @returns the profile the command line names, when it names one.
 */
export function refusalContext(argv: readonly string[]): RefusalContext {
  const profile = namedProfile(argv)
  return profile === undefined ? {} : { profile }
}

/** The redactor of a `delorun` process that opened no home log: `@delo/logs`'s listed secret forms. */
export const PATTERN_REDACTOR: TextRedactor = new Redactor()

/**
 * The redactor a `delorun` refusal passes: the home log's, which also knows the secrets the home process registered,
 * when this process opened one, and otherwise one with `@delo/logs`'s listed secret forms.
 * @returns the redactor.
 */
export function cliRedactor(): TextRedactor {
  return openedHomeLog()?.homeLog.redactor ?? PATTERN_REDACTOR
}

/**
 * The text and exit code of a failed `delorun` command.
 * @param error - the value the command threw.
 * @param argv - the arguments after the script, for the profile a remedy names.
 * @returns the redacted text for standard error and {@link CliError}'s exit code, or `failed` for any other value.
 */
export function cliRefusal(error: unknown, argv: readonly string[]): { readonly text: string, readonly exit: ExitCode } {
  const refusal = describeFailure(error, CLI_DESCRIBERS, refusalContext(argv))
  return { text: renderRefusal(refusal, cliRedactor()), exit: error instanceof CliError ? error.exit : EXIT.failed }
}
