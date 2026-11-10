/**
 * What the launcher prints when it stops, and what it offers: one sentence per refusal in contract C1's and C2's
 * terms, naming the release, host or file the refusal concerns, with the remedies the refusal carries. Every message
 * leads with what Delo did, then why, then what the person can do, and none of them claims a check passed.
 *
 * @module @delo/npm-launcher/refusals
 */
import { isInstallError, messageOf, type InstallError, type InstallErrorCode } from '@delo/install'
import { isStoreError, type RuntimeStoreError } from '@delo/runtime-store'

/** The launcher's exit codes. */
export const LAUNCHER_EXIT = {
  /** The runtime ran and ended with its own status. */
  ok: 0,
  /** Delo refused or failed, and nothing ran. */
  failed: 1,
  /** The command line is wrong. */
  usage: 2,
} as const

/** An exit code the launcher returns. */
export type LauncherExit = (typeof LAUNCHER_EXIT)[keyof typeof LAUNCHER_EXIT]

/** A refusal, as the launcher prints it. */
export interface Refusal {
  /** The sentence for standard error, ending with a newline. */
  readonly text: string
  /** The exit code. */
  readonly exit: LauncherExit
  /** What the person can do, in order; empty when the launcher offers nothing. */
  readonly remedies: readonly string[]
}

/** What naming a remedy needs. */
export interface RemedyContext {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
}

/**
 * The remedies an install refusal carries: the person runs the same command again when the cause may pass, and the
 * release page's install script when the launcher itself cannot verify anything.
 * @param code - the install failure's code.
 * @returns the remedies, in the order to offer them.
 */
export function installRemedies(code: InstallErrorCode): readonly string[] {
  switch (code) {
    case 'DOWNLOAD_FAILED':
      return ['Check this computer\'s connection, then run the same command again.']
    case 'NO_TRUSTED_ROOT':
      return ['Install Delo from the install script on its release page.']
    case 'TRUST_STATE_INVALID':
      return ['Move the file named above out of the way and run the same command again; Delo stores it again from the release it verifies.']
    case 'RELEASE_NOT_OFFERED':
      return ['Name the release your channel publishes, or run the same command without a release to install the current one.']
    case 'DOWNLOAD_REFUSED':
    case 'INSTALL_VERIFY_FAILED':
    case 'ARCHIVE_REFUSED':
    case 'RELEASE_LOG_FAILED':
    case 'RELEASE_METADATA_INVALID':
      return ['Run the same command again when the release page names a newer release, and report this if it repeats.']
  }
}

/**
 * The remedies a runtime-store refusal carries, from the store's own list.
 * @param error - the store error.
 * @param context - the home and profile a remedy's command names.
 * @returns the remedies, in the order the store offers them.
 */
export function storeRemedies(error: RuntimeStoreError, context: RemedyContext): readonly string[] {
  const profile = `--profile ${context.profile}`
  return error.remedies.map((remedy) => {
    switch (remedy) {
      case 'reinstall':
        return `Install the release again: delorun update ${profile}`
      case 'rollback':
        return `Go back to the version before the last update: delorun recover rollback ${profile}`
      case 'update':
        return `Update the runtime: delorun update ${profile}`
      case 'launcher-update':
        return 'Update the launcher to a version that reads this runtime.'
    }
  })
}

/**
 * The sentence for an install failure.
 * @param error - the failure.
 * @returns the refusal, with its remedies.
 */
function installRefusal(error: InstallError): Refusal {
  const remedies = installRemedies(error.code)
  const lead = ((): string => {
    switch (error.code) {
      case 'DOWNLOAD_REFUSED':
        return `Delo refused to download ${error.source}: ${error.detail}`
      case 'DOWNLOAD_FAILED':
        return `The download of ${error.source} did not finish: ${error.detail}`
      case 'INSTALL_VERIFY_FAILED':
        return `Delo refused release ${error.source}, which did not verify: ${error.detail}. Nothing was installed.`
      case 'ARCHIVE_REFUSED':
        return `Delo refused the runtime archive ${error.source}: ${error.detail}. Nothing was installed.`
      case 'RELEASE_LOG_FAILED':
        return `Delo refused ${error.source} because its release-log check failed: ${error.detail}`
      case 'RELEASE_NOT_OFFERED':
        return `Delo did not install that release: ${error.detail}`
      case 'RELEASE_METADATA_INVALID':
        return `Delo could not read the release metadata at ${error.source}: ${error.detail}. Nothing was installed.`
      case 'TRUST_STATE_INVALID':
        return `Delo could not read what it stored about verified releases: ${error.detail} Nothing was installed.`
      case 'NO_TRUSTED_ROOT':
        return `This launcher cannot verify any release: ${error.detail}`
    }
  })()
  return { text: `${lead}\n${remedies.map(remedy => `  ${remedy}\n`).join('')}`, exit: LAUNCHER_EXIT.failed, remedies }
}

/**
 * The sentence for a runtime-store refusal.
 * @param error - the refusal.
 * @param context - the home and profile a remedy's command names.
 * @returns the refusal, with its remedies.
 */
function storeRefusal(error: RuntimeStoreError, context: RemedyContext): Refusal {
  const remedies = storeRemedies(error, context)
  const lead = ((): string => {
    switch (error.code) {
      case 'RUNTIME_CHANGED':
        return `Delo did not start the installed runtime: ${error.detail}`
      case 'RUNTIME_INCOMPATIBLE':
        return `Delo did not start the installed runtime: ${error.detail}`
      case 'NO_ACTIVE_RUNTIME':
        return `Delo found no installed runtime to start: ${error.detail}`
      case 'STORE_BUSY':
        return `Another Delo command is changing the installed runtimes: ${error.detail}`
      case 'POINTER_REPLACE_FAILED':
      case 'POINTER_CHANGED':
      case 'NOT_INSTALLED':
      case 'NO_PREVIOUS':
        return `Delo did not change which runtime is active: ${error.detail}`
      case 'INSTALL_VERIFY_FAILED':
        return `Delo refused the release it downloaded: ${error.detail}`
    }
  })()
  return { text: `${lead}\n${remedies.map(remedy => `  ${remedy}`).join('\n')}${remedies.length === 0 ? '' : '\n'}`, exit: LAUNCHER_EXIT.failed, remedies }
}

/**
 * The refusal for anything the launcher caught, which is what it prints before it stops.
 * @param error - the value thrown.
 * @param context - the home and profile a remedy's command names.
 * @returns the refusal; an unrecognised failure is reported with its own message and offers no remedy.
 */
export function refusalFor(error: unknown, context: RemedyContext): Refusal {
  if (isInstallError(error)) return installRefusal(error)
  if (isStoreError(error)) return storeRefusal(error, context)
  return { text: `Delo stopped: ${messageOf(error)}\n`, exit: LAUNCHER_EXIT.failed, remedies: [] }
}
