/**
 * The sidebar's settings, shared by the host half that stores them and the
 * studio half that applies them: the header art and its palette, how the
 * chat list groups and sorts chats, whether working chats gather on their
 * shelf, whether unpinning asks first, the sidebar's width, each
 * Workspace's icon (kept as stored; the studio validates each icon it reads),
 * and how often the studio asks the harness for the update notice.
 * @module @delo/plugin-sidebar/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** The Loader row id, which names the settings namespace the studio edits. */
export const SIDEBAR_ROW_ID = 'delo-sidebar'

/** The header art: none, T3 Code's night sky or blueprint, or a scene generated from `artSeed`. */
export const HEADER_ARTS = ['none', 'night', 'blueprint', 'waves', 'aurora', 'contours', 'constellation', 'halftone', 'shards'] as const

/** The largest art seed; Shuffle picks one below it. */
export const MAX_ART_SEED = 2_147_483_647

/** One header art choice. */
export type HeaderArt = typeof HEADER_ARTS[number]

/** The art palettes: T3 Code's Blueprint, Rose, Grove, Ocean, Ember and Iris, and the studio's accent. */
export const ART_PALETTES = ['blueprint', 'rose', 'grove', 'ocean', 'ember', 'iris', 'accent'] as const

/** One art palette. */
export type ArtPalette = typeof ART_PALETTES[number]

/** How the chat list groups chats: cards, or T3 Code's workspace folders with slim rows. */
export const LIST_VIEWS = ['cards', 'folders'] as const

/** One list view. */
export type ListView = typeof LIST_VIEWS[number]

/** How strongly the header art shows. */
export const ART_STRENGTHS = ['subtle', 'standard', 'vivid'] as const

/** One art strength. */
export type ArtStrength = typeof ART_STRENGTHS[number]

/** How the art shows, as T3 Code's environment badge does: behind the sidebar's top, or as a small pill beside the brand. */
export const ART_STYLES = ['artwork', 'pill'] as const

/** One art style. */
export type ArtStyle = typeof ART_STYLES[number]

/** How the chats are sorted: by their latest change, or by when they were created, T3 Code's two orders. */
export const SORT_ORDERS = ['updated', 'created'] as const

/** One sort order. */
export type SortOrder = typeof SORT_ORDERS[number]

/** The sidebar width slider's range and step, in pixels, and its notches: T3 Code's 256 and upstream's 280. */
export const SIDEBAR_WIDTH = { min: 240, max: 420, step: 4, notches: [256, 280] } as const

/** The most Workspace icons the setting holds; the studio drops the oldest beyond it, and a stored value above it is refused. */
export const MAX_WORKSPACE_ICONS = 200

/** The range, in minutes, of the studio's interval between reads of the update notice. */
export const UPDATE_NOTICE_REFRESH_MINUTES = { min: 5, max: 1440 } as const

/** The settings as the studio reads them. */
export interface SidebarSettings {
  headerArt: HeaderArt
  artPalette: ArtPalette
  view: ListView
  /** Whether working chats gather on the Working shelf at the bottom, instead of staying among the cards. */
  workingShelf: boolean
  /** The seed a generated scene is drawn from; Shuffle picks a new one. */
  artSeed: number
  /** How strongly the art shows. */
  artStrength: ArtStrength
  /** Whether the art fills the sidebar's top or shows as a pill. */
  artStyle: ArtStyle
  /** How the chats are sorted. */
  sort: SortOrder
  /** Whether unpinning a chat asks first. */
  confirmUnpin: boolean
  /** The sidebar's width in pixels, within `SIDEBAR_WIDTH`. */
  width: number
  /**
   * Each Workspace's chosen icon, by Workspace id, as stored, oldest choice first and at most `MAX_WORKSPACE_ICONS`.
   * The harness accepts any value for an icon so one bad icon cannot keep the row from loading; read it through
   * `readWorkspaceIcons`. A Workspace without a valid icon shows its monogram.
   */
  workspaceIcons: Record<string, unknown>
  /**
   * Minutes between the studio's reads of the update notice, within `UPDATE_NOTICE_REFRESH_MINUTES`; the studio also
   * reads it when it starts, reconnects or regains focus.
   */
  updateNoticeRefreshMinutes: number
}

/** The settings a studio applies before its stored ones arrive. */
export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = {
  headerArt: 'blueprint', artPalette: 'accent', view: 'cards', workingShelf: true, artSeed: 1, artStrength: 'standard', artStyle: 'artwork', sort: 'updated',
  confirmUnpin: false, width: 256, workspaceIcons: {}, updateNoticeRefreshMinutes: 60,
}

/** The host half's live configuration: one field per setting. */
export interface Config {
  headerArt: Volatile<HeaderArt>
  artPalette: Volatile<ArtPalette>
  view: Volatile<ListView>
  workingShelf: Volatile<boolean>
  artSeed: Volatile<number>
  artStrength: Volatile<ArtStrength>
  artStyle: Volatile<ArtStyle>
  sort: Volatile<SortOrder>
  confirmUnpin: Volatile<boolean>
  width: Volatile<number>
  workspaceIcons: Volatile<Record<string, unknown>>
  updateNoticeRefreshMinutes: Volatile<number>
}

/** The configuration schema: each field validated, defaulted, and changeable while the studio runs. */
export const Config = z.object({
  headerArt: z.union([...HEADER_ARTS]).default(DEFAULT_SIDEBAR_SETTINGS.headerArt).volatile(),
  artPalette: z.union([...ART_PALETTES]).default(DEFAULT_SIDEBAR_SETTINGS.artPalette).volatile(),
  view: z.union([...LIST_VIEWS]).default(DEFAULT_SIDEBAR_SETTINGS.view).volatile(),
  workingShelf: z.boolean().default(DEFAULT_SIDEBAR_SETTINGS.workingShelf).volatile(),
  artSeed: z.natural().min(1).max(MAX_ART_SEED).default(DEFAULT_SIDEBAR_SETTINGS.artSeed).volatile(),
  artStrength: z.union([...ART_STRENGTHS]).default(DEFAULT_SIDEBAR_SETTINGS.artStrength).volatile(),
  artStyle: z.union([...ART_STYLES]).default(DEFAULT_SIDEBAR_SETTINGS.artStyle).volatile(),
  sort: z.union([...SORT_ORDERS]).default(DEFAULT_SIDEBAR_SETTINGS.sort).volatile(),
  confirmUnpin: z.boolean().default(DEFAULT_SIDEBAR_SETTINGS.confirmUnpin).volatile(),
  // A plain dict: the studio rehydrates this schema from its serialized form, which carries no transform callback, so a
  // transform here fails every validation there. The host half refuses a stored value above `MAX_WORKSPACE_ICONS` at load.
  workspaceIcons: z.dict(z.any()).default({}).volatile(),
  width: z.number().min(SIDEBAR_WIDTH.min).max(SIDEBAR_WIDTH.max).step(SIDEBAR_WIDTH.step).default(DEFAULT_SIDEBAR_SETTINGS.width).volatile(),
  updateNoticeRefreshMinutes: z.natural().min(UPDATE_NOTICE_REFRESH_MINUTES.min).max(UPDATE_NOTICE_REFRESH_MINUTES.max)
    .description('Minutes between the studio\'s reads of the update notice.').default(DEFAULT_SIDEBAR_SETTINGS.updateNoticeRefreshMinutes).volatile(),
})
