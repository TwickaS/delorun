/**
 * Connects the header's theme control to the home page's mosaic: the control asks for a re-tile as part of its effect,
 * and each mounted mosaic layout answers by laying its tiles out again in the new look. Pages without a mosaic answer at
 * once.
 *
 * @module @delorun/website/home/retile
 */
import type { EffectRun } from './effects.ts'

/** Lays a mosaic out again in a look; settles when its last tile has turned. */
type Retiler = (look: string, run: EffectRun) => Promise<void>

const retilers = new Set<Retiler>()

/**
 * Registers a mosaic layout.
 * @param retiler - what re-tiles it.
 * @returns the disposer.
 */
export function onRetile(retiler: Retiler): () => void {
  retilers.add(retiler)
  return () => { retilers.delete(retiler) }
}

/**
 * Whether the page has a mosaic to re-tile.
 * @returns true when one is mounted.
 */
export function canRetile(): boolean {
  return retilers.size > 0
}

/**
 * Re-tiles every mounted mosaic layout in a look.
 * @param look - the look's id.
 * @param run - the effect's run, for its speed.
 * @returns a promise that settles when every layout has finished.
 */
export async function retile(look: string, run: EffectRun): Promise<void> {
  await Promise.all([...retilers].map(retiler => retiler(look, run)))
}
