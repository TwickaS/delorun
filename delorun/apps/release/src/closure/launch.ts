/**
 * The files a runtime closure must hold for the launcher to start it (contract C1, launch protocol 1): the runtime's own
 * Node executable and the `delorun` entry file. The runtime store refuses an installed runtime without them
 * (`RUNTIME_INCOMPATIBLE`), so the build refuses to archive a closure that lacks them instead of publishing a release no
 * launcher can start.
 *
 * @module @delorun/release/closure/launch
 */
import type { RuntimePlatform } from '@delorun/contract-release-manifest'

/**
 * Launch protocol 1's files inside a closure, relative and `/`-separated as the file list names them.
 * @param platform - the closure's platform.
 * @returns the Node executable and the `delorun` entry file.
 */
export function launchProtocolFiles(platform: RuntimePlatform): readonly string[] {
  return [platform === 'win32-x64' ? 'node/node.exe' : 'node/bin/node', 'app/node_modules/@delorun/cli/src/bin.js']
}

/**
 * The launch files a closure lacks.
 * @param paths - the closure's file paths.
 * @param platform - the closure's platform.
 * @returns each launch file not among the paths; empty when the launcher can start the closure.
 */
export function missingLaunchFiles(paths: Iterable<string>, platform: RuntimePlatform): string[] {
  const present = new Set(paths)
  return launchProtocolFiles(platform).filter(path => !present.has(path))
}
