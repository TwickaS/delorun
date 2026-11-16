/**
 * Setup export and import: reading a profile's setup for an archive, planning what importing one would change, and
 * applying it through Changes' plugin-request paths.
 *
 * @module @delorun/changes/setup-transfer
 */
export { applySetupImport, BEFORE_IMPORT_VERSION_NAME, type SetupApplied, type SetupApplyOptions } from './apply.ts'
export { collectSetup, SETUP_MAX_PLUGIN_BYTES, type SetupExport } from './collect.ts'
export { planSetupImport, type PatchPlan, type PluginInstall, type SetupPlan } from './plan.ts'
export { CARRIED_ROW_IDS, entryClass, entryLabel, isProductPackage, judgeEntry, type EntryVerdict } from './policy.ts'
