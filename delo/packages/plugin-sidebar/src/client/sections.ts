/**
 * How the sidebar sorts and marks the person's chats: each chat's status, the
 * section it sits in, whether its row recedes, search and the workspace badge.
 * Ported from T3 Code's sidebar logic (`apps/web/src/components/Sidebar.logic.ts`,
 * MIT, © 2026 T3 Tools Inc.), adapted to the harness's Sessions, Workspaces
 * and chat states. Pure: every function takes the clock it reads.
 * @module @delo/plugin-sidebar/client/sections
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SortOrder } from '../config.ts'

/** What a chat is doing, most urgent first: waiting on the person, working, or ready. */
export type ChatStatus = 'approval' | 'question' | 'plan' | 'working' | 'ready'

/** The status facts the sidebar reads of a chat, as the studio's session status has them. */
export interface ChatStatusFacts {
  /** Absent until the studio knows; the list's own flag stands in. */
  readonly running: boolean | undefined
  readonly pendingInteraction: { readonly kind: string } | undefined
  readonly completionUnread: boolean
}

/** One chat as the sidebar draws it. */
export interface SidebarChat {
  readonly id: SessionId
  readonly title: string
  /** The latest prompt or change, in epoch milliseconds. */
  readonly updatedAt: number
  /** When the chat was created, in epoch milliseconds; its latest change when the list does not say. */
  readonly createdAt: number
  /** When the latest prompt was sent, when the list knows it: the start of the run a working chat shows. */
  readonly promptAt: number | undefined
  /** The Workspace that lists the chat, or null outside every Workspace. */
  readonly workspace: WorkspaceView | null
  readonly pinned: boolean
  readonly status: ChatStatus
  /** Whether a run ended while the person was elsewhere and they have not looked since. */
  readonly unread: boolean
  /** The model the chat used last, or will use next. */
  readonly model: { readonly provider: string; readonly model: string } | null
  /** The agent preset the chat runs, such as its mode. */
  readonly preset: string | null
}

/** The sections, top to bottom: Pinned and the active cards, then the Working, Snoozed and Settled shelves. */
export type SidebarSection = 'pinned' | 'active' | 'working' | 'snoozed' | 'settled'

/** The chat states the sidebar sorts by: when each chat was snoozed or settled, and each snooze's end. */
export interface SidebarShelving {
  readonly snoozed: ReadonlyMap<SessionId, number>
  readonly settled: ReadonlyMap<SessionId, number>
}

/**
 * A chat's status: what it waits on, else working, else ready.
 * @param facts - its status, when the studio has one.
 * @param running - the list's own running flag, used until the status knows.
 * @returns the status.
 */
export function chatStatus(facts: ChatStatusFacts | undefined, running: boolean): ChatStatus {
  switch (facts?.pendingInteraction?.kind) {
    case 'approval': return 'approval'
    case 'question': return 'question'
    case 'plan-review': return 'plan'
    default: return (facts?.running ?? running) ? 'working' : 'ready'
  }
}

/**
 * Whether a chat waits on the person.
 * @param status - its status.
 * @returns true for an approval, a question or a plan to review.
 */
export function waitsOnPerson(status: ChatStatus): boolean {
  return status === 'approval' || status === 'question' || status === 'plan'
}

/**
 * Whether a row recedes: a chat that is working, or ready with nothing new, steps back unless it is open.
 * @param input - the chat's status, whether it is unread or woke, and whether it is open.
 * @returns whether the row is drawn quieter.
 */
export function shouldRecede(input: { readonly status: ChatStatus; readonly unread: boolean; readonly woke: boolean; readonly current: boolean }): boolean {
  if (input.current || input.status === 'question' || input.status === 'plan') return false
  if (input.status === 'working') return true
  return !input.unread && !input.woke
}

/**
 * The person's chats as the sidebar lists them: the main chat and other hidden chats, subagents, blank and archived
 * chats stay out.
 * @param list - the studio's chat list, without hidden chats.
 * @param statuses - each chat's status.
 * @param workspaces - the Workspaces with their shown titles.
 * @param pinnedIds - the pinned chats, in pin order.
 * @param archivedIds - the archived chats.
 * @returns the chats.
 */
export function sidebarChats(
  list: SessionListState,
  statuses: ReadonlyMap<SessionId, ChatStatusFacts>,
  workspaces: readonly WorkspaceView[],
  pinnedIds: readonly SessionId[],
  archivedIds: readonly SessionId[],
): SidebarChat[] {
  const archived = new Set(archivedIds)
  const pinned = new Set(pinnedIds)
  const workspaceOf = new Map<SessionId, WorkspaceView>()
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds) if (!workspaceOf.has(id)) workspaceOf.set(id, workspace)
  }
  return list.ids.flatMap((id) => {
    const chat = list.byId[id]
    if (chat === undefined || chat.origin === 'subagent' || chat.blank || archived.has(id)) return []
    const facts = statuses.get(id)
    const values = chat.projectionValues
    const promptAt = values?.sessionListMetadata?.lastPromptAt
    const selection = values?.modelSelection?.lastUsed ?? values?.modelSelection?.next ?? null
    const workspace = workspaceOf.get(id) ?? null
    return [{
      id,
      title: chat.displayTitle,
      updatedAt: chat.updatedAt,
      createdAt: chat.createdAt ?? chat.updatedAt,
      promptAt: typeof promptAt === 'number' ? promptAt : undefined,
      workspace,
      pinned: pinned.has(id),
      status: chatStatus(facts, chat.running),
      unread: facts?.completionUnread ?? false,
      model: selection === null ? null : { provider: selection.provider, model: selection.model },
      preset: values?.agentPreset ?? null,
    }]
  })
}

/**
 * Sort chats into sections. A pinned chat stays under Pinned. A chat waiting on the person or working never sits on
 * the Snoozed or Settled shelf, so a snooze or settle gives way to it; otherwise one shelved no earlier than its latest
 * prompt sits on that shelf. With the Working shelf on, a working chat goes there; the rest are the active cards. Pinned
 * keeps pin order, Settled the latest settled first, the rest the latest change, or the latest created, first.
 * @param chats - the chats.
 * @param shelving - the snoozed and settled chats.
 * @param pinnedIds - the pinned chats, in pin order.
 * @param workingShelf - whether working chats gather on the Working shelf.
 * @param sort - whether the latest change or the latest created comes first.
 * @returns each section's chats.
 */
export function sidebarSections(
  chats: readonly SidebarChat[], shelving: SidebarShelving, pinnedIds: readonly SessionId[], workingShelf = true, sort: SortOrder = 'updated',
): Record<SidebarSection, SidebarChat[]> {
  const sections: Record<SidebarSection, SidebarChat[]> = { pinned: [], active: [], working: [], snoozed: [], settled: [] }
  const key = (chat: SidebarChat): number => (sort === 'created' ? chat.createdAt : chat.updatedAt)
  const newestFirst = [...chats].sort((a, b) => key(b) - key(a))
  for (const chat of newestFirst) {
    if (chat.pinned) {
      sections.pinned.push(chat)
      continue
    }
    const busy = waitsOnPerson(chat.status) || chat.status === 'working'
    const snoozedAt = shelving.snoozed.get(chat.id)
    const settledAt = shelving.settled.get(chat.id)
    if (!busy && snoozedAt !== undefined && chat.updatedAt <= snoozedAt) sections.snoozed.push(chat)
    else if (!busy && settledAt !== undefined && chat.updatedAt <= settledAt) sections.settled.push(chat)
    else if (workingShelf && chat.status === 'working') sections.working.push(chat)
    else sections.active.push(chat)
  }
  const pinOrder = new Map(pinnedIds.map((id, index) => [id, index]))
  sections.pinned.sort((a, b) => (pinOrder.get(a.id) ?? 0) - (pinOrder.get(b.id) ?? 0))
  // Every settled chat is on the shelf because it has a settled time.
  const settledTime = (chat: SidebarChat): number => shelving.settled.get(chat.id) as number
  sections.settled.sort((a, b) => settledTime(b) - settledTime(a))
  return sections
}

const DAY_MS = 86_400_000

/**
 * The settled chats with the idle ones added: a chat untouched for `days` since its latest change, or since the person
 * last returned it to the list, counts as settled from the moment the days ran out, so the next change brings it back.
 * @param chats - the chats.
 * @param settled - the chats the person settled, with when.
 * @param kept - the chats the person returned to the list, with when.
 * @param days - the idle days; 0 adds none.
 * @param now - the clock, in epoch milliseconds.
 * @returns the settled chats, the same map when none is added.
 */
export function withAutoSettled(
  chats: readonly SidebarChat[], settled: ReadonlyMap<SessionId, number>, kept: ReadonlyMap<SessionId, number>, days: number, now: number,
): ReadonlyMap<SessionId, number> {
  if (days <= 0) return settled
  let merged: Map<SessionId, number> | undefined
  for (const chat of chats) {
    if (settled.has(chat.id)) continue
    const due = Math.max(chat.updatedAt, kept.get(chat.id) ?? 0) + days * DAY_MS
    if (due > now) continue
    merged ??= new Map(settled)
    merged.set(chat.id, due)
  }
  return merged ?? settled
}

/**
 * Chats whose title or Workspace holds every word of the query, ignoring case.
 * @param chats - the chats.
 * @param query - the search field's text.
 * @returns the matches, the latest change first.
 */
export function searchChats(chats: readonly SidebarChat[], query: string): SidebarChat[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return []
  return chats
    .filter((chat) => {
      const text = `${chat.title} ${chat.workspace?.title ?? ''}`.toLocaleLowerCase()
      return words.every(word => text.includes(word))
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Keep the chats of the Workspaces a filter names; an empty filter keeps every chat.
 * @param chats - the chats.
 * @param scope - the Workspaces the filter names.
 * @returns the chats in scope.
 */
export function inScope(chats: readonly SidebarChat[], scope: ReadonlySet<WorkspaceId>): SidebarChat[] {
  return scope.size === 0 ? [...chats] : chats.filter(chat => chat.workspace !== null && scope.has(chat.workspace.workspaceId))
}

/**
 * A Workspace badge's letters: the initials of its first two words, or its first two letters.
 * @param title - the Workspace's shown title.
 * @returns one or two uppercase letters, or an empty string for a title without letters or digits.
 */
export function workspaceInitials(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(word => word !== '')
  const [first, second] = words
  if (first === undefined) return ''
  const letters = second === undefined ? [...first].slice(0, 2) : [[...first][0], [...second][0]]
  return letters.join('').toLocaleUpperCase()
}

/** The badge colours, in Workspace order, so the first five differ. */
export const BADGE_COLORS = ['blue', 'green', 'amber', 'violet', 'red'] as const

/** One badge colour. */
export type BadgeColor = typeof BADGE_COLORS[number]

/**
 * A Workspace's badge colour by its place in the Workspace order.
 * @param workspaces - the Workspaces in their stored order.
 * @param workspaceId - the Workspace.
 * @returns its colour.
 */
export function badgeColor(workspaces: readonly WorkspaceView[], workspaceId: WorkspaceId): BadgeColor {
  const index = Math.max(0, workspaces.findIndex(workspace => workspace.workspaceId === workspaceId))
  return BADGE_COLORS[index % BADGE_COLORS.length] as BadgeColor
}

/** One Workspace folder in the folders view: its Workspace, or null for chats outside every Workspace, and its chats. */
export interface SidebarFolder {
  readonly workspace: WorkspaceView | null
  readonly chats: readonly SidebarChat[]
}

/**
 * Group the active chats by Workspace, in the Workspaces' order, for T3 Code's folders view; chats outside every
 * Workspace come last.
 * @param chats - the active chats, the latest change first.
 * @param workspaces - the Workspaces in their stored order.
 * @param scope - the Workspaces the filter names; empty for every one.
 * @returns the folders, each Workspace in scope even without chats.
 */
export function sidebarFolders(chats: readonly SidebarChat[], workspaces: readonly WorkspaceView[], scope: ReadonlySet<WorkspaceId>): SidebarFolder[] {
  const folders: SidebarFolder[] = workspaces
    .filter(workspace => scope.size === 0 || scope.has(workspace.workspaceId))
    .map(workspace => ({ workspace, chats: chats.filter(chat => chat.workspace?.workspaceId === workspace.workspaceId) }))
  const loose = chats.filter(chat => chat.workspace === null)
  return loose.length === 0 ? folders : [...folders, { workspace: null, chats: loose }]
}

/**
 * The most urgent state among a folded folder's chats, for the dot on its header: waiting on the person, else working,
 * else a finished unread run.
 * @param chats - the folder's chats.
 * @returns the state, or null for a quiet folder.
 */
export function folderDot(chats: readonly SidebarChat[]): 'waiting' | 'working' | 'done' | null {
  if (chats.some(chat => waitsOnPerson(chat.status))) return 'waiting'
  if (chats.some(chat => chat.status === 'working')) return 'working'
  return chats.some(chat => chat.unread) ? 'done' : null
}

/** The modifier digits jump to the first nine chats with. */
export const JUMP_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

/** The markers between the list's sections, which a drag drops on or between: T3 Code's sidebar list markers. */
export type SidebarListMarker = 'pinned-divider' | 'working-header' | 'snoozed-header' | 'settled-header'

/** One entry of the list in its drawn order: a chat in its section, or a marker. */
export type SidebarListItem =
  | { readonly kind: 'chat'; readonly id: SessionId; readonly section: SidebarSection }
  | { readonly kind: 'marker'; readonly marker: SidebarListMarker }

/** The prefix of a marker's drag id, which no session id starts with. */
const MARKER_PREFIX = 'marker:'

/**
 * An entry's drag id: the chat's session id, or the marker's name after a prefix.
 * @param item - the entry.
 * @returns its id.
 */
export function sidebarItemId(item: SidebarListItem): string {
  return item.kind === 'chat' ? item.id : MARKER_PREFIX + item.marker
}

/** The section a slot of the list falls in: the section the last marker above it opens, Pinned above every marker. */
function sectionAtSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = 'pinned'
  for (const item of items.slice(0, index)) {
    if (item.kind !== 'marker') continue
    if (item.marker === 'pinned-divider') section = 'active'
    else if (item.marker === 'working-header') section = 'working'
    else if (item.marker === 'snoozed-header') section = 'snoozed'
    else section = 'settled'
  }
  return section
}

/** Where a dragged chat would land: its section, and the pinned chats' order with it in place. */
export interface SidebarDropTarget {
  readonly section: 'pinned' | 'active' | 'settled'
  readonly pinnedOrder: readonly SessionId[]
}

/**
 * Where a dragged chat lands when dropped over an entry, after T3 Code's `resolveSidebarDropTarget`: the list with the
 * chat moved to the entry's place decides the section. Working and Snoozed take no drops.
 * @param items - the list in its drawn order.
 * @param activeId - the dragged chat's drag id.
 * @param overId - the drag id of the entry under the pointer.
 * @returns the target, or null where the chat cannot land.
 */
export function sidebarDropTarget(items: readonly SidebarListItem[], activeId: string, overId: string): SidebarDropTarget | null {
  const activeIndex = items.findIndex(item => sidebarItemId(item) === activeId)
  const overIndex = items.findIndex(item => sidebarItemId(item) === overId)
  const active = items[activeIndex]
  if (active?.kind !== 'chat' || overIndex === -1) return null
  const moved = items.filter((_, index) => index !== activeIndex)
  moved.splice(overIndex, 0, active)
  const section = sectionAtSlot(moved, overIndex)
  if (section === 'working' || section === 'snoozed') return null
  const pinnedOrder: SessionId[] = []
  for (const item of moved) {
    if (item.kind === 'marker') break
    pinnedOrder.push(item.id)
  }
  return { section, pinnedOrder }
}

/** What a drop does, named on the dragged row's badge. */
export type SidebarDropVerb = 'pin' | 'unpin' | 'settle' | 'unsettle' | 'wake'

/**
 * The verb of a drop from one section to another, after T3 Code's `resolveSidebarDropVerb`.
 * @param from - the dragged chat's section.
 * @param to - the target's section, or null where it cannot land.
 * @returns the verb, or null for a drop that stays in its section.
 */
export function sidebarDropVerb(from: SidebarSection, to: SidebarSection | null): SidebarDropVerb | null {
  if (to === null || to === from || to === 'working' || to === 'snoozed') return null
  if (to === 'pinned') return 'pin'
  if (to === 'settled') return 'settle'
  if (from === 'pinned') return 'unpin'
  if (from === 'settled') return 'unsettle'
  return 'wake'
}

/**
 * The pinned chats in the viewer's order: the ones that order names first, as it names them, then the rest in pin
 * order.
 * @param pinnedIds - the pinned chats, in pin order.
 * @param viewerOrder - the order the viewer dragged them into.
 * @returns the pinned chats.
 */
export function orderPinned(pinnedIds: readonly SessionId[], viewerOrder: readonly SessionId[]): SessionId[] {
  const pinned = new Set(pinnedIds)
  const ordered = viewerOrder.filter(id => pinned.has(id))
  const placed = new Set(ordered)
  return [...ordered, ...pinnedIds.filter(id => !placed.has(id))]
}
