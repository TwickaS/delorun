/**
 * The pane layout: the adapter that draws a {@link LayoutModel} with the library's Workspace. A pane is a tabset of one tab whose
 * toolbar is the pane header; panes dragged onto an edge of another split there, panes dropped on the middle join its tabs, and the
 * dividers are `separator` elements that resize with a pointer, a finger and the arrow keys.
 * @module @delorun/plugin-multiview/layout/PaneLayout
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type JSX, type ReactNode } from 'react'
import {
  Separator,
  TabsetDragHandle,
  Workspace,
  useWorkspaceRef,
  type TabNode,
  type TabRenderProps,
  type TabsetNode,
  type WorkspaceChangedMeta,
  type WorkspaceModel,
} from 'react-resizable-panels'
import { fromWorkspaceModel, toWorkspaceModel, type PaneTabData } from './convert.ts'
import { createPaneLayoutActions } from './actions.ts'
import { StateKeeper } from './keep.ts'
import { measurePanes, playFlip, type PaneRects } from './flip.ts'
import { panesOf, type LayoutModel, type PaneId } from './model.ts'
import { moveOptions } from './ops.ts'
import styles from './PaneLayout.module.css'
import type { LayoutChangeReason, PaneLayoutProps, PaneState } from './props.ts'

type Meta = WorkspaceChangedMeta

/** A pane's frame, the element the layout glide moves. */
const FRAME_SELECTOR = `.${styles.tabset ?? 'tabset'}`

/** Frames to wait after a pointer release for the library to apply a drop. */
const DROP_WAIT_FRAMES = 15

const REASONS: Partial<Record<Meta['reason'], LayoutChangeReason>> = {
  move: 'move',
  add: 'move',
  transfer: 'move',
  resize: 'resize',
  select: 'select',
}

const sameModel = (left: LayoutModel, right: LayoutModel): boolean => left === right || JSON.stringify(left) === JSON.stringify(right)

/** The grip glyph: two columns of three dots, drawn here so the adapter needs no icon package. */
function GripGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" focusable="false">
      {[3, 8, 13].flatMap(y => [2.5, 7.5].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.25" fill="currentColor" />))}
    </svg>
  )
}

/** Runs after every commit of the pane it sits in, so a pending glide starts before the browser paints the new layout. */
function CommitProbe({ onCommit }: { readonly onCommit: () => void }): null {
  useLayoutEffect(() => { onCommit() })
  return null
}

/**
 * Draw the layout. The layout is controlled: `model` is shown, and every change the person makes is reported through
 * `onModelChange`. A pane body is mounted once and keeps its DOM when the pane moves.
 * @param props - the layout, the pane renderers and the limits.
 * @returns the layout element.
 */
export function PaneLayout(props: PaneLayoutProps): JSX.Element {
  const { model, main, limits, labels, onAreaChange, renderHeader, renderPane, renderTab, focusedPane } = props
  const workspace = useWorkspaceRef<PaneTabData>()
  const root = useRef<HTMLDivElement | null>(null)
  // The layout the engine last showed or reported; a `model` equal to it needs no `setModel`.
  const shown = useRef<LayoutModel>(model)
  const latest = useRef(props)
  latest.current = props
  const initial = useMemo(() => toWorkspaceModel(model), [])

  const actions = useMemo(
    () =>
      createPaneLayoutActions(
        () => ({ model: latest.current.model, context: { main: latest.current.main, limits: latest.current.limits } }),
        (next, reason) => latest.current.onModelChange(next, reason),
      ),
    [],
  )

  const reportsArea = onAreaChange !== undefined
  const keeper = useRef<StateKeeper | undefined>(undefined)
  useEffect(() => {
    const element = root.current
    if (element === null) return undefined
    const own = new StateKeeper(element)
    keeper.current = own
    // A drag starts on a grip: freeze the recorded scroll offsets until the drop has been applied or abandoned.
    let gripHeld = false
    const onDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || event.target.closest('[data-tabset-drag-handle]') === null) return
      gripHeld = true
      own.freeze()
    }
    // Only the end of a drag that began on a grip restores; any other pointerup in the document leaves the recorded scroll alone.
    const onUp = (): void => {
      if (!gripHeld) return
      gripHeld = false
      own.release(DROP_WAIT_FRAMES)
    }
    element.addEventListener('pointerdown', onDown, true)
    element.ownerDocument.addEventListener('pointerup', onUp, true)
    element.ownerDocument.addEventListener('pointercancel', onUp, true)
    return () => {
      element.removeEventListener('pointerdown', onDown, true)
      element.ownerDocument.removeEventListener('pointerup', onUp, true)
      element.ownerDocument.removeEventListener('pointercancel', onUp, true)
      own.dispose()
      keeper.current = undefined
    }
  }, [])

  // A layout replaced from outside (a choice, Auto, the mosaic) glides from the old places to the new ones; the panes are measured
  // before the change and moved once the engine has drawn it, from wherever an unfinished glide had them.
  const pendingFlip = useRef<PaneRects | undefined>(undefined)
  const runFlip = useCallback((): void => {
    const before = pendingFlip.current
    const element = root.current
    if (before === undefined || element === null) return
    pendingFlip.current = undefined
    playFlip(element, FRAME_SELECTOR, before)
  }, [])
  useLayoutEffect(() => {
    if (sameModel(shown.current, model)) return
    shown.current = model
    const element = root.current
    if (latest.current.animate === true && element !== null) {
      pendingFlip.current = measurePanes(element, FRAME_SELECTOR)
      // Whichever comes first: the engine's next draw of a pane (the probe below) or the next frame.
      element.ownerDocument.defaultView?.requestAnimationFrame(runFlip)
    }
    keeper.current?.freeze()
    workspace.current?.setModel(toWorkspaceModel(model))
    keeper.current?.release()
  }, [model, workspace, runFlip])

  useEffect(() => {
    const element = root.current
    if (element === null || !reportsArea) return undefined
    // The callback is read through `latest`, so a new callback identity never re-subscribes; an unchanged size is not reported again.
    let width: number | undefined
    let height: number | undefined
    const report = (): void => {
      if (element.clientWidth === width && element.clientHeight === height) return
      width = element.clientWidth
      height = element.clientHeight
      latest.current.onAreaChange?.({ width, height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [reportsArea])

  const onModelChanged = useCallback(
    (next: WorkspaceModel<PaneTabData>, meta: Meta): void => {
      const reason = REASONS[meta.reason]
      const layout = fromWorkspaceModel(next)
      if (reason === undefined || layout === undefined || sameModel(shown.current, layout)) return
      shown.current = layout
      keeper.current?.release()
      latest.current.onModelChange(layout, reason)
    },
    [],
  )

  const stateOf = (pane: PaneId, leafSize: number, selected: boolean): PaneState => ({
    isMain: pane === main,
    focused: pane === focusedPane,
    selected,
    leafSize,
    paneTotal: panesOf(model).length,
  })
  const leafSizeOf = (pane: PaneId): number => {
    const walk = (node: LayoutModel['root']): number | undefined =>
      node.kind === 'leaf' ? (node.panes.includes(pane) ? node.panes.length : undefined) : node.children.map(walk).find(size => size !== undefined)
    return walk(model.root) ?? 1
  }
  const selectedOf = (pane: PaneId): boolean => {
    const walk = (node: LayoutModel['root']): boolean | undefined =>
      node.kind === 'leaf' ? (node.panes.includes(pane) ? node.active === pane : undefined) : node.children.map(walk).find(found => found !== undefined)
    return walk(model.root) ?? false
  }

  const renderTabContent = useCallback(
    (tab: TabNode<PaneTabData>): ReactNode => {
      const pane = tab.id as PaneId
      return (
        <div
          className={styles.body}
          data-pane={pane}
          onFocusCapture={() => latest.current.onFocusPane?.(pane)}
          onPointerDownCapture={() => latest.current.onFocusPane?.(pane)}
        >
          {renderPane(pane, stateOf(pane, leafSizeOf(pane), selectedOf(pane)))}
          <CommitProbe onCommit={runFlip} />
        </div>
      )
    },
    [renderPane, model, main, focusedPane],
  )

  const renderTabsetToolbar = useCallback(
    (tabset: TabsetNode<PaneTabData>): ReactNode => {
      const pane = (tabset.selectedId ?? tabset.tabs[0]?.id) as PaneId | undefined
      if (pane === undefined) return null
      const state = stateOf(pane, tabset.tabs.length, true)
      return <div className={styles.toolbarFill} data-flip-pane={pane}>{renderHeader(pane, state, {
        grip: (
          <TabsetDragHandle className={styles.grip} title={labels.grip} aria-label={labels.grip}>
            <GripGlyph />
          </TabsetDragHandle>
        ),
        actions,
        swapCandidates: panesOf(model).filter(candidate => candidate !== pane),
        moveOptions: moveOptions(model, pane),
        canClose: pane !== main,
      })}</div>
    },
    [renderHeader, labels.grip, actions, model, main, focusedPane],
  )

  const renderTabElement = useCallback(
    (tab: TabNode<PaneTabData>, tabProps: TabRenderProps): ReactNode => (
      <div {...tabProps} className={[tabProps.className, styles.tab].filter(Boolean).join(' ')}>
        {renderTab(tab.id as PaneId)}
      </div>
    ),
    [renderTab],
  )

  const renderSeparator = useCallback(
    (): ReactNode => <Separator className={styles.separator} aria-label={labels.separator} />,
    [labels.separator],
  )

  const classNames = useMemo(
    () => ({
      tabset: styles.tabset!,
      header: styles.header!,
      toolbar: styles.toolbar!,
      tabPanels: styles.panels!,
      tabContent: styles.content!,
      dropIndicator: styles.dropIndicator!,
      dragPreview: styles.dragPreview!,
    }),
    [],
  )
  // A leaf with one pane has no tab strip: the pane header takes its place.
  // One row of tabs that scrolls sideways when it is longer than the leaf, above the pane header's row.
  const tabListStyle = useCallback((tabset: TabsetNode<PaneTabData>): CSSProperties => (
    tabset.tabs.length < 2 ? { display: 'none' } : { display: 'flex', flex: '1 0 100%', flexWrap: 'nowrap', overflowX: 'auto', scrollbarWidth: 'thin', minWidth: 0 }
  ), [])
  const workspaceStyles = useMemo(() => ({ tabList: tabListStyle }), [tabListStyle])

  return (
    <div ref={root} className={[styles.root, props.className].filter(Boolean).join(' ')} role="region" aria-label={labels.region}>
      <Workspace<PaneTabData>
        workspaceRef={workspace}
        className={styles.workspace}
        classNames={classNames}
        styles={workspaceStyles}
        defaultModel={initial}
        onModelChanged={onModelChanged}
        renderTab={renderTabElement}
        renderTabContent={renderTabContent}
        renderTabsetToolbar={renderTabsetToolbar}
        renderSeparator={renderSeparator}
        tabsetMinWidth={`${limits.minPaneWidth}px`}
        tabsetMinHeight={`${limits.minPaneHeight}px`}
        tabRemovalSelectionBehavior="adjacent"
        hiddenTabBehavior="keep-mounted"
      />
    </div>
  )
}
