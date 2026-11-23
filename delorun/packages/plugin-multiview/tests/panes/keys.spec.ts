import { describe, expect, it, vi } from 'vitest'
import type { MultiviewService } from '../../src/client/contract.ts'
import { buildPreset, type LayoutModel, type PaneId } from '../../src/layout/index.ts'
import { createLayerRegistry, LAYOUT_KEYS, type OpenLayer } from '../../src/panel/keys.ts'
import { A, B, CHAT } from '../entry/fixtures.ts'

const key = (id: string) => LAYOUT_KEYS.find(entry => entry.id === id)!

function layer(focused: PaneId = CHAT, display: LayoutModel = buildPreset('side-by-side', CHAT, [A, B])) {
  const focusPane = vi.fn()
  const open: OpenLayer = { main: CHAT, focused: () => focused, display: () => display, area: () => ({ width: 1440, height: 900 }), focusPane }
  return { open, focusPane }
}

function service() {
  const calls = { cycleLayout: vi.fn(), swapWithMain: vi.fn(), resizeMain: vi.fn() }
  const multiview: Pick<MultiviewService, 'cycleLayout' | 'swapWithMain' | 'resizeMain'> = calls
  return { calls, multiview: multiview as MultiviewService }
}

describe('the layout keys', () => {
  it('are nine commands with distinct ids under multiview., none with a key', () => {
    expect(LAYOUT_KEYS.map(entry => entry.id)).toEqual([
      'multiview.layout.next', 'multiview.layout.previous', 'multiview.focus.left', 'multiview.focus.right', 'multiview.focus.up',
      'multiview.focus.down', 'multiview.pane.swapMain', 'multiview.main.grow', 'multiview.main.shrink',
    ])
  })

  it('cycle the layout, grow and shrink the main chat, and swap the focused pane into the main place', () => {
    const { calls, multiview } = service()
    const { open, focusPane } = layer(B)
    key('multiview.layout.next').run(open, multiview)
    key('multiview.layout.previous').run(open, multiview)
    expect(calls.cycleLayout.mock.calls).toEqual([[CHAT, 1], [CHAT, -1]])
    key('multiview.main.grow').run(open, multiview)
    key('multiview.main.shrink').run(open, multiview)
    expect(calls.resizeMain.mock.calls).toEqual([[CHAT, 1], [CHAT, -1]])
    key('multiview.pane.swapMain').run(open, multiview)
    expect(calls.swapWithMain).toHaveBeenCalledWith(CHAT, B)
    expect(focusPane).toHaveBeenCalledWith(B)
  })

  it('move focus to the neighbouring pane, and stay at an edge', () => {
    const { multiview } = service()
    const { open, focusPane } = layer(A)
    key('multiview.focus.right').run(open, multiview)
    key('multiview.focus.left').run(open, multiview)
    expect(focusPane.mock.calls).toEqual([[B], [CHAT]])
    const edge = layer(CHAT)
    key('multiview.focus.left').run(edge.open, multiview)
    key('multiview.focus.up').run(edge.open, multiview)
    expect(edge.focusPane).not.toHaveBeenCalled()
  })
})

describe('the open layers', () => {
  it('answer with the most recent, and the one before it once that closes', () => {
    const registry = createLayerRegistry()
    expect(registry.current()).toBeUndefined()
    const first = layer().open
    const second = layer(A).open
    registry.offer(first)
    const close = registry.offer(second)
    expect(registry.current()).toBe(second)
    close()
    expect(registry.current()).toBe(first)
  })
})
