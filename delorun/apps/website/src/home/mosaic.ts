/**
 * The home page's photomosaic of the Delorun mark: a grid of 16:10 screenshot tiles in which light pictures draw the hex
 * nut, dark pictures fill its round hole and the space around it, and light pictures in the peach looks (Ember and the
 * custom peach accents) take the plug, those with the most peach first. Each picture's measured colour comes from
 * `shot-colours.ts`; a greedy match gives each cell the closest picture that does not already sit next to it, preferring
 * pictures in the page's look outside the plug. `scripts/mosaic-plans.ts` runs the match for every look once and
 * writes `mosaic-plans.ts`, which the page reads.
 *
 * @module @delorun/website/home/mosaic
 */
import { MARK } from '../../../../packages/brand/src/mark-data.ts'
import { SHOT_COLOURS } from './shot-colours.ts'
import { SHOTS, type Shot } from './shots.ts'

/** What part of the mark a cell lies in, by the larger share of its area. */
export type Part = 'nut' | 'hole' | 'plug' | 'out'

/** One cell of the mosaic. */
export interface Cell {
  readonly col: number
  readonly row: number
  readonly part: Part
  readonly shot: Shot
  /** True for the layout's pinned cell, the one the page zooms into. */
  readonly pinned: boolean
}

/** A layout's cells for one look, by row, and the index of the living tile's cell. */
export interface Plan { readonly cells: readonly Cell[]; readonly live: number }

/** Where the mark sits in a grid, in cells. */
export interface Layout {
  readonly cols: number
  readonly rows: number
  /** The mark's centre, in cell units from the grid's top-left corner. */
  readonly centre: readonly [number, number]
  /** The mark's nut height (point to point), in rows. */
  readonly height: number
  /** A cell that always shows one picture, placed before the greedy match fills the rest. */
  readonly pin: { readonly col: number; readonly row: number; readonly id: string }
}

/** The computer layout: the mark on the right, the words on the left; the pinned chat sits in the hole beside the plug. */
export const WIDE: Layout = { cols: 28, rows: 26, centre: [19.5, 13], height: 19, pin: { col: 17, row: 12, id: 'handoff-dark' } }

/**
 * The phone layout: fewer, larger cells, the mark centred in the top 15 rows. The rows below sit under the words once the
 * mark has formed, and keep the screen filled while the wall pulls back.
 */
export const NARROW: Layout = { cols: 10, rows: 34, centre: [5, 7.5], height: 12, pin: { col: 3, row: 7, id: 'handoff-dark' } }

/** The nut's corners in the mark's 32-unit box, read from the brand path, and the hole's and plug's radii. */
const HEX: readonly (readonly [number, number])[] = [[16, 2.5], [27.7, 9.25], [27.7, 22.75], [16, 29.5], [4.3, 22.75], [4.3, 9.25]]
const HOLE = 6.6
const NUT_HEIGHT = 27

/**
 * Whether a point lies inside the hexagon.
 * @param x - the point's x, in mark units.
 * @param y - the point's y, in mark units.
 * @returns true inside.
 */
function inHex(x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = HEX.length - 1; i < HEX.length; j = i++) {
    const [xi, yi] = HEX[i] as readonly [number, number]
    const [xj, yj] = HEX[j] as readonly [number, number]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * The part of the mark a point lies in.
 * @param x - the point's x, in mark units.
 * @param y - the point's y, in mark units.
 * @returns the part.
 */
function partAt(x: number, y: number): Part {
  if (!inHex(x, y)) return 'out'
  const d = Math.hypot(x - MARK.plug.cx, y - MARK.plug.cy)
  if (d <= MARK.plug.r) return 'plug'
  if (d <= HOLE) return 'hole'
  return 'nut'
}

/** The looks whose accent is the brand's peach, as `Shot.theme` names them. */
const PEACH_LOOKS = new Set(['Ember', 'Custom, peach accent', 'Custom, brand peach accent'])

/** What one more use of a picture costs, in lightness steps: in the mark high enough that it repeats few pictures; around
 * it, where the shade dims the tiles, low enough that the page's look can fill most cells. */
const REUSE: Readonly<Record<Part, number>> = { nut: 6, plug: 8, hole: 0.5, out: 0.5 }

/** What a picture in another look costs, in lightness steps. */
const OTHER_LOOK = 24

/** The screens the living tile plays, in order, as dark computer captures. */
export const LIVING = ['chat-working', 'chat-after-run'] as const

/**
 * The living tile's frames in a look.
 * @param look - the look's id.
 * @returns the pictures, in order; empty when the look has no capture of a chat while the agent works.
 */
export function livingFrames(look: string): readonly Shot[] {
  const frames = LIVING.map(screen => SHOTS.find(shot => shot.id === `${screen}-${look}-dark-1440`))
  return frames[0] === undefined ? [] : frames.filter((shot): shot is Shot => shot !== undefined)
}

/** How a cell's share of each part sets the lightness the cell should have. */
const LIGHTNESS: Readonly<Record<Part, number>> = { nut: 96, plug: 90, hole: 6, out: 6 }

/**
 * Lays out the mosaic.
 * @param layout - the grid and where the mark sits.
 * @param look - the page's look, whose pictures the match prefers outside the plug.
 * @returns the cells, row by row, and the living tile's cell.
 */
export function mosaic(layout: Layout, look: string): Plan {
  const { cols, rows, centre, height, pin } = layout
  // A cell is 16:10; the mark's units are square on screen, so a row is `height / NUT_HEIGHT` of the nut per unit.
  const unitsPerRow = NUT_HEIGHT / height
  const unitsPerCol = unitsPerRow * 1.6
  const samples = 5

  interface Target { readonly col: number; readonly row: number; readonly part: Part; readonly lightness: number; readonly order: number }
  const targets: Target[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const share: Record<Part, number> = { nut: 0, hole: 0, plug: 0, out: 0 }
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = 16 + (col + (sx + 0.5) / samples - centre[0]) * unitsPerCol
          const y = 16 + (row + (sy + 0.5) / samples - centre[1]) * unitsPerRow
          share[partAt(x, y)] += 1 / samples ** 2
        }
      }
      const part = (Object.keys(share) as Part[]).reduce((best, each) => share[each] > share[best] ? each : best, 'out')
      const lightness = (Object.keys(share) as Part[]).reduce((sum, each) => sum + share[each] * LIGHTNESS[each], 0)
      // Scarce pictures go first: the plug, then the nut, then the dark cells.
      const order = part === 'plug' ? 0 : part === 'nut' ? 1 : 2
      targets.push({ col, row, part, lightness, order })
    }
  }

  const uses = new Map<string, number>()
  const placed = new Map<string, Shot>()
  const key = (col: number, row: number) => `${col},${row}`
  const maxPeach = Math.max(...SHOTS.map(shot => SHOT_COLOURS[shot.id]?.peach ?? 0))
  const pinned = SHOTS.find(shot => shot.id === pin.id)
  if (pinned === undefined) throw new Error(`The pinned picture ${pin.id} is not one of the shots`)
  placed.set(key(pin.col, pin.row), pinned)
  uses.set(pinned.id, 1)
  // The living tile: the hole cell nearest the plug on the side away from the pinned cell.
  const plugCol = centre[0] + (MARK.plug.cx - 16) / unitsPerCol
  const plugRow = centre[1] + (MARK.plug.cy - 16) / unitsPerRow
  const away = Math.sign(plugCol - (pin.col + 0.5)) || 1
  const live = targets
    .filter(each => each.part === 'hole' && (each.col + 0.5 - plugCol) * away > 0 && !(each.col === pin.col && each.row === pin.row))
    .sort((p, q) => Math.hypot(p.col + 0.5 - plugCol, p.row + 0.5 - plugRow) - Math.hypot(q.col + 0.5 - plugCol, q.row + 0.5 - plugRow))[0]
  const firstFrame = livingFrames(look)[0]
  if (live !== undefined && firstFrame !== undefined) {
    placed.set(key(live.col, live.row), firstFrame)
    uses.set(firstFrame.id, (uses.get(firstFrame.id) ?? 0) + 1)
  }
  const sorted = [...targets].sort((p, q) => p.order - q.order || p.row - q.row || p.col - q.col)
  for (const target of sorted) {
    if (placed.has(key(target.col, target.row))) continue
    const near = new Set<string>()
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const neighbour = placed.get(key(target.col + dx, target.row + dy))
      if (neighbour !== undefined) near.add(neighbour.id)
    }
    let best: Shot | undefined
    let bestCost = Infinity
    for (const shot of SHOTS) {
      if (near.has(shot.id)) continue
      if (target.part === 'plug' && !PEACH_LOOKS.has(shot.theme ?? '')) continue
      const colour = SHOT_COLOURS[shot.id]
      if (colour === undefined) continue
      const peachGap = target.part === 'plug' ? (maxPeach - colour.peach) / maxPeach * 15 : 0
      const otherLook = target.part !== 'plug' && shot.look !== look ? OTHER_LOOK : 0
      const cost = Math.abs(colour.l - target.lightness) + peachGap + otherLook + (uses.get(shot.id) ?? 0) * REUSE[target.part]
      if (cost < bestCost) { bestCost = cost; best = shot }
    }
    if (best === undefined) throw new Error(`No picture fits cell ${key(target.col, target.row)} without repeating a neighbour`)
    placed.set(key(target.col, target.row), best)
    uses.set(best.id, (uses.get(best.id) ?? 0) + 1)
  }

  const cells = targets.map(({ col, row, part }) => {
    const shot = placed.get(key(col, row)) as Shot
    return { col, row, part, shot, pinned: col === pin.col && row === pin.row }
  })
  return { cells, live: live === undefined ? -1 : live.row * cols + live.col }
}
