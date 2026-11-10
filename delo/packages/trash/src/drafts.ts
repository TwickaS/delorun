/**
 * The browser half of contract C8's purge: the item's draft entries in the
 * browser that performs the purge, under every host scope, as the
 * host-qualified keys contract sets. The module imports nothing that needs
 * Node, so the studio's trash screen runs it against the page's own storage.
 *
 * @module @delo/trash/drafts
 */
import { PERSISTED_KEYS } from '@delo/contract-host-qualified-keys'

/** The length of a host id in a host-qualified key: C10's UUID form. */
const HOST_ID_LENGTH = 36

/** The browser draft storage of the studio connection performing the purge. */
export interface DraftStorage {
  /** Every stored key. */
  keys(): readonly string[]
  /**
   * Remove one stored key.
   * @param key - the key to remove.
   */
  remove(key: string): void
}

/**
 * Remove the item's draft entries from the browser's storage, under every host
 * scope. A session- or store-scoped entry is stored as `<name>.<id>` while the
 * page has no host id, and as `<name>.<host id>.<id>` once it has one, where
 * the host id has a fixed length and the upstream id follows it exactly as the
 * home issued it. Every key that names one of the item's ids in either form
 * goes, whichever connection wrote it.
 * @param storage - the browser draft storage.
 * @param sessionIds - the item's chat session ids.
 * @param workspaceIds - the item's workspace ids.
 * @returns the keys removed.
 */
export function removeDraftEntries(
  storage: DraftStorage,
  sessionIds: readonly string[],
  workspaceIds: readonly string[] = [],
): string[] {
  const sessions = new Set(sessionIds)
  const workspaces = new Set(workspaceIds)
  const removed: string[] = []
  for (const entry of PERSISTED_KEYS) {
    if (entry.scope !== 'host-and-session' && entry.scope !== 'host-and-store-scope') continue
    const targets = entry.scope === 'host-and-session' ? sessions : workspaces
    if (targets.size === 0) continue
    const prefix = `${entry.name}.`
    for (const key of storage.keys()) {
      if (!key.startsWith(prefix)) continue
      const scope = key.slice(prefix.length)
      // The host id has a fixed length, so the reader splits after it and the upstream id that follows is never parsed.
      const qualified = scope.length > HOST_ID_LENGTH + 1 && scope[HOST_ID_LENGTH] === '.' && targets.has(scope.slice(HOST_ID_LENGTH + 1))
      if (!qualified && !targets.has(scope)) continue
      storage.remove(key)
      removed.push(key)
    }
  }
  return removed
}
