/**
 * Delo's install path: one implementation of contract C1's download rule, contract C2's client verification steps 1
 * to 5, contract C18's bundle and online log check, and the extraction of a verified runtime archive into the runtime
 * store's staging directory. The npm launcher ([`delo/apps/npm-launcher`](../../npm-launcher/README.md)) is its
 * caller; the store's install publishes what this package prepares.
 *
 * @module @delo/install
 */
export { bundleFileName, LauncherChannel, RELEASE_SOURCE, type LauncherChannelOptions, type ReleaseSource } from './channel.ts'
export { Downloader, RELEASE_HOSTS, RELEASE_TIMINGS, type Downloaded, type DownloaderOptions, type DownloadTimings, type ReleaseHosts } from './download.ts'
export { InstallError, isInstallError, messageOf, type InstallErrorCode, type InstallLayoutCode } from './errors.ts'
export { extractArchive, extractionPath, type ExtractRequest } from './extract.ts'
export { CHECKPOINT_MAX_BYTES, createTilesLogService, requireVerifiedLog, runOnlineCheck, type LogService, type OnlineCheckRequest, type OnlineCheckResult, type TilesLogOptions } from './log.ts'
export {
  readStoredCheckpoint,
  readStoredRootBytes,
  readStoredTimestamp,
  trustFile,
  writeStoredCheckpoint,
  writeStoredTimestamp,
  writeTrustedRoot,
  type StoredCheckpoint,
  type StoredTimestamp,
} from './state.ts'
export {
  newestRootVersion,
  rootVersionOf,
  verifyChannelRelease,
  verifyDownloadedFile,
  verifyPlatformFiles,
  verifyStoredRoot,
  verifyTimestampUnderRoots,
  type FileListRequest,
  type ReleaseRequest,
  type RootAndTimestamp,
  type StoredRootRequest,
  type TimestampRequest,
  type VerifiedChannelRelease,
} from './verify.ts'
