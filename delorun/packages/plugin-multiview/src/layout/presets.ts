/**
 * The layout presets: the arrangements a person picks from the layout picker. A preset only rearranges the panes it is given:
 * nothing opens or closes. Each preset is a pure function of the panes in slot order (the main slot first), the person's
 * Main and stack options and, for Auto and the activity mosaic, the area and the panes' activity.
 * @module @delorun/plugin-multiview/layout/presets
 */

import type { LayoutLimits } from './limits.ts'
import { layoutOf, leafOf, splitOf, type LayoutArea, type LayoutModel, type LayoutNode, type PaneId, type SplitOrientation } from './model.ts'

/**
 * The arrangements the picker offers, in picker order. `auto` chooses one of the others from the pane count and the area;
 * `main-stack` keeps the main chat full height on one side with the others tiled beside it.
 */
export const LAYOUT_IDS = [
  'auto',
  'main-stack',
  'side-by-side',
  'rows',
  'grid',
  'main-top',
  'spiral',
  'centred',
  'mosaic',
  'tabs',
] as const

/** One arrangement of {@link LAYOUT_IDS}. */
export type LayoutPreset = (typeof LAYOUT_IDS)[number]

/** What the picker offers: every preset, and the person's own arrangement. */
export type LayoutChoiceId = LayoutPreset | 'yours'

/** Every choice, in picker order. */
export const LAYOUT_CHOICE_IDS: readonly LayoutChoiceId[] = [...LAYOUT_IDS, 'yours']

/** The arrangement saved before Auto existed: the main chat on the left beside a column of the others. It reads as Main and stack. */
export type LegacyLayoutPreset = 'main-column'

/**
 * The four arrangements the Layout menu offered before the picker, in that menu's order.
 * @deprecated Use {@link LAYOUT_IDS}; kept so the old Layout menu compiles until the picker replaces it.
 */
export const LAYOUT_PRESETS: readonly (LegacyLayoutPreset | 'side-by-side' | 'grid' | 'main-top')[] = ['main-column', 'side-by-side', 'grid', 'main-top']

/** The preset a new layout and "Reset to Auto" use. */
export const DEFAULT_PRESET: LayoutPreset = 'auto'

/** The default share of the main chat in Main and stack, Main on top and Centred main, in percent. */
export const MAIN_SHARE = 56

/** The main chat's share in Centred main when agents sit on both sides, in percent. */
export const CENTRED_SHARE = 50

/** The bounds of the main chat's share that dragging and the grow and shrink keys keep to, in percent. */
export const MAIN_SHARE_RANGE = { min: 25, max: 75 } as const

/** The step of the grow and shrink keys, in percentage points. */
export const MAIN_SHARE_STEP = 5

/** Which side Main and stack keeps the main chat on. */
export type MainSide = 'left' | 'right'

/** How Main and stack tiles the other panes beside the main chat. */
export type StackStyle = 'rows' | 'columns' | 'grid' | 'spiral'

/** Every stack style, in picker order. */
export const STACK_STYLES: readonly StackStyle[] = ['rows', 'columns', 'grid', 'spiral']

/** Every main side, in picker order. */
export const MAIN_SIDES: readonly MainSide[] = ['left', 'right']

/** How busy a pane is, for the activity mosaic: `large` while it works or waits for approval, `small` when done or idle. */
export type PaneActivity = 'large' | 'small'

/** The person's options for the presets that have them, and what Auto and the mosaic read. */
export interface PresetOptions {
  /** The side Main and stack keeps the main chat on. */
  readonly mainSide: MainSide
  /** How Main and stack tiles the others. */
  readonly stackStyle: StackStyle
  /** The main chat's share in Main and stack, Main on top and Centred main, in percent. */
  readonly mainShare: number
  /** The rectangle the layout fills; Auto reads its shape. Absent until measured. */
  readonly area?: LayoutArea | undefined
  /** The least pane size; Auto reads it to choose between stacked rows and tabs. */
  readonly limits?: Pick<LayoutLimits, 'minPaneWidth' | 'minPaneHeight'> | undefined
  /** Each pane's activity, for the mosaic; a pane not listed is `small`, the main slot `large`. */
  readonly activity?: ReadonlyMap<PaneId, PaneActivity> | undefined
  /** The views Auto puts side by side at most; {@link AUTO_COLUMNS_UP_TO} when absent. */
  readonly autoColumns?: number | undefined
}

/** The options a person who changed nothing has. */
export const DEFAULT_PRESET_OPTIONS: PresetOptions = { mainSide: 'left', stackStyle: 'rows', mainShare: MAIN_SHARE }

/** Auto's thresholds: the aspect ratio (width / height) at and above which the area counts as ultrawide, and the width that does too. */
export const AUTO_ULTRAWIDE = { aspect: 2.1, width: 2560 } as const

/** Up to this many views, unless the person sets another count, Auto puts every pane side by side in equal columns. */
export const AUTO_COLUMNS_UP_TO = 3

/** The mosaic's share of the height for the large tiles when there are small ones, in percent. */
export const MOSAIC_LARGE_SHARE = 72

const single = (pane: PaneId): LayoutNode => leafOf([pane])

/**
 * Keep a share inside {@link MAIN_SHARE_RANGE}.
 * @param share - a share in percent.
 * @returns the share, bounded; a value that is not a number gives {@link MAIN_SHARE}.
 */
export function clampShare(share: number): number {
  if (!Number.isFinite(share)) return MAIN_SHARE
  return Math.min(MAIN_SHARE_RANGE.max, Math.max(MAIN_SHARE_RANGE.min, share))
}

/** Two parts along one axis with the first taking `share` percent. */
function pair(orientation: SplitOrientation, first: LayoutNode, second: LayoutNode, share: number): LayoutNode {
  return { kind: 'split', orientation, size: 100, children: [{ ...first, size: share }, { ...second, size: 100 - share }] }
}

/** Rows of equal panes, `perRow` to a row, the last row filling its width. */
function gridOf(panes: readonly PaneId[], perRow: number): LayoutNode {
  if (panes.length === 1) return single(panes[0]!)
  const rows: LayoutNode[] = []
  for (let index = 0; index < panes.length; index += perRow) {
    const row = panes.slice(index, index + perRow)
    rows.push(row.length === 1 ? single(row[0]!) : splitOf('horizontal', row.map(single)))
  }
  return rows.length === 1 ? rows[0]! : splitOf('vertical', rows)
}

/**
 * The spiral: the first pane takes half, the next half of the rest, and so on, turning a quarter each step (right, down, left,
 * up), so the last pane is the smallest.
 */
function spiralOf(panes: readonly PaneId[], step = 0): LayoutNode {
  if (panes.length === 1) return single(panes[0]!)
  const [first, ...rest] = panes
  const head = single(first!)
  const tail = spiralOf(rest, step + 1)
  const turn = step % 4
  const orientation: SplitOrientation = turn % 2 === 0 ? 'horizontal' : 'vertical'
  return turn < 2 ? pair(orientation, head, tail, 50) : pair(orientation, tail, head, 50)
}

/**
 * The columns of a stack grid: as many as keep a pane at the least width, and no more than keep it at the least height; without
 * an area, the square root of the count, rounded.
 */
function stackColumns(count: number, stack: LayoutArea | undefined, limits: PresetOptions['limits']): number {
  if (stack === undefined || limits === undefined) return Math.max(1, Math.round(Math.sqrt(count)))
  const widest = Math.max(1, Math.floor(stack.width / limits.minPaneWidth))
  const tallest = Math.max(1, Math.floor(stack.height / limits.minPaneHeight))
  return Math.min(widest, count, Math.max(1, Math.ceil(count / tallest)))
}

/** The other panes tiled in a stack style; `stack` is the stack's own area, when known. */
function stackOf(panes: readonly PaneId[], style: StackStyle, stack?: LayoutArea, limits?: PresetOptions['limits']): LayoutNode {
  if (panes.length === 1) return single(panes[0]!)
  switch (style) {
    case 'rows':
      return splitOf('vertical', panes.map(single))
    case 'columns':
      return splitOf('horizontal', panes.map(single))
    case 'grid':
      return gridOf(panes, stackColumns(panes.length, stack, limits))
    case 'spiral':
      return spiralOf(panes, 1)
    default:
      return assertNever(style)
  }
}

/** Main and stack: the main slot full height on its side, the others tiled in the rest. */
function mainStackOf(main: PaneId, others: readonly PaneId[], options: PresetOptions): LayoutNode {
  const share = clampShare(options.mainShare)
  const area = options.area === undefined ? undefined : { width: options.area.width * (100 - share) / 100, height: options.area.height }
  const stack = stackOf(others, options.stackStyle, area, options.limits)
  return options.mainSide === 'left'
    ? pair('horizontal', single(main), stack, share)
    : pair('horizontal', stack, single(main), 100 - share)
}

/** Centred main: the main slot in the middle, the others alternating right, left, right… in a column on each side. */
function centredOf(main: PaneId, others: readonly PaneId[], options: PresetOptions): LayoutNode {
  const right = others.filter((_, index) => index % 2 === 0)
  const left = others.filter((_, index) => index % 2 === 1)
  const column = (panes: readonly PaneId[]): LayoutNode => (panes.length === 1 ? single(panes[0]!) : splitOf('vertical', panes.map(single)))
  if (left.length === 0) return pair('horizontal', single(main), column(right), clampShare(options.mainShare))
  // The main share moves Centred main as it moves the other layouts, from about half.
  const share = Math.min(60, Math.max(34, CENTRED_SHARE + clampShare(options.mainShare) - MAIN_SHARE))
  const side = (100 - share) / 2
  return {
    kind: 'split',
    orientation: 'horizontal',
    size: 100,
    children: [{ ...column(left), size: side }, { ...single(main), size: share }, { ...column(right), size: side }],
  }
}

/** The activity mosaic: busy panes as large tiles above a strip of small ones. The main slot is always large. */
function mosaicOf(main: PaneId, others: readonly PaneId[], options: PresetOptions): LayoutNode {
  const activity = options.activity
  const large = [main, ...others.filter(pane => activity?.get(pane) === 'large')]
  const small = others.filter(pane => activity?.get(pane) !== 'large')
  const top = gridOf(large, large.length <= 3 ? large.length : Math.ceil(Math.sqrt(large.length)))
  if (small.length === 0) return top
  const strip = small.length === 1 ? single(small[0]!) : splitOf('horizontal', small.map(single))
  return pair('vertical', top, strip, MOSAIC_LARGE_SHARE)
}

/**
 * Decide which arrangement Auto shows.
 * @param count - the panes, the main chat included.
 * @param options - the area and the least pane size.
 * @returns `side-by-side` up to `autoColumns` panes (three unless set); beyond, `rows` (or `tabs` when a row would be under the least height) for a tall
 * area, `centred` for an ultrawide one, otherwise `main-stack` with a grid stack. Without an area, from four panes, `main-stack`.
 */
export function autoChoice(count: number, options: Pick<PresetOptions, 'area' | 'limits' | 'autoColumns'>): Exclude<LayoutPreset, 'auto'> {
  if (count <= (options.autoColumns ?? AUTO_COLUMNS_UP_TO)) return 'side-by-side'
  const { area } = options
  if (area === undefined || area.width <= 0 || area.height <= 0) return 'main-stack'
  const aspect = area.width / area.height
  if (aspect < 1) {
    const minHeight = options.limits?.minPaneHeight ?? 0
    return area.height / count < minHeight ? 'tabs' : 'rows'
  }
  if (aspect >= AUTO_ULTRAWIDE.aspect || area.width >= AUTO_ULTRAWIDE.width) return 'centred'
  return 'main-stack'
}

/**
 * Arrange panes in a preset.
 * @param preset - the arrangement; `main-column`, the arrangement saved before Auto, is Main and stack on the left with rows.
 * @param main - the pane in the main slot, which every preset puts first or in its main place.
 * @param others - the other panes in slot order.
 * @param options - the person's Main and stack options, the area and the activity; missing ones take {@link DEFAULT_PRESET_OPTIONS}.
 * @returns the layout. Nothing is opened or closed: the layout holds exactly `main` and `others`.
 */
export function buildPreset(
  preset: LayoutPreset | LegacyLayoutPreset,
  main: PaneId,
  others: readonly PaneId[],
  options: Partial<PresetOptions> = {},
): LayoutModel {
  const opts: PresetOptions = { ...DEFAULT_PRESET_OPTIONS, ...options }
  if (others.length === 0) return layoutOf(single(main))
  const all = [main, ...others]
  switch (preset) {
    case 'auto': {
      const chosen = autoChoice(all.length, opts)
      return buildPreset(chosen, main, others, chosen === 'main-stack' ? { ...opts, stackStyle: 'grid' } : opts)
    }
    case 'main-column':
      return layoutOf(mainStackOf(main, others, { ...opts, mainSide: 'left', stackStyle: 'rows' }))
    case 'main-stack':
      return layoutOf(mainStackOf(main, others, opts))
    case 'main-top':
      return layoutOf(pair('vertical', single(main), stackOf(others, 'columns'), clampShare(opts.mainShare)))
    case 'side-by-side':
      return layoutOf(splitOf('horizontal', all.map(single)))
    case 'rows':
      return layoutOf(splitOf('vertical', all.map(single)))
    case 'grid':
      return layoutOf(gridOf(all, Math.ceil(Math.sqrt(all.length))))
    case 'spiral':
      return layoutOf(spiralOf(all))
    case 'centred':
      return layoutOf(centredOf(main, others, opts))
    case 'mosaic':
      return layoutOf(mosaicOf(main, others, opts))
    case 'tabs':
      return layoutOf(leafOf(all, 100, main))
    default:
      return assertNever(preset)
  }
}

/**
 * Report whether a value names a preset, the legacy `main-column` included.
 * @param value - any value.
 * @returns true for one of {@link LAYOUT_IDS} or `main-column`.
 */
export function isLayoutPreset(value: unknown): value is LayoutPreset | LegacyLayoutPreset {
  return value === 'main-column' || (LAYOUT_IDS as readonly unknown[]).includes(value)
}

function assertNever(value: never): never {
  throw new Error(`Unknown layout preset: ${String(value)}`)
}
