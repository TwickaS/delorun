/**
 * The working indicator: a 16px orbital ring in the status slot, in place of the frozen loading arc. A quiet track, a
 * dash-array head that orbits once every 2.6s and a core that breathes on the same period. The animations sit inside
 * `prefers-reduced-motion: no-preference`, so a person who asks for less motion gets a still arc and a still core.
 * @module @delorun/plugin-sidebar/client/WorkingRing
 */
import { cx } from './cx.ts'
import css from './WorkingRing.module.css'

/**
 * Pin the ring's CSS animations to document time zero, as `StateDot` does for its spinner. A CSS animation starts when
 * its element is inserted and restarts when the element is moved or shown again, so rings started at different moments
 * orbit out of phase; one shared start time keeps every visible ring in step. Mount pins the first start, and the
 * element's own `animationstart` listener pins each restart.
 * @param element - the mounted ring, or null on unmount.
 */
function syncRing(element: SVGSVGElement | null): void {
  if (element === null) return
  pinRing(element)
  element.addEventListener('animationstart', () => { pinRing(element) })
}

/**
 * Set every CSS animation in the ring's subtree to start at document time zero.
 * @param element - the mounted ring.
 */
function pinRing(element: SVGSVGElement): void {
  // jsdom (the unit lane) implements no Web Animations despite lib.dom's non-optional typing, so the optional call
  // leaves that lane unpinned rather than failing.
  const ring = element as { getAnimations?: SVGSVGElement['getAnimations'] }
  for (const animation of ring.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0
}

/**
 * Render the working indicator.
 * @param props.className - the box the ring fills, which the status slot sizes.
 * @returns the ring, hidden from assistive technology because the status text beside it names the state.
 */
export function WorkingRing({ className }: { readonly className?: string | undefined }) {
  return (
    <svg ref={syncRing} className={cx(css.ring, className)} viewBox="0 0 16 16" aria-hidden="true">
      <circle className={css.ringTrack} cx="8" cy="8" r="6.2" />
      <circle className={css.ringHead} cx="8" cy="8" r="6.2" />
      <circle className={css.ringCore} cx="8" cy="8" r="1.6" />
    </svg>
  )
}
