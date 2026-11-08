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
  type TrashItem,
  type TrashItemKind,
} from './store.ts'
export {
  removeAttachments,
  removeDraftEntries,
  removeSessionDirectory,
  removeSpill,
  removeStrayGenerations,
  type DraftStorage,
  type SessionIndexPurge,
} from './effects.ts'
export {
  PURGE_RESIDUE_NOTICE,
  TrashService,
  type PurgeReport,
  type PurgeStore,
  type TrashServiceConfig,
  type TrashStores,
} from './service.ts'
