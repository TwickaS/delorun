/**
 * `@delorun/profile-safety`: contract C3's undo, restore, safe mode and `delorun recover`, and the check that keeps an
 * update from dropping what the person added to their profile.
 *
 * A profile belongs to the person, and an update belongs to Delorun. This package holds the line between them: before an
 * update changes anything, {@link planCarry} compares the profile the person left with the profile the target release
 * would leave, and {@link assertCarriable} refuses when the target would lose a row, a local plugin or a setting the
 * person added, reorder or rewrite their bundle list, or put back a plugin they ejected — unless an update-report item
 * names the change, in which case the person sees it and confirms it. {@link recordSnapshot} writes the history version
 * the update must be able to go back to, over an extension of upstream's file list that holds the Delorun axis's
 * exemptions, Delorun's own record of ejections and disabled plugins, a copy of the home patch and the report itself.
 * {@link planRestore} lists the plugins, build decisions and exemptions an undo or restore changes before anything is
 * written, and brings revoked plugin versions back disabled with their reason; {@link ejectPlugin} takes a plugin out
 * while keeping every row and setting the person wrote for it; safe mode starts the home without third-party plugins
 * and changes no profile file; {@link recover} is `delorun recover`. {@link secretFieldAdmission} keeps a value for a
 * plugin's secret-role field out of every history version (contract C1).
 *
 * @module @delorun/profile-safety
 */

export {
  isProfileSafetyError,
  ProfileSafetyError,
  type ProfileSafetyCode,
  type ProfileSafetyRemedy,
  type RefusedSubject,
} from './errors.ts'

export {
  assertCarriable,
  planCarry,
  type CarryChange,
  type CarryEffect,
  type CarryKind,
  type CarryOptions,
  type CarryPlan,
  type CarryRefusal,
} from './carry.ts'

export {
  bundleListOf,
  dependenciesOf,
  isLocalSpec,
  readInventory,
  type InventoryOptions,
  type PatchLayer,
  type PersonConfiguration,
  type PersonPlugin,
  type PersonRow,
  type ProfileInventory,
} from './inventory.ts'

export {
  DELORUN_COMPATIBILITY_FILENAME,
  HOME_PATCH_COPY_FILENAME,
  HOME_PATCH_FILENAME,
  isTrackedFile,
  PROFILE_MANIFEST_FILENAME,
  PROFILE_PATCH_FILENAME,
  DELORUN_STATE_FILES,
  PROFILE_SAFETY_FILES,
  PROFILE_WORKSPACE_FILENAME,
  SAFETY_RECORD_FILENAME,
  SAFETY_RECORD_SCHEMA,
  UPDATE_REPORT_FILENAME,
} from './files.ts'

export {
  EMPTY_SAFETY_RECORD,
  readSafetyRecord,
  withDisabled,
  withEjection,
  withUpdate,
  writeSafetyRecord,
  type DisabledPlugin,
  type EjectedKind,
  type EjectedPlugin,
  type LastUpdate,
  type SafetyRecord,
} from './record.ts'

export {
  mirrorHomePatch,
  ProfileHomePatch,
  readHomePatch,
  readHomePatchCopy,
  restoreHomePatchCopy,
  writeHomePatch,
  type HomePatchWhere,
} from './home-patch.ts'

export {
  applyRestore,
  currentFiles,
  HISTORY_TIMEOUT_MS,
  latestVersion,
  MANAGER_FILES,
  historyGitProblem,
  openHistory,
  planRestore,
  PROFILE_LOCK_WAIT_MS,
  recordSnapshot,
  rollbackToSnapshot,
  withProfileLock,
  type HistoryOptions,
  type RestorePlan,
  type RestoreRequest,
  type RevokedPlugin,
  type SnapshotRequest,
} from './snapshot.ts'

export {
  enterSafeMode,
  exitSafeMode,
  readSafeMode,
  SAFE_MODE_FILENAME,
  SAFE_MODE_SCHEMA,
  safeModePath,
  startInSafeMode,
  type SafeModeMarker,
  type SafeModeStart,
  type SafeModeStartOptions,
} from './safe-mode.ts'

export { DELORUN_BUNDLE, ejectPlugin, type EjectRequest, type EjectResult } from './eject.ts'

export {
  describeSecretField,
  describeSecretValues,
  expressionOf,
  findSecretValues,
  secretFieldAdmission,
  secretFieldRemedy,
  secretFieldsSet,
  secretValuesInPatch,
  secretValuesInVersion,
  type ConfigSchemasOf,
  type PatchRowIdentity,
  type SecretField,
  type SecretReference,
  type SecretValueFound,
  type SecretValuePlace,
} from './secrets.ts'

export { recover, recoverTarget, type RecoverAction, type RecoverReport, type RecoverRequest, type RecoverVersion } from './recover.ts'

export {
  listProfileVersions,
  MAX_LISTED_VERSIONS,
  MAX_VERSION_NAME,
  originOf,
  saveProfileVersion,
  SAVED_SUMMARY,
  savedSummary,
  switchToVersion,
  SWITCH_SUMMARY_PREFIX,
  UPDATE_SUMMARY_PREFIX,
  type ProfileVersionList,
  type ProfileVersionView,
  type SaveVersionRequest,
  type SwitchVersionRequest,
  type VersionOrigin,
  type VersionsRequest,
} from './versions.ts'
