import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { vi } from 'vitest'
import { moveOptions, type LayoutModel, type LayoutResult, type PaneHeaderControls } from '../../src/layout/index.ts'

export const sid = (value: string): SessionId => value as SessionId

const refused = (): LayoutResult => ({ ok: false, reason: 'no-room' })

/** Controls for a header over a layout of the given other panes; the actions record what they are asked. */
export function controlsFor(pane: SessionId, others: readonly SessionId[], model: LayoutModel | undefined, overrides: Partial<PaneHeaderControls> = {}): PaneHeaderControls {
  return {
    grip: <span data-grip />,
    actions: {
      applyPreset: vi.fn(), reset: vi.fn(),
      add: vi.fn(refused), move: vi.fn(refused), swap: vi.fn(refused), close: vi.fn(refused),
    },
    swapCandidates: others,
    moveOptions: model === undefined ? [] : moveOptions(model, pane),
    canClose: true,
    ...overrides,
  }
}
