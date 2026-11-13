/**
 * How a {@link RuntimeStoreError} reads in `@delo/home`'s refusal format: what the store did, the code and detail, and
 * the store's own remedies as `delorun` commands for the profile.
 *
 * @module @delo/runtime-store/refusal
 */
import { codedReason, profileOption, refusalDescriber, type RefusalContext, type RefusalDescriber } from '@delo/home'
import { RuntimeStoreError } from './errors.ts'

/**
 * The remedies a runtime-store refusal carries, from the store's own list.
 * @param error - the store error.
 * @param context - the profile a remedy's command names.
 * @returns the remedies, in the order the store offers them.
 */
export function storeRemedies(error: RuntimeStoreError, context: RefusalContext): readonly string[] {
  const profile = profileOption(context)
  return error.remedies.map((remedy) => {
    switch (remedy) {
      case 'reinstall':
        return `Install the release again: delorun update${profile}`
      case 'rollback':
        return `Go back to the version before the last update: delorun recover rollback${profile}`
      case 'update':
        return `Update the runtime: delorun update${profile}`
      case 'launcher-update':
        return 'Update the launcher to a version that reads this runtime.'
    }
  })
}

/**
 * What the store did, for one failure.
 * @param error - the failure.
 * @returns the lead sentence.
 */
function storeLead(error: RuntimeStoreError): string {
  switch (error.code) {
    case 'RUNTIME_CHANGED':
    case 'RUNTIME_INCOMPATIBLE':
    case 'ROOT_NOT_ANCHORED':
      return 'Delorun did not start the installed runtime.'
    case 'NO_ACTIVE_RUNTIME':
      return 'Delo found no installed runtime to start.'
    case 'STORE_BUSY':
      return 'Another Delo command is changing the installed runtimes.'
    case 'POINTER_REPLACE_FAILED':
    case 'POINTER_CHANGED':
    case 'NOT_INSTALLED':
    case 'NO_PREVIOUS':
      return 'Delo did not change which runtime is active.'
    case 'INSTALL_VERIFY_FAILED':
      return 'Delo refused the release it downloaded.'
    case 'TARGET_LOWER':
      return 'Delo did not update to a lower version.'
  }
}

/** How a {@link RuntimeStoreError} reads: what the store did, its code and detail, and {@link storeRemedies}. */
export const runtimeStoreDescriber: RefusalDescriber<RuntimeStoreError> = refusalDescriber(RuntimeStoreError, (error, context) => ({
  lead: storeLead(error),
  reason: codedReason(error.code, error.detail),
  remedies: storeRemedies(error, context),
}))
