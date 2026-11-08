/**
 * The launcher npm serves as `delorun`: the run flow that starts the installed runtime or installs the release the
 * channel names first, the refusals it prints with their remedies, the root files it ships, and the entry point.
 *
 * @module @delo/npm-launcher
 */
export { LAUNCHER_EXIT, installRemedies, refusalFor, storeRemedies, type LauncherExit, type Refusal, type RemedyContext } from './refusals.ts'
export { launcherProfile, runLauncher, type LauncherOptions, type LauncherOutput, type LauncherStore, type SpawnRuntime } from './launcher.ts'
export { platformOf, RELEASE_LOG_TILES_ORIGIN } from './platform.ts'
export { readEmbeddedRoots, ROOTS_DIRECTORY } from './root.ts'
export { LAUNCHER_MODE, PROFILE_FLAG, RELEASE_FLAG, parseCommandLine, spawnRuntime, usage, type LauncherCommandLine } from './bin.ts'
