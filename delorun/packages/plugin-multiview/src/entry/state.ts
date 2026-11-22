/**
 * The per-chat Multiview state behind the `multiview` service: pins, layout and open flag, each chat's kept through
 * {@link MultiviewPersistence}. Pins are the source of truth; the layout only places them and is reconciled with the pins on
 * every change.
 * @module @delorun/plugin-multiview/entry/state
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MultiviewSettings } from '../config.ts'
import {
  applyPreset, capacityRefusal, reconcileLayout, resetLayout,
  type CapacityRefusal, type LayoutArea, type LayoutLimits, type LayoutModel, type LayoutPreset,
} from '../layout/index.ts'
import {
  EMPTY_CHAT_MULTIVIEW, type ChatMultiview, type MultiviewPersistence, type MultiviewService, type PinResult,
} from '../client/contract.ts'

/** What the store needs from its surroundings. */
export interface MultiviewStoreOptions {
  /** The settings now in force. */
  readonly settings: HostObservable<MultiviewSettings>
  /** Where chats' state is kept. */
  readonly persistence: MultiviewPersistence
  /** The window's size, used for "screen full" until the layout reports its own area. */
  readonly windowArea: () => LayoutArea
}

/**
 * The limits the settings give.
 * @param settings - the multiview settings.
 * @returns the pane count and the minimum pane size they allow.
 */
export function limitsOf(settings: MultiviewSettings): LayoutLimits {
  return { maxPanes: settings.maxPanes, minPaneWidth: settings.minPaneWidth, minPaneHeight: settings.minPaneHeight }
}

/** The per-chat state of every chat the page has touched. */
export class MultiviewStore implements MultiviewService {
  readonly #chats = new Map<SessionId, SnapshotStore<ChatMultiview>>()
  #area: LayoutArea | undefined
  /** The settings now in force. */
  readonly settings: HostObservable<MultiviewSettings>
  readonly #options: MultiviewStoreOptions

  /** @param options - the settings, the persistence and the window measure. */
  constructor(options: MultiviewStoreOptions) {
    this.#options = options
    this.settings = options.settings
  }

  #store(chat: SessionId): SnapshotStore<ChatMultiview> {
    const known = this.#chats.get(chat)
    if (known !== undefined) return known
    const created = createSnapshotStore<ChatMultiview>(this.#options.persistence.load(chat) ?? EMPTY_CHAT_MULTIVIEW)
    this.#chats.set(chat, created)
    return created
  }

  #write(chat: SessionId, next: ChatMultiview): void {
    this.#store(chat).set(next)
    this.#options.persistence.save(chat, next, this.settings.getSnapshot().keepChats)
  }

  #limits(): LayoutLimits {
    return limitsOf(this.settings.getSnapshot())
  }

  /** The chat's state as an observable. */
  of(chat: SessionId): HostObservable<ChatMultiview> {
    return this.#store(chat)
  }

  /** Why one more agent cannot be pinned, or undefined. */
  capacityRefusal(chat: SessionId): CapacityRefusal | undefined {
    return capacityRefusal(1 + this.#store(chat).getSnapshot().pins.length, this.#limits(), this.#area ?? this.#options.windowArea())
  }

  /** Pin an agent's chat. */
  pin(chat: SessionId, agent: SessionId): PinResult {
    if (agent === chat) return { ok: false, reason: 'main-chat' }
    const state = this.#store(chat).getSnapshot()
    if (state.pins.includes(agent)) return { ok: false, reason: 'already-pinned' }
    const refusal = this.capacityRefusal(chat)
    if (refusal !== undefined) return { ok: false, reason: refusal }
    const pins = [...state.pins, agent]
    this.#write(chat, { ...state, pins, layout: state.layout === null ? null : reconcileLayout(state.layout, chat, pins) })
    return { ok: true }
  }

  /** Remove a pin and its pane. */
  unpin(chat: SessionId, agent: SessionId): void {
    const state = this.#store(chat).getSnapshot()
    if (!state.pins.includes(agent)) return
    const pins = state.pins.filter(pin => pin !== agent)
    this.#write(chat, { ...state, pins, layout: state.layout === null ? null : reconcileLayout(state.layout, chat, pins) })
  }

  /** Pin each agent until the limit is reached. */
  pinAll(chat: SessionId, agents: readonly SessionId[]): { readonly pinned: number; readonly refused: number } {
    let pinned = 0
    let refused = 0
    for (const agent of agents) {
      const result = this.pin(chat, agent)
      if (result.ok) pinned += 1
      else if (result.reason === 'max-panes' || result.reason === 'no-room') refused += 1
    }
    return { pinned, refused }
  }

  /** Open Multiview for a chat. */
  open(chat: SessionId): void {
    this.#write(chat, { ...this.#store(chat).getSnapshot(), open: true })
  }

  /** Return to the normal chat. */
  close(chat: SessionId): void {
    this.#write(chat, { ...this.#store(chat).getSnapshot(), open: false })
  }

  /** Replace the layout. */
  setLayout(chat: SessionId, layout: LayoutModel): void {
    this.#write(chat, { ...this.#store(chat).getSnapshot(), layout })
  }

  /** Rearrange the panes in a preset. */
  applyPreset(chat: SessionId, preset: LayoutPreset): void {
    const state = this.#store(chat).getSnapshot()
    const current = reconcileLayout(state.layout ?? undefined, chat, state.pins)
    this.#write(chat, { ...state, layout: applyPreset(current, { main: chat }, preset) })
  }

  /** Go back to the default arrangement. */
  resetLayout(chat: SessionId): void {
    const state = this.#store(chat).getSnapshot()
    const current = reconcileLayout(state.layout ?? undefined, chat, state.pins)
    this.#write(chat, { ...state, layout: resetLayout(current, { main: chat }) })
  }

  /** Report the area the layout fills. */
  reportArea(area: LayoutArea | undefined): void {
    this.#area = area
  }
}
