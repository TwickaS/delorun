import { describe, expect, it } from 'vitest'
import { mosaic, NARROW, WIDE, type Layout } from '../src/home/mosaic.ts'
import { MOSAIC_PLANS, PLAN_IDS, PLAN_LOOKS, PLAN_MODES } from '../src/home/mosaic-plans.ts'
import { planCells, type LayoutName } from '../src/home/plans.ts'
import { SHOT_COLOURS } from '../src/home/shot-colours.ts'
import { SHOTS } from '../src/home/shots.ts'

const LAYOUTS: readonly (readonly [LayoutName, Layout])[] = [['wide', WIDE], ['narrow', NARROW]]

describe('the mosaic tile matcher', () => {
  for (const [name, layout] of LAYOUTS) {
    it(`puts no picture next to itself in the ${name} layout, in any look or colour scheme, diagonals included`, () => {
      for (const look of PLAN_LOOKS) {
        for (const mode of PLAN_MODES) {
          const cells = planCells(name, look, mode)
          expect(cells).toHaveLength(layout.cols * layout.rows)
          const repeats: string[] = []
          cells.forEach((index, at) => {
            const col = at % layout.cols
            const row = Math.floor(at / layout.cols)
            for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]] as const) {
              const c = col + dx
              const r = row + dy
              if (c < 0 || c >= layout.cols || r >= layout.rows) continue
              if (cells[r * layout.cols + c] === index) repeats.push(`${look} ${mode} ${PLAN_IDS[index] ?? ''} at ${String(col)},${String(row)}`)
            }
          })
          expect(repeats).toEqual([])
        }
      }
    })
  }

  it('names only pictures of the wall, and the pinned picture in its cell', () => {
    const known = new Set(SHOTS.map(shot => shot.id))
    for (const id of PLAN_IDS) expect(known.has(id), id).toBe(true)
    for (const [name, layout] of LAYOUTS) {
      const at = layout.pin.row * layout.cols + layout.pin.col
      for (const look of PLAN_LOOKS) for (const mode of PLAN_MODES) expect(PLAN_IDS[planCells(name, look, mode)[at] ?? -1], `${name} ${look} ${mode}`).toBe(layout.pin.id)
      expect(MOSAIC_PLANS[name].parts[at]).toBe('h')
    }
  })

  it('lays the hexagon lighter than its ground in the dark scheme and darker than it in the light scheme, so it reads in both', () => {
    for (const [, layout] of LAYOUTS) {
      for (const look of PLAN_LOOKS) {
        const lightness = (mode: 'light' | 'dark', part: string): number => {
          const cells = mosaic(layout, look, mode).cells.filter(cell => cell.part === part)
          return cells.reduce((sum, cell) => sum + (SHOT_COLOURS[cell.shot.id]?.l ?? 0), 0) / cells.length
        }
        expect(lightness('dark', 'nut') - lightness('dark', 'out'), `${look} dark`).toBeGreaterThan(30)
        expect(lightness('light', 'out') - lightness('light', 'nut'), `${look} light`).toBeGreaterThan(30)
      }
    }
  })

  it('is what the committed plans were generated from', () => {
    for (const [name, layout] of LAYOUTS) {
      for (const mode of PLAN_MODES) {
        const plan = mosaic(layout, 'ocean', mode)
        expect(plan.cells.map(cell => PLAN_IDS.indexOf(cell.shot.id)), `${name} ${mode}`).toEqual([...planCells(name, 'ocean', mode)])
        expect(plan.live).toBe(MOSAIC_PLANS[name].looks.ocean[mode].live)
      }
    }
  })
})
