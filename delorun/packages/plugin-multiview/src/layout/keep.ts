/**
 * Keeps what a pane's content would lose when the library moves its DOM: the scroll offsets of scrolled elements, and keyboard focus
 * (WebKit has no `moveBefore`, so a moved focused element is blurred). Positions are recorded as the content scrolls; around a
 * layout change the recording is frozen, and afterwards offsets that were reset are put back and focus that fell to the page is
 * given back to the element that held it.
 * @module @delorun/plugin-multiview/layout/keep
 */

/** The window around a layout change, in animation frames, in which the library finishes moving and resetting DOM. */
const SETTLE_FRAMES = 2

/** Records and restores the scroll and focus state of a layout's content. */
export class StateKeeper {
  private readonly positions = new Map<Element, { top: number; left: number }>()
  private frozen = false
  private focused: HTMLElement | undefined
  private pending: number | undefined

  /**
   * @param root - the layout's root element; scrolling inside it is recorded.
   */
  constructor(private readonly root: HTMLElement) {
    root.addEventListener('scroll', this.onScroll, true)
  }

  private readonly onScroll = (event: Event): void => {
    if (this.frozen || !(event.target instanceof HTMLElement)) return
    this.positions.set(event.target, { top: event.target.scrollTop, left: event.target.scrollLeft })
  }

  /** Stop recording and remember the focused element; call it just before the layout changes. */
  freeze(): void {
    this.frozen = true
    const active = this.root.ownerDocument.activeElement
    this.focused = active instanceof HTMLElement && this.root.contains(active) ? active : undefined
    if (this.pending !== undefined) {
      this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.pending)
      this.pending = undefined
    }
  }

  /**
   * Restore after the layout changed: once the library has settled, put back scroll offsets that were reset and focus that fell to the page.
   * @param delayFrames - extra animation frames to wait, for a change whose end is not known exactly.
   */
  release(delayFrames = 0): void {
    const view = this.root.ownerDocument.defaultView
    if (view === null) return
    let frames = SETTLE_FRAMES + delayFrames
    const step = (): void => {
      frames -= 1
      if (frames > 0) {
        this.pending = view.requestAnimationFrame(step)
        return
      }
      this.pending = undefined
      this.restore()
    }
    this.pending = view.requestAnimationFrame(step)
  }

  private restore(): void {
    for (const [element, position] of this.positions) {
      if (!element.isConnected) this.positions.delete(element)
      else if (element.scrollTop !== position.top || element.scrollLeft !== position.left) element.scrollTo(position.left, position.top)
    }
    const { focused } = this
    this.focused = undefined
    const document = this.root.ownerDocument
    if (focused?.isConnected === true && (document.activeElement === null || document.activeElement === document.body)) {
      focused.focus({ preventScroll: true })
    }
    this.frozen = false
  }

  /** Stop listening. */
  dispose(): void {
    this.root.removeEventListener('scroll', this.onScroll, true)
    if (this.pending !== undefined) this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.pending)
    this.positions.clear()
  }
}
