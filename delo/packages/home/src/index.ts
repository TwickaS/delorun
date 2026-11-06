/**
 * Contract C1's home, the one implementation every Delo component uses:
 * resolving the Delo home, creating its tree at the contract's modes, reading
 * and writing protected files, and the per-profile home lock.
 *
 * @module @delo/home
 */
export { HomeLayoutError } from './errors.ts'
export { resolveDeloHome, type DeloHome } from './resolve.ts'
export { checkPrivateDirectory, checkPrivateDirectorySync, ensureHomeTree, runDirectory } from './tree.ts'
export { checkProtectedFile, checkProtectedFileSync, readProtectedFile, writeProtectedFile } from './protected-file.ts'
export { acquireHomeLock, processExists, readHomeLock, removeStaleLock, type AcquireOptions, type HolderAnswer, type HolderProbe, type HomeLock } from './lock.ts'
