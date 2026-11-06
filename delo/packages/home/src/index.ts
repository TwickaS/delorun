/**
 * Contract C1's home for the `delorun` command: resolving the Delo home,
 * creating its tree at the contract's modes, protected files and the home lock.
 *
 * @module @delo/cli/home
 */
export { HomeLayoutError } from './errors.ts'
export { resolveDeloHome, type DeloHome } from './resolve.ts'
export { checkPrivateDirectory, ensureHomeTree, runDirectory } from './tree.ts'
export { checkProtectedFile, readProtectedFile, writeProtectedFile } from './protected-file.ts'
export { acquireHomeLock, processExists, readHomeLock, type AcquireOptions, type HolderAnswer, type HolderProbe, type HomeLock } from './lock.ts'
