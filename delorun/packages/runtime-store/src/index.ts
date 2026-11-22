/**
 * Contract C1's runtime store, with contract C2's start check: installed runtime closures under
 * `~/.delorun/runtimes/<version>/`, the `current` and `previous` pointers replaced by atomic rename under
 * `store.lock`, retention of the two versions they name, and the check of every installed file against its signed
 * file list before a launch, by its recorded identity or by its hash.
 *
 * @module @delorun/runtime-store
 */
export { isStoreError, RuntimeStoreError, type RuntimeRemedy, type RuntimeStoreErrorCode, type StoreLayoutCode } from './errors.ts'
export { installedFileMode } from './files.ts'
export { identityOf } from './identity.ts'
export { runtimeStoreDescriber, storeRemedies } from './refusal.ts'
export { launchFiles, launchProtocolOf, SUPPORTED, type LaunchCommand, type LauncherSupport } from './launch.ts'
export { checkInstalledPack, installPack, packProblems, packVariantFor, removePack, signedPackFiles, type PackInstallRequest, type SignedPackFiles } from './packs.ts'
export { installedPacksProblems } from './packs-check.ts'
export { acquirePacks, fetchPack, installFetchedPack, packDownloadSize, openSignedPacks, readStoredPacks, turnOnPack, type FetchedPack, type InstalledRelease, type PacksLogCheck, type PackFiles, type PackSize, type PackTransfer, type SignedPacks } from './packs-client.ts'
export { ensurePacksCurrent, isRunningRelease, requireRunningRelease, PACKS_CURRENT, packsCurrentProblem, pointPacks, pointPacksIfUsed } from './packs-current.ts'
export { carryPacks, repairPacks, type PackCarry } from './packs-carry.ts'
export { createPackFiles, NPM_REGISTRY_HOST, type PackTransportOptions } from './packs-fetch.ts'
export { parseRuntimeVersion, StorePaths } from './paths.ts'
export { readPointerFile, type RuntimePointers } from './pointer.ts'
export { readStoredRelease, type ReleaseFileBytes, type TrustedRootSource, type VerifiedRelease } from './release.ts'
export {
  HomeRuntimeStore,
  type ChannelRelease,
  type HomeCommand,
  type HomeCommandMode,
  type HomeRuntimeStoreOptions,
  type OpenUpdateChannel,
  type PreparePhase,
  type PreparedRuntime,
  type ReportedHealth,
  type RuntimeChannel,
  type UpdateInstallEvent,
  type UpdateReleaseChannel,
  type UpdateReport,
  type UpdateReporter,
} from './seam.ts'
export { parseStartCheckHandoff, START_CHECK_SCHEMA, startCheckHandoffText, type StartCheckHandoff, type StartCheckSummary } from './start-record.ts'
export { FULL_CHECK_DAYS_ENV, resolveFullCheckDays, RuntimeStore, type CheckedRuntime, type FilledRelease, type InstallRequest, type LaunchPlan, type LaunchRequest, type RetentionResult, type RuntimeStoreOptions, type StagedFiles, type VerifiedRuntime } from './store.ts'
export type { TreeProblem } from './tree.ts'
