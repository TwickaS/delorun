/**
 * Delorun's archive format v1 and its import path (contract C8): the ZIP reader
 * and writer, the path, link, device, size and ratio refusals, the closed
 * customisation schema, the signature state, the staging directory, the atomic
 * publication, and the export with its secrets warning.
 *
 * @module @delorun/archive
 */
export { ArchiveError, isArchiveError } from './errors.ts'
export { archiveDescriber, dshImportDescriber } from './refusal.ts'
export { keyFingerprint } from './fingerprint.ts'
export { hasControlCharacter } from './text.ts'
export { RESERVED_DEVICE_NAMES, checkArchivePath, checkPathCollisions, resolveInside } from './paths.ts'
export {
  ZIP_CENTRAL_HEADER_SIGNATURE,
  ZIP_COMPRESSION_DEFLATE,
  ZIP_COMPRESSION_STORED,
  ZIP_END_SIGNATURE,
  ZIP_FLAG_DATA_DESCRIPTOR,
  ZIP_FLAG_ENCRYPTED,
  ZIP_FLAG_UTF8_NAME,
  ZIP_HOST_UNIX,
  ZIP_LOCAL_HEADER_SIGNATURE,
  ZIP_REGULAR_FILE_MODE,
  ZIP_UNIX_CHARACTER_DEVICE,
  ZIP_UNIX_DIRECTORY,
  ZIP_UNIX_REGULAR_FILE,
  ZIP_UNIX_SYMBOLIC_LINK,
  ZIP_UNIX_TYPE_MASK,
  crc32,
  isPlainFileType,
  unixFileTypeOf,
  unixModeOf,
  type ZipCentralRecord,
} from './zip-format.ts'
export { ZipArchive, type ZipReadLimits } from './zip-read.ts'
export { ZipWriter, type ZipEntryInput } from './zip-write.ts'
export {
  checkContainerDeclarations,
  checkEntrySizes,
  checkManifestDeclarations,
  type ArchiveSizeLimits,
  type DeclaredEntrySize,
} from './limits.ts'
export {
  CUSTOMISATION_PATH,
  MANIFEST_PATH,
  OBJECTS_DIRECTORY,
  SIGNATURE_PATH,
  parseManifest,
} from './manifest.ts'
export { customisationDiff, parseCustomisation, type CustomisationDiffRow } from './customisation.ts'
export {
  archiveOrigin,
  checkArchiveSignature,
  encodePublicKey,
  parseSignature,
  signManifest,
  verifyArchiveSignature,
  type Ed25519KeyPair,
  type SignatureCheck,
  type SignatureCheckInput,
  type SignatureReason,
  type SignatureState,
} from './signature.ts'
export { STAGED_FILE_MODE, STAGING_DIRECTORY_MODE, refuseLinkedDirectory, removeStaging, writeStaging, type StagedEntry } from './staging.ts'
export {
  ArchiveImporter,
  DirectoryWorkspaceStore,
  PUBLISHING_JOURNAL_SUFFIX,
  STAGED_WORKSPACE_DOCUMENT,
  signatureLabel,
  type AcceptedReason,
  type ArchiveImportReport,
  type ArchiveImporterConfig,
  type ArchivePreview,
  type ArchiveSigner,
  type ArchiveWorkspaceStore,
  type PreviewWorkspace,
  type ImportedWorkspace,
  type OpenedSetup,
  type RecoveryReport,
  type StagedWorkspaceDocument,
} from './importer.ts'
export {
  exportArchive,
  findSecrets,
  SECRET_PATTERNS,
  type ArchiveExportInput,
  type ArchiveExportResult,
  type ExportChat,
  type ExportWorkspace,
  type SecretFinding,
  type SecretKind,
} from './exporter.ts'
export { HOME_AUTH_DIRECTORY, homeKeyPath, loadHomeKey, type HomeKey } from './home-key.ts'
export {
  SETUP_DOCUMENT_SCHEMA_VERSION,
  SETUP_MAX_NOTE,
  SETUP_MAX_PATCH_ENTRIES,
  SETUP_MAX_PLUGIN_FILES,
  SETUP_MAX_PLUGINS,
  exportSetupArchive,
  parseSetupDocument,
  type SetupDocument,
  type SetupExportInput,
  type SetupJson,
  type SetupLocalPlugin,
  type SetupPlugin,
  type SetupPluginFile,
  type SetupRegistryPlugin,
} from './setup.ts'
