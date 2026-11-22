/**
 * Delorun's install path: one implementation of contract C1's download rule, contract C2's client verification steps 1
 * to 5, contract C18's bundle and its online log check through `@delorun/release-verify`, and the extraction of a verified runtime archive into the runtime
 * store's staging directory. The npm launcher ([`delorun/apps/npm-launcher`](../../npm-launcher/README.md)) is its
 * caller; the store's install publishes what this package prepares.
 *
 * @module @delorun/install
 */
export { bundleFileName, LauncherChannel, manifestFileName, RELEASE_SOURCE, storedChannelRelease, type LauncherChannelOptions, type NewestRelease, type ReleaseSource, type UnconfirmedInstall, type UnconfirmedQuestion } from './channel.ts'
export { Downloader, RELEASE_HOSTS, RELEASE_TIMINGS, type Downloaded, type DownloaderOptions, type DownloadTimings, type HostRule } from './download.ts'
export { InstallError, isInstallError, messageOf, type InstallErrorCode, type InstallLayoutCode } from './errors.ts'
export { manualSource, newestManifestVersion, type ManualSource } from './manual-source.ts'
export { installDescriber, installRemedies } from './refusal.ts'
export { formatDuration, formatSize, formatSpeed, isInstallerProgress, type InstallerProgress, type InstallProgress } from './progress.ts'
export { createRenderer, InstallRenderer, type Every, type RenderStream, type RendererOptions } from './render.ts'
export { extractArchive, extractionPath, type ExtractRequest } from './extract.ts'
export { readAnchoredRoot, readShippedRoots } from './roots.ts'
export {
  buildOrigin,
  readChannelRecord,
  readStoredRootBytes,
  readStoredRootChain,
  readStoredTimestamp,
  trustFile,
  writeChannelRecord,
  writeStoredRootChain,
  writeStoredTimestamp,
  writeTrustedRoot,
  type ChannelOrigins,
  type StoredTimestamp,
} from './state.ts'
export {
  newestRootVersion,
  rootVersionOf,
  verifyChannelRelease,
  verifyDownloadedFile,
  verifyPlatformFiles,
  verifyStoredRoot,
  trustedChain,
  verifyTimestampUnderRoots,
  verifyUnconfirmedRelease,
  type UnconfirmedReleaseRequest,
  type FileListRequest,
  type ReleaseRequest,
  type RootAndTimestamp,
  type StoredRootRequest,
  type TimestampRequest,
  type VerifiedChannelRelease,
} from './verify.ts'
