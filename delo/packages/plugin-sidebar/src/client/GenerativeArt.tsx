/**
 * Generated header art: six scenes drawn from a seed in the art palette's
 * colours (`--stage-art-*`), so every palette, both schemes and the accent
 * apply, and a new seed draws a new picture of the same kind. Each scene is
 * an SVG in a 320 by 96 box that slices to the sidebar's width.
 */
import { useId, type ReactNode } from 'react'
import css from './StageArt.module.css'

/** The generated scenes. */
export const GENERATIVE_SCENES = ['waves', 'aurora', 'contours', 'constellation', 'halftone', 'shards'] as const

/** One generated scene. */
export type GenerativeScene = typeof GENERATIVE_SCENES[number]

const WIDTH = 320
const HEIGHT = 96

/**
 * A seeded random source, mulberry32: the same seed gives the same numbers.
 * @param seed - the seed.
 * @returns the next number in [0, 1).
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const COLOURS = ['var(--stage-art-highlight)', 'var(--stage-art-secondary)', 'var(--stage-art-tertiary)', 'var(--stage-art-top)'] as const

/** Format a coordinate to one decimal. */
const round = (value: number): string => value.toFixed(1)

/** The sky every scene starts from: the palette's top, middle and bottom. */
function Sky({ id }: { readonly id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--stage-art-top)" />
          <stop offset="0.55" stopColor="var(--stage-art-mid)" />
          <stop offset="1" stopColor="var(--stage-art-bottom)" />
        </linearGradient>
      </defs>
      <rect width={WIDTH} height={HEIGHT} fill={`url(#${id})`} />
    </>
  )
}

/** Five layered wave bands. */
function waves(random: () => number): ReactNode {
  return Array.from({ length: 5 }, (_, layer) => {
    const base = 30 + layer * 13
    const amplitude = 4 + random() * 9
    const length = 70 + random() * 110
    const phase = random() * Math.PI * 2
    const points = Array.from({ length: 33 }, (_, step) => {
      const x = (step / 32) * WIDTH
      return `${round(x)},${round(base + Math.sin(x / length * Math.PI * 2 + phase) * amplitude)}`
    })
    return (
      <path key={layer} d={`M0,${String(HEIGHT)} L${points.join(' L')} L${String(WIDTH)},${String(HEIGHT)} Z`}
        fill={COLOURS[layer % COLOURS.length]} fillOpacity={0.16 + layer * 0.07} />
    )
  })
}

/** Six blurred ellipses, softened by the filter `blur`. */
function aurora(random: () => number, blur: string): ReactNode {
  return (
    <g filter={`url(#${blur})`}>
      {Array.from({ length: 6 }, (_, index) => (
        <ellipse key={index} cx={round(random() * WIDTH)} cy={round(10 + random() * 60)} rx={round(40 + random() * 70)} ry={round(14 + random() * 22)}
          fill={COLOURS[index % COLOURS.length]} fillOpacity={0.45 + random() * 0.35} />
      ))}
    </g>
  )
}

/** Three sets of nested wobbling rings, like a contour map. */
function contours(random: () => number): ReactNode {
  const centres = Array.from({ length: 3 }, () => ({ x: random() * WIDTH, y: random() * HEIGHT, wobble: random() * Math.PI * 2 }))
  return centres.flatMap((centre, index) => Array.from({ length: 9 }, (_, ring) => {
    const radius = 8 + ring * 9
    const points = Array.from({ length: 41 }, (_, step) => {
      const angle = (step / 40) * Math.PI * 2
      const r = radius * (1 + 0.18 * Math.sin(angle * 3 + centre.wobble + ring * 0.4))
      return `${round(centre.x + Math.cos(angle) * r * 1.6)},${round(centre.y + Math.sin(angle) * r)}`
    })
    return (
      <path key={`${String(index)}-${String(ring)}`} d={`M${points.join(' L')} Z`} fill="none" stroke="var(--stage-art-line)"
        strokeOpacity={0.12 + (ring % 3 === 0 ? 0.18 : 0)} strokeWidth={ring % 3 === 0 ? 0.8 : 0.5} />
    )
  }))
}

/** Scattered stars joined to their nearest neighbours by faint lines. */
function constellation(random: () => number): ReactNode {
  const stars = Array.from({ length: 34 }, () => ({ x: random() * WIDTH, y: random() * HEIGHT * 0.8, size: 0.4 + random() * 1.3 }))
  const lines = stars.flatMap((star, index) => {
    const nearest = stars
      .map((other, at) => ({ at, other, distance: Math.hypot(other.x - star.x, other.y - star.y) }))
      .filter(other => other.at > index && other.distance < 46)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2)
    return nearest.map(other => ({ from: star, to: other.other, key: `${String(index)}-${String(other.at)}` }))
  })
  return (
    <>
      {lines.map(line => (
        <line key={line.key} x1={round(line.from.x)} y1={round(line.from.y)} x2={round(line.to.x)} y2={round(line.to.y)}
          stroke="var(--stage-art-line)" strokeOpacity="0.28" strokeWidth="0.5" />
      ))}
      {stars.map((star, index) => (
        <circle key={index} cx={round(star.x)} cy={round(star.y)} r={round(star.size)} fill="var(--stage-art-highlight)" fillOpacity={0.55 + star.size * 0.25} />
      ))}
    </>
  )
}

/** A grid of dots whose size falls off from a seeded centre. */
function halftone(random: () => number): ReactNode {
  const centre = { x: random() * WIDTH, y: random() * HEIGHT * 0.6 }
  const spread = 90 + random() * 80
  const step = 8
  const dots: ReactNode[] = []
  for (let y = step / 2; y < HEIGHT; y += step) {
    for (let x = ((y / step) % 2) * (step / 2); x < WIDTH; x += step) {
      const fall = Math.max(0, 1 - Math.hypot(x - centre.x, (y - centre.y) * 2) / spread)
      if (fall > 0.04) dots.push(<circle key={`${String(x)}-${String(y)}`} cx={round(x)} cy={round(y)} r={round(fall * 3.2)} fill="var(--stage-art-highlight)" fillOpacity="0.7" />)
    }
  }
  return dots
}

/** A jittered grid split into translucent triangles. */
function shards(random: () => number): ReactNode {
  const columns = 9
  const rows = 4
  const point = (column: number, row: number): { x: number; y: number } => ({
    x: (column / columns) * WIDTH + (column > 0 && column < columns ? (random() - 0.5) * 22 : 0),
    y: (row / rows) * HEIGHT + (row > 0 && row < rows ? (random() - 0.5) * 16 : 0),
  })
  const grid = Array.from({ length: rows + 1 }, (_, row) => Array.from({ length: columns + 1 }, (_, column) => point(column, row)))
  const at = (row: number, column: number): { x: number; y: number } => grid[row]?.[column] as { x: number; y: number }
  const triangles: ReactNode[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = at(row, column)
      const b = at(row, column + 1)
      const c = at(row + 1, column)
      const d = at(row + 1, column + 1)
      for (const [index, shape] of [[a, b, d], [a, d, c]].entries()) {
        triangles.push(
          <path key={`${String(row)}-${String(column)}-${String(index)}`} d={`M${shape.map(p => `${round(p.x)},${round(p.y)}`).join(' L')} Z`}
            fill={COLOURS[Math.floor(random() * COLOURS.length)]} fillOpacity={0.08 + random() * 0.3}
            stroke="var(--stage-art-line)" strokeOpacity="0.12" strokeWidth="0.4" />,
        )
      }
    }
  }
  return triangles
}

/**
 * Draw one generated scene.
 * @param props - the scene and its seed.
 * @returns the art.
 */
export function GenerativeArt({ scene, seed }: { readonly scene: GenerativeScene; readonly seed: number }) {
  const id = useId()
  const sky = `${id}-sky`
  const blur = `${id}-blur`
  const random = seededRandom(seed * 7919 + GENERATIVE_SCENES.indexOf(scene))
  const body = (): ReactNode => {
    switch (scene) {
      case 'waves': return waves(random)
      case 'aurora': return aurora(random, blur)
      case 'contours': return contours(random)
      case 'constellation': return constellation(random)
      case 'halftone': return halftone(random)
      case 'shards': return shards(random)
    }
  }
  return (
    <svg className={css.art} data-stage-art={scene} viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {scene === 'aurora' && (
        <defs>
          <filter id={blur} x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="14" /></filter>
        </defs>
      )}
      <Sky id={sky} />
      {body()}
    </svg>
  )
}
