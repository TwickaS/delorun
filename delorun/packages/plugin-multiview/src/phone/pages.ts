/**
 * Pure arithmetic of the phone pager: which page a scroll position shows, and which pages keep their body mounted.
 * @module @delorun/plugin-multiview/phone/pages
 */

/** How many pages on each side of the shown page keep their body mounted, so a swipe reveals content instead of a blank page. */
export const MOUNT_RADIUS = 1

/**
 * The page a horizontal scroll position shows.
 * @param scrollLeft - the scroller's `scrollLeft`.
 * @param pageWidth - the width of one page; at most 0 means the scroller has no layout yet.
 * @param count - the number of pages.
 * @returns the index of the page nearest the left edge, clamped to the pages; 0 without layout or pages.
 */
export function pageAt(scrollLeft: number, pageWidth: number, count: number): number {
  if (pageWidth <= 0 || count <= 0) return 0
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / pageWidth)))
}

/**
 * Whether a page keeps its body mounted.
 * @param index - the page's index.
 * @param active - the shown page's index.
 * @param radius - how far from the shown page a body stays mounted.
 * @returns true for the shown page and its neighbours within `radius`.
 */
export function isMounted(index: number, active: number, radius: number = MOUNT_RADIUS): boolean {
  return Math.abs(index - active) <= radius
}

/**
 * The page a keyboard key moves to in the strip.
 * @param key - a `KeyboardEvent.key` value.
 * @param active - the shown page's index.
 * @param count - the number of pages.
 * @returns the target index, or null for a key the strip does not handle or a move past either end.
 */
export function pageForKey(key: string, active: number, count: number): number | null {
  const target = key === 'ArrowRight' ? active + 1 : key === 'ArrowLeft' ? active - 1 : key === 'Home' ? 0 : key === 'End' ? count - 1 : null
  return target === null || target < 0 || target >= count || target === active ? null : target
}

/**
 * The pager's page order: the main chat first, then each pinned agent in pin order. Desktop and phone share the saved pins, so the
 * phone ignores the desktop layout tree.
 * @param main - the main chat's pane id.
 * @param pins - the pinned agents' pane ids in pin order.
 * @returns the pane ids, each once, with `main` first.
 */
export function pageOrder<Id extends string>(main: Id, pins: readonly Id[]): Id[] {
  return [main, ...new Set(pins.filter(pin => pin !== main))]
}
