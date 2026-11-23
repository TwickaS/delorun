/**
 * Multiview's layer in the main Conversation's content (`conversation.main.body`). While Multiview is closed it renders the content
 * as it is. While open it draws the pane layout, or, in a window narrower than the pager breakpoint, the phone pager, under the
 * Conversation's own header. The main chat's pane is that content itself, the real chat with its full composer; an agent's pane is
 * the pane header and body slots, each inside the agent chat's own `multiviewPane` session reference, held here so that moving,
 * paging or hiding a pane never closes its chat.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RememberScope } from '../config.ts'
import type { MultiviewService } from '../client/contract.ts'
import { limitsOf } from '../entry/state.ts'
import {
  drawnPreset, fitToMinimums, mainShareFromDrag, panesOf, PaneLayout, reconcileLayout, selectPane, slotOrder,
  type LayoutArea, type LayoutChangeReason, type LayoutModel, type LayoutsLocaleKey, type PaneActivity, type PaneHeaderControls, type PaneId,
  type PaneLayoutLabels,
} from '../layout/index.ts'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { useBusy, useHeld } from './busy.ts'
import type { LayerRegistry } from './keys.ts'
import type { PANES_NS } from '../panes/locales.ts'
import { usePaneReferences, type PaneSessions } from '../panes/references.ts'
import type { PaneHeaderOwnerProps } from '../panes/slots.ts'
import { initialsOf } from '../panes/status.ts'
import { PhonePager, pageOrder, PhoneSwitch } from '../phone/index.ts'
import type { PhoneDotsStore } from './dots.tsx'
import css from './Layer.module.css'

/** What the layer reads and does. */
export interface LayerInjected {
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
  /** The layout copy, for the "Saved as your default layout" notice. */
  readonly layoutsT: Translate<LayoutsLocaleKey>
  /** Where the open layer offers itself to the layout keys. */
  readonly layers: LayerRegistry
}

/** How long a new area must hold before Auto re-arranges for it, in milliseconds. */
export const AREA_SETTLE_MS = 200

/** How long a pane's activity must hold before the mosaic re-arranges for it, so a flapping status never shakes the layout. */
export const ACTIVITY_SETTLE_MS = 700

const sameArea = (left: LayoutArea | undefined, right: LayoutArea | undefined): boolean =>
  left === right || (left !== undefined && right !== undefined && left.width === right.width && left.height === right.height)

/** Props of the layer entry. */
export type LayerProps = PropsRuntime<'conversation.main.body'>
  & PropsRenderSlots<'multiview.pane.header' | 'multiview.pane.body'>
  & PropsLocale<typeof PANES_NS>
  & InjectFace<LayerInjected>
  & { readonly children: ReactNode }

type Frame = Pick<LayerProps, 'SessionProvider' | 'renderSlot' | 'useSessions' | 'useSessionStatus' | 't'> & LayerInjected

/**
 * The layer.
 * @param props - the main content, the slot kit and the services.
 * @returns the content as it is while Multiview is closed or has nothing pinned, otherwise the layout or the pager.
 */
export function MultiviewLayer(props: LayerProps) {
  const { sessionId, multiview, children, ...rest } = props
  const open = useObservable(multiview.of(sessionId ?? NO_CHAT)).open
  // The content is a new element on every event of the main chat. It reaches the main pane through this store, so the layer and the
  // agent panes, which are memoised on everything else, do not render again for each streamed chunk.
  const [content] = useState(() => createSnapshotStore<ReactNode>(children))
  useLayoutEffect(() => { content.set(children) })
  if (sessionId === undefined || !open) return <>{children}</>
  return <ChatMultiview {...rest} sessionId={sessionId} multiview={multiview} main={sessionId} content={content} />
}

/** The main content in the main pane or page: it alone renders again when the main chat's content changes. */
function MainContent({ content }: { readonly content: SnapshotStore<ReactNode> }) {
  return <>{useSyncExternalStore(content.subscribe, content.getSnapshot)}</>
}

/** The chat key of a content that has no chat: nothing is ever stored under it. */
const NO_CHAT = '' as SessionId

/** Observe a service value as React state. */
function useObservable<T>(source: { subscribe(listener: () => void): () => void; getSnapshot(): T }): T {
  return useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot())
}

const ChatMultiview = memo(function ChatMultiview(props: Omit<LayerProps, 'children'> & { readonly main: SessionId; readonly content: SnapshotStore<ReactNode> }) {
  const { main, content, multiview, sessions, openFull, clock, dots, layoutsT, layers, t, SessionProvider, renderSlot, useSessions, useSessionStatus } = props
  const mainContent = useMemo(() => <MainContent content={content} />, [content])
  const state = useObservable(multiview.of(main))
  const settings = useObservable(multiview.settings)
  const defaults = useSyncExternalStore(listener => multiview.defaults.subscribe(listener), () => multiview.defaultsOf(main))
  const limits = useMemo(() => limitsOf(settings), [settings])
  const root = useRef<HTMLDivElement | null>(null)
  const busy = useBusy(root)
  const [area, setArea] = useState<LayoutArea | undefined>(undefined)
  const heldArea = useHeld(area, AREA_SETTLE_MS, busy, sameArea)
  const [focused, setFocused] = useState<PaneId | undefined>(undefined)
  const [active, setActive] = useState<PaneId>(main)
  const [notice, setNotice] = useState<{ readonly seq: number; readonly scope: RememberScope } | undefined>(undefined)
  const references = usePaneReferences(sessions, useMemo(() => [main, ...state.pins], [main, state.pins]))
  const frame: Frame = { SessionProvider, renderSlot, useSessions, useSessionStatus, t, multiview, sessions, openFull, clock, dots, layoutsT, layers }

  useEffect(() => { if (state.pins.length === 0) multiview.close(main) }, [multiview, main, state.pins.length])
  useEffect(() => () => { multiview.reportArea(undefined) }, [multiview])
  const onAreaChange = useCallback((next: LayoutArea) => { setArea(next); multiview.reportArea(next) }, [multiview])
  const stop = useCallback((id: SessionId) => {
    references.get(id)?.binding.session.cancel().catch((_error: unknown) => {
      // A refused stop is published on the chat's own promptError, which its composer shows.
    })
  }, [references])
  // The main chat counts too: its own request is easy to miss when the main page is out of sight on a phone or the pane is small.
  const ids = useMemo(() => pageOrder(main, state.pins), [main, state.pins])
  const waitingKey = useSessionStatus(statuses => ids.filter(pane => statuses.get(pane)?.pendingInteraction !== undefined).join('\n'))
  const waitingPanes = useMemo(() => new Set(waitingKey === '' ? [] : waitingKey.split('\n')), [waitingKey])
  const runningKey = useSessions(list => ids.map(id => (list.byId[id]?.running === true ? '1' : '0')).join(''))
  const labels: PaneLayoutLabels = { separator: t('layout.separator'), region: t('region'), tabList: t('layout.tabs'), grip: t('layout.grip') }

  // The mosaic reads each pane's activity once it has held for a while, and never while the person is busy in the layout.
  const arrangement = state.arrangement ?? multiview.arrangementOf(main)
  const activityKey = arrangement === 'mosaic' ? ids.map((id, index) => `${id}=${runningKey[index] === '1' || waitingPanes.has(id) ? 'large' : 'small'}`).join('\n') : ''
  const heldActivity = useHeld(activityKey, ACTIVITY_SETTLE_MS, busy)
  const activity = useMemo(() => new Map(heldActivity === '' ? [] : heldActivity.split('\n').map(entry => entry.split('=') as [PaneId, PaneActivity])), [heldActivity])

  const arranged = useMemo(
    () => multiview.layoutFor(main, heldArea, arrangement === 'mosaic' ? activity : undefined),
    [multiview, main, state, defaults, limits, heldArea, arrangement, activity],
  )
  // While the person is busy in the layout nothing rearranges by itself: a pin that comes or goes is placed in the layout as shown,
  // and the full arrangement follows once they are done. A change they make (a choice, a tab, a drag) shows at once.
  const shown = useRef<{ readonly model: LayoutModel; readonly inputs: unknown } | undefined>(undefined)
  const inputs = useMemo(() => ({ arrangement, shape: state.shape, slots: state.slots, layout: state.layout, defaults, heldArea, activity }), [arrangement, state.shape, state.slots, state.layout, defaults, heldArea, activity])
  let display = arranged
  if (busy && shown.current !== undefined && shown.current.inputs === inputs) {
    const slots = slotOrder(state.slots, main, state.pins)
    const held = shown.current.model
    const samePanes = panesOf(held).length === slots.length && slots.every(pane => panesOf(held).includes(pane))
    display = samePanes ? held : fitToMinimums(reconcileLayout(held, slots[0]!, slots.slice(1)), limits, heldArea)
  }
  useLayoutEffect(() => { shown.current = { model: display, inputs } })

  // A resize during a drag is kept until the pointer is released, so a drag of a divider saves once and the notice shows once.
  const pendingResize = useRef<LayoutModel | undefined>(undefined)
  const commitResize = useCallback((model: LayoutModel, before: LayoutModel) => {
    const slots = slotOrder(state.slots, main, state.pins)
    const preset = drawnPreset(arrangement, slots.length, { area: heldArea, limits, autoColumns: defaults.autoColumns })
    const share = mainShareFromDrag(before, model, preset, slots[0]!)
    if (share !== undefined) {
      multiview.setMainShare(share)
      return
    }
    const result = multiview.adoptArrangement(main, model, 'resize')
    if (result.saved) setNotice(previous => ({ seq: (previous?.seq ?? 0) + 1, scope: result.scope }))
  }, [multiview, main, state.slots, state.pins, arrangement, heldArea, limits, defaults.autoColumns])
  const resizeBase = useRef<LayoutModel | undefined>(undefined)
  useEffect(() => {
    if (busy || pendingResize.current === undefined) return
    const model = pendingResize.current
    const before = resizeBase.current ?? display
    pendingResize.current = undefined
    resizeBase.current = undefined
    commitResize(model, before)
  }, [busy, commitResize, display])

  const onModelChange = (model: LayoutModel, reason: LayoutChangeReason): void => {
    switch (reason) {
      case 'resize':
        resizeBase.current ??= display
        pendingResize.current = model
        if (!busy) {
          const before = resizeBase.current
          pendingResize.current = undefined
          resizeBase.current = undefined
          commitResize(model, before)
        }
        return
      case 'move':
      case 'swap': {
        const result = multiview.adoptArrangement(main, model, reason)
        if (result.saved) setNotice(previous => ({ seq: (previous?.seq ?? 0) + 1, scope: result.scope }))
        return
      }
      default:
        multiview.setLayout(main, model)
    }
  }

  // The layout keys act on the open layer: its chat, the focused pane and the layout as drawn.
  const latest = useRef({ display, focused, heldArea, slots: slotOrder(state.slots, main, state.pins) })
  latest.current = { display, focused, heldArea, slots: slotOrder(state.slots, main, state.pins) }
  useEffect(() => layers.offer({
    main,
    focused: () => latest.current.focused ?? latest.current.slots[0] ?? main,
    display: () => latest.current.display,
    area: () => latest.current.heldArea,
    focusPane: (pane) => {
      const model = latest.current.display
      const selected = selectPane(model, pane)
      if (selected.ok && JSON.stringify(selected.model) !== JSON.stringify(model)) multiview.setLayout(main, selected.model)
      setFocused(pane)
      const body = [...(root.current?.querySelectorAll<HTMLElement>('[data-pane]') ?? [])].find(element => element.dataset.pane === pane)
      const target = body?.querySelector<HTMLElement>('textarea, [contenteditable="true"], input:not([type="hidden"])') ?? body
      if (body !== null && body !== undefined && !body.hasAttribute('tabindex')) body.tabIndex = -1
      target?.focus({ preventScroll: true })
    },
  }), [layers, main, multiview])

  const split = (
    <PaneLayout
      model={display}
      main={main}
      limits={limits}
      labels={labels}
      focusedPane={focused}
      onFocusPane={setFocused}
      onAreaChange={onAreaChange}
      onModelChange={onModelChange}
      animate={arrangement !== 'mosaic' || defaults.mosaicMotion === 'on'}
      renderTab={pane => <TabLabel useSessions={useSessions} pane={pane} waiting={waitingPanes.has(pane)} label={t('pager.attention')} />}
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
      renderPane={pane => <BodySlot frame={frame} reference={references.get(pane)} content={pane === main ? mainContent : undefined} compact={settings.compactComposer} waiting={waitingPanes.has(pane)} />}
    />
  )
  const phone = (
    <Pager frame={frame} main={main} content={mainContent} ids={ids} references={references} active={active} onActive={setActive} stop={stop} compact={settings.compactComposer} waiting={waitingPanes} />
  )
  return (
    <div ref={root} className={css.root} data-multiview-panel={main}>
      <PhoneSwitch phone={phone} split={<div className={css.layout}>{split}</div>} />
      {notice !== undefined && (
        <Toast
          key={notice.seq}
          tone="success"
          holdMs={6000}
          text={layoutsT(`saved.${notice.scope}`)}
          actions={[{ label: layoutsT('saved.undo'), prefix: ' · ', onClick: () => { multiview.undoDefault(); setNotice(undefined) } }]}
          onDone={() => { setNotice(current => (current?.seq === notice.seq ? undefined : current)) }}
        />
      )}
    </div>
  )
})

/** The layout's tab label for a pane that shares a leaf: the chat's name. */
function TabLabel({ useSessions, pane, waiting, label }: Pick<LayerProps, 'useSessions'> & { readonly pane: PaneId; readonly waiting: boolean; readonly label: string }) {
  const name = useSessions(state => state.byId[pane]?.projectionValues?.subagent?.label ?? state.byId[pane]?.displayTitle ?? pane)
  return <>{name}{waiting && <span className={css.tabDot} role="img" aria-label={label} data-attention-dot="" />}</>
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

/** A pane's body: the main content for the main chat, otherwise the pane body slot inside the agent chat's reference. A waiting chat's body carries the amber ring. */
function BodySlot({ frame, reference, content, compact, waiting }: {
  readonly frame: Frame
  readonly reference: SessionReference | undefined
  readonly content: ReactNode | undefined
  readonly compact: boolean
  readonly waiting: boolean
}) {
  const { SessionProvider, renderSlot } = frame
  return (
    <div className={css.pane} data-pane-body data-waiting={waiting || undefined}>
      {content !== undefined
        ? content
        : reference === undefined
          ? <div className={css.loading} />
          : <SessionProvider session={reference}>{renderSlot('multiview.pane.body', { compact })}</SessionProvider>}
    </div>
  )
}

/** The phone pager over the same references, with the pager's position published for the dots in each page's chat. */
function Pager({ frame, main, content, ids, references, active, onActive, stop, compact, waiting }: {
  readonly frame: Frame
  readonly main: SessionId
  readonly content: ReactNode
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
      renderChipIcon={id => <span className={css.monogram} aria-hidden>{initialsOf(id === main ? t('badge.mainChat') : names[ids.indexOf(id)] ?? '')}</span>}
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
              <BodySlot frame={frame} reference={reference} content={id === main ? content : undefined} compact={compact} waiting={false} />
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
