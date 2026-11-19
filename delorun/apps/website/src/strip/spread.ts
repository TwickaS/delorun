/**
 * The strip's signature movement: the new colours spread from the control that was pressed, as a circle drawn with the
 * View Transitions interface. Where the interface is missing, under reduced motion, or when the transition cannot start,
 * the colours change in place. Timing and easing are read from the brand's motion tokens, which are 0ms under reduced motion.
 *
 * @module website/strip/spread
 */

/** A point on the screen, in CSS pixels from the top left of the window. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** The class the root carries while a spread runs, so the page's other transitions keep the browser's cross-fade. */
export const SPREAD_CLASS = 'strip-spread'

/**
 * The radius that covers the whole window from a point.
 * @param from - the centre.
 * @param width - the window's width.
 * @param height - the window's height.
 * @returns the radius in pixels.
 */
export function coverRadius(from: Point, width: number, height: number): number {
  return Math.ceil(Math.hypot(Math.max(from.x, width - from.x), Math.max(from.y, height - from.y)))
}

/**
 * The centre of an element on the screen.
 * @param element - the element.
 * @returns its centre.
 */
export function centreOf(element: Element): Point {
  const box = element.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

/**
 * Changes the look, spreading the new colours from a point where the browser can.
 * @param from - where the press was; undefined changes in place.
 * @param update - sets the new look on the root; it runs exactly once, synchronously or inside the transition.
 */
export function spread(from: Point | undefined, update: () => void): void {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const duration = Number.parseFloat(style.getPropertyValue('--dl-motion-explain'))
  if (from === undefined || typeof document.startViewTransition !== 'function' || !(duration > 0)) {
    update()
    return
  }
  root.classList.add(SPREAD_CLASS)
  const transition = document.startViewTransition(update)
  const radius = coverRadius(from, window.innerWidth, window.innerHeight)
  transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${String(from.x)}px ${String(from.y)}px)`, `circle(${String(radius)}px at ${String(from.x)}px ${String(from.y)}px)`] },
      { duration, easing: style.getPropertyValue('--dl-ease-out').trim(), pseudoElement: '::view-transition-new(root)' },
    )
  }, () => {
    // The transition could not start (another one replaced it, or the page hid); the update has still run, so the plain change stands.
  })
  const done = (): void => { root.classList.remove(SPREAD_CLASS) }
  transition.finished.then(done, done)
}
