/**
 * The active connection's host id and the host-qualified persisted-key algebra
 * of contract C10 (`delorun/docs/contracts/c10-host-qualified-keys.md`).
 *
 * A host id identifies one studio connection to a home's Host process. The
 * studio creates it when the person adds a connection — with upstream's
 * `randomUuid` — and stores it in the studio's connection list in the browser;
 * this module only carries the active connection's id into the persistence
 * layer, where every persisted browser key joins it. A host id never leaves
 * the browser: it does not encode the studio address, a home key, or any other
 * identity, and it is never sent to a home.
 *
 * A host-qualified key is the entry's persist name, a dot, and a scope:
 * `<hostId>` for a host-scope entry, or `<hostId>.<upstreamId>` for an
 * upstream-scoped one, with the session or workspace id exactly as the home
 * issued it. The host id has a fixed length, so a reader splits the key by
 * taking the first 36 characters after the persist name and never parses the
 * upstream id — this module composes keys from parts and never splits them.
 *
 * Until the studio names a host id the composition falls back to the bare
 * persist name (plus the caller's scope), the shape stock entries were written
 * under. Those entries are not migrated: once a host id is named, an entry
 * written without one is simply not read.
 */

/** Canonical form of a host id: a lowercase UUID version 4, 36 characters. */
const HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** The active connection's host id; absent until the studio names one. */
let activeHostId: string | undefined

/**
 * Name the active connection's host id, clearing it with `undefined`.
 *
 * The studio calls this when the active connection changes, passing the host
 * id it generated for that connection and keeps in its connection list. The
 * canonical lowercase UUID version 4 form is enforced fail-loud: a malformed
 * id would silently merge two connections' browser state.
 * @param hostId - the connection's host id, or `undefined` to clear.
 * @throws when the id is not a canonical lowercase UUID version 4.
 */
export function setPersistenceHostId(hostId: string | undefined): void {
  if (hostId !== undefined && !HOST_ID_PATTERN.test(hostId)) {
    throw new Error(`persistence host id must be a canonical lowercase UUID version 4 (got "${hostId}")`)
  }
  activeHostId = hostId
}

/**
 * The active connection's host id, or `undefined` before the studio names one.
 * @returns the current host id.
 */
export function persistenceHostId(): string | undefined {
  return activeHostId
}

/**
 * Join a persist name with its host-qualified scope: `<name>.<hostId>` for a
 * host-scope entry, `<name>.<hostId>.<scopeKey>` when the caller passes an
 * upstream id. Without a host id the bare shape remains, so pre-wiring runs
 * keep writing the stock entries instead of inventing a half-qualified one.
 * @param persistName - the entry's persist name from the inventory.
 * @param scopeKey - the session or workspace scope the caller scopes by.
 * @returns the storage key to read, write, or remove.
 */
export function qualifiedPersistKey(persistName: string, scopeKey?: string): string {
  if (activeHostId === undefined) {
    return scopeKey === undefined ? persistName : `${persistName}.${scopeKey}`
  }
  return scopeKey === undefined
    ? `${persistName}.${activeHostId}`
    : `${persistName}.${activeHostId}.${scopeKey}`
}
