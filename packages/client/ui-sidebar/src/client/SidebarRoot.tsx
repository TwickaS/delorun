/**
 * Sidebar shell: column geometry and global panel navigation.
 * Collapse is a slide plus crossfade:
 * content freezes at its expanded width (inline style) and fades out in place
 * while the sliding column (AppFrame grid tracks) clips it — nothing reflows
 * mid-slide. At settle the wide-only content unmounts and the upper
 * controls enter the 56px rail from the same horizontal offset (one icon each,
 * same top-down order) on one fade that ends with the slide. The bottom-pinned
 * settings control only fades. The workspace/session browsing region between
 * global panel rows and the foot is the `sidebar.workspaces` registrant's,
 * and the foot holds `sidebar.settings` plus `sidebar.footer.action`; the shell
 * hands them the wide flag (plus an expand request callback for the browser).
 * Through the browser's hookContext, the shell also hands it the scroller hook
 * that continues wheel scrolling over the sidebar viewport into its list.
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 *
 * Collapsed, the shell can also lift itself out of the frame as a transient
 * hover peek: the same expanded content, fixed over the page at the column's
 * open width (the frame's --dsh-sidebar-expanded-width), while the frame keeps
 * the rail's track and the persisted collapse state does not change. It opens
 * on a pointer dwell of the rail's own surface (or the left edge where the
 * platform hides the rail), closes after a short grace and fade when the pointer
 * leaves, on Escape, and when keyboard focus leaves the panel, and it never arms from
 * a rail control, so every rail click keeps its meaning. Without a hovering
 * fine pointer, or in the phone drawer, there is no peek.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  FishLogo, IconAppsAddOutlineRegular, IconNewChatOutlineMedium, IconNewChatOutlineRegular,
  IconPanelLeftOutlineRegular, IconPinFillRegular, focusWithoutRing, isBehindModal, isDarwinDesktop, Menu, ShortcutKeys, Toast,
  Tooltip, useModalLayer, useSurfaceEdges, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  SidebarPanelActionsOwnerProps, SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected, SidebarSectionHookContext,
  SidebarSectionOwnerProps,
} from './contract/slots.ts'
import { FIXED_PANEL_ID } from './panel-pins.ts'
import { createScrollHandoff } from './scroll-handoff.ts'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

/**
 * Grace between the pointer leaving the peek and its close fade starting. Moving back into the panel inside the
 * grace keeps it open; Escape and focus leaving close it at once.
 */
const PEEK_CLOSE_GRACE_MS = 250

/** Hover-peek close fade; matches the 140ms `.peekClosing` animation. */
const PEEK_SETTLE_MS = 140

/** Width of the left-edge pointer band that opens the peek where the platform hides the rail, in px. */
const PEEK_EDGE_PX = 8

/**
 * Whether the device's primary pointer hovers, which is the only input the peek
 * serves. A view without matchMedia (jsdom in the unit lane, some embedded
 * browsers) gets no peek; its rail keeps the explicit expand control.
 * @returns whether `(hover: hover) and (pointer: fine)` matches.
 */
function hoveringPointer(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

/**
 * Whether a pointer target is one of the rail's own controls, whose click the
 * peek must not interrupt by moving them under the expanding overlay.
 * @param target - the pointer event's target, an Element for pointer events.
 * @returns whether the target sits inside a control.
 */
function isRailControl(target: EventTarget): boolean {
  return (target as Element).closest('button, a[href], [role="button"]') !== null
}

/**
 * Whether a focus target is an overlay that a panel control opened (a menu, a
 * dialog): focus moving there has not left the peek's task.
 * @param target - the focusout's related target.
 * @returns whether the target sits inside a menu, dialog or listbox.
 */
function isOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="menu"], [role="dialog"], [role="listbox"]') !== null
}

/**
 * Whether a pointer event lies inside the column's box. Leaving is decided by
 * geometry as well as by pointerleave: ui-settings renders a full-viewport
 * panel as a fixed-position DESCENDANT of the column, and an overlay can open
 * under a stationary pointer, so neither case emits the leave pair.
 * @param column - the column element, when mounted.
 * @param event - the pointer move.
 * @returns whether the pointer is inside the element's border box.
 */
function pointerInsideElement(column: HTMLElement | null, event: PointerEvent): boolean {
  const rect = column?.getBoundingClientRect()
  /* v8 ignore next -- the listener only exists while the column is mounted. */
  if (rect === undefined) return false
  return event.clientX >= rect.left && event.clientX < rect.right
    && event.clientY >= rect.top && event.clientY < rect.bottom
}

/** Format complete-build metadata for the local brand badge. */
function localBuildVersion(): string | undefined {
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined) return undefined
  const commit = process.env.DSH_CLIENT_COMMIT_HASH
  return version
    + (commit === undefined ? '' : `-${commit}`)
    + (process.env.DSH_CLIENT_GIT_DIRTY === 'true' ? '-dirty' : '')
}

type PanelRowProps =
  Pick<SidebarPanelMetadata, 'id' | 'label'>
  & Pick<SidebarSectionOwnerProps, 'wide'>
  & Pick<PropsRuntime<'sidebar'>, 'usePanelInfo'>
  & Pick<InjectFace<SidebarRootInjected>, 'selectPanel' | 'trackEntryClick' | 'setPinned'>
  & { readonly unpinLabel: string; readonly unpinTooltip: string; readonly canUnpin: boolean }
  & PropsRenderFactories
  & { readonly current?: ObservableSnapshot<boolean> }

/** A row that nothing but its own panel marks current. */
const NOT_CURRENT: ObservableSnapshot<boolean> = { getSnapshot: () => false, subscribe: () => () => {} }

/** Analytics category of an official panel; other panels are never reported. */
function officialEntry(id: string): 'plugin' | 'cron' | undefined {
  if (id === 'plugins') return 'plugin'
  return id === 'schedules' ? 'cron' : undefined
}

/** Each panel row subscribes only to its own selection state. */
function PanelRow({
  id, label, wide, unpinLabel, unpinTooltip, canUnpin, usePanelInfo, selectPanel, setPinned, trackEntryClick, renderFactorySlot,
  current = NOT_CURRENT,
}: PanelRowProps) {
  const selected = usePanelInfo(info => info.activePanelId === id)
  const subscribe = useCallback((listener: () => void) => current.subscribe(listener), [current])
  const standsFor = useSyncExternalStore(subscribe, () => current.getSnapshot())
  const active = selected || standsFor
  return (
    <div className={clsx(css.panelEntry, wide && css.panelEntryWide, active && css.panelEntryActive)}>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.panelRow}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            const entry = officialEntry(id)
            if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar' })
            selectPanel(id)
          }}
        >
          <span className={css.panelGlyph} aria-hidden="true">
            {renderFactorySlot('sidebar.panel.icon', { id, size: wide ? 16 : 18, active })}
          </span>
          {wide && (
            <span className={clsx(css.panelTitle, css.wide)}>
              {label}
            </span>
          )}
        </button>
      </Tooltip>
      {wide && canUnpin && <Tooltip label={unpinTooltip} side="bottom" align="end" delayMs={500} portal>
        <button type="button" className={css.panelUnpin} aria-label={unpinLabel} onClick={(event) => {
          // Unpin is rendered only while this navigation also renders More.
          const navigation = event.currentTarget.closest('nav') as HTMLElement
          const more = navigation.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
          focusWithoutRing(more)
          setPinned(id, false)
        }}>
          <IconPinFillRegular size={14} />
        </button>
      </Tooltip>}
    </div>
  )
}

type PanelMoreMenuProps =
  Pick<SidebarSectionOwnerProps, 'wide'>
  & Omit<SidebarPanelActionsOwnerProps, 'onDismiss'>
  & PropsRenderSlots<'sidebar.panellist.actions'>
  & Pick<InjectFace<SidebarRootInjected>, 'trackEntryClick'>
  & { readonly label: string }

/** The panel list's More launcher: a panel-row button whose menu rows come from `sidebar.panellist.actions`. */
function PanelMoreMenu({ wide, label, entries, onOpen, onPinnedChange, trackEntryClick, renderSlot }: PanelMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <Menu open={open} onClose={onDismiss} portal autoFocus className={css.moreAnchor} listClassName={css.moreMenu}
      anchor={(
        <Tooltip label={label} delayMs={500} disabled={wide}>
          <button type="button" className={css.panelRow} aria-label={label} aria-haspopup="menu" aria-expanded={open}
            onClick={() => {
              trackEntryClick({ menu_name: 'more', position: 'sidebar' })
              setOpen(value => !value)
            }}>
            <span className={css.panelGlyph} aria-hidden="true"><IconAppsAddOutlineRegular size={wide ? 16 : 18} /></span>
            {wide && <span className={clsx(css.panelTitle, css.wide)}>{label}</span>}
          </button>
        </Tooltip>
      )}>
      {renderSlot('sidebar.panellist.actions', { entries, onOpen, onPinnedChange, onDismiss })}
    </Menu>
  )
}

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({
  collapsed,
  width,
  drawer,
  startSession,
  toggleSidebar,
  selectPanel,
  setPinned,
  trackEntryClick,
  useRemoteAccess,
  usePanels,
  useEntryPins,
  useEntryActions,
  usePanelPlacement,
  useLeadPanel,
  useNewSessionButton,
  useFootRow,
  useHoverPeek,
  useShortcuts,
  usePanelInfo,
  t,
  renderSlot,
  renderFactorySlot,
}: SidebarRootComponentProps) {
  const panels = usePanels(snapshot => snapshot)
  const unpinned = useEntryPins(ids => ids)
  const activePanelId = usePanelInfo(info => info.activePanelId)
  const hasEntryActions = useEntryActions(registered => registered)
  // In the foot, the panels are a row of icon buttons with tooltips above the foot's own controls.
  const inFoot = usePanelPlacement(placement => placement) === 'footer'
  const leadEntry = useLeadPanel(entry => entry)
  const newSessionButton = useNewSessionButton(shown => shown)
  const footRow = useFootRow(row => row)
  const hoverPeek = useHoverPeek(peek => peek)
  const lead = panels.find(panel => panel.id === leadEntry?.panelId)
  const listed = lead === undefined ? panels : panels.filter(panel => panel.id !== lead.id)
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'sidebar.left.toggle'))
  const newShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.new'))
  // A page whose access snapshot excludes starting a Session offers no New Session affordance.
  const canStartSession = useRemoteAccess('session/create')
  const toggleLabel = collapsed ? t('toggle.open') : t('toggle.collapse')
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  // A closed drawer retains its content with the rail phase already settled.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (drawer || !collapsed) { setSettled(collapsed); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed, drawer])
  const windowsTitlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  // The hover peek's own phase: closed, open, or fading closed while its
  // expanded content stays mounted. It is a view of the collapsed state, never
  // a write to it, so the rail stays the persisted state throughout.
  const [peek, setPeek] = useState<'closed' | 'open' | 'closing'>('closed')
  const peekRef = useRef(peek)
  peekRef.current = peek
  const peeked = peek !== 'closed' && collapsed && !drawer
  const wide = drawer || peeked || (windowsTitlebar ? !collapsed : !collapsed || !settled)
  const [scrollHandoff] = useState(createScrollHandoff)
  const sectionHookContext = useMemo<SidebarSectionHookContext>(
    () => ({ useSectionScroller: scrollHandoff.useSectionScroller }), [scrollHandoff],
  )
  // The Windows titlebar hosts the New Session controls while the sidebar is collapsed.
  const openNewSession = (): void => {
    trackEntryClick({ menu_name: 'new_session', position: windowsTitlebar && collapsed ? 'titlebar' : 'sidebar' })
    startSession()
  }
  // The Windows caption menus occupy the strip to the right of these controls
  // (that is what --dsh-windows-menu-start reserves), so a right-side bubble
  // lands under their text. Below the caption is the only clear side.
  const captionTooltipSide = windowsTitlebar ? 'bottom' : 'right'
  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (drawer || !collapsed) lastWideWidth.current = width

  // A closed drawer returns to the static rail; only a live collapse fades it in.
  const animateRail = useRef(!collapsed)
  if (drawer || !collapsed) animateRail.current = !collapsed

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const sidebarFocus = useRef<Element | null>(null)
  useModalLayer(column, drawer && !collapsed, toggleSidebar)
  useSurfaceEdges(column, drawer && !collapsed, true)
  useLayoutEffect(() => {
    if (!collapsed) return
    const controlled = sidebarFocus.current?.getAttribute('aria-controls')?.split(/\s+/) ?? []
    const ownsMenuFocus = controlled.some(id => document.getElementById(id)?.contains(document.activeElement))
    if (sidebarFocus.current !== document.activeElement && !ownsMenuFocus) return
    const opener = drawer
      ? column.current?.ownerDocument.querySelector<HTMLElement>('[data-sidebar-opener]')
      : column.current?.querySelector<HTMLElement>('[data-sidebar-toggle]')
    if (opener != null && !isBehindModal(opener)) focusWithoutRing(opener, { preventScroll: true })
  }, [drawer, collapsed])
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. ui-settings renders its full-viewport panel as a
  // fixed-position DESCENDANT of this column, so a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      if (pointerInsideElement(column.current, event)) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  // Hover peek: the dwell is `SidebarLayout.setHoverPeek`'s delay. It is what leaves the rail's controls alone: the
  // pointer crosses the rail's surface on its way to a control, which cancels the arm, so a click that starts on a
  // control is not intercepted by the expanding panel (a zero delay gives that up). Dwell on the rail's own surface
  // (or on the left edge where the platform hides the rail) lifts the expanded shell over the page. The
  // pointer handlers arm it, both through the element and, where the column
  // has no rail to enter, through the document's left edge band; focus and
  // Escape end it. It never runs while the drawer is open.
  const peekTimer = useRef<number | undefined>(undefined)
  const peekEligible = useCallback((): boolean => hoverPeek.enabled && collapsed && !drawer && hoveringPointer()
    && !isBehindModal(column.current), [hoverPeek.enabled, collapsed, drawer])
  const cancelPeekArm = useCallback((): void => {
    if (peekTimer.current === undefined) return
    window.clearTimeout(peekTimer.current)
    peekTimer.current = undefined
  }, [])
  const armPeek = useCallback((): void => {
    if (peekTimer.current !== undefined || !peekEligible()) return
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = undefined
      if (!peekEligible()) return
      setPeek('open')
    }, hoverPeek.delayMs)
  }, [peekEligible, hoverPeek.delayMs])
  const closeGraceTimer = useRef<number | undefined>(undefined)
  const cancelPeekGrace = useCallback((): void => {
    if (closeGraceTimer.current === undefined) return
    window.clearTimeout(closeGraceTimer.current)
    closeGraceTimer.current = undefined
  }, [])
  const closePeek = useCallback((): void => {
    cancelPeekGrace()
    // A closing panel would unmount the focused control under the person;
    // hand focus to the rail's toggle (which survives both states) first.
    if (peekRef.current === 'open' && column.current?.contains(document.activeElement) === true) {
      const toggle = column.current.querySelector<HTMLElement>('[data-sidebar-toggle]')
      /* v8 ignore next -- every wide state renders the toggle in the logo row or the macOS strip. */
      if (toggle !== null) focusWithoutRing(toggle, { preventScroll: true })
    }
    setPeek('closing')
  }, [cancelPeekGrace])
  // A pointer that left starts the close after the grace; a pending grace keeps its original deadline.
  const closePeekAfterGrace = useCallback((): void => {
    if (peekRef.current === 'closed' || closeGraceTimer.current !== undefined) return
    closeGraceTimer.current = window.setTimeout(() => {
      closeGraceTimer.current = undefined
      closePeek()
    }, PEEK_CLOSE_GRACE_MS)
  }, [closePeek])
  // Expanding, collapsing into the drawer, or leaving the rail ends the peek;
  // its trigger and close timer go with it.
  useEffect(() => {
    if (collapsed && !drawer && hoverPeek.enabled) return
    cancelPeekArm()
    cancelPeekGrace()
    setPeek('closed')
  }, [collapsed, drawer, hoverPeek.enabled, cancelPeekArm, cancelPeekGrace])
  // The close fade keeps the expanded content mounted for its duration.
  useEffect(() => {
    if (peek !== 'closing') return
    const timer = window.setTimeout(() => { setPeek('closed') }, PEEK_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [peek])
  useEffect(() => cancelPeekArm, [cancelPeekArm])
  useEffect(() => cancelPeekGrace, [cancelPeekGrace])
  // Leaving is decided by the panel's BOX as well as by pointerleave: opening
  // under a stationary pointer (the left edge band) leaves the browser no
  // enter/leave pair to report, so the next move to the page closes it. Moves
  // over a menu or dialog the panel opened still belong to the peek.
  useEffect(() => {
    if (!peeked) return
    const onMove = (event: PointerEvent): void => {
      if (pointerInsideElement(column.current, event)) { cancelPeekGrace(); return }
      if (isOverlayTarget(event.target)) return
      closePeekAfterGrace()
    }
    document.addEventListener('pointermove', onMove)
    return () => { document.removeEventListener('pointermove', onMove) }
  }, [peeked, cancelPeekGrace, closePeekAfterGrace])
  // Escape closes the peek from anywhere, including from inside its panel.
  useEffect(() => {
    if (peek === 'closed') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      closePeek()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [peek, closePeek])
  // macOS desktop and the Windows caption hide the collapsed column instead of
  // keeping a rail, so the left edge band is the trigger there; a rail takes
  // that role itself through the root's own pointer handlers.
  useEffect(() => {
    if (!collapsed || drawer || width > 0 || peek !== 'closed') return
    const onMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return
      if (event.clientX <= PEEK_EDGE_PX) armPeek()
      else cancelPeekArm()
    }
    document.addEventListener('pointermove', onMove)
    return () => { document.removeEventListener('pointermove', onMove) }
  }, [collapsed, drawer, width, peek, armPeek, cancelPeekArm])

  const buildVersion = localBuildVersion()
  // The local-build fallbacks copy the badge text; the brand button below
  // skips New Session for clicks inside them. The click still bubbles, so
  // document-level outside-click listeners see it.
  // Each successful copy bumps the key so a repeated copy replays the toast.
  const [copiedToast, setCopiedToast] = useState<number | null>(null)
  const copyVersion = (version: string) => (): void => {
    void writeClipboard(version).then((ok) => {
      if (ok) setCopiedToast(seq => (seq ?? 0) + 1)
    })
  }

  const panelsWide = wide && !inFoot
  const panelList = listed.length === 0 ? null : (
    <nav className={clsx(css.panelList, inFoot && css.footPanels)} aria-label={t('panels.label')}>
      {listed.filter(({ id }) => id === FIXED_PANEL_ID || !hasEntryActions || !unpinned.includes(id)).map(({ id, label }) => (
        <PanelRow
          key={id}
          id={id}
          label={label}
          wide={panelsWide}
          unpinLabel={t('panels.unpin', { name: label })}
          unpinTooltip={t('panels.unpinTooltip')}
          canUnpin={hasEntryActions && id !== FIXED_PANEL_ID}
          setPinned={setPinned}
          usePanelInfo={usePanelInfo}
          selectPanel={selectPanel}
          trackEntryClick={trackEntryClick}
          renderFactorySlot={renderFactorySlot}
        />
      ))}
      {hasEntryActions && (
        <PanelMoreMenu
          wide={panelsWide}
          label={t('panels.more')}
          entries={listed.filter(({ id }) => id !== FIXED_PANEL_ID)
            .map(({ id, label }) => ({ id, label, pinned: !unpinned.includes(id), active: id === activePanelId }))}
          onOpen={(id) => {
            const entry = officialEntry(id)
            if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar_more' })
            const panel = panels.find(candidate => candidate.id === id)
            if (panel !== undefined) selectPanel(panel.id)
          }}
          onPinnedChange={setPinned}
          trackEntryClick={trackEntryClick}
          renderSlot={renderSlot}
        />
      )}
    </nav>
  )

  const settingsArea = (
    <div className={css.settingsArea}>
      {renderSlot('sidebar.settings', { wide })}
    </div>
  )

  const darwinDesktop = isDarwinDesktop()
  // Rail resting state is the whale mark; hovering swaps in the panel icon
  // (the expand affordance, figma sidebar-hover flow). Expanded it is a plain
  // panel icon.
  const toggle = (
    <Tooltip label={toggleLabel} shortcutKeys={shortcut?.keys} delayMs={500} side={captionTooltipSide} portal={drawer}>
      <button
        data-sidebar-toggle
        data-modal-autofocus={drawer || undefined}
        type="button"
        className={clsx(css.iconButton, css.toggle)}
        aria-label={toggleLabel}
        aria-keyshortcuts={shortcut?.aria}
        onClick={() => { toggleSidebar() }}
      >
        {!wide && !windowsTitlebar && (
          <span className={css.railMark} aria-hidden="true">
            {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo size={24} /> })}
          </span>
        )}
        {/* Rail icons render at 18 (figma rail spec); expanded keeps the glyph-native sizes. */}
        <IconPanelLeftOutlineRegular className={css.panelIcon} size={wide || windowsTitlebar ? 16 : 18} />
        {!wide && renderSlot('sidebar.toggle.badge', {})}
      </button>
    </Tooltip>
  )

  return (
    <div
      ref={column}
      onFocusCapture={(event) => { sidebarFocus.current = event.target }}
      role={drawer ? 'dialog' : undefined}
      data-shortcut-modal={drawer ? 'sidebar' : undefined}
      aria-modal={drawer && !collapsed ? true : undefined}
      aria-label={drawer ? t('navigation.label') : undefined}
      tabIndex={drawer ? -1 : undefined}
      data-sidebar-peek={peek === 'closed' ? undefined : peek}
      data-delorun-edge-surface="sidebar"
      className={clsx(
        css.root, !wide && css.collapsed, !wide && animateRail.current && css.railIn,
        // The peek overlay replaces the collapse crossfade: it is already
        // the expanded shell, so nothing fades and nothing reflows.
        !drawer && collapsed && wide && !peeked && css.fading,
        peeked && css.peeking, peek === 'closing' && css.peekClosing,
        !pointerInside && css.quietBars,
      )}
      style={wide && !peeked ? { width: !drawer && collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={(event) => {
        cancelLinger()
        setPointerInside(true)
        if (event.pointerType === 'touch') return
        // Returning during the close fade reopens at once; a fresh entry arms
        // the dwell, unless it lands on a rail control (whose click the peek
        // must not move out from under the pointer).
        if (peek !== 'closed') { cancelPeekGrace(); setPeek('open'); return }
        if (!isRailControl(event.target)) armPeek()
      }}
      onPointerMove={(event) => {
        if (peek !== 'closed' || !collapsed || drawer || event.pointerType === 'touch') return
        if (isRailControl(event.target)) cancelPeekArm()
        else armPeek()
      }}
      onPointerLeave={() => {
        armLinger()
        cancelPeekArm()
        closePeekAfterGrace()
      }}
      onBlurCapture={(event) => {
        if (peek === 'closed') return
        const next = event.relatedTarget
        // Focus moving between controls of the panel stays inside; focus moving
        // into a menu or dialog that the panel opened is still part of the
        // panel task. Anything else has left the peek.
        if (next instanceof Node && (column.current?.contains(next) === true || isOverlayTarget(next))) return
        closePeek()
      }}
    >
      {wide && <div className={css.backdrop} aria-hidden="true">{renderSlot('sidebar.backdrop', {})}</div>}
      {/* macOS hiddenInset titlebar: the strip shares the row with the
          traffic lights and keeps the toggle at the sidebar's top-right. */}
      {darwinDesktop && <div className={css.topStrip} data-window-drag>{toggle}</div>}
      <div className={css.logoRow} data-window-drag>
        {/* Expanded, the brand doubles as a New Session shortcut while the
            access snapshot allows `session/create` — except on
            macOS, where it stays part of the logo row's window-drag surface
            (the drag-row controls rule would subtract a button);
            the collapsed rail's logo is the expand toggle below instead.
            Mouse clicks on the local-build fallbacks copy the version instead. */}
        {wide && (() => {
          const identity = (
            <span className={css.brandIdentity} aria-hidden="true">
              <span className={css.brandMark}>
                {renderSlot('sidebar.brand.mark', { size: 24 }, {
                  fallback: buildVersion === undefined
                    ? <FishLogo size={24} />
                    : <span className={css.copyVersion} data-copy-version onClick={copyVersion(buildVersion)}><FishLogo size={24} /></span>,
                })}
              </span>
              <span className={css.brandName}>
                {renderSlot('sidebar.brand.name', {}, {
                  fallback: buildVersion === undefined
                    ? <span className={css.fallbackBrandName}>{t('brand.localBuild')}</span>
                    : (
                      <span className={clsx(css.localBuildBrand, css.copyVersion)} data-copy-version onClick={copyVersion(buildVersion)}>
                        <span className={css.localBuildTitle}>{t('brand.localBuild')}</span>
                        <span className={css.buildVersion}>{buildVersion}</span>
                      </span>
                    ),
                })}
              </span>
            </span>
          )
          return darwinDesktop || !canStartSession
            ? <span className={clsx(css.brand, css.wide)}>{identity}</span>
            : (
              <button
                type="button"
                className={clsx(css.brand, css.wide)}
                aria-label={t('session.new.label')}
                aria-keyshortcuts={newShortcut?.aria}
                onClick={(event) => {
                  if ((event.target as Element).closest('[data-copy-version]') !== null) return
                  openNewSession()
                }}
              >
                {identity}
              </button>
            )
        })()}
        {!darwinDesktop && toggle}
      </div>
      {wide && renderSlot('sidebar.brand.badge', {})}

      {lead !== undefined && (
        <div className={css.leadPanel}>
          <PanelRow
            id={lead.id}
            label={lead.label}
            wide={wide}
            unpinLabel={t('panels.unpin', { name: lead.label })}
            unpinTooltip={t('panels.unpinTooltip')}
            canUnpin={false}
            setPinned={setPinned}
            usePanelInfo={usePanelInfo}
            selectPanel={selectPanel}
            trackEntryClick={trackEntryClick}
            renderFactorySlot={renderFactorySlot}
            {...(leadEntry?.current === undefined ? {} : { current: leadEntry.current })}
          />
        </div>
      )}

      {/* The label fades before the hover/focus shortcut, including on translucent backgrounds. */}
      {canStartSession && (newSessionButton || !wide) && (
        <div className={css.newSessionRow}>
          {renderSlot('sidebar.session.action', { wide }, {
            children: (
              <Tooltip label={t('session.new.label')} shortcutKeys={newShortcut?.keys} delayMs={500} side={captionTooltipSide} disabled={wide}>
                <button
                  type="button"
                  className={css.newSession}
                  aria-label={t('session.new.label')}
                  aria-keyshortcuts={newShortcut?.aria}
                  onClick={openNewSession}
                >
                  <span className={css.newSessionLabelMask}><span className={css.newSessionContent}>
                    {wide
                      ? <IconNewChatOutlineMedium size={14} />
                      : <IconNewChatOutlineRegular size={windowsTitlebar ? 16 : 18} />}
                    {wide && <span className={clsx(css.newSessionLabel, css.wide)}>{t('session.new')}</span>}
                  </span></span>
                  {wide && newShortcut !== undefined && newShortcut.keys.length > 0 && <span className={css.newSessionShortcut} aria-hidden="true">
                    <ShortcutKeys keys={newShortcut.keys} />
                  </span>}
                </button>
              </Tooltip>
            ),
          })}
        </div>
      )}

      <div className={css.scrollRegion}>
        <div
          ref={scrollHandoff.bindViewportRef}
          className={css.scrollArea}
          data-sidebar-scrollport={wide ? '' : undefined}
        >
          {!inFoot && panelList}
          <div className={css.sectionsArea}>
            {renderSlot('sidebar.sections', {
              wide,
              expandSidebar: () => { if (collapsed) toggleSidebar() },
            })}
          </div>
          <div className={css.regionArea}>
            {renderSlot('sidebar.workspaces', {
              wide,
              expandSidebar: () => { if (collapsed) toggleSidebar() },
            }, { hookContext: sectionHookContext })}
          </div>
        </div>
        <span className={css.scrollFade} aria-hidden="true" />
      </div>

      {copiedToast !== null && (
        <Toast key={copiedToast} tone="success" text={t('version.copied')} onDone={() => { setCopiedToast(null) }} />
      )}

      {/* Footer actions stack above Settings, or, in a wide one-row foot, end the settings row. */}
      <div className={css.footArea}>
        {inFoot && !wide && panelList}
        {wide && footRow
          ? (
            <div className={css.footRow}>
              {settingsArea}
              {inFoot && panelList}
              <span className={css.footSpacer} aria-hidden="true" />
              <div className={css.footerActionsInline}>{renderSlot('sidebar.footer.action', { wide, inline: true })}</div>
            </div>
          )
          : (
            <>
              <div className={css.footerActions}>
                {renderSlot('sidebar.footer.action', { wide })}
              </div>
              {/* Wide, panels placed in the foot share the settings row, at its end. */}
              {inFoot && wide
                ? <div className={css.footRow}>{settingsArea}{panelList}</div>
                : settingsArea}
            </>
          )}
      </div>
    </div>
  )
}
