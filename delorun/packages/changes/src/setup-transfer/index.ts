/**
 * Setup export and import: reading a profile's setup for an archive, planning what importing one would change, and
 * applying it through Changes' plugin-request paths.
 *
 * @module @delorun/changes/setup-transfer
 */
export { applySetupImport, BEFORE_IMPORT_VERSION_NAME, type SetupApplied, type SetupApplyOptions } from './apply.ts'
export { collectSetup, exportablePlugins, SETUP_MAX_PLUGIN_BYTES, type CollectOptions, type ExportablePlugin, type SetupExport } from './collect.ts'
export { DEFAULT_IMPORT_OPTIONS, planSetupImport, type EndpointItem, type EndpointNotice, type ImportOptions, type KeyItem, type PatchPlan, type PluginInstall, type PluginWas, type ReplaceCode, type SettingChange, type SetupPlan } from './plan.ts'
export { CARRIED_ROW_IDS, entryClass, entryLabel, isModelEntry, isProductPackage, judgeEntry, MODEL_ROW_IDS, type EntryVerdict, type LeftOutCode, type LeftOutItem } from './policy.ts'
export { discardImportReviews, recordImportReviews } from './import-reviews.ts'
export { composedRowIds } from './composed-ids.ts'
