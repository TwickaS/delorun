/**
 * Host entry of Delorun's sidebar. The chat list is browser-only; this half
 * keeps its settings (header art, palette, list view, shelves, sort order,
 * width and the workspace icons) and the update notice's refresh interval as
 * the row's live configuration, which the studio's Sidebar section edits.
 * @module @delorun/plugin-sidebar
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.settings merge.
import type {} from '@deepseek-ai/dsh-settings'
import { MAX_WORKSPACE_ICONS, type Config } from './config.ts'

export {
  ART_FADES, ART_PALETTES, ART_STRENGTHS, ART_STYLES, Config, DEFAULT_SIDEBAR_SETTINGS, HEADER_ARTS, LIST_VIEWS, MAX_ART_SEED, MAX_WORKSPACE_ICONS, PEEK_DELAY, SIDEBAR_ROW_ID,
  SIDEBAR_WIDTH, SORT_ORDERS, UPDATE_NOTICE_REFRESH_MINUTES,
  type ArtFade, type ArtPalette, type ArtStrength, type ArtStyle, type HeaderArt, type ListView, type SidebarSettings, type SortOrder,
} from './config.ts'
export {
  DEFAULT_WORKSPACE_ICON, ICON_COLORS, ICON_GLYPHS, ICON_KINDS, ICON_SHAPES, ICON_STYLES, parseWorkspaceIcon, pruneWorkspaceIcons, readWorkspaceIcons,
  withWorkspaceIcon, WorkspaceIconSchema,
  type IconColorName, type IconGlyph, type IconKind, type IconShape, type IconStyle, type WorkspaceIcon,
} from './workspace-icon.ts'

/** The plugin's name in logs. */
export const name = 'delorun-sidebar'

/**
 * Keep the settings; the Sidebar section is this plugin's own page, so the settings service builds no form for it.
 * @param ctx - the plugin context.
 * @param config - the row's live configuration.
 * @throws {RangeError} when the stored Workspace icons number more than `MAX_WORKSPACE_ICONS`, so the row does not load.
 */
export function apply(ctx: Context, config: Config): void {
  const icons = Object.keys(config.workspaceIcons.get()).length
  if (icons > MAX_WORKSPACE_ICONS) {
    throw new RangeError(`delorun-sidebar: workspaceIcons holds ${String(icons)} Workspace icons, more than ${String(MAX_WORKSPACE_ICONS)}; remove the oldest entries from the row's configuration`)
  }
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
