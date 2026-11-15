/**
 * A Workspace's badge. Without a chosen icon it is T3 Code's `ProjectMonogram`
 * (`apps/web/src/components/ProjectMonogram.tsx`, MIT, © 2026 T3 Tools Inc.):
 * monospace initials fitted to a 16px tile, on the Workspace's colour at 14%.
 * With one it draws the person's letters, glyph, emoji or seeded pattern in
 * their colour, shape and style. The list provides the chosen icons, already
 * validated, through {@link WorkspaceIconsContext}.
 */
import {
  IconApiOutlineMedium, IconArchiveOutlineMedium, IconBranchOutlineMedium, IconBrowseOutlineMedium, IconChecklistOutlineMedium,
  IconClockOutlineMedium, IconCodeOutlineMedium, IconCordisPluginOutlineMedium, IconDarkOutlineMedium, IconDatabaseOutlineMedium,
  IconDataOutlineMedium, IconDeliverDocMedium, IconEnhanceOutlineMedium, IconFolderCloseMedium, IconGaugeOutlineMedium,
  IconGlobeOutlineMedium, IconGoalOutlineMedium, IconInspectOutlineMedium, IconLightOutlineMedium, IconLinkOutlineMedium,
  IconMicrophoneOutlineMedium, IconPersonalizationOutlineMedium, IconPinOutlineMedium, IconPlanOutlineMedium,
  IconPluginPinwheelOutlineMedium, IconQueueOutlineMedium, IconSaveOutlineMedium, IconSendOutlineMedium, IconSettingsOutlineMedium,
  IconShieldOutlineMedium, IconSkillOutlineMedium, IconSparkleMedium, IconThinkOutlineMedium, IconUserOutlineMedium,
  IconUsersOutlineMedium, IconWorkspaceTreeOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createContext, useContext, type CSSProperties } from 'react'
import { isCustomColor, patternCells, type IconGlyph, type WorkspaceIcon } from './workspace-icon.ts'
import { workspaceInitials, type BadgeColor } from './badge-colors.ts'
import './badge-colors.css'
import css from './WorkspaceBadge.module.css'

/** The chosen, already validated icons by Workspace id, which the list provides to every badge inside it. */
export const WorkspaceIconsContext = createContext<Readonly<Record<string, WorkspaceIcon>>>({})

/** The glyphs' drawings: the studio's own icons, drawn in the current text colour. */
export const GLYPHS: Readonly<Record<IconGlyph, (props: { size?: number | undefined; className?: string | undefined }) => React.JSX.Element>> = {
  folder: IconFolderCloseMedium, code: IconCodeOutlineMedium, database: IconDatabaseOutlineMedium, globe: IconGlobeOutlineMedium,
  branch: IconBranchOutlineMedium, shield: IconShieldOutlineMedium, sparkle: IconSparkleMedium, think: IconThinkOutlineMedium,
  goal: IconGoalOutlineMedium, gauge: IconGaugeOutlineMedium, api: IconApiOutlineMedium, browse: IconBrowseOutlineMedium,
  data: IconDataOutlineMedium, document: IconDeliverDocMedium, plan: IconPlanOutlineMedium, checklist: IconChecklistOutlineMedium,
  skill: IconSkillOutlineMedium, plugin: IconCordisPluginOutlineMedium, pinwheel: IconPluginPinwheelOutlineMedium,
  person: IconPersonalizationOutlineMedium, users: IconUsersOutlineMedium, user: IconUserOutlineMedium,
  microphone: IconMicrophoneOutlineMedium, send: IconSendOutlineMedium, link: IconLinkOutlineMedium, sun: IconLightOutlineMedium,
  moon: IconDarkOutlineMedium, clock: IconClockOutlineMedium, queue: IconQueueOutlineMedium, inspect: IconInspectOutlineMedium,
  settings: IconSettingsOutlineMedium, enhance: IconEnhanceOutlineMedium, tree: IconWorkspaceTreeOutlineMedium, pin: IconPinOutlineMedium,
  archive: IconArchiveOutlineMedium, save: IconSaveOutlineMedium,
}

/** The glyph's share of the tile's width. */
const GLYPH_SHARE = 0.66

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Letters fitted to the tile's width, T3 Code's monogram. */
function Letters({ letters }: { readonly letters: string }) {
  const count = Array.from(graphemes.segment(letters)).length
  return (
    <svg viewBox="0 0 16 16" className={css.fill}>
      {letters !== '' && (
        <text x="8" y="10.8" textAnchor="middle" fill="currentColor" fontSize="8.25" fontWeight="700"
          textLength={count === 1 ? 6 : count === 3 ? 13 : 12} lengthAdjust="spacingAndGlyphs" textRendering="geometricPrecision">
          {letters}
        </text>
      )}
    </svg>
  )
}

/** A seeded pattern: a mirrored 5 by 5 grid in the colour. */
function Pattern({ seed }: { readonly seed: number }) {
  return (
    <svg viewBox="0 0 7 7" className={css.fill} shapeRendering="crispEdges">
      {patternCells(seed).map(([row, column]) => <rect key={`${String(row)}-${String(column)}`} x={column + 1} y={row + 1} width="1" height="1" fill="currentColor" />)}
    </svg>
  )
}

/** What the tile shows for a chosen icon, or the title's initials when there is none. */
function Content({ icon, title, size }: { readonly icon: WorkspaceIcon | undefined; readonly title: string; readonly size: number }) {
  if (icon === undefined) return <Letters letters={workspaceInitials(title)} />
  switch (icon.kind) {
    case 'letters':
      return <Letters letters={icon.letters === '' ? workspaceInitials(title) : icon.letters.toLocaleUpperCase()} />
    case 'glyph': {
      const Glyph = GLYPHS[icon.glyph]
      return <Glyph size={Math.round(size * GLYPH_SHARE)} />
    }
    case 'emoji':
      return <span className={css.emoji}>{icon.emoji}</span>
    case 'pattern':
      return <Pattern seed={icon.seed} />
    default:
      return assertNever(icon.kind)
  }
}

/** Fails at compile time when a kind is unhandled, and at run time on a value that bypassed validation. */
function assertNever(kind: never): never {
  throw new Error(`Unknown workspace icon kind: ${String(kind)}`)
}

/**
 * Render a Workspace's badge.
 * @param props.title - the Workspace's shown title, whose initials the badge shows when no letters are chosen.
 * @param props.color - the Workspace's place colour, used when the icon's colour is `auto` or there is no icon.
 * @param props.workspaceId - the Workspace's id to look its chosen icon up by in {@link WorkspaceIconsContext}.
 * @param props.icon - an icon to draw instead of the looked-up one.
 * @param props.size - the badge's width and height in pixels; 16 by default.
 * @returns the badge, hidden from assistive technology since the title is read beside it.
 */
export function WorkspaceBadge({ title, color, workspaceId, icon, size = 16 }: {
  readonly title: string
  readonly color: BadgeColor
  readonly workspaceId?: string | undefined
  readonly icon?: WorkspaceIcon | undefined
  readonly size?: number
}) {
  const chosen = useContext(WorkspaceIconsContext)
  const shown = icon ?? (workspaceId === undefined ? undefined : chosen[workspaceId])
  const colour = shown === undefined || shown.color === 'auto' ? color : shown.color
  const custom = isCustomColor(colour)
  const style: CSSProperties & Record<`--${string}`, string> = { '--badge-size': `${String(size)}px` }
  if (custom) style['--badge-color'] = colour
  return (
    <span className={css.badge} data-color={custom ? undefined : colour} data-shape={shown?.shape ?? 'rounded'} data-style={shown?.style ?? 'soft'}
      style={style} aria-hidden="true">
      <Content icon={shown} title={title} size={size} />
    </span>
  )
}
