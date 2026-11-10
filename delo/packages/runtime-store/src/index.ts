/**
 * Contract C1's runtime store, with contract C2's start check: installed runtime closures under
 * `~/.delo/runtimes/<version>/`, the `current` and `previous` pointers replaced by atomic rename under
 * `store.lock`, retention of the two versions they name, and the check of every installed file against its signed
 * file list before a launch, by its recorded identity or by its hash.
 *
 * @module @delo/runtime-store
 */
export { isStoreError, RuntimeStoreError, type RuntimeRemedy, type RuntimeStoreErrorCode, type StoreLayoutCode } from './errors.ts'
export { installedFileMode } from './files.ts'
export { identityOf } from './identity.ts'
export { runtimeStoreDescriber, storeRemedies } from './refusal.ts'
export { launchFiles, launchProtocolOf, SUPPORTED, type LaunchCommand, type LauncherSupport } from './launch.ts'
export { parseRuntimeVersion, StorePaths } from './paths.ts'
export type { RuntimePointers } from './pointer.ts'
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
  type UpdateReleaseChannel,
  type UpdateReport,
  type UpdateReporter,
} from './seam.ts'
export { resolveFullCheckDays, RuntimeStore, type FilledRelease, type InstallRequest, type LaunchPlan, type LaunchRequest, type RetentionResult, type RuntimeStoreOptions, type StagedFiles, type VerifiedRuntime } from './store.ts'
export type { TreeProblem } from './tree.ts'
