/**
 * The Multiview entry points in the chat header: the pin button on each row of the agents list, the popover's footer with
 * the layout picker, "Pin running" and "Open Multiview", and the icon toggle at the end of the agents action with its amber dot,
 * its layouts popover and the one-time hint.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCloseOutlineRegular, IconPinFillRegular, IconPinOutlineRegular, IconSettingsOutlineRegular, MenuSurface, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, Translate as TranslateOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MAX_PANES_RANGE, type MultiviewSettings } from '../config.ts'
import { LayoutPicker, type CapacityRefusal, type LayoutsLocaleKey } from '../layout/index.ts'
import type { MULTIVIEW_NS } from '../client/contract.ts'
import { EMPTY_CHAT_MULTIVIEW, type ChatMultiview, type MultiviewService } from '../client/contract.ts'
import type { HintPreference } from './hint.ts'
import { catalogOf, ownerOf, runningAgentsOf } from './read.ts'
import css from './Entry.module.css'

/** What the entry points read and do. */
export interface EntryInjected {
  /** The pins, layouts and open state. */
  readonly multiview: MultiviewService
  /** The layout copy for the layout picker: `ctx.locale.bind(LAYOUTS_NS)`. */
  readonly layoutsT: TranslateOf<LayoutsLocaleKey>
  /** The keys bound to the focus command, empty while it is unbound or the studio has no keyboard settings. */
  readonly focusKeys?: HostObservable<readonly string[]>
  /** Whether the one-time hint has been shown; without it the hint never shows. */
  readonly hint?: HintPreference
}

type Translate = PropsLocale<typeof MULTIVIEW_NS>['t']

/** The state of one chat as React state. */
function useChat(multiview: MultiviewService, chat: SessionId): ChatMultiview {
  const source = multiview.of(chat)
  return useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot())
}

/** The sentence a refused pin gives. */
function refusalText(t: Translate, reason: CapacityRefusal, maxPanes: number): string {
  return reason === 'max-panes' ? t('pin.refused.max-panes', { max: String(maxPanes) }) : t('pin.refused.no-room')
}

/** Props of the pin button on an agents-list row. */
export type PinButtonProps = PropsRuntime<'conversation.session.header.actions.subagent.row.trail'>
  & PropsLocale<typeof MULTIVIEW_NS> & InjectFace<EntryInjected>

/**
 * The pin button of one row: a filled pin while the agent is pinned. With the pane limit reached, or no room on the screen,
 * an unpinned agent's button is disabled and says why.
 * @param props - the row, the services and the dictionary.
 * @returns the button.
 */
export function PinButton({ sessionId, label, useSessions, multiview, t }: PinButtonProps) {
  const chat = useSessions(state => ownerOf(state, sessionId))
  const { pins } = useChat(multiview, chat)
  const settings = useSyncExternalStore(listener => multiview.settings.subscribe(listener), () => multiview.settings.getSnapshot())
  const pinned = pins.includes(sessionId)
  const refusal = pinned ? undefined : multiview.capacityRefusal(chat)
  const reason = refusal === undefined ? undefined : refusalText(t, refusal, settings.maxPanes)
  const action = pinned ? t('unpin') : t('pin')
  return (
    <Tooltip label={reason ?? action} side="bottom" align="end" delayMs={500} portal>
      <button
        type="button"
        className={css.pin}
        data-pinned={pinned || undefined}
        aria-pressed={pinned}
        aria-disabled={reason !== undefined || undefined}
        aria-label={pinned ? t('unpin.aria', { agent: label }) : t('pin.aria', { agent: label })}
        aria-description={reason}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (pinned) multiview.unpin(chat, sessionId)
          else if (reason === undefined) multiview.pin(chat, sessionId)
        }}
        onKeyDown={(event) => { event.stopPropagation() }}
      >
        {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}

/** Props of the agents list's control bar. */
export type HeaderProps = PropsRuntime<'conversation.session.header.actions.subagent.header'>
  & PropsLocale<typeof MULTIVIEW_NS> & InjectFace<EntryInjected>

/**
 * The agents list's control bar: the pane limit as a stepper, "Unpin all" while anything is pinned, and the settings button
 * that opens the pane's own settings. Each control states its own job; nothing here explains the pane.
 * @param props - the chat, the services and the dictionary.
 * @returns the bar.
 */
export function Header({ sessionId, multiview, layoutsT, t }: HeaderProps) {
  const { pins } = useChat(multiview, sessionId)
  const settings = useSyncExternalStore(listener => multiview.settings.subscribe(listener), () => multiview.settings.getSnapshot())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLButtonElement>(null)
  const anchorName = `--multiview-header-${useId().replaceAll(':', '')}`
  const closeSettings = (restoreFocus: boolean): void => {
    setSettingsOpen(false)
    if (restoreFocus) settingsRef.current?.focus()
  }
  return (
    <div className={css.header} role="group" aria-label={t('header.aria')}>
      <span className={css.stepper}>
        <span className={css.stepperLabel}>{t('header.panes')}</span>
        <button
          type="button"
          className={css.stepperButton}
          aria-label={t('header.panes.fewer')}
          aria-disabled={settings.maxPanes <= MAX_PANES_RANGE.min || undefined}
          onClick={() => { if (settings.maxPanes > MAX_PANES_RANGE.min) multiview.setMaxPanes(settings.maxPanes - 1) }}
        >
          <span aria-hidden>−</span>
        </button>
        <span className={css.stepperValue} aria-live="polite">{settings.maxPanes}</span>
        <button
          type="button"
          className={css.stepperButton}
          aria-label={t('header.panes.more')}
          aria-disabled={settings.maxPanes >= MAX_PANES_RANGE.max || undefined}
          onClick={() => { if (settings.maxPanes < MAX_PANES_RANGE.max) multiview.setMaxPanes(settings.maxPanes + 1) }}
        >
          <span aria-hidden>+</span>
        </button>
      </span>
      <span className={css.headerSpacer} />
      <button
        type="button"
        className={css.headerButton}
        aria-disabled={pins.length === 0 || undefined}
        onClick={() => { if (pins.length > 0) multiview.unpinAll(sessionId) }}
      >
        {t('header.unpinAll')}
      </button>
      <Tooltip label={t('header.settings')} side="bottom" align="end" delayMs={500} portal>
        <button
          ref={settingsRef}
          type="button"
          className={css.headerIcon}
          style={{ anchorName }}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          aria-label={t('header.settings')}
          onClick={() => { setSettingsOpen(current => !current) }}
        >
          <IconSettingsOutlineRegular size={14} />
        </button>
      </Tooltip>
      {settingsOpen && createPortal(
        <MenuSurface
          className={css.headerPopover}
          style={{ positionAnchor: anchorName }}
          role="dialog"
          aria-label={t('header.settings')}
          data-multiview-header-settings
        >
          <HeaderSettings chat={sessionId} multiview={multiview} settings={settings} layoutsT={layoutsT} t={t} onClose={() => { closeSettings(true) }} />
        </MenuSurface>,
        document.body,
      )}
    </div>
  )
}

/** What the settings popover reads and does. */
interface HeaderSettingsProps {
  readonly chat: SessionId
  readonly multiview: MultiviewService
  readonly settings: MultiviewSettings
  readonly layoutsT: TranslateOf<LayoutsLocaleKey>
  readonly t: Translate
  readonly onClose: () => void
}

/**
 * The pane's own settings, moved out of the list body: the layout a new Multiview starts with, and whether a hand-off opens
 * it. Both are the settings the pane's behaviour depends on, so they sit where the pane is used.
 * @param props - the chat, the service, the settings in force, the copy and the close call.
 * @returns the settings.
 */
function HeaderSettings({ chat, multiview, settings, layoutsT, t, onClose }: HeaderSettingsProps) {
  return (
    <div className={css.settingsBody}>
      <div className={css.settingsGroup}>
        <span className={css.settingsLabel}>{t('header.settings.layout')}</span>
        <LayoutPicker chat={chat} multiview={multiview} variant="row" t={layoutsT} onChosen={onClose} />
      </div>
      <label className={css.settingsRow}>
        <input
          type="checkbox"
          className={css.settingsCheck}
          checked={settings.autoOpen}
          onChange={(event) => { multiview.setAutoOpen(event.currentTarget.checked) }}
        />
        <span className={css.settingsText}>
          <span className={css.settingsTitle}>{t('header.settings.autoOpen')}</span>
          <span className={css.settingsHelp}>{t('header.settings.autoOpen.help')}</span>
        </span>
      </label>
    </div>
  )
}

/** Props of the popover footer. */
export type FooterProps = PropsRuntime<'conversation.session.header.actions.subagent.footer'>
  & PropsLocale<typeof MULTIVIEW_NS> & InjectFace<EntryInjected>

/**
 * The agents popover's footer: the list's own actions, "Pin running" and "Open Multiview". The layout picker and the
 * pinned-and-room line that used to sit here are a setting and an explanation of the pane, so they moved to the control bar's
 * settings popover and out of the list; "Unpin all" sits in the control bar, where the pointer already is when the list opens.
 * @param props - the chat, the services and the dictionary.
 * @returns the footer.
 */
export function Footer({ sessionId, useSessions, multiview, t }: FooterProps) {
  const { pins, open: shown } = useChat(multiview, sessionId)
  const running = useSessions(state => runningAgentsOf(state, sessionId).join('\n'))
  const unpinnedRunning = running === '' ? [] : running.split('\n').filter(id => !pins.includes(id as SessionId)) as SessionId[]
  const pinRunningReason = unpinnedRunning.length > 0
    ? undefined
    : t(running === '' ? 'footer.pinRunning.none' : 'footer.pinRunning.allPinned')
  const openDisabled = !shown && pins.length === 0 && unpinnedRunning.length === 0
  return (
    <div className={css.footer} role="group" aria-label={t('button')}>
      <Tooltip label={pinRunningReason ?? ''} disabled={pinRunningReason === undefined} side="top" delayMs={500} portal>
        <button
          type="button"
          className={css.footerButton}
          aria-disabled={pinRunningReason !== undefined || undefined}
          onClick={() => { if (pinRunningReason === undefined) multiview.pinAll(sessionId, unpinnedRunning) }}
        >
          {t('footer.pinRunning')}
        </button>
      </Tooltip>
      <button
        type="button"
        className={`${css.footerButton} ${css.footerPrimary}`}
        aria-disabled={openDisabled || undefined}
        onClick={() => { openOrClose(multiview, sessionId, shown, unpinnedRunning) }}
      >
        {shown ? t('footer.close') : t('footer.open')}
      </button>
    </div>
  )
}

/**
 * Open Multiview, pinning every running agent first when nothing is pinned; or close it while it shows. Both are the person's
 * own choice: a close here keeps a hand-off from opening Multiview again, and an open lets it open again.
 * @param multiview - the service.
 * @param chat - the chat.
 * @param shown - whether Multiview shows now.
 * @param running - the running agents that are not pinned.
 */
export function openOrClose(multiview: MultiviewService, chat: SessionId, shown: boolean, running: readonly SessionId[]): void {
  if (shown) { multiview.closeByPerson(chat); return }
  if (multiview.of(chat).getSnapshot().pins.length === 0) multiview.pinAll(chat, running)
  if (multiview.of(chat).getSnapshot().pins.length > 0) multiview.open(chat)
}

/** Props of the Multiview toggle at the end of the agents action. */
export type ToggleProps = PropsRuntime<'conversation.session.header.actions.subagent.end'>
  & PropsLocale<typeof MULTIVIEW_NS> & InjectFace<EntryInjected>

/** How long a touch or pen press is held before it opens the layouts instead of toggling. */
const LONG_PRESS_MS = 500
/** How far a held press may move, in CSS pixels, before it no longer counts as a long press. */
const LONG_PRESS_SLOP = 8

/**
 * The icon toggle at the end of the header's agents action: pressed while Multiview shows, with an amber dot while a pinned
 * agent waits for the person. A press opens or closes Multiview; with nothing pinned it pins every running agent first. With
 * agents but nothing pinned or running it is disabled and says why; with no agents, nothing pinned and Multiview closed it is
 * absent, since there is nothing it could show. A right-click or a long press opens the layout picker in a popover, and the first
 * time Multiview opens in this browser a one-time hint points at the layouts. The agents action renders this only in a
 * top-level chat.
 * @param props - the chat, the services and the dictionary.
 * @returns the toggle, or null when the chat has nothing for Multiview.
 */
export function MultiviewToggle({ sessionId, useSessions, useSessionStatus, multiview, layoutsT, focusKeys, hint, t }: ToggleProps) {
  const { pins, open: shown } = useChat(multiview, sessionId)
  const keys = useSyncExternalStore(listener => focusKeys?.subscribe(listener) ?? noop, () => focusKeys?.getSnapshot() ?? NO_KEYS)
  const waiting = useSessionStatus(statuses => pins.some(pin => statuses.get(pin)?.pendingInteraction !== undefined))
  const agents = useSessions(state => (catalogOf(state, sessionId) ?? []).length)
  const running = useSessions(state => runningAgentsOf(state, sessionId).join('\n'))
  const buttonRef = useRef<HTMLButtonElement>(null)
  const anchorName = `--multiview-toggle-${useId().replaceAll(':', '')}`
  const [picker, setPicker] = useState(false)
  const [hintShown, dismissHint] = useOnceHint(hint, shown)
  const press = useLongPress(() => { setPicker(true) })
  const unpinnedRunning = running === '' ? [] : running.split('\n').filter(id => !pins.includes(id as SessionId)) as SessionId[]
  if (!shown && pins.length === 0 && agents === 0) return null
  const nothing = !shown && pins.length === 0 && unpinnedRunning.length === 0
  const description = [
    pins.length > 0 ? t('button.count', { count: String(pins.length) }) : undefined,
    waiting ? t('button.waiting') : undefined,
  ].filter(part => part !== undefined).join(', ')
  const closePicker = (restoreFocus: boolean): void => {
    setPicker(false)
    if (restoreFocus) buttonRef.current?.focus()
  }
  return (
    <>
      <Tooltip label={nothing ? t('button.open.none') : t('button')} shortcutKeys={nothing ? undefined : keys} disabled={picker || hintShown} side="bottom" align="end" delayMs={500} portal>
        <button
          ref={buttonRef}
          type="button"
          className={css.toggle}
          style={{ anchorName }}
          aria-pressed={shown}
          aria-disabled={nothing || undefined}
          aria-label={t('button.aria')}
          aria-description={description === '' ? undefined : description}
          data-waiting={waiting || undefined}
          onClick={(event) => {
            if (press.consumeClick(event)) return
            if (!nothing) openOrClose(multiview, sessionId, shown, unpinnedRunning)
          }}
          onContextMenu={(event) => { event.preventDefault(); setPicker(true) }}
          onPointerDown={press.onPointerDown}
          onPointerMove={press.onPointerMove}
          onPointerUp={press.stop}
          onPointerCancel={press.cancel}
          onPointerLeave={press.stop}
        >
          <MultiviewGlyph />
          {waiting && <span className={css.dot} aria-hidden />}
        </button>
      </Tooltip>
      {picker && createPortal(
        <PickerPopover anchorName={anchorName} anchor={buttonRef} onClose={closePicker} label={t('layout')}>
          <LayoutPicker chat={sessionId} multiview={multiview} variant="grid" onChosen={() => { closePicker(true) }} t={layoutsT} />
        </PickerPopover>,
        document.body,
      )}
      {hintShown && !picker && createPortal(
        <MenuSurface compact className={css.hint} style={{ positionAnchor: anchorName }} role="status" data-multiview-hint>
          <span className={css.hintText}>{t('hint.text')}</span>
          <button type="button" className={css.hintDismiss} aria-label={t('hint.dismiss')} onClick={dismissHint}>
            <IconCloseOutlineRegular size={14} />
          </button>
        </MenuSurface>,
        document.body,
      )}
    </>
  )
}

/** An open menu or dialog other than the hint itself. */
const OVERLAY = '[role="dialog"]:not([data-multiview-hint]), [role="alertdialog"], [role="menu"]'

/**
 * Whether a menu or dialog shows now; the hint never covers one.
 * @returns true while one is visible.
 */
function overlayOpen(): boolean {
  return [...document.querySelectorAll(OVERLAY)].some(element => typeof element.checkVisibility !== 'function' || element.checkVisibility())
}

/**
 * Run a check after each change to the document, at most once a frame, until the returned disposer runs.
 * @param check - the check.
 * @returns the disposer.
 */
function onDocumentChange(check: () => void): () => void {
  let frame: number | undefined
  const observer = new MutationObserver(() => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => { frame = undefined; check() })
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'hidden', 'open'] })
  return () => {
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}

/**
 * The one-time hint: shown the first time Multiview opens and no menu or dialog shows, recorded as seen at that moment, hidden
 * when Multiview closes, when the person dismisses it, or when a menu or dialog opens over the header.
 * @param hint - the preference, absent where the plugin keeps none.
 * @param shown - whether Multiview shows.
 * @returns whether the hint shows, and its dismiss call.
 */
function useOnceHint(hint: HintPreference | undefined, shown: boolean): [boolean, () => void] {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!shown) { setVisible(false); return }
    if (hint === undefined || hint.seen()) return
    let stop: (() => void) | undefined
    const show = (): void => {
      if (overlayOpen() || hint.seen()) return
      hint.markSeen()
      setVisible(true)
      stop?.()
    }
    stop = onDocumentChange(show)
    show()
    return () => { stop?.() }
  }, [hint, shown])
  useEffect(() => {
    if (!visible) return
    return onDocumentChange(() => { if (overlayOpen()) setVisible(false) })
  }, [visible])
  return [visible, () => { setVisible(false) }]
}

/** What a long press reads and does on the toggle. */
interface LongPress {
  readonly onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void
  readonly onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void
  /** Stop waiting for the hold, keeping a hold that already fired so the click that ends it is still ignored. */
  readonly stop: () => void
  /** The press was cancelled, so no click ends it: stop waiting and forget a hold that fired. */
  readonly cancel: () => void
  /**
   * Whether this click ends a long press and should be ignored; reading it clears the hold. Only a pointer click (`detail` above
   * 0) is ignored, so Enter or Space after a hold that ended without a click still presses the toggle.
   */
  readonly consumeClick: (event: MouseEvent<HTMLButtonElement>) => boolean
}

/**
 * A touch or pen press held still for {@link LONG_PRESS_MS}; a mouse uses the right button instead.
 * @param onLongPress - what the press does.
 * @returns the handlers.
 */
function useLongPress(onLongPress: () => void): LongPress {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const start = useRef({ x: 0, y: 0 })
  const fired = useRef(false)
  const stop = (): void => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  }
  useEffect(() => stop, [])
  return {
    onPointerDown: (event) => {
      fired.current = false
      if (event.pointerType === 'mouse') return
      stop()
      start.current = { x: event.clientX, y: event.clientY }
      timer.current = setTimeout(() => {
        timer.current = undefined
        fired.current = true
        onLongPress()
      }, LONG_PRESS_MS)
    },
    onPointerMove: (event) => {
      if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > LONG_PRESS_SLOP) stop()
    },
    stop,
    cancel: () => {
      stop()
      fired.current = false
    },
    consumeClick: (event) => {
      const was = fired.current
      fired.current = false
      return was && event.detail > 0
    },
  }
}

/**
 * The layouts popover under the toggle: closes on Escape (focus back on the toggle), on a press outside it and the toggle, and
 * after a choice. It focuses the current choice, or the first, when it opens.
 * @param props - the anchor, the close call, the accessible name and the picker.
 * @returns the popover.
 */
function PickerPopover({ anchorName, anchor, onClose, label, children }: {
  readonly anchorName: string
  readonly anchor: RefObject<HTMLButtonElement>
  readonly onClose: (restoreFocus: boolean) => void
  readonly label: string
  readonly children: ReactNode
}) {
  const surface = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const target = surface.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? surface.current?.querySelector<HTMLElement>('button, [role="radio"]')
    target?.focus()
    const outside = (event: globalThis.PointerEvent): void => {
      if (event.target instanceof Node && !surface.current?.contains(event.target) && !anchor.current?.contains(event.target)) close.current(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close.current(true)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [anchor])
  return (
    <MenuSurface ref={surface} className={css.pickerPopover} style={{ positionAnchor: anchorName }} role="dialog" aria-label={label} data-multiview-layouts>
      {children}
    </MenuSurface>
  )
}

const NO_KEYS: readonly string[] = []
const noop = (): void => {}

/**
 * Multiview's own glyph: a main pane and two stacked panes, in the product icons' 16 px grid and one-pixel stroke, so it reads
 * apart from the sidebar's and the side panel's toggles.
 * @returns the glyph.
 */
function MultiviewGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden data-multiview-glyph>
      <rect x="1.5" y="1.5" width="13" height="13" rx="1" />
      <path d="M8.5 1.5v13M8.5 8h6" />
    </svg>
  )
}

/** An empty state, for a chat the store has not seen. */
export const NO_PINS = EMPTY_CHAT_MULTIVIEW
