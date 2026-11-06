/**
 * Host ids, host-qualified key forms and the inventory of persisted browser keys of
 * the studio, as specified by `delo/docs/contracts/c10-host-qualified-keys.md`. This
 * module holds readonly constants and types only.
 *
 * @module @delo/contract-host-qualified-keys
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Length, in characters, of a host id in its canonical UUID form. */
export const HOST_ID_LENGTH = 36 as const

/** Separator between a host id and an upstream id in an upstream-scoped key. */
export const HOST_KEY_SEPARATOR = '.' as const

/**
 * The studio's identifier of one connection to a home's Host process. Generated in
 * the browser and never sent to a home.
 */
export type HostId = Branded<'HostId'>

/** Scope of a host-qualified key: the host alone, or the host and one upstream id, unchanged. */
export interface HostQualifiedScope {
  readonly hostId: HostId
  /** Session or workspace id as the home issued it. Absent for the host scope. */
  readonly upstreamId?: string
}

/** Scope kinds that an inventory entry may declare. */
export const PERSISTED_SCOPE_KINDS = [
  'host',
  'host-and-session',
  'host-and-store-scope',
  'host-and-caller-key',
] as const

/** One scope kind of {@link PERSISTED_SCOPE_KINDS}. */
export type PersistedScopeKind = (typeof PERSISTED_SCOPE_KINDS)[number]

/** One persisted browser entry of the inventory. */
export interface PersistedKeyEntry {
  /** Persist name. For an entry whose name ends in `:`, the name stops before the colon. */
  readonly name: string
  readonly storage: 'localStorage'
  /** Repository path of the package that writes the entry. */
  readonly owner: string
  readonly scope: PersistedScopeKind
}

/**
 * The fixed persisted browser entries. Every entry carries a host id in its stored
 * name. The spec that enumerates persisted keys fails on an entry missing from this list.
 */
export const PERSISTED_KEYS = [
  { name: 'dsh.keybindings.v1', storage: 'localStorage', owner: 'packages/client/shortcuts', scope: 'host' },
  { name: 'dsh.sidebar-right.v1', storage: 'localStorage', owner: 'packages/client/ui-sidebar-right', scope: 'host-and-session' },
  { name: 'dsh.schedule.recent-time-zones.v1', storage: 'localStorage', owner: 'packages/client/ui-schedule', scope: 'host' },
  { name: 'dsh.schedule.task-tab.v1', storage: 'localStorage', owner: 'packages/client/ui-schedule', scope: 'host-and-session' },
  { name: 'dsh.conversation', storage: 'localStorage', owner: 'packages/client/ui-conversation', scope: 'host-and-session' },
  { name: 'dsh.conversation.contentWidth', storage: 'localStorage', owner: 'packages/client/ui-conversation', scope: 'host' },
  { name: 'dsh.terminal.binding.v1', storage: 'localStorage', owner: 'packages/api/terminal-controller', scope: 'host-and-session' },
  { name: 'dsh.terminal.close.v1', storage: 'localStorage', owner: 'packages/api/terminal-controller', scope: 'host' },
  { name: 'dsh.terminal.shell', storage: 'localStorage', owner: 'packages/api/terminal-controller', scope: 'host' },
  { name: 'dsh.user-questions.drafts.v1', storage: 'localStorage', owner: 'packages/client/ui-user-questions', scope: 'host-and-session' },
  { name: 'dsh.workspace.view.v5', storage: 'localStorage', owner: 'packages/client/ui-workspace', scope: 'host-and-store-scope' },
  { name: 'dsh.sidebar-browser.v1', storage: 'localStorage', owner: 'packages/client/ui-sidebar-browser', scope: 'host' },
  { name: 'dsh.experimental-inspector.client-source-id.v0', storage: 'localStorage', owner: 'packages/experimental/inspector', scope: 'host' },
  { name: 'dsh.experimental-inspector.client-source', storage: 'localStorage', owner: 'packages/experimental/inspector', scope: 'host' },
] as const satisfies readonly PersistedKeyEntry[]

/** Name of a fixed persisted entry, from {@link PERSISTED_KEYS}. */
export type PersistedKeyName = (typeof PERSISTED_KEYS)[number]['name']

/**
 * Persisted entries whose names are chosen at run time: the experimental forge's review
 * queue, keyed by the caller, and any store declared with a persist name.
 */
export const PERSISTED_DYNAMIC_KEYS = ['review-queue', 'store-declared'] as const

/** Prefix of the cookies that the Host sets. They are outside the inventory, because each studio address has its own origin. */
export const ORIGIN_SCOPED_COOKIE_PREFIX = 'dsh-auth-' as const
