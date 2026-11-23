/**
 * Delorun's pre-update report (contract C3, `delorun/docs/contracts/c03-update-report.md`): what an update would change or
 * break in the person's profile before anything changes. The package reads the profile and the staged target — no
 * plugin code — and returns the report's facts: every plugin, bundle and profile row the target would disable, remove
 * or change, each with its reason and whether the prediction rests on metadata Delorun read, both installations' versions
 * and update states, and the counts. It also holds the gate `delorun update --yes` must pass, the sentence each
 * reason states, and the service the runtime store's `prepare` calls.
 *
 * @module @delorun/update
 */
export { confirmationNeeds, confirmsWithoutAsking, type ConfirmationNeeds } from './confirm.ts'
export { compareDataFacts, dataFormatsOf, dataFormatsText, dataItems, DELORUN_RECORDS, parseDataFormats, readDataFormats, type DataComparison, type DataFacts, type ReleaseDataFacts } from './data-formats.ts'
export { DataSafetyError, isDataSafetyError, UpdateReportError, type DataSafetyErrorCode, type UpdateReportErrorCode } from './errors.ts'
export {
  assertCopyFits,
  changedChats,
  COPY_RECORD_FILE,
  COPY_RECORD_SCHEMA,
  DATA_COPIES_DIRECTORY,
  DATA_SET_ASIDE_DIRECTORY,
  discardCopy,
  discardKeptData,
  keepOnlyCopy,
  isRuntimesSetAsideName,
  listKeptData,
  RUNTIMES_SET_ASIDE_PREFIX,
  planDataCopy,
  readCopyRecord,
  recoverDataCopies,
  RESTORE_JOURNAL_FILE,
  RESTORE_JOURNAL_SCHEMA,
  restoreDataCopy,
  runtimesSetAsideName,
  saveDataCopy,
  type CopyRecord,
  type DiscardGuard,
  type KeptData,
  type RestoreResult,
  type SaveRequest,
} from './data-copy.ts'
export { decideRollback, ROLLING_BACK_PHASE, rollbackUpdate, type RollbackDecision, type RollbackRequest, type RollbackResult, type UpdateRecordFacts } from './rollback.ts'
export { harnessItems, type HarnessFact } from './harness-items.ts'
export { type BundleFacts, type IncludeFact, type InstallationStatusFacts, type LayerFact, type ProfileFacts, type ReleaseChecks, type ReportInput, type RevokedPluginVersion, type RowFact, type RowSettingsFact, type SkippedBundleFact, type TargetFacts } from './facts.ts'
export { canonicalJson, previousConfigsOf, protectedPluginsOfLayers, releaseSettingChanges, rowSettingsFact, settingsItems, type RowSettingsChange } from './row-settings.ts'
export { bundleItems, bundleRowItems, pluginItems, predictBundleList, rowItems, versionOf, type DisabledPlugin, type PluginItems } from './items.ts'
export { readInstalledPlugin, type InstalledPluginFact } from './manifest.ts'
export { dataCopyNote, exemptionNote, reasonMessage, settingsNote, uncheckedMessage, UNVERIFIED_NOTE, type MessageVersions } from './messages.ts'
export { buildUpdateReport, countItems, disabledPluginNames, sortItems } from './report.ts'
export { buildFromSources, builtReport, readReportInput, UpdateReportService, type BuiltUpdateReport, type ReportHealth, type ReportPurpose, type ReportSources, type UpdateReportOptions } from './service.ts'
export { decidePluginVersion, evaluatePluginAxes, exempted, exemptionKey, requirementText, satisfiesRange, type AxisDecision, type AxisVersions, type DecidedBy, type PluginVersionDecision } from './versions.ts'
export { parseHomeDataFormat, readHomeDataFormat, recordHomeDataFormat, relateHomeData, writeHomeDataFormat, type HomeDataRelation, type RecordOutcome, type ReleaseHomeFacts } from './home-data-format.ts'
