/**
 * The stock-home import of contract C8: a DeepSeek Harness home copied into
 * a Delorun home. {@link planDshHomeImport} reads both homes and writes nothing;
 * {@link applyDshHomeImport} stages, journals and publishes a plan so the Delorun
 * home holds all of it or none of it: the data, and each category the person
 * said yes to; {@link recoverDshImport} withdraws an import a crash
 * interrupted, and {@link recoverStockImport} is its form for the start path.
 * The stock home is only ever read.
 *
 * @module @delorun/archive/dsh-import
 */
export { DSH_IMPORT_ERROR_CODES, DshImportError, isDshImportError, type DshImportErrorCode } from './errors.ts'
export {
  DSH_HOME_ROOT_ENTRIES,
  DSH_IMPORT_SKIP_REASONS,
  DSH_IMPORT_SKIP_SENTENCES,
  PROFILE_CARRIED_FILES,
  attachmentAddress,
  isProfileName,
  isProjectName,
  isSafeSegment,
  isSessionName,
  sessionFileKind,
  type DshImportSkipReason,
} from './layout.ts'
export type { DshHashedFile, DshImportFile } from './source.ts'
export { carryRefusalNotes, isPackageName, isRegistrySpec, landManifest, type DshImportPlugin, type DshImportPluginStatus, type LandedManifest } from './profiles.ts'
export { CARRIED_SETTINGS, HOLD_SENTENCES, isCarriedSetting, splitPatchLayer, splitSettingsLayer, type HeldRow, type HoldReason, type SplitLayer } from './layers.ts'
export { mergeRegistries, parseRegistry, REGISTRY_PATH, sensitiveFolder, type Registry, type SensitiveFolders } from './workspaces.ts'
export { CREDENTIALS_PATH, OFFERED_RECORD_SCOPES, OFFERED_REFERENCES, type DshImportCredential, type DshImportCredentialState } from './credentials.ts'
export {
  CREDENTIALS_DOCUMENT_BYTES,
  DSH_IMPORT_CATEGORIES,
  DSH_IMPORT_LIMITS,
  PARSED_DOCUMENT_BYTES,
  SKIPPED_LIST_LIMIT,
  planDshHomeImport,
  resolveDshImportLimits,
  type DshHomeImportPlan,
  type DshImportCategory,
  type DshImportChat,
  type DshImportCredentials,
  type DshImportInstructions,
  type DshImportLayer,
  type DshImportLimits,
  type DshImportOptions,
  type DshImportProfile,
  type DshImportRegistry,
  type DshImportSkill,
  type DshImportSkip,
  type DshImportState,
  type DshImportText,
  type DshImportWorkspace,
} from './plan.ts'
export {
  STOCK_IMPORT_DIRECTORY,
  STOCK_IMPORT_JOURNAL,
  STOCK_IMPORT_RECORD,
  applyDshHomeImport,
  readDshImportRecord,
  readImportedChats,
  recoverDshImport,
  recoverStockImport,
  type DshHomeImportReport,
  type DshImportApplyOptions,
  type DshImportRecovery,
  type DshImportRecordEntry,
} from './apply.ts'
