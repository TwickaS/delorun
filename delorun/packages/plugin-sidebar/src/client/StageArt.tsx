/**
 * The sidebar's header art: a night sky with stars and clouds, or a blueprint
 * with its grid, ruler and annotations, each drawn from the art palette's
 * colours. Copied from T3 Code's `SidebarStageBackdrop`
 * (`apps/web/src/components/SidebarStageBackdrop.tsx`, MIT, © 2026 T3 Tools
 * Inc.), whose two scenes mark its nightly and development builds.
 */
import { useId, type CSSProperties } from 'react'
import './art-palettes.css'
import css from './StageArt.module.css'
import { GENERATIVE_SCENES, GenerativeArt } from './GenerativeArt.tsx'
import type { ArtFade, ArtStrength } from '../config.ts'

const STAGE_BACKDROP_VIEW_BOX = '0 0 8192 96'

const NIGHTLY_STARS: ReadonlyArray<{
  cx: number
  cy: number
  r: number
  opacity: number
}> = [
  { cx: 14, cy: 10, r: 0.6, opacity: 0.85 },
  { cx: 38, cy: 22, r: 0.4, opacity: 0.55 },
  { cx: 58, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 84, cy: 16, r: 0.4, opacity: 0.5 },
  { cx: 104, cy: 7, r: 0.6, opacity: 0.8 },
  { cx: 126, cy: 20, r: 0.4, opacity: 0.55 },
  { cx: 148, cy: 11, r: 0.5, opacity: 0.7 },
  { cx: 170, cy: 24, r: 0.4, opacity: 0.5 },
  { cx: 192, cy: 9, r: 0.6, opacity: 0.8 },
  { cx: 214, cy: 18, r: 0.4, opacity: 0.55 },
  { cx: 236, cy: 8, r: 0.5, opacity: 0.7 },
  { cx: 258, cy: 20, r: 0.45, opacity: 0.6 },
  { cx: 278, cy: 11, r: 0.55, opacity: 0.75 },
  { cx: 26, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 118, cy: 34, r: 0.4, opacity: 0.45 },
  { cx: 202, cy: 32, r: 0.4, opacity: 0.5 },
  { cx: 268, cy: 34, r: 0.4, opacity: 0.45 },
]

const NIGHTLY_SPARKLES: ReadonlyArray<{ x: number; y: number }> = [
  { x: 70, y: 28 },
  { x: 160, y: 36 },
  { x: 246, y: 26 },
]

/**
 * The night sky: a gradient sky with soft glows, stars, sparkles and two blurred clouds.
 * @param props - `compact` shifts the view for a small preview.
 * @returns the scene.
 */
export function NightSkyArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(':', '')
  const skyId = `${idPrefix}-stage-night-sky`
  const glowId = `${idPrefix}-stage-night-glow`
  const cloudId = `${idPrefix}-stage-night-cloud`
  const softId = `${idPrefix}-stage-night-soft`
  const starsId = `${idPrefix}-stage-night-stars`
  const glowsId = `${idPrefix}-stage-night-glows`

  return (
    <svg
      data-stage-art="nightly"
      className={css.art}
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? '96 0 8192 96' : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={skyId}
          x1="24"
          y1="0"
          x2="264"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={{ stopColor: 'var(--stage-night-bottom)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--stage-night-mid)' }} />
          <stop offset="1" style={{ stopColor: 'var(--stage-night-top)' }} />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 18) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: 'var(--stage-night-glow-highlight)' }} stopOpacity="0.4" />
          <stop
            offset="0.5"
            style={{ stopColor: 'var(--stage-night-glow-secondary)' }}
            stopOpacity="0.16"
          />
          <stop offset="1" style={{ stopColor: 'var(--stage-night-bottom)' }} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={cloudId} x1="0" y1="60" x2="288" y2="96" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: 'var(--stage-night-highlight)' }} stopOpacity="0.5" />
          <stop
            offset="0.52"
            style={{ stopColor: 'var(--stage-night-secondary)' }}
            stopOpacity="0.62"
          />
          <stop offset="1" style={{ stopColor: 'var(--stage-night-tertiary)' }} stopOpacity="0.5" />
        </linearGradient>
        <filter id={softId} x="-24" y="-24" width="336" height="144" filterUnits="userSpaceOnUse">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <pattern id={starsId} width="288" height="96" patternUnits="userSpaceOnUse">
          <g style={{ fill: 'var(--stage-night-line)' }}>
            {NIGHTLY_STARS.map((star) => (
              <circle
                key={`${star.cx}-${star.cy}`}
                cx={star.cx}
                cy={star.cy}
                r={star.r}
                fillOpacity={star.opacity}
              />
            ))}
          </g>
          <g
            style={{ stroke: 'var(--stage-night-sparkle)' }}
            strokeLinecap="round"
            strokeOpacity="0.7"
            strokeWidth="0.6"
          >
            {NIGHTLY_SPARKLES.map((sparkle) => (
              <g key={`${sparkle.x}-${sparkle.y}`}>
                <path d={`M${sparkle.x - 1.5} ${sparkle.y}H${sparkle.x + 1.5}`} />
                <path d={`M${sparkle.x} ${sparkle.y - 1.5}V${sparkle.y + 1.5}`} />
              </g>
            ))}
          </g>
        </pattern>
        <pattern id={glowsId} width="640" height="96" patternUnits="userSpaceOnUse">
          <rect width="640" height="96" fill={`url(#${glowId})`} />
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${starsId})`} />

      <g filter={`url(#${softId})`}>
        <path
          d="M-12 88C-12 74 0 63 14 63C18 50 30 41 44 41C58 41 70 49 74 62C79 57 86 54 94 54C110 54 123 66 124 82C132 83 138 88 141 96H-12V88Z"
          fill={`url(#${cloudId})`}
        />
      </g>
      <g filter={`url(#${softId})`}>
        <path
          d="M150 96C151 84 161 75 173 75C176 64 186 57 198 57C210 57 220 64 223 75C231 75 238 80 241 87C250 87 257 91 260 96H150Z"
          fill={`url(#${cloudId})`}
          fillOpacity="0.8"
        />
      </g>
    </svg>
  )
}

/**
 * The blueprint: drafting paper with glows, a minor and major grid, a ruler along the top and dimension annotations.
 * @param props - `compact` shifts the view for a small preview.
 * @returns the scene.
 */
export function BlueprintArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(':', '')
  const paperId = `${idPrefix}-stage-bp-paper`
  const glowId = `${idPrefix}-stage-bp-glow`
  const celesteGlowId = `${idPrefix}-stage-bp-glow-celeste`
  const violetGlowId = `${idPrefix}-stage-bp-glow-violet`
  const minorGridId = `${idPrefix}-stage-bp-grid-minor`
  const majorGridId = `${idPrefix}-stage-bp-grid-major`
  const rulerId = `${idPrefix}-stage-bp-ruler`
  const glowsId = `${idPrefix}-stage-bp-glows`
  const annotationsId = `${idPrefix}-stage-bp-annotations`

  return (
    <svg
      data-stage-art="blueprint"
      className={css.art}
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? '64 0 8192 96' : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={paperId}
          x1="60"
          y1="0"
          x2="220"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop style={{ stopColor: 'var(--stage-art-bottom)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--stage-art-mid)' }} />
          <stop offset="1" style={{ stopColor: 'var(--stage-art-top)' }} />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 14) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: 'var(--stage-art-highlight)' }} stopOpacity="0.4" />
          <stop
            offset="0.52"
            style={{ stopColor: 'var(--stage-art-secondary)' }}
            stopOpacity="0.16"
          />
          <stop offset="1" style={{ stopColor: 'var(--stage-art-bottom)' }} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={celesteGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(474 44) rotate(166) scale(156 92)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: 'var(--stage-art-celeste-highlight)' }} stopOpacity="0.34" />
          <stop
            offset="0.5"
            style={{ stopColor: 'var(--stage-art-celeste-secondary)' }}
            stopOpacity="0.18"
          />
          <stop offset="1" style={{ stopColor: 'var(--stage-art-bottom)' }} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={violetGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(704 18) rotate(145) scale(132 88)"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: 'var(--stage-art-violet-highlight)' }} stopOpacity="0.3" />
          <stop
            offset="0.52"
            style={{ stopColor: 'var(--stage-art-tertiary)' }}
            stopOpacity="0.14"
          />
          <stop offset="1" style={{ stopColor: 'var(--stage-art-bottom)' }} stopOpacity="0" />
        </radialGradient>
        <pattern id={minorGridId} width="8" height="8" patternUnits="userSpaceOnUse">
          <path
            d="M8 0H0V8"
            style={{ stroke: 'var(--stage-art-grid-line)' }}
            strokeOpacity="0.14"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={majorGridId} width="32" height="32" patternUnits="userSpaceOnUse">
          <path
            d="M32 0H0V32"
            style={{ stroke: 'var(--stage-art-grid-line)' }}
            strokeOpacity="0.26"
            strokeWidth="0.6"
          />
        </pattern>
        <pattern id={rulerId} width="32" height="6" patternUnits="userSpaceOnUse">
          <path
            d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5"
            style={{ stroke: 'var(--stage-art-line)' }}
            strokeOpacity="0.5"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={glowsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <rect width="768" height="96" fill={`url(#${glowId})`} />
          <rect width="768" height="96" fill={`url(#${celesteGlowId})`} />
          <rect width="768" height="96" fill={`url(#${violetGlowId})`} />
        </pattern>
        <pattern id={annotationsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <g
            style={{ stroke: 'var(--stage-art-line)' }}
            strokeLinecap="round"
            strokeOpacity="0.6"
            strokeWidth="0.7"
          >
            <path d="M180 64H264" strokeDasharray="5 4" />
            <path d="M180 61V67M264 61V67" />
            <path d="M276 10V44" strokeDasharray="4 4" strokeOpacity="0.5" />
            <path d="M273 10H279M273 44H279" strokeOpacity="0.5" />
            <path d="M348 30H428" strokeDasharray="3.5 5" strokeOpacity="0.5" />
            <path d="M348 27V33M428 27V33" strokeOpacity="0.5" />
            <path d="M512 48V80" strokeDasharray="5 3" strokeOpacity="0.45" />
            <path d="M509 48H515M509 80H515" strokeOpacity="0.45" />
            <path d="M590 70H724" strokeDasharray="7 4" strokeOpacity="0.55" />
            <path d="M590 67V73M724 67V73" strokeOpacity="0.55" />
          </g>

          <g
            style={{ stroke: 'var(--stage-art-line)' }}
            strokeLinecap="round"
            strokeOpacity="0.55"
            strokeWidth="0.6"
          >
            <g>
              <path d="M34 60L38 64M38 60L34 64" />
            </g>
            <g>
              <path d="M228 26H234M231 23V29" />
            </g>
            <g>
              <path d="M143 51H149M146 48V54" />
            </g>
            <g>
              <path d="M316 16L322 22M322 16L316 22" />
            </g>
            <g>
              <path d="M468 70H476M472 66V74" />
            </g>
            <g>
              <path d="M558 28L564 34M564 28L558 34" />
            </g>
            <g>
              <path d="M742 44H750M746 40V48" />
            </g>
          </g>

          <g style={{ stroke: 'var(--stage-art-line)' }} strokeOpacity="0.35" strokeWidth="0.6">
            <circle cx="196" cy="38" r="13" strokeDasharray="3.5 4" />
            <path d="M196 33V43M191 38H201" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="414" cy="64" r="10" strokeDasharray="2.5 3.5" />
            <path d="M414 60V68M410 64H418" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="648" cy="32" r="15" strokeDasharray="4 5" />
            <path d="M648 26V38M642 32H654" strokeOpacity="0.6" strokeWidth="0.4" />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${paperId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${minorGridId})`} />
      <rect width="100%" height="96" fill={`url(#${majorGridId})`} />
      <rect width="100%" height="6" fill={`url(#${rulerId})`} />
      <rect width="100%" height="96" fill={`url(#${annotationsId})`} />
    </svg>
  )
}

/** The header art's scenes: T3 Code's night sky and blueprint, then the generated ones. */
export const STAGE_SCENES = ['night', 'blueprint', ...GENERATIVE_SCENES] as const

/** One scene. */
export type StageScene = typeof STAGE_SCENES[number]

/** The static token the brand row's edge is drawn in: a near-black that stays dark in both colour schemes. */
export const INK_EDGE_TOKEN = '--dsw-static-neutral-bluish-1000'

/**
 * The edge's opacity, in percent, around each part of upstream's brand row over the art: `brand` around the title and
 * its mark, `control` around the toggle's icon. The filter fills the ink's grown shape, so the edge takes the share of
 * the ink's own opacity; the toggle's ink is the title's opaque white, so each edge takes its own share whole. Upstream's
 * sidebar draws the row in that white over art, and the filter draws the ink over its own edge; against that edge composited over every colour any
 * scene draws in, in every art palette, strength, theme palette and colour scheme, and over the sidebar's fill the art
 * fades into, the title reads at 4.5:1 or more and the toggle at 3:1 or more. Each share sits within four points of the
 * smallest that does, so the edge stays as light as legibility allows; `title-contrast.client.spec.tsx` checks both.
 */
export const INK_EDGE_OPACITY = { brand: 60, control: 45 } as const

/** One part of the brand row the edge is drawn around. */
export type InkEdgePart = keyof typeof INK_EDGE_OPACITY

/** The parts in a fixed order. */
const INK_EDGE_PARTS = Object.keys(INK_EDGE_OPACITY) as readonly InkEdgePart[]

/**
 * The ids by which upstream's sidebar draws the brand (`brand`) and the toggle's icon (`control`) through the edge's
 * filters while art lies behind them.
 */
export const INK_EDGE_IDS = { brand: 'dsh-sidebar-backdrop-ink-brand', control: 'dsh-sidebar-backdrop-ink-control' } as const satisfies Record<InkEdgePart, string>

/** How far the edge reaches beyond the ink, in CSS pixels. */
export const INK_EDGE_RADIUS = 1

/** The soft shade under the edge, which smooths it into the art: its blur's standard deviation in CSS pixels and its opacity in percent. It adds contrast and the contrast check does not count it. */
export const INK_EDGE_SHADE = { blur: 1.5, opacity: 24 } as const

const flood = (opacity: number): CSSProperties => ({ floodColor: `var(${INK_EDGE_TOKEN})`, floodOpacity: opacity / 100 })

/**
 * The edge's SVG filters, one per part under the id given for it: the ink's shape grown by `INK_EDGE_RADIUS` and filled
 * in `INK_EDGE_TOKEN` at the part's `INK_EDGE_OPACITY`, over a soft shade, with the ink itself on top. The art mounts
 * them under `INK_EDGE_IDS`; a preview mounts them under ids of its own.
 * @param props - the filter id for each part.
 * @returns a zero-size SVG holding the filters, hidden from assistive technology.
 */
export function InkEdgeFilters({ ids }: { readonly ids: Readonly<Record<InkEdgePart, string>> }) {
  return (
    <svg className={css.inkEdge} width="0" height="0" aria-hidden="true" focusable="false" data-ink-edge="">
      {INK_EDGE_PARTS.map(part => (
        <filter key={part} id={ids[part]} x="-25%" y="-25%" width="150%" height="150%" colorInterpolationFilters="sRGB">
          <feMorphology in="SourceAlpha" operator="dilate" radius={INK_EDGE_RADIUS} result="grown" />
          <feGaussianBlur in="grown" stdDeviation={INK_EDGE_SHADE.blur} result="soft" />
          <feFlood style={flood(INK_EDGE_SHADE.opacity)} />
          <feComposite in2="soft" operator="in" result="shade" />
          <feFlood style={flood(INK_EDGE_OPACITY[part])} />
          <feComposite in2="grown" operator="in" result="edge" />
          <feMerge>
            <feMergeNode in="shade" />
            <feMergeNode in="edge" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      ))}
    </svg>
  )
}

/** The art palettes: T3 Code's Blueprint, Rose, Grove, Ocean, Ember and Iris, and the studio's accent. */
export const STAGE_PALETTES = ['blueprint', 'rose', 'grove', 'ocean', 'ember', 'iris', 'accent'] as const

/** One palette. */
export type StagePalette = typeof STAGE_PALETTES[number]

/**
 * The art in its fading box, filling the nearest positioned ancestor.
 * @param props - the scene, the palette, the generated scenes' seed, its strength, `compact` for a small preview, and how it fades.
 * @returns the backdrop, hidden from assistive technology.
 */
export function StageBackdrop({ scene, palette, seed = 1, strength = 'standard', compact = false, fade = 'soft' }: {
  readonly scene: StageScene
  /** The seed a generated scene is drawn from. */
  readonly seed?: number
  readonly palette: StagePalette
  /** How strongly the art shows. */
  readonly strength?: ArtStrength
  readonly compact?: boolean
  /** How the art's bottom edge meets the sidebar below it; `false` shows the art whole, as a swatch does. */
  readonly fade?: ArtFade | false
}) {
  return (
    <div className={css.backdrop} data-palette={palette} data-scene={scene} data-fade={String(fade)} data-strength={strength} data-delorun-edge-surface="sidebar-art" aria-hidden="true">
      {scene === 'night' ? <NightSkyArt compact={compact} /> : scene === 'blueprint' ? <BlueprintArt compact={compact} /> : <GenerativeArt scene={scene} seed={seed} />}
    </div>
  )
}
