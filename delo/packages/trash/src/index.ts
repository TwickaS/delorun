/**
 * Delo's trash (C8): the trash store, the delete, restore and purge service,
 * the purge effects over the stores the contract names, and the 30-day
 * retention.
 *
 * @module @delo/trash
 */
export {
  attachmentObjectPath,
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
  TRASH_ITEM_SCHEMA_VERSION,
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
export { SESSION_LOCK_FILENAME, takeSessionLock, type HeldSessionLock } from './lease.ts'
export {
  PURGE_RESIDUE_NOTICE,
  TrashService,
  type PurgeReport,
  type ProjectionCachePurge,
  type PurgeStore,
  type TrashServiceConfig,
  type TrashStores,
} from './service.ts'
