/**
 * The Multiview settings, shared by the host half that declares them and the browser half that reads them: whether a
 * hand-off opens Multiview, how many panes it holds, how a pane's composer looks, whether a chat reopens it, and the layout a
 * new Multiview starts with.
 * @module @delorun/plugin-multiview/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_PANES, DEFAULT_MIN_PANE_HEIGHT, DEFAULT_MIN_PANE_WIDTH } from './layout/limits.ts'
import {
  AUTO_COLUMNS_UP_TO, DEFAULT_PRESET, LAYOUT_CHOICE_IDS, MAIN_SHARE, MAIN_SHARE_RANGE, MAIN_SIDES, STACK_STYLES,
  type LayoutChoiceId, type MainSide, type StackStyle,
} from './layout/presets.ts'
import type { LayoutShape } from './layout/model.ts'

/** The Loader row id of `@delorun/bundle-local`'s row for this plugin, which names the settings namespace the browser half reads. */
export const MULTIVIEW_ROW_ID = 'delorun-multiview'

/** The most panes Config accepts, the main chat included; the layout also stops at what fits the screen. */
export const MAX_PANES_RANGE = { min: 2, max: 12 } as const

/** The smallest pane Config accepts, in CSS pixels. */
export const MIN_PANE_SIZE_RANGE = { width: { min: 240, max: 1200 }, height: { min: 160, max: 1200 } } as const

/** The most chats whose saved Multiview state is kept, least recent first to go; Config accepts a count in this range. */
export const KEPT_CHATS_RANGE = { min: 1, max: 500 } as const

/** The views Auto puts side by side at most, before it chooses by the window's shape; Config accepts a count in this range. */
export const AUTO_COLUMNS_RANGE = { min: 1, max: 6 } as const

/** Whether the activity mosaic animates its rearrangements, or follows the system's reduced-motion setting by not animating. */
export const MOSAIC_MOTIONS = ['on', 'reduced'] as const

/** How far a person's own arrangement ("Yours") applies: every chat of the studio, the chats of one workspace, or one chat. */
export const REMEMBER_SCOPES = ['studio', 'workspace', 'chat'] as const

/** What makes an arrangement the person's own: moving or resizing panes, or moving panes only (resizing then stays with the chat). */
export const SAVE_TRIGGERS = ['move-or-resize', 'move'] as const

/** One of {@link MOSAIC_MOTIONS}. */
export type MosaicMotion = (typeof MOSAIC_MOTIONS)[number]

/** One of {@link REMEMBER_SCOPES}. */
export type RememberScope = (typeof REMEMBER_SCOPES)[number]

/** One of {@link SAVE_TRIGGERS}. */
export type SaveTrigger = (typeof SAVE_TRIGGERS)[number]

/** The layout defaults one workspace keeps; a field it lacks is the studio's. */
export interface WorkspaceLayoutDefaults {
  /** The layout a new Multiview in the workspace starts with. */
  readonly defaultLayout?: LayoutChoiceId | undefined
  /** "Yours" for the workspace. */
  readonly yours?: LayoutShape | null | undefined
  /** The side Main and stack keeps the main chat on. */
  readonly mainSide?: MainSide | undefined
  /** How Main and stack tiles the other panes. */
  readonly stackStyle?: StackStyle | undefined
}

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
  /** The layout a new Multiview starts with: a layout of the picker, or `yours`, the person's own saved arrangement. */
  defaultLayout: LayoutChoiceId
  /** The side Main and stack keeps the main chat on. */
  mainSide: MainSide
  /** How Main and stack tiles the other panes. */
  stackStyle: StackStyle
  /** The main chat's share in Main and stack, Main on top and Centred main, in percent. */
  mainShare: number
  /** The views Auto puts side by side at most. */
  autoColumns: number
  /** Whether the activity mosaic animates its rearrangements. */
  mosaicMotion: MosaicMotion
  /** How far the person's own arrangement applies. */
  rememberScope: RememberScope
  /** What makes an arrangement the person's own. */
  saveOn: SaveTrigger
  /** "Yours" for the whole studio; null or absent when none is saved (Reset to Auto writes null). */
  yours: LayoutShape | null | undefined
  /** The defaults of each workspace that has its own, by workspace id. */
  workspaceLayouts: Readonly<Record<string, WorkspaceLayoutDefaults>>
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
  defaultLayout: DEFAULT_PRESET,
  mainSide: 'left',
  stackStyle: 'rows',
  mainShare: MAIN_SHARE,
  autoColumns: AUTO_COLUMNS_UP_TO,
  mosaicMotion: 'on',
  rememberScope: 'studio',
  saveOn: 'move-or-resize',
  yours: undefined,
  workspaceLayouts: {},
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
  /** The layout a new Multiview starts with; default `auto`. */
  defaultLayout: Volatile<LayoutChoiceId>
  /** The side Main and stack keeps the main chat on; default `left`. */
  mainSide: Volatile<MainSide>
  /** How Main and stack tiles the other panes; default `rows`. */
  stackStyle: Volatile<StackStyle>
  /** The main chat's share in percent; default 56. */
  mainShare: Volatile<number>
  /** The views Auto puts side by side at most; default 3. */
  autoColumns: Volatile<number>
  /** Whether the activity mosaic animates; default `on`. */
  mosaicMotion: Volatile<MosaicMotion>
  /** How far the person's own arrangement applies; default `studio`. */
  rememberScope: Volatile<RememberScope>
  /** What makes an arrangement the person's own; default `move-or-resize`. */
  saveOn: Volatile<SaveTrigger>
  /** "Yours" for the whole studio; default none. */
  yours: Volatile<LayoutShape | null | undefined>
  /** Each workspace's own defaults; default none. */
  workspaceLayouts: Volatile<Readonly<Record<string, WorkspaceLayoutDefaults>>>
}

/** The most slots a saved shape names: the Config ceiling of panes. */
const MAX_SHAPE_SLOTS = MAX_PANES_RANGE.max
const shapeSize = z.number().min(0.01).max(100).required()
const ShapeLeaf = z.object({
  kind: z.const('leaf').required(),
  slots: z.array(z.natural().max(MAX_SHAPE_SLOTS * 4)).min(1).max(MAX_SHAPE_SLOTS).required(),
  active: z.natural().max(MAX_SHAPE_SLOTS * 4).required(),
  size: shapeSize,
})
// The schemas below check stored arrangements when the configuration loads; their element types are the readonly `LayoutShape`
// and `WorkspaceLayoutDefaults` above, which schemastery's mutable inferred types do not express, so they stay unannotated.
const ShapeNodeSchema: z = z.lazy((): z => z.union([
  ShapeLeaf,
  z.object({
    kind: z.const('split').required(),
    orientation: z.union(['horizontal', 'vertical'] as const).required(),
    children: z.array(ShapeNodeSchema).min(2).max(MAX_SHAPE_SLOTS).required(),
    size: shapeSize,
  }),
]))

/** The schema of a saved arrangement ("Yours"): slots in place of chats, so it applies to any chat's agents. */
export const ShapeSchema: z = z.object({ version: z.const(1).required(), root: ShapeNodeSchema.required() })

const WorkspaceDefaultsSchema: z = z.object({
  defaultLayout: z.union([...LAYOUT_CHOICE_IDS]),
  yours: z.union([z.const(null), ShapeSchema]),
  mainSide: z.union([...MAIN_SIDES]),
  stackStyle: z.union([...STACK_STYLES]),
})

/** The configuration schema: each field validated, defaulted, and changeable while the studio runs. */
export const Config = z.object({
  autoOpen: z.boolean().description('Open Multiview by itself, and pin the agent, each time the chat hands work to a teammate, subagent, Claude Code or Codex.').default(DEFAULT_MULTIVIEW_SETTINGS.autoOpen).volatile(),
  maxPanes: z.natural().min(MAX_PANES_RANGE.min).max(MAX_PANES_RANGE.max).description('Panes Multiview holds at most, the main chat included; the pin button is disabled when the limit is reached.').default(DEFAULT_MULTIVIEW_SETTINGS.maxPanes).volatile(),
  minPaneWidth: z.natural().min(MIN_PANE_SIZE_RANGE.width.min).max(MIN_PANE_SIZE_RANGE.width.max).description('The least width of a pane in CSS pixels; panes that would be narrower become tabs.').default(DEFAULT_MULTIVIEW_SETTINGS.minPaneWidth).volatile(),
  minPaneHeight: z.natural().min(MIN_PANE_SIZE_RANGE.height.min).max(MIN_PANE_SIZE_RANGE.height.max).description('The least height of a pane in CSS pixels; panes that would be shorter become tabs.').default(DEFAULT_MULTIVIEW_SETTINGS.minPaneHeight).volatile(),
  compactComposer: z.boolean().description('Show a one-line reply box in each pane; off shows the full composer, with its model and permission controls, in every pane.').default(DEFAULT_MULTIVIEW_SETTINGS.compactComposer).volatile(),
  reopenOnReturn: z.boolean().description('Reopen Multiview when the person returns to a chat that had it open.').default(DEFAULT_MULTIVIEW_SETTINGS.reopenOnReturn).volatile(),
  keepChats: z.natural().min(KEPT_CHATS_RANGE.min).max(KEPT_CHATS_RANGE.max).description('How many chats keep their pinned agents and layout in this browser; the chat saved longest ago is forgotten first.').default(DEFAULT_MULTIVIEW_SETTINGS.keepChats).volatile(),
  defaultLayout: z.union([...LAYOUT_CHOICE_IDS]).description('The layout a new Multiview starts with: auto (sized to the window), a layout of the picker, or yours (the arrangement you made by dragging). Choosing a layout in the picker sets it.').default(DEFAULT_MULTIVIEW_SETTINGS.defaultLayout).volatile(),
  mainSide: z.union([...MAIN_SIDES]).description('The side Main and stack keeps the main chat on, at full height.').default(DEFAULT_MULTIVIEW_SETTINGS.mainSide).volatile(),
  stackStyle: z.union([...STACK_STYLES]).description('How Main and stack tiles the other panes beside the main chat: rows, columns, a grid or a spiral.').default(DEFAULT_MULTIVIEW_SETTINGS.stackStyle).volatile(),
  mainShare: z.natural().min(MAIN_SHARE_RANGE.min).max(MAIN_SHARE_RANGE.max).description('The main chat\'s share of the width in Main and stack and Centred main, and of the height in Main on top, in percent; dragging its divider sets it.').default(DEFAULT_MULTIVIEW_SETTINGS.mainShare).volatile(),
  autoColumns: z.natural().min(AUTO_COLUMNS_RANGE.min).max(AUTO_COLUMNS_RANGE.max).description('Auto puts up to this many views side by side; with more it chooses a layout for the window\'s shape.').default(DEFAULT_MULTIVIEW_SETTINGS.autoColumns).volatile(),
  mosaicMotion: z.union([...MOSAIC_MOTIONS]).description('Whether the activity mosaic animates as agents start and finish: on, or reduced (no animation; the system\'s reduced-motion setting also turns it off).').default(DEFAULT_MULTIVIEW_SETTINGS.mosaicMotion).volatile(),
  rememberScope: z.union([...REMEMBER_SCOPES]).description('Where an arrangement you make by dragging becomes the default: the whole studio, this workspace, or this chat only.').default(DEFAULT_MULTIVIEW_SETTINGS.rememberScope).volatile(),
  saveOn: z.union([...SAVE_TRIGGERS]).description('What makes an arrangement your default: moving or resizing panes, or moving panes only (a resize then stays with that chat).').default(DEFAULT_MULTIVIEW_SETTINGS.saveOn).volatile(),
  yours: z.union([z.const(null), ShapeSchema]).hidden().description('Your arrangement for the whole studio, saved when you drag panes; Reset to Auto clears it.').volatile(),
  workspaceLayouts: z.dict(WorkspaceDefaultsSchema).hidden().description('Layout defaults kept for single workspaces, by workspace id.').default({}).volatile(),
})
