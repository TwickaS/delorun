/**
 * Reads the generated mosaic plans: a plan's cells as picture indexes, and the plan a page look and colour scheme need.
 *
 * @module @delorun/website/home/plans
 */
import type { PLAN_MODES } from './mosaic-plans.ts';
import { MOSAIC_PLANS, PLAN_LOOKS } from './mosaic-plans.ts'

/** A look the plans cover. */
export type PlanLook = (typeof PLAN_LOOKS)[number]

/** A colour scheme the plans cover. */
export type PlanMode = (typeof PLAN_MODES)[number]

/** The layouts' names. */
export type LayoutName = keyof typeof MOSAIC_PLANS

const decoded = new Map<string, readonly number[]>()

/**
 * One plan's cells as indexes into `PLAN_IDS`.
 * @param name - the layout.
 * @param look - the look.
 * @param mode - the colour scheme.
 * @returns the index of each cell's picture, row by row.
 */
export function planCells(name: LayoutName, look: PlanLook, mode: PlanMode): readonly number[] {
  const key = `${name}:${look}:${mode}`
  const known = decoded.get(key)
  if (known !== undefined) return known
  const text = MOSAIC_PLANS[name].looks[look][mode].cells
  const cells = Array.from({ length: text.length / 2 }, (_, at) => parseInt(text.slice(at * 2, at * 2 + 2), 36))
  decoded.set(key, cells)
  return cells
}

/**
 * The plan's look for a page look: the page's own when a plan covers it, otherwise Soft.
 * @param look - the page's look id.
 * @returns the plan's look.
 */
export function planLook(look: string): PlanLook {
  return (PLAN_LOOKS as readonly string[]).includes(look) ? look as PlanLook : 'soft'
}
