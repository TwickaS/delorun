/**
 * What the entry points share with the layer and the panes: the settings, the dictionary namespace, the layer id, and
 * the `multiview` service that holds each chat's pins, its layout and whether Multiview is open.
 * @module @delorun/plugin-multiview/client/contract
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CapacityRefusal, ChatArrangement, LayoutArea, LayoutChoiceId, LayoutModel, LayoutPreset, LayoutShape, LegacyLayoutPreset, MainSide, PaneActivity,
  PaneId, StackStyle,
} from '../layout/index.ts'
import type { MosaicMotion, MultiviewSettings, RememberScope, SaveTrigger } from '../config.ts'

/** The dictionary namespace of the entry points' copy. */
export const MULTIVIEW_NS = 'delorunMultiview'

/** The id of Multiview's layer in the `conversation.main.body` slot, which the entry points wait for before they mount. */
export const MULTIVIEW_LAYER_ID = 'multiview'

/** One chat's Multiview state, the value that is kept per chat as a client preference. */
export interface ChatMultiview {
  /** The pinned agents' chats in pin order; the source of truth for which panes exist. */
  readonly pins: readonly SessionId[]
  /** Where the panes sit; null until the person or a preset arranges them, when the layer builds the default. */
  readonly layout: LayoutModel | null
  /** Whether the person had Multiview open in this chat. */
  readonly open: boolean
  /**
   * What the chat's layout follows: a picker choice, or `custom` for a layout saved before choices were remembered. Absent until the
   * chat is first written, when it takes the default for new Multiviews; a chat keeps it when that default changes later.
   */
  readonly arrangement?: ChatArrangement | undefined
  /** The panes in slot order, the main slot first, once the person swapped a pane into the main place; absent means the main chat then the pins. */
  readonly slots?: readonly SessionId[] | undefined
  /** The chat's own copy of "Yours", taken when it started following `yours`. */
  readonly shape?: LayoutShape | undefined
  /**
   * Set while the person has closed Multiview in this chat and not opened it since: a hand-off pins its agent but does not open
   * Multiview. It is either `true` or absent, never `false`, and it is absent whenever `open` is true, so a record saved before
   * this field loads as it did.
   */
  readonly closedByPerson?: true | undefined
}

/** A chat with nothing pinned and Multiview closed. */
export const EMPTY_CHAT_MULTIVIEW: ChatMultiview = { pins: [], layout: null, open: false }

/** Why a pin was not made: the pane limit, no room on the screen, or the agent is the chat itself or already pinned. */
export type PinRefusal = CapacityRefusal | 'already-pinned' | 'main-chat'

/** The result of a pin. */
export type PinResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PinRefusal }

/** The layout defaults that apply to a chat, and the options the presets share. */
export interface LayoutDefaults {
  /** The layout a new Multiview starts with; `yours` only when a shape is saved. */
  readonly layout: LayoutChoiceId
  /** "Yours" for the chat's workspace or the studio, when saved. */
  readonly shape: LayoutShape | undefined
  /** Where "Yours" comes from. */
  readonly shapeScope: 'studio' | 'workspace' | undefined
  /** The side Main and stack keeps the main chat on. */
  readonly mainSide: MainSide
  /** How Main and stack tiles the others. */
  readonly stackStyle: StackStyle
  /** The main chat's share, in percent. */
  readonly mainShare: number
  /** The views Auto puts side by side at most. */
  readonly autoColumns: number
  /** Whether the activity mosaic animates. */
  readonly mosaicMotion: MosaicMotion
  /** How far an arrangement the person makes applies. */
  readonly scope: RememberScope
  /** What makes an arrangement the person's own. */
  readonly saveOn: SaveTrigger
  /** Whether the last "Saved as your default layout" can still be undone. */
  readonly canUndo: boolean
}

/** A value that changes whenever any chat's defaults may have changed. */
export interface DefaultsRevision {
  readonly revision: number
  /** Whether the last "Saved as your default layout" can still be undone. */
  readonly canUndo: boolean
}

/** Why the person's own arrangement is being kept: a drag of a pane or a divider, or a move from a pane's menu. */
export type AdoptReason = 'move' | 'swap' | 'resize'

/**
 * Whether a kept arrangement is to become a default, and at which scope, for the "Saved as your default layout" notice. `written`
 * settles with true once the Host accepted the new default (at once for the chat scope, which writes nothing) and false when it
 * refused it, for example on a device whose settings are read-only; the notice waits for it.
 */
export type AdoptResult =
  | { readonly saved: false }
  | { readonly saved: true; readonly scope: RememberScope; readonly written: Promise<boolean> }

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
 * The service `ctx.multiview`: the entry points write it, the layer reads it. State is per chat, identified by the chat
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
   * Remove every pin of a chat, leaving its layout to be rebuilt from what remains.
   * @param chat - the chat that Multiview belongs to.
   * @returns how many pins were removed.
   */
  unpinAll(chat: SessionId): number
  /**
   * Set how many panes Multiview holds at most, the main chat included, as the agents list's settings popover does.
   * @param panes - the limit; kept inside {@link MAX_PANES_RANGE}.
   */
  setMaxPanes(panes: number): void
  /**
   * Set whether a hand-off pins its agent and opens Multiview, as the agents list's settings popover does.
   * @param autoOpen - the choice.
   */
  setAutoOpen(autoOpen: boolean): void
  /**
   * Open Multiview for a chat: the layer in the chat's content shows the panes, and the choice is kept. This is the person's
   * own open, so a later hand-off opens Multiview again.
   * @param chat - the chat that Multiview belongs to.
   */
  open(chat: SessionId): void
  /**
   * Close Multiview for a chat: the content shows the normal chat, and the choice is kept. The layer's own reasons close it
   * this way, recording no choice of the person's, so a later hand-off opens Multiview again.
   * @param chat - the chat that Multiview belongs to.
   */
  close(chat: SessionId): void
  /**
   * Close Multiview because the person did, with the toggle, the footer's button or the focus command: a hand-off pins its
   * agent but does not open Multiview again until the person opens it.
   * @param chat - the chat that Multiview belongs to.
   */
  closeByPerson(chat: SessionId): void
  /**
   * Replace the layout, for the layer's own changes: a drop, a divider, a tab.
   * @param chat - the chat that Multiview belongs to.
   * @param layout - the new layout.
   */
  setLayout(chat: SessionId, layout: LayoutModel): void
  /**
   * Rearrange the panes in a preset; nothing opens or closes. The same as {@link MultiviewService.chooseLayout}, `main-column` reading as Main and stack.
   * @param chat - the chat that Multiview belongs to.
   * @param preset - the arrangement.
   */
  applyPreset(chat: SessionId, preset: LayoutPreset | LegacyLayoutPreset): void
  /**
   * Go back to the default for new Multiviews with the same panes; the default itself does not change.
   * @param chat - the chat that Multiview belongs to.
   */
  resetLayout(chat: SessionId): void
  /** Changes whenever any chat's defaults may have changed; subscribe to it and read {@link MultiviewService.defaultsOf}. */
  readonly defaults: HostObservable<DefaultsRevision>
  /**
   * The defaults that apply to a chat: its workspace's own where it has them, else the studio's.
   * @param chat - the chat.
   * @returns the defaults; the same object while they do not change.
   */
  defaultsOf(chat: SessionId): LayoutDefaults
  /**
   * What a chat's layout follows now.
   * @param chat - the chat.
   * @returns its arrangement, or the default for a chat that has none yet.
   */
  arrangementOf(chat: SessionId): ChatArrangement
  /**
   * Show a picker choice in a chat and make it the default for new Multiviews at the person's scope. Nothing opens or closes.
   * @param chat - the chat that Multiview belongs to.
   * @param choice - the choice; `yours` without a saved arrangement shows Auto.
   */
  chooseLayout(chat: SessionId, choice: LayoutChoiceId): void
  /**
   * Keep the person's own arrangement: the chat follows it and, at the person's scope (the studio, the chat's workspace, or the
   * chat only), it becomes "Yours", the default for new Multiviews. The previous defaults and the chat's previous arrangement are
   * kept for {@link MultiviewService.undoDefault}.
   * @param chat - the chat that Multiview belongs to.
   * @param layout - the arrangement the person made.
   * @param reason - what the person did; a resize with `saveOn` set to moving only stays with the chat.
   * @returns whether it became a default, and at which scope.
   */
  adoptArrangement(chat: SessionId, layout: LayoutModel, reason: AdoptReason): AdoptResult
  /** Undo the last {@link MultiviewService.adoptArrangement}: the previous default and that chat's previous arrangement come back. */
  undoDefault(): void
  /**
   * Clear "Yours" for the studio and for the chat's workspace, and make Auto the default for new Multiviews.
   * @param chat - a chat to show Auto in at once, whose workspace's own defaults are cleared too, if any.
   */
  resetToAuto(chat?: SessionId): void
  /**
   * Set the main chat's share for the layouts that have one, remembered for every chat.
   * @param share - percent; kept inside the bounds.
   */
  setMainShare(share: number): void
  /**
   * Set the Main and stack options, remembered as settings for the studio, or for the chat's workspace with the workspace scope.
   * @param options - the side and the stack style to change.
   * @param chat - the chat whose workspace the workspace scope writes, if any.
   */
  setStackOptions(options: { readonly mainSide?: MainSide; readonly stackStyle?: StackStyle }, chat?: SessionId): void
  /**
   * Show the next or previous picker choice in a chat, for the layout keys.
   * @param chat - the chat that Multiview belongs to.
   * @param step - 1 for next, -1 for previous.
   */
  cycleLayout(chat: SessionId, step: 1 | -1): void
  /**
   * Put a pane in the main place and the pane there in its place.
   * @param chat - the chat that Multiview belongs to.
   * @param pane - the pane to bring to the main place.
   */
  swapWithMain(chat: SessionId, pane: PaneId): void
  /**
   * Grow or shrink the main place by one step.
   * @param chat - the chat that Multiview belongs to.
   * @param step - 1 to grow, -1 to shrink.
   */
  resizeMain(chat: SessionId, step: 1 | -1): void
  /**
   * The layout a chat shows: its arrangement for its panes, the area and the activity, panes under the least size as tabs.
   * @param chat - the chat.
   * @param area - the rectangle the layout fills, if measured.
   * @param activity - each pane's activity, for the activity mosaic.
   * @returns the layout.
   */
  layoutFor(chat: SessionId, area?: LayoutArea, activity?: ReadonlyMap<PaneId, PaneActivity>): LayoutModel
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
    /** The layout picker's, the layout keys' and the Multiview settings section's copy. */
    'delorunMultiviewLayouts': import('../layout/locales.ts').LayoutsLocaleKey
  }
}
