/**
 * A Workspace's icon, as the person chose it in the icon picker: letters, a
 * glyph from a curated set, an emoji, or a pattern generated from a seed, in
 * a colour, a shape and a style. Workspaces with no choice keep T3 Code's
 * monogram of their initials in their place's colour.
 * @module @delorun/plugin-sidebar/workspace-icon
 */
import z from '@deepseek-ai/schemastery'
import { MAX_WORKSPACE_ICONS } from './config.ts'

/** What the icon shows. */
export const ICON_KINDS = ['letters', 'glyph', 'emoji', 'pattern'] as const

/** One kind of icon. */
export type IconKind = typeof ICON_KINDS[number]

/** The glyphs the picker offers, by name; each is drawn by one of the studio's own icons. */
export const ICON_GLYPHS = [
  'folder', 'code', 'database', 'globe', 'branch', 'shield', 'sparkle', 'think', 'goal', 'gauge', 'api', 'browse',
  'data', 'document', 'plan', 'checklist', 'skill', 'plugin', 'pinwheel', 'person', 'users', 'user', 'microphone', 'send',
  'link', 'sun', 'moon', 'clock', 'queue', 'inspect', 'settings', 'enhance', 'tree', 'pin', 'archive', 'save',
] as const

/** One glyph. */
export type IconGlyph = typeof ICON_GLYPHS[number]

/** The named colours; `auto` is the Workspace's place colour, and a `#RRGGBB` value is the person's own. */
export const ICON_COLORS = ['auto', 'blue', 'green', 'amber', 'violet', 'red', 'pink', 'teal', 'slate'] as const

/** One named colour. */
export type IconColorName = typeof ICON_COLORS[number]

/** The tile's shape. */
export const ICON_SHAPES = ['rounded', 'circle', 'square', 'hexagon'] as const

/** One shape. */
export type IconShape = typeof ICON_SHAPES[number]

/** How the colour fills the tile: tinted behind coloured content, solid behind white, or a coloured outline. */
export const ICON_STYLES = ['soft', 'solid', 'outline'] as const

/** One style. */
export type IconStyle = typeof ICON_STYLES[number]

/** A Workspace's chosen icon. */
export interface WorkspaceIcon {
  kind: IconKind
  /** Up to three letters, for `letters`; the Workspace's initials when empty. */
  letters: string
  /** The glyph, for `glyph`. */
  glyph: IconGlyph
  /** One emoji, for `emoji`. */
  emoji: string
  /** The seed a `pattern` is drawn from. */
  seed: number
  /** A named colour or `#RRGGBB`. */
  color: string
  shape: IconShape
  style: IconStyle
}

/** The icon a picker opens with for a Workspace that has none: its initials in its place's colour, as T3 Code draws them. */
export const DEFAULT_WORKSPACE_ICON: WorkspaceIcon = {
  kind: 'letters', letters: '', glyph: 'folder', emoji: '✨', seed: 1, color: 'auto', shape: 'rounded', style: 'soft',
}

/** The largest pattern seed. */
export const MAX_ICON_SEED = 2_147_483_647

const HEX = /^#[0-9a-fA-F]{6}$/

/** One icon's schema: each field validated and defaulted. */
export const WorkspaceIconSchema: z<WorkspaceIcon> = z.object({
  kind: z.union([...ICON_KINDS]).required(),
  letters: z.string().max(3).default(''),
  glyph: z.union([...ICON_GLYPHS]).default(DEFAULT_WORKSPACE_ICON.glyph),
  emoji: z.string().max(16).default(DEFAULT_WORKSPACE_ICON.emoji),
  seed: z.natural().min(1).max(MAX_ICON_SEED).default(DEFAULT_WORKSPACE_ICON.seed),
  color: z.union([...ICON_COLORS, z.string().pattern(HEX)]).default(DEFAULT_WORKSPACE_ICON.color),
  shape: z.union([...ICON_SHAPES]).default(DEFAULT_WORKSPACE_ICON.shape),
  style: z.union([...ICON_STYLES]).default(DEFAULT_WORKSPACE_ICON.style),
})

/**
 * Whether a colour is the person's own `#RRGGBB` rather than a named one.
 * @param color - the colour.
 * @returns whether it is a hex colour.
 */
export function isCustomColor(color: string): boolean {
  return HEX.test(color)
}

/**
 * A random icon, for the picker's Surprise me: any kind, glyph, colour, shape and style.
 * @param random - the random source.
 * @param emojis - the emoji the picker offers.
 * @returns the icon.
 */
export function randomIcon(random: () => number, emojis: readonly string[]): WorkspaceIcon {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  return {
    ...DEFAULT_WORKSPACE_ICON,
    kind: pick(ICON_KINDS),
    glyph: pick(ICON_GLYPHS),
    emoji: pick(emojis),
    seed: 1 + Math.floor(random() * (MAX_ICON_SEED - 1)),
    color: pick(ICON_COLORS.filter(color => color !== 'auto')),
    shape: pick(ICON_SHAPES),
    style: pick(ICON_STYLES),
  }
}

/**
 * The cells of a pattern: a 5 by 5 grid mirrored left to right, drawn from the seed, never empty.
 * @param seed - the seed.
 * @returns the filled cells' rows and columns.
 */
export function patternCells(seed: number): ReadonlyArray<readonly [number, number]> {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0
    return state / 4_294_967_296
  }
  const cells: Array<readonly [number, number]> = []
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 3; column++) {
      if (next() < 0.5) continue
      cells.push([row, column])
      if (column < 2) cells.push([row, 4 - column])
    }
  }
  return cells.length > 0 ? cells : [[2, 2]]
}

/**
 * One stored icon, validated and completed with the defaults.
 * @param stored - the value read from the setting.
 * @returns the icon, or undefined for a value that is not a valid icon, such as a glyph name the picker no longer offers.
 */
export function parseWorkspaceIcon(stored: unknown): WorkspaceIcon | undefined {
  const result = WorkspaceIconSchema['~standard'].validate(stored)
  return 'issues' in result && result.issues !== undefined ? undefined : (result as { readonly value: WorkspaceIcon }).value
}

/**
 * The stored icons that are valid, by Workspace id; a Workspace whose stored icon is malformed shows its monogram.
 * @param stored - the setting's value.
 * @returns the valid icons.
 */
export function readWorkspaceIcons(stored: Readonly<Record<string, unknown>>): Readonly<Record<string, WorkspaceIcon>> {
  const icons: Record<string, WorkspaceIcon> = {}
  for (const [workspaceId, value] of Object.entries(stored)) {
    const icon = parseWorkspaceIcon(value)
    if (icon !== undefined) icons[workspaceId] = icon
  }
  return icons
}

/**
 * The stored icons with one Workspace's icon set or cleared. A set icon becomes the newest entry, and the oldest
 * entries beyond `MAX_WORKSPACE_ICONS` are dropped, so the stored value always passes the setting's bound.
 * @param stored - the setting's value, oldest choice first.
 * @param workspaceId - the Workspace.
 * @param icon - its new icon, or null to return it to its monogram.
 * @returns the new value.
 */
export function withWorkspaceIcon(stored: Readonly<Record<string, unknown>>, workspaceId: string, icon: WorkspaceIcon | null): Record<string, unknown> {
  const { [workspaceId]: _replaced, ...others } = stored
  const entries = Object.entries(icon === null ? others : { ...others, [workspaceId]: icon })
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_WORKSPACE_ICONS)))
}

/**
 * The stored icons of the Workspaces that still exist. Call it only with the complete Workspace list, never with a list
 * still loading, which would drop every icon.
 * @param stored - the setting's value.
 * @param liveIds - the ids of every Workspace that exists.
 * @returns the value without the icons of removed Workspaces, or undefined when none is stale.
 */
export function pruneWorkspaceIcons(stored: Readonly<Record<string, unknown>>, liveIds: ReadonlySet<string>): Record<string, unknown> | undefined {
  const entries = Object.entries(stored)
  const kept = entries.filter(([workspaceId]) => liveIds.has(workspaceId))
  return kept.length === entries.length ? undefined : Object.fromEntries(kept)
}
