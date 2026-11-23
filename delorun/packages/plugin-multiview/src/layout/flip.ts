/**
 * The layout glide: each pane moves from where it was to where the new layout puts it, by a transform only, so nothing is laid
 * out again during the motion. A glide that is still running when the layout changes again starts the next one from where the
 * pane is on screen. Nothing moves with reduced motion.
 * @module @delorun/plugin-multiview/layout/flip
 */

/** How long a glide takes, in milliseconds. */
export const GLIDE_MS = 240

/** The glide's curve: a quick start that settles gently, as a pane being placed. */
export const GLIDE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** Where each pane's frame is on screen, by the pane its header shows. */
export type PaneRects = ReadonlyMap<string, DOMRect>

/** The frames of the panes in a layout: the element matching `frame` around each pane header's marker. */
function frames(root: HTMLElement, frame: string): readonly { readonly pane: string; readonly element: HTMLElement }[] {
  const out: { pane: string; element: HTMLElement }[] = []
  for (const marker of root.querySelectorAll<HTMLElement>('[data-flip-pane]')) {
    const pane = marker.dataset.flipPane
    const element = marker.closest<HTMLElement>(frame)
    if (pane !== undefined && element !== null && root.contains(element)) out.push({ pane, element })
  }
  return out
}

/**
 * Report whether motion is wanted.
 * @param root - an element of the page.
 * @returns false when the person asked for reduced motion or the page cannot animate.
 */
export function motionAllowed(root: HTMLElement): boolean {
  const view = root.ownerDocument.defaultView
  if (view === null || typeof root.animate !== 'function') return false
  return view.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true
}

/**
 * Measure the panes before a layout change, where they are on screen now (an unfinished glide included).
 * @param root - the layout's root element.
 * @param frame - a selector for a pane's frame, an ancestor of its header.
 * @returns each pane's frame.
 */
export function measurePanes(root: HTMLElement, frame: string): PaneRects {
  const rects = new Map<string, DOMRect>()
  for (const { pane, element } of frames(root, frame)) rects.set(pane, element.getBoundingClientRect())
  return rects
}

/**
 * Glide every pane from its measured frame to its frame now. A pane with no earlier frame fades in.
 * @param root - the layout's root element.
 * @param frame - the selector given to {@link measurePanes}.
 * @param before - the frames measured before the change.
 */
export function playFlip(root: HTMLElement, frame: string, before: PaneRects): void {
  if (!motionAllowed(root)) return
  for (const { pane, element } of frames(root, frame)) {
    for (const running of element.getAnimations()) running.cancel()
    const from = before.get(pane)
    const to = element.getBoundingClientRect()
    if (to.width === 0 || to.height === 0) continue
    if (from === undefined) {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: GLIDE_MS * 0.6, easing: 'ease-out' })
      continue
    }
    const dx = from.left - to.left
    const dy = from.top - to.top
    const sx = from.width / to.width
    const sy = from.height / to.height
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue
    element.animate(
      [
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: '0 0', transform: 'none' },
      ],
      { duration: GLIDE_MS, easing: GLIDE_EASING },
    )
  }
}
