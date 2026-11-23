/**
 * A tiny picture of a layout: the arrangement a choice gives `n` panes in a landscape window, drawn from the same functions that
 * lay the panes out, so a thumbnail never disagrees with the layout it names.
 * @module @delorun/plugin-multiview/layout/LayoutThumb
 */

import { memo, type JSX } from 'react'
import { placeLeaves } from './fit.ts'
import type { LayoutModel, PaneId } from './model.ts'
import { buildPreset, DEFAULT_PRESET_OPTIONS, type LayoutChoiceId, type MainSide, type PaneActivity, type StackStyle } from './presets.ts'
import { applyShape, type LayoutShape } from './shape.ts'

/** The picture's drawing area: a 16:10 window. */
const VIEW = { width: 32, height: 20 } as const
/** The gap between tiles, in drawing units. */
const GAP = 1.4

/** The props of {@link LayoutThumb}. */
export interface LayoutThumbProps {
  /** The choice to draw. */
  readonly choice: LayoutChoiceId
  /** The panes to draw, the main chat included; fewer than two draws two, more than six draws six. */
  readonly n: number
  /** The rendered width in CSS pixels; the height follows at 16:10. Default 32. */
  readonly size?: number
  /** "Yours", for the `yours` choice; without one it draws a dashed outline. */
  readonly shape?: LayoutShape | undefined
  /** The Main and stack options, so its thumbnail shows the person's side and stack. */
  readonly mainSide?: MainSide
  readonly stackStyle?: StackStyle
}

const ids = (count: number): PaneId[] => Array.from({ length: count }, (_, index) => String(index) as PaneId)

/**
 * The layout a thumbnail draws.
 * @param props - the choice, the pane count, the shape and the options.
 * @returns the model, or undefined for `yours` without a shape.
 */
export function thumbModel(props: Pick<LayoutThumbProps, 'choice' | 'n' | 'shape' | 'mainSide' | 'stackStyle'>): LayoutModel | undefined {
  const count = Math.min(6, Math.max(2, Math.floor(props.n)))
  const [main, ...others] = ids(count)
  const options = {
    ...DEFAULT_PRESET_OPTIONS,
    mainSide: props.mainSide ?? DEFAULT_PRESET_OPTIONS.mainSide,
    stackStyle: props.stackStyle ?? DEFAULT_PRESET_OPTIONS.stackStyle,
    area: { width: 1440, height: 900 },
    // The mosaic's picture: every other agent working, so it shows large and small tiles together.
    activity: new Map<PaneId, PaneActivity>(others.map((pane, index) => [pane, index % 2 === 0 ? 'large' : 'small'])),
  }
  if (props.choice === 'yours') return props.shape === undefined ? undefined : applyShape(props.shape, main!, others)
  return buildPreset(props.choice, main!, others, options)
}

/**
 * Draw a layout's thumbnail: the main slot solid, the other panes lighter, a pane with tabs marked by a strip along its top.
 * @param props - the choice, the pane count and the size.
 * @returns an inline SVG, hidden from assistive technology (its label is the choice's name beside it).
 */
export const LayoutThumb = memo(function LayoutThumb(props: LayoutThumbProps): JSX.Element {
  const width = props.size ?? 32
  const height = (width * VIEW.height) / VIEW.width
  const model = thumbModel(props)
  return (
    <svg viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} width={width} height={height} aria-hidden="true" focusable="false" data-layout-thumb={props.choice}>
      {model === undefined
        ? <rect x={0.75} y={0.75} width={VIEW.width - 1.5} height={VIEW.height - 1.5} rx={2.5} fill="none" stroke="currentColor" strokeOpacity={0.45} strokeWidth={1} strokeDasharray="2 1.6" />
        : placeLeaves(model, VIEW).map(({ leaf, rect }) => {
          const x = rect.x + GAP / 2
          const y = rect.y + GAP / 2
          const w = Math.max(0.5, rect.width - GAP)
          const h = Math.max(0.5, rect.height - GAP)
          const main = leaf.panes.includes('0' as PaneId)
          return (
            <g key={leaf.panes.join('+')}>
              <rect x={x} y={y} width={w} height={h} rx={1.6} fill="currentColor" fillOpacity={main ? 0.9 : 0.32} />
              {leaf.panes.length > 1 && <rect x={x} y={y} width={w} height={Math.min(2.4, h / 3)} rx={1} fill="currentColor" fillOpacity={main ? 1 : 0.55} />}
            </g>
          )
        })}
    </svg>
  )
})
