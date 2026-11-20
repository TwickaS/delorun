/**
 * The Multiview settings, shared by the host half that declares them and the browser half that reads them: whether a
 * hand-off opens Multiview, how many panes it holds, how a pane's composer looks, and whether a chat reopens it.
 * @module @delorun/plugin-multiview/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_PANES, DEFAULT_MIN_PANE_HEIGHT, DEFAULT_MIN_PANE_WIDTH } from './layout/limits.ts'

/** The Loader row id of `@delorun/bundle-local`'s row for this plugin, which names the settings namespace the browser half reads. */
export const MULTIVIEW_ROW_ID = 'delorun-multiview'

/** The most panes Config accepts, the main chat included; the layout also stops at what fits the screen. */
export const MAX_PANES_RANGE = { min: 2, max: 12 } as const

/** The smallest pane Config accepts, in CSS pixels. */
export const MIN_PANE_SIZE_RANGE = { width: { min: 240, max: 1200 }, height: { min: 160, max: 1200 } } as const

/** The most chats whose saved Multiview state is kept, least recent first to go; Config accepts a count in this range. */
export const KEPT_CHATS_RANGE = { min: 1, max: 500 } as const

/** The settings as the browser half reads them. */
export interface MultiviewSettings {
  /** Whether a new hand-off (teammate, subagent, Claude Code or Codex) pins itself and opens Multiview, every time. */
  autoOpen: boolean
  /** Panes at most, the main chat included. */
  maxPanes: number
  /** The least width of a pane, in CSS pixels. */
  minPaneWidth: number
  /** The least height of a pane, in CSS pixels. */
  minPaneHeight: number
  /** Whether a pane shows the compact reply box (one line, no model or permission controls) instead of the full composer. */
  compactComposer: boolean
  /** Whether a chat that had Multiview open reopens it when the person comes back to the chat. */
  reopenOnReturn: boolean
  /** How many chats' saved pins and layouts the browser keeps; saving one more removes the least recently saved chat's. */
  keepChats: number
}

/** The settings a browser applies before its stored ones arrive. */
export const DEFAULT_MULTIVIEW_SETTINGS: MultiviewSettings = {
  autoOpen: true,
  maxPanes: DEFAULT_MAX_PANES,
  minPaneWidth: DEFAULT_MIN_PANE_WIDTH,
  minPaneHeight: DEFAULT_MIN_PANE_HEIGHT,
  compactComposer: true,
  reopenOnReturn: true,
  keepChats: 50,
}

/** The host half's live configuration: one field per setting. */
export interface Config {
  /** Whether a new hand-off pins itself and opens Multiview every time; default on. */
  autoOpen: Volatile<boolean>
  /** Panes at most, the main chat included; default 6. */
  maxPanes: Volatile<number>
  /** The least pane width in CSS pixels; a pane is never laid out narrower, so the layout holds fewer panes on a narrow screen; default 340. */
  minPaneWidth: Volatile<number>
  /** The least pane height in CSS pixels; default 240. */
  minPaneHeight: Volatile<number>
  /** Whether panes show the compact reply box; off shows the full composer in every pane; default on. */
  compactComposer: Volatile<boolean>
  /** Whether a chat that had Multiview open reopens it on return; default on. */
  reopenOnReturn: Volatile<boolean>
  /** How many chats' saved pins and layouts the browser keeps; default 50. */
  keepChats: Volatile<number>
}

/** The configuration schema: each field validated, defaulted, and changeable while the studio runs. */
export const Config = z.object({
  autoOpen: z.boolean().description('Open Multiview by itself, and pin the agent, each time the chat hands work to a teammate, subagent, Claude Code or Codex.').default(DEFAULT_MULTIVIEW_SETTINGS.autoOpen).volatile(),
  maxPanes: z.natural().min(MAX_PANES_RANGE.min).max(MAX_PANES_RANGE.max).description('Panes Multiview holds at most, the main chat included; the pin button is disabled when the limit is reached.').default(DEFAULT_MULTIVIEW_SETTINGS.maxPanes).volatile(),
  minPaneWidth: z.natural().min(MIN_PANE_SIZE_RANGE.width.min).max(MIN_PANE_SIZE_RANGE.width.max).description('The least width of a pane in CSS pixels; a narrow screen holds fewer panes.').default(DEFAULT_MULTIVIEW_SETTINGS.minPaneWidth).volatile(),
  minPaneHeight: z.natural().min(MIN_PANE_SIZE_RANGE.height.min).max(MIN_PANE_SIZE_RANGE.height.max).description('The least height of a pane in CSS pixels.').default(DEFAULT_MULTIVIEW_SETTINGS.minPaneHeight).volatile(),
  compactComposer: z.boolean().description('Show a one-line reply box in each pane; off shows the full composer, with its model and permission controls, in every pane.').default(DEFAULT_MULTIVIEW_SETTINGS.compactComposer).volatile(),
  reopenOnReturn: z.boolean().description('Reopen Multiview when the person returns to a chat that had it open.').default(DEFAULT_MULTIVIEW_SETTINGS.reopenOnReturn).volatile(),
  keepChats: z.natural().min(KEPT_CHATS_RANGE.min).max(KEPT_CHATS_RANGE.max).description('How many chats keep their pinned agents and layout in this browser; the chat saved longest ago is forgotten first.').default(DEFAULT_MULTIVIEW_SETTINGS.keepChats).volatile(),
})
