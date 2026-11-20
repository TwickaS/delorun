import { useCallback, useState, type JSX } from 'react'
import {
  buildPreset, DEFAULT_LAYOUT_LIMITS, PaneLayout, type LayoutChangeReason, type LayoutModel, type PaneId, type PaneLayoutLabels,
  type PaneLayoutProps,
} from '../../src/layout/index.ts'

export const LABELS: PaneLayoutLabels = { separator: 'Resize panes', region: 'Multiview', tabList: 'Panes', grip: 'Move pane' }

export interface Harness {
  readonly changes: { model: LayoutModel; reason: LayoutChangeReason }[]
  mounts: Map<string, number>
}

/** A controlled layout with a plain input in every pane body, counting mounts of each body. */
export function LayoutHarness(props: {
  initial: LayoutModel
  main: PaneId
  record: Harness
  overrides?: Partial<PaneLayoutProps>
  onModel?: (model: LayoutModel) => void
}): JSX.Element {
  const [model, setModel] = useState(props.initial)
  const onModelChange = useCallback((next: LayoutModel, reason: LayoutChangeReason) => {
    props.record.changes.push({ model: next, reason })
    setModel(next)
    props.onModel?.(next)
  }, [props])
  return (
    <div style={{ width: 1200, height: 700, display: 'flex' }}>
      <PaneLayout
        model={model}
        main={props.main}
        limits={DEFAULT_LAYOUT_LIMITS}
        onModelChange={onModelChange}
        labels={LABELS}
        renderPane={pane => <PaneBodyProbe pane={pane} record={props.record} />}
        renderHeader={(pane, state, controls) => (
          <div data-header={pane}>
            {controls.grip}
            <span>{pane}</span>
            <button type="button" onClick={() => controls.actions.close(pane)} disabled={!controls.canClose}>Close {pane}</button>
            <button type="button" onClick={() => controls.swapCandidates[0] !== undefined && controls.actions.swap(pane, controls.swapCandidates[0])}>Swap {pane}</button>
            <span hidden>{state.leafSize}</span>
          </div>
        )}
        renderTab={pane => <span>{pane}</span>}
        {...props.overrides}
      />
    </div>
  )
}

function PaneBodyProbe({ pane, record }: { pane: PaneId; record: Harness }): JSX.Element {
  // Counted in the render of a ref callback: it runs once per real mount of this pane's input, not per render.
  const ref = useCallback((element: HTMLInputElement | null) => {
    if (element !== null) record.mounts.set(pane, (record.mounts.get(pane) ?? 0) + 1)
  }, [pane, record])
  return <input ref={ref} aria-label={`Reply to ${pane}`} data-testid={`input-${pane}`} />
}

export { buildPreset }
