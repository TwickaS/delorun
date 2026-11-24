/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel with the section nav rail. In browsers below 768px the panel fills
 * the viewport and the rail turns into a horizontal strip; Windows and macOS
 * desktop windows retain the rail
 * (SettingsRoot.module.css). The shell is a pure composition face —
 * slot-owned text (trigger label, panel title, close label, sections) arrives
 * from registrants through slots; accessible names resolve from localized
 * content (trigger: shell locale; dialog: aria-labelledby the title node;
 * close: visually-hidden slot text). Modal open state and the active section
 * id belong to the declared owner store; the onboarding coordinator mounts
 * exactly one ordered registrant while the sessions-derived empty-Hero fact
 * is active. Visible dialog chrome belongs to the step, so a
 * mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  ConnectionIndicator, Tooltip, useModalLayer, useSurfaceEdges,
  IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconChevronLeftOutlineRegular, IconCloseOutlineRegular, IconDataOutlineMedium,
  IconPersonalizationOutlineMedium, IconSearchOutlineRegular, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import { GENERAL_SECTION_ID, searchNav, UNPLACED_ITEMS_PAGE, type SettingsNav, type SettingsNavPage } from './layout.ts'
import css from './SettingsRoot.module.css'
import { DesktopUpdateIndicator } from './DesktopUpdateIndicator.tsx'

/** Width at or below which the panel is a list of pages that each open full screen. */
const PHONE_QUERY = '(max-width: 600px)'

const subscribePhone = (listener: () => void): (() => void) => {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(PHONE_QUERY)
  query.addEventListener('change', listener)
  return () => { query.removeEventListener('change', listener) }
}

/** Whether the panel uses the phone list: a narrow viewport outside the desktop windows, which keep the rail. */
const phoneSnapshot = (): boolean => {
  if (typeof window.matchMedia !== 'function') return false
  const root = document.documentElement
  return window.matchMedia(PHONE_QUERY).matches && !root.hasAttribute('data-windows-titlebar') && root.dataset.platform !== 'darwin'
}

const RECOVERY_CONFIRMATION_MS = 2_000

/** Minimum visible time for the connecting pill; shorter attempts read as flicker. */
const CONNECTING_MIN_VISIBLE_MS = 800

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'account') return <IconUserOutlineMedium size={16} />
  if (id === 'models') return <IconDataOutlineMedium size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium size={16} />
  return <IconSettingsOutlineMedium size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  /** The grouped navigation when a layout is registered; the flat list otherwise. */
  nav: SettingsNav | undefined
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
  /** The shell's `back` label, for the phone page header. */
  backLabel: string
}

/** A section drawn inside an onboarding step has no panel to close. */
const noSectionClose = (): void => {}

/**
 * Body-portaled modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, nav, renderSlot, activeId, onSelect, onClose, backLabel }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone. In a grouped
  // layout a requested section id selects the page that holds it.
  const pages = useMemo(() => nav?.groups.flatMap(group => group.pages) ?? [], [nav])
  const activePage = nav === undefined
    ? undefined
    : (pages.find(page => page.id === activeId)
      ?? pages.find(page => page.blocks.some(block => block.kind === 'section' && block.id === activeId))
      ?? pages[0])
  const active = nav === undefined ? (rows.find(r => r.id === activeId)?.id ?? rows[0]?.id) : activePage?.id
  const titleId = useId()
  const [query, setQuery] = useState('')
  const [anchor, setAnchor] = useState<string | undefined>()
  const options = useRef<HTMLDivElement>(null)
  const results = useMemo(() => (nav === undefined ? [] : searchNav(nav, query)), [nav, query])
  const searching = query.trim() !== ''
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot)
  // On a phone the panel opens on the list unless a section was requested; a pick on any width shows its page.
  const [showList, setShowList] = useState(activeId === undefined)
  const phoneView = !phone || nav === undefined ? undefined : searching ? 'results' : showList ? 'list' : 'page'
  const back = useRef<HTMLButtonElement>(null)
  const opened = useRef<string | undefined>(undefined)
  const select = useCallback((id: string) => {
    opened.current = id
    setShowList(false)
    onSelect(id)
  }, [onSelect])

  // A search result opens its page, then brings its card or row into view.
  useEffect(() => {
    if (anchor === undefined || searching) return
    const target = Array.from(options.current?.querySelectorAll<HTMLElement>('[data-settings-anchor]') ?? [])
      .find(node => node.dataset.settingsAnchor === anchor)
    if (target === undefined) return
    target.scrollIntoView({ block: 'start' })
    setAnchor(undefined)
  }, [anchor, searching, active])

  const panel = useRef<HTMLDivElement>(null)
  useModalLayer(panel, true, onClose)
  useSurfaceEdges(panel, true)

  // Focus follows the view: the back arrow when a page opens, the page's row when the list returns, and the panel when a
  // width change removes the focused control.
  const seenView = useRef(phoneView)
  useEffect(() => {
    const previous = seenView.current
    seenView.current = phoneView
    if (previous === phoneView) return
    if (phoneView === 'page') back.current?.focus()
    else if (phoneView === 'list' && opened.current !== undefined) {
      const row = Array.from(panel.current?.querySelectorAll<HTMLElement>('[data-page-id]') ?? []).find(node => node.dataset.pageId === opened.current)
      row?.focus()
    } else if (!panel.current?.contains(document.activeElement)) panel.current?.focus()
  }, [phoneView])

  // Portalled beside #root like the Modal primitive: a covering surface mounted
  // inside the root would precede the columns' chrome in document order, so a
  // chrome row that declares window drag after it would override its subtraction.
  // Beside the root, base.css's `body > :not(#root)` rule subtracts it instead.
  return createPortal((
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div ref={panel} tabIndex={-1} data-shortcut-modal="settings" className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
        data-phone={phoneView}
        data-delorun-edge-surface="settings">
        {/* The four seats stay direct children of the panel and take their
            places from its grid: title and header share the first row, the
            navigation and the active section the second. */}
        <div className={css.navTitle} id={phoneView === 'page' ? undefined : titleId} tabIndex={-1} data-modal-autofocus={active === undefined ? '' : undefined}>
          {phoneView === 'page' && (
            <button ref={back} type="button" className={css.back} aria-label={backLabel} onClick={() => { setShowList(true) }}>
              <IconChevronLeftOutlineRegular size={18} />
            </button>
          )}
          {phoneView === 'page' && activePage !== undefined
            ? <span id={titleId} className={css.navTitleText}>{activePage.label}</span>
            : renderSlot('settings.header', {})}
        </div>
        <nav className={css.nav}>
          {nav !== undefined && (
            <label className={css.search}>
              <IconSearchOutlineRegular size={14} className={css.searchIcon} />
              <input
                type="search"
                className={css.searchInput}
                value={query}
                placeholder={nav.searchPlaceholder}
                aria-label={nav.searchPlaceholder}
                onChange={(event) => { setQuery(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Escape' && query !== '') { event.stopPropagation(); setQuery('') } }}
              />
            </label>
          )}
          {nav !== undefined && (
            <div className={clsx(css.navList, css.navGroups)}>
              {nav.groups.map(group => (
                <div key={group.id} className={css.navGroup} role="group" aria-label={group.label}>
                  <div className={css.navGroupLabel} aria-hidden="true">{group.label}</div>
                  <div className={css.navGroupCells}>
                    {group.pages.map(page => (
                      <NavCell key={page.id} id={page.id} label={page.label} icon={page.icon}
                        active={!searching && page.id === active} renderSlot={renderSlot}
                        onSelect={(id) => { setQuery(''); select(id) }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {nav === undefined && <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                data-modal-autofocus={row.id === active ? '' : undefined}
                onFocus={(event) => { event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}
                onClick={() => { onSelect(row.id) }}
              >
                <span className={css.navIcon} aria-hidden="true">
                  {renderSlot('settings.section.icon', { size: 16, active: row.id === active }, {
                    only: row.id, fallback: navIcon(row.id),
                  })}
                </span>
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>}
        </nav>
        <div className={css.header}>
          <div className={css.actions}>{renderSlot('settings.action', {})}</div>
          <button type="button" className={css.close} onClick={onClose}>
            <IconCloseOutlineRegular size={14} />
            <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
          </button>
        </div>
        <div ref={options} className={css.options}>
          {nav === undefined && active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          {nav !== undefined && searching && (
            <ul className={css.results}>
              {results.length === 0 && <li className={css.resultsEmpty}>{nav.searchEmpty}</li>}
              {results.map(result => (
                <li key={`${result.pageId}/${result.anchor ?? ''}`}>
                  <button type="button" className={css.result}
                    onClick={() => { setQuery(''); setAnchor(result.anchor); select(result.pageId) }}>
                    {result.path.map((part, index) => (
                      <span key={index} className={index === result.path.length - 1 ? css.resultName : css.resultPath}>{part}</span>
                    ))}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {nav !== undefined && !searching && activePage !== undefined && (
            <GroupedPage page={activePage} renderSlot={renderSlot} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  ), document.body)
}

/** One cell of the grouped navigation; its icon sits in the same wrapper as the flat rows. */
function NavCell({ id, label, icon: Icon, active, renderSlot, onSelect }: {
  id: string
  label: string
  icon: SettingsNavPage['icon']
  active: boolean
  renderSlot: PanelProps['renderSlot']
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      className={clsx(css.navCell, active && css.active)}
      aria-current={active ? 'true' : undefined}
      data-modal-autofocus={active ? '' : undefined}
      onFocus={(event) => { event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }}
      data-page-id={id}
      onClick={() => { onSelect(id) }}
    >
      <span className={css.navIcon} aria-hidden="true">
        {Icon === undefined
          ? renderSlot('settings.section.icon', { size: 16, active }, { only: id, fallback: navIcon(id) })
          : <Icon size={16} />}
      </span>
      <span className={css.navLabel}>{label}</span>
    </button>
  )
}

/**
 * A grouped-layout page: its title, then each block in order. A card of
 * General rows renders the General section's entry with the rows it holds.
 */
function GroupedPage({ page, renderSlot, onClose }: {
  page: SettingsNavPage
  renderSlot: PanelProps['renderSlot']
  onClose: () => void
}) {
  return (
    <div className={clsx(css.page, page.titled && css.titledPage)}>
      {page.titled && <h2 className={css.pageTitle}>{page.label}</h2>}
      {page.blocks.map(block => (block.kind === 'section'
        ? (
          <div key={`section:${block.id}`} className={css.pageSection} data-settings-anchor={block.id}>
            {renderSlot('settings.section', { close: onClose }, { only: block.id })}
          </div>
        )
        : (
          <section key={`items:${block.id}`} className={css.card} data-settings-anchor={block.id}
            aria-label={block.heading ?? (page.id === UNPLACED_ITEMS_PAGE ? page.label : undefined)}>
            {block.heading !== undefined && <h3 className={css.cardHeading}>{block.heading}</h3>}
            <div className={css.cardBody}>
              {renderSlot('settings.section', { close: onClose, items: block.items.map(item => item.id) }, { only: GENERAL_SECTION_ID })}
            </div>
          </section>
        )))}
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useSessions, renderSlot, t,
    useDesktopUpdate, openDesktopUpdate, useStore, actions, useShortcuts, useNav,
  } = props
  const { open, activeId, onboarding: requestedOnboarding } = useStore(state => state)
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'settings.open'))
  const { close, openSection, requestOnboarding, finishOnboarding } = actions
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const [holdConnecting, setHoldConnecting] = useState(false)
  const connectingShownAt = useRef<number | undefined>(undefined)

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const nav = useNav(state => state)
  const desktopUpdate = useDesktopUpdate(state => state)
  const connectionState = useConnectionState(state => state)
  const previousConnectionState = useRef(connectionState)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions((state) => {
    const main = Object.values(state.byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)
    return state.phase === 'ready' && (main === undefined || main.blank)
  })
  const onboardingStep = requestedOnboarding !== undefined
    ? onboardingSteps.find(step => step.id === requestedOnboarding)
    : onboardingActive
      ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
      : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const onboardingStepSeen = useRef(onboardingStep)
  // An onboarding step owns the viewport and marks `#root` inert. The panel portals
  // beside `#root`, outside that mark, so a step that appears while the panel is open
  // takes the panel down rather than leaving it focusable behind the onboarding mask.
  useEffect(() => {
    const appeared = onboardingStepSeen.current === undefined && onboardingStep !== undefined
    onboardingStepSeen.current = onboardingStep
    if (appeared && open) close()
  }, [onboardingStep, open, close])

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
  }, [connectionState])

  // The confirmation window starts when the recovered pill becomes visible,
  // which the connecting minimum-visible hold can delay past the transition.
  useLayoutEffect(() => {
    if (!showRecovery || holdConnecting) return
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [showRecovery, holdConnecting])

  useLayoutEffect(() => {
    if (connectionState === 'connecting') {
      connectingShownAt.current = Date.now()
      return
    }
    const shownAt = connectingShownAt.current
    if (shownAt === undefined) return
    connectingShownAt.current = undefined
    const remaining = CONNECTING_MIN_VISIBLE_MS - (Date.now() - shownAt)
    if (remaining <= 0) return
    setHoldConnecting(true)
    const timeout = window.setTimeout(() => { setHoldConnecting(false) }, remaining)
    return () => {
      window.clearTimeout(timeout)
      setHoldConnecting(false)
    }
  }, [connectionState])

  const completeOnboardingStep = useCallback((id: string) => {
    finishOnboarding()
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [finishOnboarding])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'connecting' || holdConnecting) {
    connectionIndicator = 'connecting'
  } else if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  return (
    <>
      <div className={clsx(css.triggerRow, !wide && css.railRow)}>
        {renderSlot('settings.launcher', {
          wide, settingsOpen: open, openSettings: (sectionId) => {
            if (sectionId === undefined) actions.open()
            else actions.openSection(sectionId)
          },
          ...(shortcut?.keys.length ? { settingsShortcut: { keys: shortcut.keys, aria: shortcut.aria } } : {}),
          openOnboarding: requestOnboarding,
        }, { fallback: <Tooltip disabled={open} label={t('trigger')} shortcutKeys={shortcut?.keys}>
          <button
            type="button"
            className={clsx(css.trigger, !wide && css.rail)}
            aria-label={t('trigger')}
            aria-keyshortcuts={shortcut?.aria}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => { actions.open() }}
          >
            {renderSlot('settings.trigger', { wide })}
          </button>
        </Tooltip> })}
        <ConnectionIndicator
          // A plugin that shows the connection's state elsewhere (Delorun's pinned alert) marks the root, which withdraws this pill.
          state={wide && desktopUpdate.presentation?.phase !== 'installing' && !document.documentElement.hasAttribute('data-delorun-connection-alert')
            ? connectionIndicator
            : undefined}
          disconnectedLabel={t('connection.error')}
          connectingLabel={t('connection.connecting')}
          recoveredLabel={t('connection.connected')}
          reconnectActionLabel={t('connection.reconnect')}
          restartActionLabel={t('connection.restart')}
          onReconnect={reconnect}
        />
        <DesktopUpdateIndicator wide={wide} hidden={connectionIndicator !== undefined && desktopUpdate.presentation?.phase !== 'installing'}
          t={t} view={desktopUpdate} onOpen={openDesktopUpdate} />
      </div>
      {open && (
        <SettingsPanel
          rows={rows}
          nav={nav}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={actions.select}
          onClose={close}
          backLabel={t('back')}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        explicit: requestedOnboarding !== undefined,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
        renderSection: id => renderSlot('settings.section', { close: noSectionClose }, { only: id }),
        completeStep: completeOnboardingStep,
      }, { only: onboardingStep.id })}
    </>
  )
}
