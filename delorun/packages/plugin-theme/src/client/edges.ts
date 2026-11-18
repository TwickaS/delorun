/**
 * Seamless backgrounds on mobile Safari. Safari paints a fixed element's background behind its status bar and bottom
 * toolbar, and needs 5px of a strip showing on screen to read it, so two fixed strips 12px tall, 7px off screen and above the page, one colour calculated once and applied to the strips, the `html` and `body`
 * backgrounds and the `theme-color` meta tag, make the browser's chrome continue the studio.
 *
 * The top colour is the studio's top edge: the main header at phone width, the sidebar header beside the main column
 * above it. The bottom colour is the composer area's background. Both are read from the active theme's tokens.
 * @module @delorun/plugin-theme/client/edges
 */

/** The token the page, and the main header and composer area on it, take their background from. */
const PAGE_TOKEN = '--dsw-alias-bg-base'
/** The token the sidebar, and so its header, takes its background from. */
const SIDEBAR_TOKEN = '--dsw-specific-sidebar-fill'
/** At or below this width the main header is at the top of the screen; above it, the sidebar header is. */
const PHONE_WIDTH = 767

/** Marks the strips and the style element, so a test or a later instance can find them. */
export const EDGE_ATTRIBUTE = 'data-delorun-edge'

/** The two colours of the edges. */
export interface EdgeColours {
  /** The colour of the studio's top edge. */
  readonly top: string
  /** The colour of the composer area. */
  readonly bottom: string
}

/**
 * Calculate the edge colours once from the theme's tokens.
 * @param read - reads a token's resolved value.
 * @param phone - whether the main header is at the top of the screen.
 * @returns the colours; a token that resolves to nothing falls back to the page token.
 */
export function edgeColours(read: (token: string) => string, phone: boolean): EdgeColours {
  const page = read(PAGE_TOKEN)
  const sidebar = read(SIDEBAR_TOKEN)
  return { top: phone || sidebar === '' ? page : sidebar, bottom: page }
}

/** Inline styles saved before the controller changes them, to restore on dispose. */
interface Saved {
  readonly htmlBackground: string
  readonly bodyBackground: string
  readonly bodyPadding: string
  readonly bodyBoxSizing: string
  readonly viewport: string | undefined
}

/** Owns the strips, the tag changes and the listeners; {@link EdgeController.dispose} undoes all of them. */
export class EdgeController {
  private readonly doc: Document
  private readonly win: Window
  private readonly strips: HTMLElement[] = []
  private readonly sheet: HTMLStyleElement
  private readonly ownThemeColor: HTMLMetaElement
  private readonly removed: Array<{ readonly meta: HTMLMetaElement; readonly parent: Node; readonly next: Node | null }> = []
  private readonly saved: Saved
  private readonly viewportMeta: HTMLMetaElement | null
  private readonly listeners: Array<() => void> = []

  /**
   * Add the strips and start following resizes, scheme switches and Safari's toolbar collapse.
   * @param doc - the studio's document.
   * @param win - its window.
   */
  constructor(doc: Document, win: Window) {
    this.doc = doc
    this.win = win
    const html = doc.documentElement
    const body = doc.body
    this.viewportMeta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    this.saved = {
      htmlBackground: html.style.background,
      bodyBackground: body.style.background,
      bodyPadding: body.style.padding,
      bodyBoxSizing: body.style.boxSizing,
      viewport: this.viewportMeta?.getAttribute('content') ?? undefined,
    }
    if (this.viewportMeta !== null && !/viewport-fit\s*=\s*cover/.test(this.saved.viewport ?? '')) {
      this.viewportMeta.setAttribute('content', `${this.saved.viewport ?? 'width=device-width, initial-scale=1'}, viewport-fit=cover`)
    }
    // Text and controls stay inside the safe areas; the insets are 0 outside a notched or home-indicator display.
    body.style.boxSizing = 'border-box'
    body.style.padding = 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
    // jsdom's CSS parser drops max() and env() from inline styles, and a stylesheet keeps the rules in one place.
    this.sheet = doc.createElement('style')
    this.sheet.setAttribute(EDGE_ATTRIBUTE, 'style')
    this.sheet.textContent = ['top', 'bottom'].map(edge =>
      `[${EDGE_ATTRIBUTE}="${edge}"]{position:fixed;left:0;right:0;${edge}:-7px;height:max(12px,calc(env(safe-area-inset-${edge}) + 7px));pointer-events:none;z-index:10;background:var(--edge-${edge}-background)}`).join('')
    doc.head.appendChild(this.sheet)
    for (const edge of ['top', 'bottom']) {
      const strip = doc.createElement('div')
      strip.setAttribute(EDGE_ATTRIBUTE, edge)
      strip.setAttribute('aria-hidden', 'true')
      body.appendChild(strip)
      this.strips.push(strip)
    }
    this.ownThemeColor = doc.createElement('meta')
    this.ownThemeColor.name = 'theme-color'
    this.ownThemeColor.setAttribute(EDGE_ATTRIBUTE, 'theme-color')
    this.claimThemeColor()
    doc.head.appendChild(this.ownThemeColor)
    const refresh = (): void => { this.refresh() }
    const listen = (target: EventTarget | null | undefined, type: string): void => {
      if (target === null || target === undefined) return
      target.addEventListener(type, refresh)
      this.listeners.push(() => { target.removeEventListener(type, refresh) })
    }
    listen(win, 'resize')
    listen(win.visualViewport, 'resize')
    // jsdom and some embedded views have no matchMedia; the colour-scheme change then still arrives as a theme change.
    if (typeof win.matchMedia === 'function') listen(win.matchMedia('(prefers-color-scheme: dark)'), 'change')
    this.refresh()
  }

  /** Set aside every other theme-color tag, such as the page's per-scheme ones or the theme service's, so the one carrying the top colour is the only one. */
  private claimThemeColor(): void {
    for (const meta of this.doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      if (meta === this.ownThemeColor) continue
      this.removed.push({ meta, parent: meta.parentNode as Node, next: meta.nextSibling })
      meta.remove()
    }
  }

  /** Read the tokens again and apply the colours everywhere; call it after a theme, accent or colour-scheme change. */
  refresh(): void {
    this.claimThemeColor()
    const style = this.win.getComputedStyle(this.doc.body)
    const phone = this.win.innerWidth <= PHONE_WIDTH
    const colours = edgeColours(token => style.getPropertyValue(token).trim(), phone)
    const html = this.doc.documentElement
    html.style.setProperty('--edge-top-background', colours.top)
    html.style.setProperty('--edge-bottom-background', colours.bottom)
    html.style.background = colours.top
    this.doc.body.style.background = colours.bottom
    this.ownThemeColor.content = colours.top
  }

  /** Remove the strips and listeners and restore every style and tag this controller changed. */
  dispose(): void {
    for (const stop of this.listeners) stop()
    this.listeners.length = 0
    // The set-aside tags go back before the nodes this controller added, which some of them may precede.
    for (const { meta, parent, next } of this.removed) parent.insertBefore(meta, next?.parentNode === parent ? next : null)
    for (const strip of this.strips) strip.remove()
    this.sheet.remove()
    this.ownThemeColor.remove()
    const html = this.doc.documentElement
    html.style.removeProperty('--edge-top-background')
    html.style.removeProperty('--edge-bottom-background')
    html.style.background = this.saved.htmlBackground
    this.doc.body.style.background = this.saved.bodyBackground
    this.doc.body.style.padding = this.saved.bodyPadding
    this.doc.body.style.boxSizing = this.saved.bodyBoxSizing
    if (this.viewportMeta !== null && this.saved.viewport !== undefined) this.viewportMeta.setAttribute('content', this.saved.viewport)
  }
}
