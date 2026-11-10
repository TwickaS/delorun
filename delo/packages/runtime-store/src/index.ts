/**
 * Contract C1's runtime store, with contract C2's start check: installed runtime closures under
 * `~/.delo/runtimes/<version>/`, the `current` and `previous` pointers replaced by atomic rename under
 * `store.lock`, retention of the two versions they name, and the check of every installed file against its signed
 * file list before a launch.
 *
 * @module @delo/runtime-store
 */
export { isStoreError, RuntimeStoreError, type RuntimeRemedy, type RuntimeStoreErrorCode, type StoreLayoutCode } from './errors.ts'
export { launchFiles, launchProtocolOf, SUPPORTED, type LaunchCommand, type LauncherSupport } from './launch.ts'
export { parseRuntimeVersion, StorePaths } from './paths.ts'
export type { RuntimePointers } from './pointer.ts'
export { readStoredRoot, type ReleaseFileBytes, type VerifiedRelease } from './release.ts'
export {
  HomeRuntimeStore,
  type ChannelRelease,
  type HomeCommand,
  type HomeCommandMode,
  type HomeRuntimeStoreOptions,
  type PreparePhase,
  type PreparedRuntime,
  type ReportedHealth,
  type RuntimeChannel,
  type UpdateReport,
  type UpdateReporter,
} from './seam.ts'
export { RuntimeStore, type InstallRequest, type LaunchPlan, type LaunchRequest, type RetentionResult, type RuntimeStoreOptions, type VerifiedRuntime } from './store.ts'
export type { TreeProblem } from './tree.ts'
