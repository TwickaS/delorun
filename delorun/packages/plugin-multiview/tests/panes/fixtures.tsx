import type { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { vi } from 'vitest'
import { moveOptions, type PaneHeaderControls, type LayoutModel } from '../../src/layout/index.ts'
import type { SeatLimits } from '../../src/panes/status.ts'

export const sid = (value: string): SessionId => value as SessionId

/** One chat row of the session list. */
export interface Row {
  readonly title: string
  readonly label?: string
  readonly createdAt?: number
  readonly updatedAt?: number
}

/** The sources a pane header or body reads, as a fake slot kit. */
export interface FakeChat {
  readonly session: ReturnType<typeof createSnapshotStore<{ running: boolean; subagent: null | { address: { mode: 'continuable' | 'one-shot' } } }>>
  readonly statuses: ReturnType<typeof createSnapshotStore<ReadonlyMap<SessionId, { pendingInteraction: object | undefined }>>>
  readonly list: ReturnType<typeof createSnapshotStore<{ byId: Record<string, object> }>>
}

/** Controls for a header over a layout of the given other panes; the actions record what they are asked. */
export function controlsFor(pane: SessionId, others: readonly SessionId[], model: LayoutModel | undefined, overrides: Partial<PaneHeaderControls> = {}): PaneHeaderControls {
  return {
    grip: <span data-grip />,
    actions: {
      applyPreset: vi.fn(), reset: vi.fn(),
      add: vi.fn(() => ({ ok: false, reason: 'no-room' as const })), move: vi.fn(() => ({ ok: false, reason: 'no-room' as const })),
      swap: vi.fn(() => ({ ok: false, reason: 'no-room' as const })), close: vi.fn(() => ({ ok: false, reason: 'no-room' as const })),
    },
    swapCandidates: others,
    moveOptions: model === undefined ? [] : moveOptions(model, pane),
    canClose: true,
    ...overrides,
  }
}

export type { SeatLimits }
