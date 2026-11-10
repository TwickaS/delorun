/**
 * Delo's chat list, in upstream's `sidebar.workspaces.list` seat: a search
 * field with a workspace filter, Add workspace and New chat beside it; the
 * pinned and active chats as cards; and the Working, Snoozed and Settled
 * shelves held at the bottom, each folding with its count; or, in the
 * folders view, a folder per Workspace. Holding Alt shows a digit on the
 * first nine chats, and Alt with that digit opens one outside a text field.
 * Dragging a card pins, reorders the pins, unpins, settles, returns or wakes
 * it, as T3 Code's drag does. Settling, snoozing, pinning and unpinning offer
 * Undo for a few seconds, in the undo notice at the sidebar's foot. Below the
 * list, a quiet notice names a newer Delorun release when one exists. Ported
 * from T3 Code's sidebar (`apps/web/src/components/Sidebar.tsx` and its
 * `sidebar/` parts, MIT, © 2026 T3 Tools Inc.) onto the harness's Sessions
 * and Workspaces.
 * @module @delo/plugin-sidebar/client/Sidebar
 */
import {
  Button, HoverCardGroup, IconCloseOutlineRegular, IconEditOutlineRegular, IconNewChatOutlineRegular, IconPersonalizationOutlineRegular,
  IconProjectAddOutlineRegular, IconSearchOutlineRegular, IconSlidersTwoOutlineRegular, IconTrashOutlineRegular, Menu, Modal, ShortcutKeys,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContextMenuTarget } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cx } from './cx.ts'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { SidebarSettings } from '../config.ts'
import { readWorkspaceIcons, type WorkspaceIcon } from '../workspace-icon.ts'
import { ChatRow, type ChatRowProps, type RowStateActions } from './ChatRow.tsx'
import { useListDrag } from './drag.ts'
import { IconPicker } from './IconPicker.tsx'
import { FolderHeader, PinnedDivider, ShelfHeader, useScrollFade, type Shelf } from './ListParts.tsx'
import {
  badgeColor, inScope, JUMP_KEYS, orderPinned, searchChats, sidebarChats, sidebarFolders, sidebarItemId, sidebarDropVerb, sidebarSections,
  withAutoSettled, type ChatStatusFacts, type SidebarChat, type SidebarFolder, type SidebarListItem, type SidebarListMarker, type SidebarSection,
} from './sections.ts'
import type { UndoKind, UndoLine } from './undo.ts'
import { UpdateNoticeCard, type UpdateNoticeFace } from './UpdateNotice.tsx'
import { WorkspaceBadge, WorkspaceIconsContext } from './WorkspaceBadge.tsx'
import css from './Sidebar.module.css'

/**
 * What the list follows beyond its seat: the chat states (empty maps without Delo's chat-states plugin), the open
 * chat menu and the sidebar's settings.
 */
export type SidebarSources = {
  snoozed: HostObservable<ReadonlyMap<SessionId, number>>
  settled: HostObservable<ReadonlyMap<SessionId, number>>
  woke: HostObservable<ReadonlyMap<SessionId, number>>
  /** Chats the person returned to the list, with when, from which auto-settle counts idle days. */
  kept: HostObservable<ReadonlyMap<SessionId, number>>
  /** The idle days after which a chat counts as settled; 0 is off. */
  autoSettleDays: HostObservable<number>
  /** Each snoozed chat's end, by session id. */
  snoozedUntil: HostObservable<ReadonlyMap<SessionId, number>>
  /** Whether Delo's chat-states plugin is present, so `states()` returns its actions. */
  chatStatesReady: HostObservable<boolean>
  /** The context menu now open, if any, so its chat's row stays lit. */
  menuTarget: HostObservable<ContextMenuTarget | null>
  settings: HostObservable<SidebarSettings>
}

/** The seat owner's add-workspace affordance, as the list last received it. */
export interface AddWorkspaceOwner {
  readonly canAddWorkspace: boolean
  readonly addWorkspace: () => void
}

/** What the list reads and does beyond its seat's owner props. */
export type SidebarInjected = {
  hooks: SidebarSources
  /** The chat-state actions while Delo's chat-states plugin is present, else null; the same object while it stays. */
  readonly states: () => RowStateActions | null
  readonly pin: (id: SessionId) => void
  readonly unpin: (id: SessionId) => void
  /** Save a Workspace's chosen icon, or null to return it to its monogram. */
  readonly setWorkspaceIcon: (workspaceId: string, icon: WorkspaceIcon | null) => void
  /**
   * Offer the owner's add-workspace affordance to other plugins while the list is mounted.
   * @param owner - a ref holding the latest owner props, read when the affordance is used.
   * @returns the function that withdraws the offer.
   */
  readonly attach: (owner: { readonly current: AddWorkspaceOwner }) => () => void
  /** Drop the stored icons of Workspaces that no longer exist; called only once the Workspace list has loaded. */
  readonly pruneIcons: (liveIds: ReadonlySet<string>) => void
  /** Read and keep one per-viewer preference, such as a shelf's folding; storage that refuses keeps the default. */
  readonly preference: { readonly read: (key: string) => string | null; readonly write: (key: string, value: string) => void }
  /** The last change the person can take back, which the foot's undo notice offers. */
  readonly undoLine: UndoLine
  /** The update notice shown below the list. */
  readonly updateNotice: UpdateNoticeFace
}

/** The list's props: its seat's owner props and the studio's hooks, the dictionary and what the list does. */
export type SidebarProps = PropsRuntime<'sidebar.workspaces.list'> & PropsLocale<'deloSidebar'> & InjectFace<SidebarInjected>

/** How many settled chats show before Show more, and how many each press adds. */
const SETTLED_FIRST = 10
const SETTLED_PAGE = 25
/** How long the undo line stays. */
const UNDO_MS = 6000
/** How long the message search waits after typing. */
const SEARCH_WAIT_MS = 250

/** Whether each shelf starts open. */
const SHELVES: Readonly<Record<Shelf, boolean>> = { working: true, snoozed: false, settled: false }

/** The prefix of a folder's folding preference, after which comes its Workspace id or `loose`. */
const FOLDER_PREFERENCE = 'folder.'

/**
 * Whether a key event comes from a field the person types in, where Alt with a digit is text, not a jump.
 * @param event - the key event.
 * @returns true for an event from a text field, a selector or an editable region.
 */
function typingInField(event: globalThis.KeyboardEvent): boolean {
  return event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null
}

/**
 * The Alt jump: the digit Alt is pressed with, from the physical key so a layout's Alt characters still count.
 * @param event - the key event.
 * @returns the digit's place among the jump keys, or -1 for any other press.
 */
function jumpIndex(event: globalThis.KeyboardEvent): number {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return -1
  return JUMP_KEYS.indexOf(event.code.replace('Digit', '') as typeof JUMP_KEYS[number])
}

/**
 * Render the chat list.
 * @param props - the seat's owner props, the studio's hooks, the dictionary and what the list does.
 * @returns the list.
 */
export function Sidebar(props: SidebarProps) {
  const {
    list, workspaces, open, startSession, canAddWorkspace, addWorkspaceAnchor, addWorkspace, renameSession, renameWorkspace,
    deleteWorkspace, searchSessions, searchRequest, searchShortcut, openSessionMenu,
    useSessionStatus, useWorkspaces, useSnoozed, useSettled, useWoke, useKept, useAutoSettleDays, useSnoozedUntil, useChatStatesReady,
    useMenuTarget, useSettings, pin, unpin, setWorkspaceIcon, pruneIcons, attach, preference, updateNotice, t,
  } = props
  const statuses = useSessionStatus(state => state as ReadonlyMap<SessionId, ChatStatusFacts>)
  const pinnedIds = useWorkspaces(state => state.pinnedSessionIds)
  const archivedIds = useWorkspaces(state => state.archivedSessionIds)
  const workspacesLoaded = useWorkspaces(state => state.phase) === 'ready'
  const snoozed = useSnoozed(map => map)
  const storedSettled = useSettled(map => map)
  const kept = useKept(map => map)
  const autoSettleDays = useAutoSettleDays(days => days)
  const woke = useWoke(map => map)
  const snoozedUntil = useSnoozedUntil(map => map)
  const menuFor = useMenuTarget(target => (target?.kind === 'session' ? target.value.sessionId : null))
  const settings = useSettings(value => value)
  const chatStatesReady = useChatStatesReady(ready => ready)
  const states = chatStatesReady ? props.states() : null
  // The latest owner props, so another plugin that adds a workspace through the list never uses a stale callback.
  const addOwner = useRef<AddWorkspaceOwner>({ canAddWorkspace, addWorkspace })
  addOwner.current = { canAddWorkspace, addWorkspace }
  useEffect(() => attach(addOwner), [attach])
  const icons = useMemo(() => readWorkspaceIcons(settings.workspaceIcons), [settings.workspaceIcons])
  // Once the Workspace list is complete, icons of Workspaces that were removed are dropped; a list still loading prunes nothing.
  const staleIcons = workspacesLoaded && Object.keys(settings.workspaceIcons).some(id => !workspaces.some(workspace => workspace.workspaceId === id))
  useEffect(() => {
    if (staleIcons) pruneIcons(new Set(workspaces.map(workspace => workspace.workspaceId)))
  }, [staleIcons, workspaces, pruneIcons])

  // Ages move on once a minute.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [])

  const [scope, setScope] = useState<ReadonlySet<WorkspaceId>>(() => {
    const saved = preference.read('scope')
    return new Set(saved === null ? [] : saved.split('\n').filter(id => id !== '') as WorkspaceId[])
  })
  const changeScope = (next: ReadonlySet<WorkspaceId>): void => {
    setScope(next)
    preference.write('scope', [...next].join('\n'))
  }
  // A filter that names a Workspace since removed keeps only the ones still there.
  const liveScope = useMemo(
    () => new Set([...scope].filter(id => workspaces.some(workspace => workspace.workspaceId === id))),
    [scope, workspaces],
  )
  const [shelves, setShelves] = useState<Record<Shelf, boolean>>(() => {
    const folded = (shelf: Shelf): boolean => {
      const saved = preference.read(`shelf.${shelf}`)
      return saved === null ? SHELVES[shelf] : saved === 'open'
    }
    return { working: folded('working'), snoozed: folded('snoozed'), settled: folded('settled') }
  })
  const toggleShelf = (shelf: Shelf): void => {
    setShelves((current) => {
      const next = { ...current, [shelf]: !current[shelf] }
      preference.write(`shelf.${shelf}`, next[shelf] ? 'open' : 'folded')
      return next
    })
  }
  const [settledShown, setSettledShown] = useState(SETTLED_FIRST)

  const chats = useMemo(
    () => sidebarChats(list, statuses, workspaces, pinnedIds, archivedIds),
    [list, statuses, workspaces, pinnedIds, archivedIds],
  )
  const scoped = useMemo(() => inScope(chats, liveScope), [chats, liveScope])
  const folders = settings.view === 'folders'
  // Folders hold every chat on the list; working chats stay in their folder.
  const workingShelf = settings.workingShelf && !folders
  // The viewer's order of the pins, which dragging sets; pins it does not name follow in pin order.
  const [pinOrder, setPinOrder] = useState<readonly SessionId[]>(() => (preference.read('pinOrder') ?? '').split('\n').filter(id => id !== '') as SessionId[])
  const keepPinOrder = (order: readonly SessionId[]): void => {
    setPinOrder(order)
    preference.write('pinOrder', order.join('\n'))
  }
  const orderedPins = useMemo(() => orderPinned(pinnedIds, pinOrder), [pinnedIds, pinOrder])
  // Idle chats count as settled as of the list's latest change; an open studio sees one cross the line on the next change.
  const settled = useMemo(
    () => withAutoSettled(scoped, storedSettled, kept, autoSettleDays, Date.now()),
    [scoped, storedSettled, kept, autoSettleDays],
  )
  const sections = useMemo(
    () => sidebarSections(scoped, { snoozed, settled }, orderedPins, workingShelf, settings.sort),
    [scoped, snoozed, settled, orderedPins, workingShelf, settings.sort],
  )
  const folderList = useMemo(
    () => (folders ? sidebarFolders([...sections.pinned, ...sections.active], workspaces, liveScope) : []),
    [folders, sections, workspaces, liveScope],
  )
  const [openFolders, setOpenFolders] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const folderKey = (folder: SidebarFolder): string => folder.workspace?.workspaceId ?? 'loose'
  const folderOpen = (folder: SidebarFolder): boolean => {
    const key = folderKey(folder)
    return openFolders.get(key) ?? preference.read(FOLDER_PREFERENCE + key) !== 'folded'
  }
  const toggleFolder = (folder: SidebarFolder): void => {
    const key = folderKey(folder)
    const next = !folderOpen(folder)
    setOpenFolders(current => new Map(current).set(key, next))
    preference.write(FOLDER_PREFERENCE + key, next ? 'open' : 'folded')
  }
  const currentId = useMemo(
    () => list.ids.find(id => (list.byId[id]?.retainedBy.mainView ?? 0) > 0),
    [list],
  )

  // Opening a chat that woke is seeing it.
  useEffect(() => {
    if (currentId !== undefined && woke.has(currentId)) states?.seen(currentId)
  }, [currentId, woke, states])

  // The undo line, which the foot's notice offers for a few seconds; a waking keeps the snooze it ended.
  const { undoLine } = props
  const undoEntry = useSyncExternalStore(listener => undoLine.subscribe(listener), () => undoLine.getSnapshot())
  useEffect(() => {
    if (undoEntry === null) return
    const timer = setTimeout(() => { undoLine.set(null) }, UNDO_MS)
    return () => { clearTimeout(timer) }
  }, [undoEntry, undoLine])
  const remember = (kind: UndoKind, undo: () => void): void => {
    undoLine.set({ kind, key: Date.now(), undo })
  }
  const rowStates = useMemo((): RowStateActions | null => states === null ? null : {
    ...states,
    settle: (id) => { states.settle(id); remember('settle', () => { states.unsettle(id) }) },
    unsettle: (id) => { states.unsettle(id); remember('unsettle', () => { states.settle(id) }) },
    snooze: (id, until) => { states.snooze(id, until); remember('snooze', () => { states.wake(id) }) },
    wake: (id) => {
      const until = snoozedUntil.get(id)
      states.wake(id)
      remember('wake', () => { if (until !== undefined && until > Date.now()) states.snooze(id, until) })
    },
  }, [states, snoozedUntil])
  const unpinWithUndo = (id: SessionId): void => {
    unpin(id)
    remember('unpin', () => { pin(id) })
  }
  // With Ask before unpinning on, the button and a drag below the divider ask first.
  const [unpinAsk, setUnpinAsk] = useState<SidebarChat | null>(null)
  const requestUnpin = (id: SessionId): void => {
    const chat = chats.find(candidate => candidate.id === id)
    if (settings.confirmUnpin && chat !== undefined) setUnpinAsk(chat)
    else unpinWithUndo(id)
  }

  // Search: titles and Workspaces at once, then the chats' messages.
  const searchInput = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [messageHits, setMessageHits] = useState<{ readonly query: string; readonly state: 'loading' | 'ready' | 'failed'; readonly items: readonly { readonly sessionId: SessionId; readonly snippet: string }[] }>({ query: '', state: 'ready', items: [] })
  const trimmed = query.trim()
  useEffect(() => {
    if (searchRequest === 0) return
    searchInput.current?.focus({ preventScroll: true })
  }, [searchRequest])
  useEffect(() => {
    if (trimmed === '') return
    const controller = new AbortController()
    setMessageHits({ query: trimmed, state: 'loading', items: [] })
    const timer = setTimeout(() => {
      searchSessions(trimmed, controller.signal).then((result) => {
        if (!controller.signal.aborted) setMessageHits({ query: trimmed, state: 'ready', items: result.items })
      }, (error: unknown) => {
        if (controller.signal.aborted) return
        console.warn('delo sidebar: the message search failed', error)
        setMessageHits({ query: trimmed, state: 'failed', items: [] })
      })
    }, SEARCH_WAIT_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [trimmed, searchSessions])
  const results = useMemo(() => {
    if (trimmed === '') return []
    const byTitle = searchChats(chats, trimmed).map(chat => ({ chat, snippet: undefined as string | undefined }))
    const seen = new Set(byTitle.map(result => result.chat.id))
    const byMessage = messageHits.query === trimmed
      ? messageHits.items.flatMap((hit) => {
        const chat = chats.find(candidate => candidate.id === hit.sessionId)
        if (chat === undefined || seen.has(chat.id)) return []
        seen.add(chat.id)
        return [{ chat, snippet: hit.snippet }]
      })
      : []
    return [...byTitle, ...byMessage]
  }, [chats, trimmed, messageHits])
  const clearSearch = (): void => {
    setQuery('')
    setHighlight(0)
  }
  const openResult = (id: SessionId): void => {
    clearSearch()
    searchInput.current?.blur()
    open(id)
  }
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      clearSearch()
      searchInput.current?.blur()
    } else if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      setHighlight(index => Math.min(results.length - 1, index + 1))
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      setHighlight(index => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      const picked = results[highlight]
      if (picked === undefined) return
      event.preventDefault()
      openResult(picked.chat.id)
    }
  }

  // The workspace filter, and the icon picker its Change icon opens.
  const [filterOpen, setFilterOpen] = useState(false)
  const [iconFor, setIconFor] = useState<WorkspaceId | null>(null)
  const iconWorkspace = iconFor === null ? undefined : workspaces.find(workspace => workspace.workspaceId === iconFor)
  const scopedWorkspaces = workspaces.filter(workspace => liveScope.has(workspace.workspaceId))
  const badgeOf = (workspace: { readonly workspaceId: WorkspaceId; readonly title: string }) => (
    <WorkspaceBadge title={workspace.title} workspaceId={workspace.workspaceId} color={badgeColor(workspaces, workspace.workspaceId)} />
  )
  const filterItems: MenuEntry[] = [
    { id: 'all', label: t('filter.all') },
    ...workspaces.length > 0 ? [{ type: 'separator' as const, id: 'workspaces' }] : [],
    ...workspaces.map(workspace => ({ id: `scope:${workspace.workspaceId}`, label: workspace.title, icon: badgeOf(workspace) })),
    ...workspaces.length > 0
      ? [
        { type: 'separator' as const, id: 'manage' },
        {
          id: 'icon', label: t('filter.icon'), icon: <IconPersonalizationOutlineRegular size={14} className={css.menuIcon} />,
          submenu: workspaces.map(workspace => ({ id: `icon:${workspace.workspaceId}`, label: workspace.title, icon: badgeOf(workspace) })),
        },
        {
          id: 'rename', label: t('filter.rename'), icon: <IconEditOutlineRegular size={14} className={css.menuIcon} />,
          submenu: workspaces.map(workspace => ({ id: `rename:${workspace.workspaceId}`, label: workspace.title })),
        },
        {
          id: 'delete', label: t('filter.delete'), icon: <IconTrashOutlineRegular size={14} className={css.menuIcon} />,
          submenu: workspaces.map(workspace => ({ id: `delete:${workspace.workspaceId}`, label: workspace.title, danger: true })),
        },
      ]
      : [],
  ]
  const pickFilter = (id: string): void => {
    if (id === 'all') {
      changeScope(new Set())
      setFilterOpen(false)
      return
    }
    const [kind, workspaceId] = id.split(':') as [string, WorkspaceId]
    if (kind === 'scope') {
      const next = new Set(liveScope)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      changeScope(next)
      return
    }
    setFilterOpen(false)
    if (kind === 'icon') setIconFor(workspaceId)
    else if (kind === 'rename') renameWorkspace(workspaceId)
    else deleteWorkspace(workspaceId)
  }
  const filterLabel = scopedWorkspaces.length === 0
    ? t('filter')
    : t('filter.active', { names: scopedWorkspaces.map(workspace => workspace.title).join(', ') })
  const newChatWorkspace = scopedWorkspaces.length === 1 ? scopedWorkspaces[0] : undefined
  const newChatLabel = newChatWorkspace === undefined ? t('chat.new') : t('chat.newIn', { name: newChatWorkspace.title })

  const shelfOrder = (['working', 'snoozed', 'settled'] as const).filter(shelf => sections[shelf].length > 0)
  const shelfRows = (shelf: Shelf): readonly SidebarChat[] => {
    const rows = sections[shelf]
    return shelf === 'settled' ? rows.slice(0, settledShown) : rows
  }
  // The chats in the order they show, for the Alt jump.
  const visible = useMemo(() => [
    ...folders
      ? folderList.flatMap(folder => (folderOpen(folder) ? folder.chats : []))
      : [...sections.pinned, ...sections.active],
    ...shelfOrder.flatMap(shelf => (shelves[shelf] ? shelfRows(shelf) : [])),
  ], [folders, folderList, openFolders, sections, shelves, settledShown])
  const jumpTo = useRef(visible)
  jumpTo.current = visible
  const [altHeld, setAltHeld] = useState(false)
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (typingInField(event)) return
      if (event.key === 'Alt') {
        setAltHeld(true)
        return
      }
      const chat = jumpTo.current[jumpIndex(event)]
      if (chat === undefined) return
      event.preventDefault()
      setAltHeld(false)
      open(chat.id)
    }
    const release = (): void => { setAltHeld(false) }
    const onKeyUp = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Alt') release() }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', release)
    }
  }, [open])
  const jumpLabels = useMemo(
    () => new Map<SessionId, string>(altHeld ? visible.slice(0, JUMP_KEYS.length).map((chat, index) => [chat.id, String(index + 1)]) : []),
    [altHeld, visible],
  )

  // Dragging, in the cards view: the list in its drawn order and T3 Code's drop rules over it.
  const scrollRef = useScrollFade()
  const canDrag = !folders && trimmed === ''
  const settledHeader = shelfOrder.includes('settled') || (states !== null)
  const dragItems = useMemo((): SidebarListItem[] => [
    ...sections.pinned.map(chat => ({ kind: 'chat' as const, id: chat.id, section: 'pinned' as const })),
    { kind: 'marker', marker: 'pinned-divider' },
    ...sections.active.map(chat => ({ kind: 'chat' as const, id: chat.id, section: 'active' as const })),
    ...shelfOrder.flatMap(shelf => [
      { kind: 'marker' as const, marker: `${shelf}-header` as const },
      ...shelves[shelf] ? shelfRows(shelf).map(chat => ({ kind: 'chat' as const, id: chat.id, section: shelf })) : [],
    ]),
    ...!shelfOrder.includes('settled') && settledHeader ? [{ kind: 'marker' as const, marker: 'settled-header' as const }] : [],
  ], [sections, shelfOrder.join(), shelves, settledShown, settledHeader])
  const drag = useListDrag({
    enabled: canDrag,
    items: dragItems,
    scroller: scrollRef,
    onDrop: (from, target) => {
      const verb = sidebarDropVerb(from.section, target.section)
      if (target.section === 'pinned') keepPinOrder(target.pinnedOrder)
      if (verb === 'pin') {
        pin(from.id)
        remember('pin', () => { unpin(from.id) })
      } else if (verb === 'unpin') requestUnpin(from.id)
      else if (verb === 'settle') rowStates?.settle(from.id)
      else if (verb === 'unsettle') rowStates?.unsettle(from.id)
      else if (verb === 'wake') rowStates?.wake(from.id)
    },
  })
  const dragged = drag.view
  // A drop ends with the pointer's release over the row, which would also open it.
  const openRow = (id: SessionId): void => {
    if (drag.justDropped()) return
    open(id)
  }

  const row = (chat: SidebarChat, section: SidebarSection, inFolder = false) => {
    const rowProps: ChatRowProps = {
      chat,
      section,
      current: chat.id === currentId,
      now,
      color: chat.workspace === null ? 'blue' : badgeColor(workspaces, chat.workspace.workspaceId),
      wokeAt: woke.get(chat.id),
      snoozedUntil: snoozedUntil.get(chat.id),
      states: rowStates,
      open: openRow,
      rename: renameSession,
      unpin: requestUnpin,
      openMenu: openSessionMenu,
      menuOpen: menuFor === chat.id,
      jumpLabel: jumpLabels.get(chat.id) ?? null,
      inFolder,
      drag: canDrag && !inFolder
        ? {
          onPointerDown: drag.press(chat.id, section),
          dragging: dragged?.id === chat.id,
          over: dragged !== null && dragged.id !== chat.id && dragged.overId === chat.id,
          verb: dragged?.id === chat.id ? dragged.verb : null,
        }
        : undefined,
      t,
    }
    return <ChatRow key={chat.id} {...rowProps} />
  }
  const empty = scoped.length === 0
  const emptyText = workspaces.length === 0
    ? t('empty.noWorkspaces')
    : newChatWorkspace !== undefined
      ? t('empty.scoped', { name: newChatWorkspace.title })
      : scopedWorkspaces.length > 1 ? t('empty.scopedMany') : t('empty.none')
  const overMarker = (marker: SidebarListMarker): boolean => dragged?.overId === sidebarItemId({ kind: 'marker', marker })

  return (
    <WorkspaceIconsContext.Provider value={icons}>
      <div className={css.root}>
        <div className={css.header}>
          <label className={css.search}>
            <IconSearchOutlineRegular size={16} className={css.searchIcon} />
            <input
              ref={searchInput}
              className={css.searchInput}
              type="search"
              placeholder={t('search.placeholder')}
              aria-label={t('search.aria')}
              role="combobox"
              aria-expanded={trimmed !== '' && results.length > 0}
              aria-controls="delo-sidebar-search-results"
              aria-activedescendant={trimmed !== '' && results[highlight] !== undefined ? `delo-sidebar-result-${String(highlight)}` : undefined}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setHighlight(0) }}
              onKeyDown={onSearchKey}
            />
            {query !== ''
              ? (
                <button type="button" className={css.clear} aria-label={t('search.clear')} onClick={() => { clearSearch(); searchInput.current?.focus() }}>
                  <IconCloseOutlineRegular size={12} className={css.clearIcon} />
                </button>
              )
              : searchShortcut !== undefined && <ShortcutKeys keys={searchShortcut.keys} className={css.searchHint} />}
          </label>
          <div className={css.headerActions}>
            {workspaces.length > 0 && (
              <Menu
                open={filterOpen}
                portal
                align="end"
                onClose={() => { setFilterOpen(false) }}
                items={filterItems}
                selectedIds={liveScope.size === 0 ? ['all'] : [...liveScope].map(id => `scope:${id}`)}
                onSelect={pickFilter}
                anchor={(
                  <button type="button" className={cx(css.iconButton, liveScope.size > 0 && css.iconButtonOn)} aria-label={filterLabel} title={filterLabel}
                    aria-haspopup="menu" aria-expanded={filterOpen} onClick={() => { setFilterOpen(value => !value) }}>
                    {scopedWorkspaces.length === 0
                      ? <IconSlidersTwoOutlineRegular size={16} className={css.icon} />
                      : (
                        <span className={css.scopeBadges}>
                          {scopedWorkspaces.slice(0, 2).map(workspace => <span key={workspace.workspaceId}>{badgeOf(workspace)}</span>)}
                        </span>
                      )}
                  </button>
                )}
              />
            )}
            {canAddWorkspace && (
              <button ref={addWorkspaceAnchor} type="button" className={css.iconButton} aria-label={t('workspace.add')} title={t('workspace.add')}
                onClick={addWorkspace}>
                <IconProjectAddOutlineRegular size={16} className={css.icon} />
              </button>
            )}
            <button type="button" className={css.iconButton} aria-label={newChatLabel} title={newChatLabel}
              onClick={() => { startSession(newChatWorkspace?.workspaceId) }}>
              <IconNewChatOutlineRegular size={16} className={css.icon} />
            </button>
          </div>
        </div>

        <div ref={scrollRef} className={css.scroll}>
          {trimmed !== ''
            ? (
              results.length === 0
                ? <p role="status" className={css.searchEmpty}>{messageHits.state === 'loading' ? t('search.searching') : messageHits.state === 'failed' ? t('search.failed') : t('search.empty')}</p>
                : (
                  <ul id="delo-sidebar-search-results" role="listbox" aria-label={t('search.aria')} className={css.results}>
                    {results.map(({ chat, snippet }, index) => (
                      <li key={chat.id} role="presentation">
                        <button
                          id={`delo-sidebar-result-${String(index)}`}
                          type="button"
                          role="option"
                          tabIndex={-1}
                          aria-selected={index === highlight}
                          className={css.result}
                          data-highlight={index === highlight}
                          onMouseMove={() => { setHighlight(index) }}
                          onClick={() => { openResult(chat.id) }}
                        >
                          {chat.workspace !== null && <WorkspaceBadge title={chat.workspace.title} workspaceId={chat.workspace.workspaceId} color={badgeColor(workspaces, chat.workspace.workspaceId)} />}
                          <span className={css.resultText}>
                            <span className={css.resultTitle}>{chat.title}</span>
                            {snippet !== undefined && <span className={css.resultSnippet}>{snippet}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
            )
            : (
              <HoverCardGroup className={css.group}>
                <ul className={css.list} role="presentation" data-dragging={dragged !== null}>
                  {folders
                    ? folderList.map((folder) => {
                      const expanded = folderOpen(folder)
                      const workspaceId = folder.workspace?.workspaceId
                      return [
                        <FolderHeader
                          key={`folder-${folderKey(folder)}`}
                          folder={folder}
                          color={workspaceId === undefined ? 'blue' : badgeColor(workspaces, workspaceId)}
                          expanded={expanded}
                          onToggle={() => { toggleFolder(folder) }}
                          onNewChat={workspaceId === undefined ? undefined : () => { startSession(workspaceId) }}
                          t={t}
                        />,
                        ...expanded ? folder.chats.map(chat => row(chat, chat.pinned ? 'pinned' : 'active', true)) : [],
                      ]
                    })
                    : (
                      <>
                        {sections.pinned.map(chat => row(chat, 'pinned'))}
                        <PinnedDivider dragging={dragged !== null} target={dragged?.verb === 'pin'} label={t('section.pinned')} />
                        {sections.active.map(chat => row(chat, 'active'))}
                      </>
                    )}
                  {empty && !(folders && folderList.length > 0) && (
                    <li className={css.empty}>
                      {emptyText}
                    </li>
                  )}
                  {shelfOrder.map((shelf, index) => {
                    const rows = sections[shelf]
                    const shown = shelfRows(shelf)
                    return [
                      <ShelfHeader key={`${shelf}-header`} shelf={shelf} label={t(`shelf.${shelf}`)} count={rows.length} expanded={shelves[shelf]}
                        onToggle={() => { toggleShelf(shelf) }} first={index === 0} over={overMarker(`${shelf}-header`)} />,
                      ...shelves[shelf] ? shown.map(chat => row(chat, shelf, false)) : [],
                      ...shelf === 'settled' && shelves.settled && rows.length > shown.length
                        ? [(
                          <li key="settled-more" className={css.shelfItem}>
                            <button type="button" className={css.more} onClick={() => { setSettledShown(count => count + SETTLED_PAGE) }}>
                              {t('shelf.more', { n: Math.min(SETTLED_PAGE, rows.length - shown.length) })}
                            </button>
                          </li>
                        )]
                        : [],
                    ]
                  })}
                  {!shelfOrder.includes('settled') && settledHeader && dragged !== null && (
                    <ShelfHeader shelf="settled" label={t('shelf.settled')} count={0} expanded={false} onToggle={undefined} first={shelfOrder.length === 0}
                      over={overMarker('settled-header')} />
                  )}
                </ul>
              </HoverCardGroup>
            )}
        </div>
        <UpdateNoticeCard face={updateNotice} t={t} />
        {iconWorkspace !== undefined && (
          <IconPicker
            t={t}
            target={{
              workspaceId: iconWorkspace.workspaceId, title: iconWorkspace.title, color: badgeColor(workspaces, iconWorkspace.workspaceId),
              icon: icons[iconWorkspace.workspaceId],
            }}
            onSave={(icon) => { setWorkspaceIcon(iconWorkspace.workspaceId, icon); setIconFor(null) }}
            onClose={() => { setIconFor(null) }}
          />
        )}
        {unpinAsk !== null && (
          <Modal
            open
            onClose={() => { setUnpinAsk(null) }}
            closeLabel={t('unpin.confirm.close')}
            title={t('unpin.confirm.title')}
            description={t('unpin.confirm.desc', { title: unpinAsk.title })}
            footer={(
              <>
                <Button variant="outline" onClick={() => { setUnpinAsk(null) }}>{t('unpin.confirm.cancel')}</Button>
                <Button onClick={() => { unpinWithUndo(unpinAsk.id); setUnpinAsk(null) }}>{t('unpin.confirm.action')}</Button>
              </>
            )}
          />
        )}
      </div>
    </WorkspaceIconsContext.Provider>
  )
}
