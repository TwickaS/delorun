import { useCallback, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import {
  buildPreset, DEFAULT_LAYOUT_LIMITS, PaneLayout, usePaneLayoutActions, type LayoutChangeReason, type LayoutModel, type PaneId,
  type PaneLayoutActions,
} from '../../../src/layout/index.ts'

/** What the browser runner reads: every reported change, and how many times each pane body input was mounted. */
interface SpikeProbe {
  changes: { model: LayoutModel; reason: LayoutChangeReason }[]
  mounts: Record<string, number>
  actions: PaneLayoutActions | undefined
  model: LayoutModel
  focused?: string
}

declare global {
  interface Window {
    __spike: SpikeProbe
  }
}

const id = (value: string): PaneId => value as PaneId
const MAIN = id('main')
const query = new URLSearchParams(location.search)
const agents = Array.from({ length: Number(query.get('agents') ?? 2) }, (_, index) => id(String.fromCharCode(97 + index)))
const initial = buildPreset((query.get('preset') ?? 'main-column') as Parameters<typeof buildPreset>[0], MAIN, agents)
window.__spike = { changes: [], mounts: {}, actions: undefined, model: initial }

function PaneBody({ pane }: { pane: PaneId }): JSX.Element {
  const ref = useCallback((element: HTMLInputElement | null) => {
    if (element === null) return
    window.__spike.mounts[pane] = (window.__spike.mounts[pane] ?? 0) + 1
  }, [pane])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }} data-scroller={pane}>
        {Array.from({ length: 60 }, (_, index) => <p key={index} style={{ margin: 0 }}>{pane} line {index}</p>)}
      </div>
      <input ref={ref} aria-label={`Reply to ${pane}`} data-input={pane} style={{ margin: 8 }} />
    </div>
  )
}

function App(): JSX.Element {
  const [model, setModel] = useState(initial)
  const onModelChange = useCallback((next: LayoutModel, reason: LayoutChangeReason) => {
    window.__spike.changes.push({ model: next, reason })
    window.__spike.model = next
    setModel(next)
  }, [])
  window.__spike.actions = usePaneLayoutActions({ model, main: MAIN, limits: DEFAULT_LAYOUT_LIMITS, onModelChange })
  return (
    <PaneLayout
      model={model}
      main={MAIN}
      limits={DEFAULT_LAYOUT_LIMITS}
      onModelChange={onModelChange}
      onFocusPane={pane => { window.__spike.focused = pane }}
      labels={{ separator: 'Resize panes', region: 'Multiview', tabList: 'Panes', grip: 'Move pane' }}
      renderPane={pane => <PaneBody pane={pane} />}
      renderHeader={(pane, _state, controls) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minHeight: 32 }} data-header={pane}>
          {controls.grip}
          <strong style={{ flex: 1 }}>{pane}</strong>
          <button type="button" data-swap={pane} onClick={() => { const other = controls.swapCandidates[0]; if (other !== undefined) controls.actions.swap(pane, other) }}>Swap</button>
          <button type="button" data-close={pane} disabled={!controls.canClose} onClick={() => controls.actions.close(pane)}>Close</button>
        </div>
      )}
      renderTab={pane => <span>{pane}</span>}
    />
  )
}

createRoot(document.getElementById('root')!).render(<App />)
