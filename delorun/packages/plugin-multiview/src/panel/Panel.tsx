/**
 * The `multiview` main panel: the main chat's header strip over the pane layout, or, in a window narrower than the pager breakpoint,
 * over the phone pager. Every pane (the main chat's too) is the real chat rendered through the pane slots, each inside its own
 * `multiviewPane` session reference, held here so that moving, paging or hiding a pane never closes its chat.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MultiviewService } from '../client/contract.ts'
import { mainChatOf } from '../entry/read.ts'
import { limitsOf } from '../entry/state.ts'
import {
  fitLayout, paneCapacity, PaneLayout, reconcileLayout, type LayoutArea, type PaneHeaderControls, type PaneId, type PaneLayoutLabels,
} from '../layout/index.ts'
import type { PANES_NS } from '../panes/locales.ts'
import { usePaneReferences, type PaneSessions } from '../panes/references.ts'
import type { PaneHeaderOwnerProps } from '../panes/slots.ts'
import { initialsOf } from '../panes/status.ts'
import { PhonePager, pageOrder, PhoneSwitch } from '../phone/index.ts'
import type { PhoneDotsStore } from './dots.tsx'
import css from './Panel.module.css'

/** What the panel reads and does. */
export interface PanelInjected {
  /** The pins, layouts and open state. */
  readonly multiview: MultiviewService
  /** The sessions service the panes' chats are retained through. */
  readonly sessions: PaneSessions
  /**
   * Open a chat in the main view, which closes Multiview.
   * @param id - the chat.
   */
  readonly openFull: (id: SessionId) => void
  /** Formats an epoch-millisecond time of day for the limits line. */
  readonly clock: (epochMs: number) => string
  /** Where the pager publishes its position for the dots above each page's reply box. */
  readonly dots: PhoneDotsStore
}

/** Props of the panel entry. */
export type PanelProps = PropsRuntime<'main'>
  & PropsRenderSlots<'conversation.header' | 'multiview.pane.header' | 'multiview.pane.body'>
  & PropsLocale<typeof PANES_NS>
  & InjectFace<PanelInjected>

type Frame = Pick<PanelProps, 'SessionProvider' | 'renderSlot' | 'useSessions' | 'useSessionStatus' | 't'> & PanelInjected

/**
 * The panel.
 * @param props - the slot kit and the services.
 * @returns the layout, or a note while no chat is the main view.
 */
export function MultiviewPanel(props: PanelProps) {
  const main = props.useSessions(state => mainChatOf(state))
  if (main === undefined) return <div className={css.empty}>{props.t('empty.noMain')}</div>
  return <ChatMultiview {...props} main={main} />
}

/** Observe a service value as React state. */
function useObservable<T>(source: { subscribe(listener: () => void): () => void; getSnapshot(): T }): T {
  return useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot())
}

function ChatMultiview(props: PanelProps & { readonly main: SessionId }) {
  const { main, multiview, sessions, openFull, clock, dots, t, SessionProvider, renderSlot, useSessions, useSessionStatus } = props
  const state = useObservable(multiview.of(main))
  const settings = useObservable(multiview.settings)
  const limits = useMemo(() => limitsOf(settings), [settings])
  const [area, setArea] = useState<LayoutArea | undefined>(undefined)
  const [focused, setFocused] = useState<PaneId | undefined>(undefined)
  const [active, setActive] = useState<PaneId>(main)
  const references = usePaneReferences(sessions, useMemo(() => [main, ...state.pins], [main, state.pins]))
  // Pins are the source of truth; the stored layout only places them, and a window too small for all of them hides the last.
  const stored = useMemo(() => reconcileLayout(state.layout ?? undefined, main, state.pins), [state.layout, main, state.pins])
  const fitted = useMemo(() => fitLayout(stored, main, paneCapacity(limits, area)), [stored, main, limits, area])
  const frame: Frame = { SessionProvider, renderSlot, useSessions, useSessionStatus, t, multiview, sessions, openFull, clock, dots }

  useEffect(() => { if (state.pins.length === 0) multiview.close(main) }, [multiview, main, state.pins.length])
  useEffect(() => () => { multiview.reportArea(undefined) }, [multiview])
  const onAreaChange = useCallback((next: LayoutArea) => { setArea(next); multiview.reportArea(next) }, [multiview])
  const stop = useCallback((id: SessionId) => {
    references.get(id)?.binding.session.cancel().catch((_error: unknown) => {
      // A refused stop is published on the chat's own promptError, which its composer shows.
    })
  }, [references])
  const waitingKey = useSessionStatus(statuses => state.pins.filter(pin => statuses.get(pin)?.pendingInteraction !== undefined).join('\n'))
  const waitingPanes = useMemo(() => new Set(waitingKey === '' ? [] : waitingKey.split('\n')), [waitingKey])
  const labels: PaneLayoutLabels = { separator: t('layout.separator'), region: t('region'), tabList: t('layout.tabs'), grip: t('layout.grip') }
  const mainReference = references.get(main)
  const strip = mainReference === undefined ? null : <SessionProvider session={mainReference}>{renderSlot('conversation.header', {})}</SessionProvider>

  const split = (
    <PaneLayout
      model={fitted.model}
      main={main}
      limits={limits}
      labels={labels}
      focusedPane={focused}
      onFocusPane={setFocused}
      onAreaChange={onAreaChange}
      onModelChange={(model) => { multiview.setLayout(main, model) }}
      renderTab={pane => <TabLabel useSessions={useSessions} pane={pane} />}
      renderHeader={(pane, paneState, controls) => (
        <HeaderSlot
          frame={frame}
          reference={references.get(pane)}
          owner={{
            isMain: paneState.isMain, focused: paneState.focused, page: false, controls, clock,
            onOpen: () => { openFull(pane) },
            onStop: () => { stop(pane) },
            onClose: () => { multiview.unpin(main, pane) },
          }}
        />
      )}
      renderPane={pane => <BodySlot frame={frame} reference={references.get(pane)} compact={pane !== main && settings.compactComposer} waiting={waitingPanes.has(pane)} />}
    />
  )
  const hidden = fitted.hidden.length === 0 ? null : (
    <div className={css.hidden} role="status">{fitted.hidden.length === 1 ? t('layout.hidden.one') : t('layout.hidden', { count: String(fitted.hidden.length) })}</div>
  )
  const ids = useMemo(() => pageOrder(main, state.pins), [main, state.pins])
  const phone = (
    <Pager frame={frame} main={main} ids={ids} references={references} active={active} onActive={setActive} stop={stop} compact={settings.compactComposer} waiting={waitingPanes} />
  )
  return (
    <div className={css.root} data-multiview-panel={main}>
      <div className={css.strip}>{strip}</div>
      <PhoneSwitch phone={phone} split={<>{hidden}<div className={css.layout}>{split}</div></>} />
    </div>
  )
}

/** The layout's tab label for a pane that shares a leaf: the chat's name. */
function TabLabel({ useSessions, pane }: Pick<PanelProps, 'useSessions'> & { readonly pane: PaneId }) {
  return <>{useSessions(state => state.byId[pane]?.projectionValues?.subagent?.label ?? state.byId[pane]?.displayTitle ?? pane)}</>
}

/** A pane's header, inside the pane's chat reference. */
function HeaderSlot({ frame, reference, owner }: {
  readonly frame: Frame
  readonly reference: SessionReference | undefined
  readonly owner: PaneHeaderOwnerProps
}) {
  if (reference === undefined) return null
  const { SessionProvider, renderSlot } = frame
  return <SessionProvider session={reference}>{renderSlot('multiview.pane.header', owner)}</SessionProvider>
}

/** A pane's body, inside the pane's chat reference; a waiting chat's body carries the amber ring. */
function BodySlot({ frame, reference, compact, waiting }: {
  readonly frame: Frame
  readonly reference: SessionReference | undefined
  readonly compact: boolean
  readonly waiting: boolean
}) {
  const { SessionProvider, renderSlot } = frame
  return (
    <div className={css.pane} data-pane-body data-waiting={waiting || undefined}>
      {reference === undefined
        ? <div className={css.loading} />
        : <SessionProvider session={reference}>{renderSlot('multiview.pane.body', { compact })}</SessionProvider>}
    </div>
  )
}

/** The phone pager over the same references, with the pager's position published for the dots in each page's chat. */
function Pager({ frame, main, ids, references, active, onActive, stop, compact, waiting }: {
  readonly frame: Frame
  readonly main: SessionId
  readonly ids: readonly SessionId[]
  readonly references: ReadonlyMap<SessionId, SessionReference>
  readonly active: PaneId
  readonly onActive: (id: PaneId) => void
  readonly stop: (id: SessionId) => void
  readonly compact: boolean
  readonly waiting: ReadonlySet<string>
}) {
  const { t, useSessions, dots, openFull, clock } = frame
  const names = useSessions(state => ids.map(id => state.byId[id]?.projectionValues?.subagent?.label ?? state.byId[id]?.displayTitle ?? id).join('\u0000')).split('\u0000')
  const pages = ids.map((id, index) => ({ id, label: id === main ? t('badge.mainChat') : names[index] ?? id, needsAttention: waiting.has(id) }))
  useEffect(() => {
    dots.set({ ids, active, select: onActive, main, open: openFull, stop })
    return () => { dots.set(undefined) }
  }, [dots, ids, active, onActive, main, openFull, stop])
  return (
    <PhonePager
      pages={pages}
      active={active}
      onActiveChange={onActive}
      externalDots
      labels={{ region: t('pager.region'), strip: t('pager.strip'), attention: t('pager.attention') }}
      renderChipIcon={id => <span className={css.monogram} aria-hidden>{initialsOf(names[ids.indexOf(id)] ?? '')}</span>}
      renderPage={(id) => {
        const reference = references.get(id)
        return (
          <div className={css.page} data-page-chat={id}>
            {reference === undefined || id === main ? null : (
              <frame.SessionProvider session={reference}>
                {frame.renderSlot('multiview.pane.header', {
                  isMain: false, focused: false, page: true, clock,
                  controls: NO_CONTROLS, onOpen: () => { openFull(id) }, onStop: () => { stop(id) }, onClose: () => undefined,
                })}
              </frame.SessionProvider>
            )}
            <div className={css.pageBody}>
              <BodySlot frame={frame} reference={reference} compact={id !== main && compact} waiting={false} />
            </div>
          </div>
        )
      }}
    />
  )
}

/** The controls of a phone page's header: there is no grip, menu or close, because the page has its own buttons. */
const NO_CONTROLS: PaneHeaderControls = {
  grip: null,
  actions: {
    applyPreset: () => undefined, reset: () => undefined,
    add: () => ({ ok: false, reason: 'main-pane' }), move: () => ({ ok: false, reason: 'main-pane' }),
    swap: () => ({ ok: false, reason: 'main-pane' }), close: () => ({ ok: false, reason: 'main-pane' }),
  },
  swapCandidates: [],
  moveOptions: [],
  canClose: false,
}
