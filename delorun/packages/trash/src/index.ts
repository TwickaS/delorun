/**
 * Delorun's trash (C8): the trash store, the delete, restore and purge service,
 * the purge effects over the stores the contract names, and the 30-day
 * retention.
 *
 * @module @delorun/trash
 */
export {
  attachmentObjectPath,
  attachmentPaths,
  encodeSegment,
  isSessionGenerationFilename,
  projectKey,
  sessionDirectoryPath,
  spillSessionDirectoryPath,
} from './paths.ts'
export {
  TrashError,
  TrashStore,
  DAY_MS,
  isSafeOrigin,
  contentName,
  moveDirectory,
  pathExists,
  TRASH_ITEM_SCHEMA_VERSION,
  type DamagedItem,
  type DeleteChatInput,
  type DeleteWorkspaceInput,
  type TrashedChat,
  type TrashedRegistration,
  type TrashItem,
  type TrashItemKind,
} from './store.ts'
export {
  PROJECTION_CACHE_UNIT,
  removeAttachments,
  removeProjectionCache,
  removeSessionDirectory,
  removeSpill,
  removeStrayGenerations,
  type SessionIndexPurge,
} from './effects.ts'
export { removeDraftEntries, type DraftStorage } from './drafts.ts'
export { MAX_GENERATION_BYTES, attachmentDigests, directoryDigests, generationFiles, generationVersion, readGeneration, treeDigests } from './session-text.ts'
export { SESSION_LOCK_FILENAME, takeSessionLock, type HeldSessionLock } from './lease.ts'
export {
  PURGE_RESIDUE_NOTICE,
  RETENTION_MAX_GAP_DAYS,
  RETENTION_RECORD,
  TrashService,
  type RetentionOutcome,
  type RetentionPause,
  type PurgeReport,
  type ProjectionCachePurge,
  type PurgeStore,
  type TrashServiceConfig,
  type TrashStores,
} from './service.ts'
