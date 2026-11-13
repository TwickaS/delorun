/**
 * How an {@link InstallError} reads in `@delo/home`'s refusal format: what the install did, the code and detail, and
 * the remedies: the same command again when the cause may pass, and a newer launcher from npx when nothing
 * can be verified.
 *
 * @module @delo/install/refusal
 */
import { codedReason, refusalDescriber, type RefusalDescriber } from '@delo/home'
import { InstallError, type InstallErrorCode } from './errors.ts'

/**
 * The remedies an install refusal carries.
 * @param code - the install failure's code.
 * @returns the remedies, in the order to offer them.
 */
export function installRemedies(code: InstallErrorCode): readonly string[] {
  switch (code) {
    case 'DOWNLOAD_FAILED':
      return ['Check this computer\'s connection, then run the same command again.']
    case 'NO_TRUSTED_ROOT':
      return ['Run npx delorun@latest, which ships the current release roots.']
    case 'TRUST_STATE_INVALID':
      return ['Move the file named above out of the way and run the same command again; Delo stores it again from the release it verifies.']
    case 'RELEASE_NOT_OFFERED':
      return ['Name the release your channel publishes, or run the same command without a release to install the current one.']
    case 'PLATFORM_NOT_RELEASED':
      return ['Run Delo on a computer whose platform this release lists, or wait for a release that includes this platform.']
    case 'DOWNLOAD_REFUSED':
    case 'INSTALL_VERIFY_FAILED':
    case 'ARCHIVE_REFUSED':
    case 'RELEASE_LOG_FAILED':
    case 'RELEASE_METADATA_INVALID':
      return ['Run the same command again when the release page names a newer release, and report this if it repeats.']
  }
}

/**
 * What the install did, for one failure.
 * @param error - the failure.
 * @returns the lead sentence.
 */
function installLead(error: InstallError): string {
  switch (error.code) {
    case 'DOWNLOAD_REFUSED':
      return `Delo refused to download ${error.source}.`
    case 'DOWNLOAD_FAILED':
      return `The download of ${error.source} did not finish.`
    case 'INSTALL_VERIFY_FAILED':
      return `Delo refused release ${error.source}, which did not verify. Nothing was installed.`
    case 'ARCHIVE_REFUSED':
      return `Delo refused the runtime archive ${error.source}. Nothing was installed.`
    case 'RELEASE_LOG_FAILED':
      return `Delo refused ${error.source} because its release-log check failed.`
    case 'RELEASE_NOT_OFFERED':
      return 'Delo did not install that release.'
    case 'PLATFORM_NOT_RELEASED':
      return `Release ${error.source} has no runtime for this computer. Nothing was installed.`
    case 'RELEASE_METADATA_INVALID':
      return `Delo could not read the release metadata at ${error.source}. Nothing was installed.`
    case 'TRUST_STATE_INVALID':
      return 'Delo could not read what it stored about verified releases. Nothing was installed.'
    case 'NO_TRUSTED_ROOT':
      return 'This launcher cannot verify any release.'
  }
}

/** How an {@link InstallError} reads: what the install did, its code and detail, and {@link installRemedies}. */
export const installDescriber: RefusalDescriber<InstallError> = refusalDescriber(InstallError, error => ({
  lead: installLead(error),
  reason: codedReason(error.code, error.detail),
  remedies: installRemedies(error.code),
}))
