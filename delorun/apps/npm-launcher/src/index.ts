/**
 * The launcher npm serves as `delorun`: the run flow that starts the installed runtime or installs the release the
 * channel names first, the lines it prints while it installs, the refusals it prints with their remedies, the root
 * files it ships, and the Node version check of its entry point.
 *
 * @module @delorun/npm-launcher
 */
export { LAUNCHER_DESCRIBERS, LAUNCHER_EXIT, refusalFor, type LauncherExit, type LauncherRefusal, type RemedyContext } from './refusals.ts'
export { launcherProfile, runLauncher, PROFILE_NAME, type LauncherOptions, type LauncherOutput, type LauncherStore, type SpawnRuntime } from './launcher.ts'
export { BUILD_CONSTANTS, channelPlan, hostRefusal, logPlan, platformOf, RELEASE_LOG_API_PREFIX, WSL_GUIDE, type BuildConstants, type ChannelPlan, type LogPlan } from './platform.ts'
export { createRenderer, formatSize, InstallRenderer, type LauncherProgress, type RenderStream } from './progress.ts'
export { MINIMUM_NODE, NODE_ENGINES_RANGE, nodeIsSupported, nodeRefusal } from './node-version.ts'
export { readEmbeddedRoots, ROOTS_DIRECTORY } from './root.ts'
export { LAUNCHER_MODE, launchEnvironment, main, parseCommandLine, PROFILE_FLAG, RELEASE_FLAG, spawnRuntime, TERMINATOR, usage, type LauncherCommandLine } from './bin.ts'
