/**
 * Contract C1's home, the one implementation every Delo component uses:
 * resolving the Delo home, creating its tree at the contract's modes, reading
 * and writing protected files, the per-profile home lock, the per-start token
 * and the listener of the two channels that check it.
 *
 * @module @delo/home
 */
export { HomeLayoutError } from './errors.ts'
export { resolveDeloHome, type DeloHome } from './resolve.ts'
export { checkPrivateDirectory, checkPrivateDirectorySync, ensureHomeTree, runDirectory } from './tree.ts'
export { checkProtectedFile, checkProtectedFileSync, readProtectedFile, writeProtectedFile } from './protected-file.ts'
export { acquireHomeLock, adoptHomeLock, newStartId, processExists, readHomeLock, removeStaleLock, type AcquireOptions, type HolderAnswer, type HolderProbe, type HomeLock } from './lock.ts'
export { newStartToken, parseStartToken, readStartTokenFile, removeStartTokenFile, StartTokenCheck, startTokenFile, writeNewStartToken } from './start-token.ts'
export { authenticateLine, listenTokenSocket, type ChannelLimits, type ChannelLogDetails, type ChannelLogger, type ChannelRefusal, type ListenerRefusal, type TokenSocket, type TokenSocketOptions } from './token-socket.ts'
