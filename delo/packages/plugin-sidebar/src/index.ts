/**
 * Host entry of Delo's sidebar. The chat list is browser-only; this half
 * keeps its settings (header art, palette, list view, shelves, sort order,
 * width and the workspace icons) as the row's live configuration, which the
 * studio's Sidebar section edits.
 * @module @delo/plugin-sidebar
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.settings merge.
import type {} from '@deepseek-ai/dsh-settings'

export {
  ART_PALETTES, ART_STRENGTHS, ART_STYLES, Config, DEFAULT_SIDEBAR_SETTINGS, HEADER_ARTS, LIST_VIEWS, MAX_ART_SEED, SIDEBAR_ROW_ID,
  SIDEBAR_WIDTH, SORT_ORDERS,
  type ArtPalette, type ArtStrength, type ArtStyle, type HeaderArt, type ListView, type SidebarSettings, type SortOrder,
} from './config.ts'
export {
  DEFAULT_WORKSPACE_ICON, ICON_COLORS, ICON_GLYPHS, ICON_KINDS, ICON_SHAPES, ICON_STYLES, parseWorkspaceIcon, readWorkspaceIcons,
  WorkspaceIconSchema,
  type IconColorName, type IconGlyph, type IconKind, type IconShape, type IconStyle, type WorkspaceIcon,
} from './workspace-icon.ts'

/** The plugin's name in logs. */
export const name = 'delo-sidebar'

/**
 * Keep the settings; the Sidebar section is this plugin's own page, so the settings service builds no form for it.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
