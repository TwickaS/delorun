/**
 * What the entry points share with the panel and the pane lanes: the settings, the dictionary namespace, the panel id, and
 * the `multiview` service that holds each chat's pins, its layout and whether Multiview is open.
 * @module @delorun/plugin-multiview/client/contract
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CapacityRefusal, LayoutArea, LayoutModel, LayoutPreset } from '../layout/index.ts'
import type { MultiviewSettings } from '../config.ts'

/** The dictionary namespace of the entry points' copy. */
export const MULTIVIEW_NS = 'delorunMultiview'

/** The id of the `main` panel the panel lane registers, and of the entry that selects it. */
export const MULTIVIEW_PANEL_ID = 'multiview'

/** One chat's Multiview state, the value that is kept per chat as a client preference. */
export interface ChatMultiview {
  /** The pinned agents' chats in pin order; the source of truth for which panes exist. */
  readonly pins: readonly SessionId[]
  /** Where the panes sit; null until the person or a preset arranges them, when the panel builds the default. */
  readonly layout: LayoutModel | null
  /** Whether the person had Multiview open in this chat. */
  readonly open: boolean
}

/** A chat with nothing pinned and Multiview closed. */
export const EMPTY_CHAT_MULTIVIEW: ChatMultiview = { pins: [], layout: null, open: false }

/** Why a pin was not made: the pane limit, no room on the screen, or the agent is the chat itself or already pinned. */
export type PinRefusal = CapacityRefusal | 'already-pinned' | 'main-chat'

/** The result of a pin. */
export type PinResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PinRefusal }

/** Where a chat's Multiview state is kept between page loads. */
export interface MultiviewPersistence {
  /**
   * Read a chat's saved state.
   * @param chat - the chat.
   * @returns the saved state, or undefined when none is saved or the saved value is not valid.
   */
  load(chat: SessionId): ChatMultiview | undefined
  /**
   * Save a chat's state.
   * @param chat - the chat.
   * @param value - the state to keep.
   * @param keepChats - how many chats' states to keep; saving beyond it forgets the least recently saved chats.
   */
  save(chat: SessionId, value: ChatMultiview, keepChats: number): void
}

/**
 * The service `ctx.multiview`: the entry lane writes it, the panel lane reads it. State is per chat, identified by the chat
 * that is the main view; every method takes that chat.
 */
export interface MultiviewService {
  /**
   * The settings now in force.
   * @returns the Config values, each applied when the studio starts and again when it changes.
   */
  readonly settings: HostObservable<MultiviewSettings>
  /**
   * A chat's state as an observable; the same object for the same chat.
   * @param chat - the chat.
   * @returns the observable state.
   */
  of(chat: SessionId): HostObservable<ChatMultiview>
  /**
   * Whether one more agent can be pinned in a chat.
   * @param chat - the chat.
   * @returns undefined when it can, otherwise why not.
   */
  capacityRefusal(chat: SessionId): CapacityRefusal | undefined
  /**
   * Pin an agent's chat.
   * @param chat - the chat that Multiview belongs to.
   * @param agent - the agent's chat.
   * @returns whether it was pinned, and why not.
   */
  pin(chat: SessionId, agent: SessionId): PinResult
  /**
   * Remove a pin and its pane.
   * @param chat - the chat that Multiview belongs to.
   * @param agent - the agent's chat.
   */
  unpin(chat: SessionId, agent: SessionId): void
  /**
   * Pin each of these agents until the limit is reached.
   * @param chat - the chat that Multiview belongs to.
   * @param agents - the agents to pin, in order.
   * @returns how many were pinned and how many the limit kept out.
   */
  pinAll(chat: SessionId, agents: readonly SessionId[]): { readonly pinned: number; readonly refused: number }
  /**
   * Show Multiview for a chat and record that it is open.
   * @param chat - the chat that Multiview belongs to.
   */
  open(chat: SessionId): void
  /**
   * Return to the normal chat and record that Multiview is closed.
   * @param chat - the chat that Multiview belongs to.
   */
  close(chat: SessionId): void
  /**
   * Replace the layout, for the panel's own changes: a drop, a divider, a tab.
   * @param chat - the chat that Multiview belongs to.
   * @param layout - the new layout.
   */
  setLayout(chat: SessionId, layout: LayoutModel): void
  /**
   * Rearrange the panes in a preset; nothing opens or closes.
   * @param chat - the chat that Multiview belongs to.
   * @param preset - the arrangement.
   */
  applyPreset(chat: SessionId, preset: LayoutPreset): void
  /**
   * Go back to the default arrangement with the same panes.
   * @param chat - the chat that Multiview belongs to.
   */
  resetLayout(chat: SessionId): void
  /**
   * Report the rectangle the layout fills, so the pin button can say the screen is full.
   * @param area - the size, or undefined when Multiview is closed, which falls back to the window.
   */
  reportArea(area: LayoutArea | undefined): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Multiview's pins, layouts and open state; provided by `@delorun/plugin-multiview/client`. */
    multiview: MultiviewService
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Multiview entry points' copy. */
    'delorunMultiview': import('../entry/locales.ts').MultiviewLocaleKey
  }
}
