/**
 * Seamless backgrounds on mobile Safari. Safari paints a fixed element's background behind its status bar and bottom
 * toolbar, and needs 5px of a strip showing on screen to read it, so two fixed strips 12px tall, 7px off screen and
 * above the page carry the colour of the surface at each edge, and the same colours go on the `html` and `body`
 * backgrounds and the one `theme-color` tag.
 *
 * A surface states its own edge colours in the CSS variables `--edge-top` and `--edge-bottom` and marks itself
 * `data-delorun-edge-surface`, so the colour follows the real UI: the sidebar's header art, the chat, Settings and a
 * modal each declare their own, and this controller reads the computed value of the surface at each edge rather than a
 * colour of its own. A page whose surfaces declare none keeps the theme's tokens. A desktop window with a fine pointer
 * has no such bars, so the strips are hidden there and the header art reaches the window's top edge.
 *
 * The controller also writes the shell's height. A pinned PWA on iOS reports a visual viewport that stops at the status
 * bar and the home indicator, so sizing the shell to it leaves a band of the page above and below the studio; the shell
 * takes the screen instead, and the surfaces pad their content by the insets. The on-screen keyboard is the one case the
 * shell follows the visual viewport, because the composer must stay above it.
 * @module @delorun/plugin-theme/client/edges
 */
import { compositeOver, edgeSurfaces, subscribeEdgeSurfaces } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EdgeSurface } from '@deepseek-ai/dsh-client-ui-primitives'

/** The token the page, and the main header and composer area on it, take their background from. */
const PAGE_TOKEN = '--dsw-alias-bg-base'
/** The token the sidebar, and so its header, takes its background from. */
const SIDEBAR_TOKEN = '--dsw-specific-sidebar-fill'
/** At or below this width the main header is at the top of the screen; above it, the sidebar header is. */
const PHONE_WIDTH = 767

/** Marks the strips and the style element, so a test or a later instance can find them. */
export const EDGE_ATTRIBUTE = 'data-delorun-edge'

/** Marks a surface that states the colour at its own edges. */
export const EDGE_SURFACE_ATTRIBUTE = 'data-delorun-edge-surface'

/** The variables a surface declares to state the colour at its own top and bottom edges. */
export const EDGE_VARIABLES = { top: '--edge-top', bottom: '--edge-bottom' } as const

/** The variables this controller writes with the resolved colours, which the strips and the page background read. */
export const EDGE_RESOLVED = { top: '--edge-top-background', bottom: '--edge-bottom-background' } as const

/** The variable carrying the height the shell sizes itself to: the screen, or what the on-screen keyboard leaves. */
export const VIEWPORT_HEIGHT_VARIABLE = '--dsh-viewport-height'

/** The safe-area insets as `edges.css` publishes them, which tell a pinned PWA's short visual viewport from the keyboard's. */
export const SAFE_AREA_VARIABLES = { top: '--delorun-safe-top', bottom: '--delorun-safe-bottom' } as const

/** The most a shorter visual viewport may fall short of the layout viewport and still be the safe areas rather than the keyboard. */
export const SAFE_AREA_SLACK = 8

/** The attributes whose change can move a surface to the top or bottom edge of the screen. */
const WATCHED_ATTRIBUTES = ['data-sidebar-collapsed', 'data-sidebar-drawer', 'data-phase', 'data-phone', 'data-ds-dark-theme', 'data-palette']

/** The two colours of the edges. */
export interface EdgeColours {
  /** The colour of the studio's top edge. */
  readonly top: string
  /** The colour of the composer area. */
  readonly bottom: string
}

/** A surface that states its edge colours, with the box it covers. */
export interface EdgeSurfaceBox {
  /** The element that declares the colours. */
  readonly element: Element
  /** Its box in viewport coordinates. */
  readonly rect: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number }
  /** Its computed `z-index`, or `undefined` where it is not positioned. */
  readonly zIndex: number | undefined
  /** Its place in document order, which breaks a tie between two surfaces at the same depth. */
  readonly order: number
  /** Whether the surface is painted at all; a closed drawer keeps its box but is hidden. */
  readonly visible: boolean
}

/** The viewport's size, which decides whether a surface covers an edge. */
export interface EdgeViewport {
  /** The viewport's width in pixels. */
  readonly width: number
  /** The viewport's height in pixels. */
  readonly height: number
}

/**
 * Calculate the fallback edge colours from the theme's tokens, for a page whose surfaces declare none.
 * @param read - reads a token's resolved value.
 * @param phone - whether the main header is at the top of the screen.
 * @returns the colours; a token that resolves to nothing falls back to the page token.
 */
export function edgeColours(read: (token: string) => string, phone: boolean): EdgeColours {
  const page = read(PAGE_TOKEN)
  const sidebar = read(SIDEBAR_TOKEN)
  return { top: phone || sidebar === '' ? page : sidebar, bottom: page }
}

/**
 * The height the shell takes: the screen, so the studio's surface reaches the physical top and bottom edges, except while
 * the on-screen keyboard shortens the visual viewport, when it takes the visual viewport so the composer stays above the
 * keyboard.
 *
 * A pinned PWA on iOS reports a visual viewport that stops at the status bar and the home indicator, so the shortfall is
 * the safe areas and the shell still takes the screen; the keyboard shortens it by far more than the insets.
 * @param layout - the layout viewport's height, which is the screen.
 * @param visual - the visual viewport's height, which the keyboard and a pinned PWA's safe areas both shorten.
 * @param insets - the safe-area insets the page resolves.
 * @returns the height in pixels, or undefined when the layout viewport reports none.
 */
export function shellHeight(layout: number, visual: number | undefined, insets: { readonly top: number; readonly bottom: number }): number | undefined {
  if (!Number.isFinite(layout) || layout <= 0) return undefined
  if (visual === undefined || !Number.isFinite(visual) || visual <= 0) return layout
  return layout - visual <= insets.top + insets.bottom + SAFE_AREA_SLACK ? layout : visual
}

/**
 * Order the surfaces that cover one edge, the one whose colour states the edge first: a surface inside another states it
 * more exactly than the surface around it, then the higher `z-index` wins, then the later in document order.
 * @param boxes - the declared surfaces.
 * @param edge - which edge to resolve.
 * @param viewport - the viewport's size.
 * @returns the covering surfaces, the first one owning the edge.
 */
export function edgeCandidates(boxes: readonly EdgeSurfaceBox[], edge: keyof EdgeColours, viewport: EdgeViewport): EdgeSurfaceBox[] {
  const y = edge === 'top' ? 0.5 : viewport.height - 0.5
  const x = viewport.width / 2
  const covering = boxes.filter(box => box.visible && box.rect.top <= y && box.rect.bottom >= y && box.rect.left <= x && box.rect.right >= x)
  // A surface inside another states the edge more exactly than the surface around it, and otherwise the deeper stacking
  // context wins: an overlay portalled beside the root sits above every column.
  const depth = (box: EdgeSurfaceBox): number => covering.filter(other => other !== box && other.element.contains(box.element)).length
  return [...covering].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0) || depth(b) - depth(a) || b.order - a.order)
}

/**
 * Read the colours the surfaces at the screen's edges declare, and leave an edge no surface states to the caller.
 * @param boxes - the declared surfaces.
 * @param read - reads an element's computed value of a custom property.
 * @param viewport - the viewport's size.
 * @returns the colours the surfaces state, each absent where no surface states that edge, and whether the surface that
 *   states it covers the whole screen at that edge, in which case nothing is painted over it.
 */
export function edgeColoursAt(
  boxes: readonly EdgeSurfaceBox[],
  read: (element: Element, name: string) => string,
  viewport: EdgeViewport,
): { readonly colours: Partial<EdgeColours>; readonly covered: Partial<Record<keyof EdgeColours, boolean>> } {
  const pick = (edge: keyof EdgeColours): { colour?: string; covered: boolean } => {
    for (const box of edgeCandidates(boxes, edge, viewport)) {
      const value = read(box.element, EDGE_VARIABLES[edge]).trim()
      if (value === '') continue
      const covered = box.rect.top <= 0 && box.rect.bottom >= viewport.height && box.rect.left <= 0 && box.rect.right >= viewport.width
      return { colour: value, covered }
    }
    return { covered: false }
  }
  const top = pick('top')
  const bottom = pick('bottom')
  return {
    colours: { ...top.colour === undefined ? {} : { top: top.colour }, ...bottom.colour === undefined ? {} : { bottom: bottom.colour } },
    covered: { ...top.colour === undefined ? {} : { top: top.covered }, ...bottom.colour === undefined ? {} : { bottom: bottom.covered } },
  }
}

/**
 * Apply the open full-screen surfaces over the studio's own edge colours, the earliest opened first: a solid surface
 * replaces both colours and an overlay tints them, so nested surfaces restore in order as they close.
 * @param base - the studio's edge colours.
 * @param surfaces - the open surfaces.
 * @returns the colours behind the browser's bars.
 */
export function stackedEdgeColours(base: EdgeColours, surfaces: readonly EdgeSurface[]): EdgeColours {
  let colours = base
  for (const surface of surfaces) {
    const current = colours
    colours = 'dim' in surface
      ? { top: compositeOver(surface.dim, current.top), bottom: compositeOver(surface.dim, current.bottom) }
      : { top: surface.top, bottom: surface.bottom }
  }
  return colours
}

/** Inline styles saved before the controller changes them, to restore on dispose. */
interface Saved {
  readonly htmlBackground: string
  readonly bodyBackground: string
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
  private readonly observer: MutationObserver
  private frame: number | undefined
  /** Colours already resolved, keyed by the value a surface states; a refresh runs on every mutation, and this is the costly part. */
  private readonly resolvedColours = new Map<string, string>()

  /**
   * Add the strips and start following resizes, scheme switches, surface changes and Safari's toolbar collapse.
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
      viewport: this.viewportMeta?.getAttribute('content') ?? undefined,
    }
    if (this.viewportMeta !== null && !/viewport-fit\s*=\s*cover/.test(this.saved.viewport ?? '')) {
      this.viewportMeta.setAttribute('content', `${this.saved.viewport ?? 'width=device-width, initial-scale=1'}, viewport-fit=cover`)
    }
    // jsdom's CSS parser drops max() and env() from inline styles, and a stylesheet keeps the rules in one place.
    this.sheet = doc.createElement('style')
    this.sheet.setAttribute(EDGE_ATTRIBUTE, 'style')
    this.sheet.textContent = ['top', 'bottom'].map(edge =>
      `[${EDGE_ATTRIBUTE}="${edge}"]{position:fixed;left:0;right:0;${edge}:-7px;height:max(12px,calc(env(safe-area-inset-${edge}) + 7px));pointer-events:none;z-index:1001;background:var(${EDGE_RESOLVED[edge as keyof EdgeColours]})}`).join('')
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
    this.listeners.push(subscribeEdgeSurfaces(doc, refresh))
    listen(win, 'resize')
    listen(win, 'orientationchange')
    listen(win.visualViewport, 'resize')
    // jsdom and some embedded views have no matchMedia; the colour-scheme change then still arrives as a theme change.
    if (typeof win.matchMedia === 'function') listen(win.matchMedia('(prefers-color-scheme: dark)'), 'change')
    // A route, view, drawer or dialog change moves another surface to an edge; one refresh per frame keeps up with it.
    this.observer = new MutationObserver(() => { this.schedule() })
    this.observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES })
    // A drawer slides in on a transform, which no attribute change reports, so the transition's end is followed too.
    listen(win, 'transitionend')
    listen(win, 'animationend')
    this.refresh()
  }

  /** Ask for one refresh on the next frame, so a burst of DOM changes costs one read. */
  private schedule(): void {
    if (this.frame !== undefined) return
    const run = (): void => { this.frame = undefined; this.refresh() }
    if (typeof this.win.requestAnimationFrame === 'function') this.frame = this.win.requestAnimationFrame(run)
    else run()
  }

  /** Set aside every other theme-color tag, such as the page's per-scheme ones or the theme service's, so the one carrying the top colour is the only one. */
  private claimThemeColor(): void {
    for (const meta of this.doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      if (meta === this.ownThemeColor) continue
      this.removed.push({ meta, parent: meta.parentNode as Node, next: meta.nextSibling })
      meta.remove()
    }
  }

  /**
   * The declared surfaces, with the box each covers and its place in the paint order. A surface's stacking depth is the
   * highest `z-index` on the way up from it, because a covering overlay portals beside the root and so carries its depth
   * on an ancestor rather than on itself.
   */
  private surfaceBoxes(): EdgeSurfaceBox[] {
    const boxes: EdgeSurfaceBox[] = []
    let order = 0
    for (const element of this.doc.querySelectorAll(`[${EDGE_SURFACE_ATTRIBUTE}]`)) {
      const rect = element.getBoundingClientRect()
      const style = this.win.getComputedStyle(element)
      // A closed drawer keeps its box and its place in the document, so only what is painted may state an edge.
      const visible = style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      boxes.push({ element, rect, zIndex: this.stackingDepth(element), order, visible })
      order += 1
    }
    return boxes
  }

  /**
   * The highest `z-index` between an element and the root, which is how deep its stacking context sits.
   * @param element - the surface's element.
   * @returns the depth, or `undefined` when nothing on the way up is positioned.
   */
  private stackingDepth(element: Element): number | undefined {
    let depth: number | undefined
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = this.win.getComputedStyle(node)
      if (style.position === 'static') continue
      const value = Number.parseInt(style.zIndex, 10)
      if (!Number.isFinite(value)) continue
      depth = depth === undefined ? value : Math.max(depth, value)
    }
    return depth
  }

  /**
   * Resolve a CSS colour to a flat form, once per value. A surface may state its colour as `color-mix()` or `oklch()`,
   * which `theme-color` does not take, so the value is painted once and read back.
   * @param colour - any CSS colour.
   * @returns the colour in a flat form, or the value unchanged when the browser cannot resolve it.
   */
  private resolved(colour: string): string {
    if (/^rgba?\(/.test(colour)) return colour
    const known = this.resolvedColours.get(colour)
    if (known !== undefined) return known
    const resolved = this.resolveUncached(colour)
    this.resolvedColours.set(colour, resolved)
    return resolved
  }

  /**
   * Resolve a colour the first time it is seen.
   * @param colour - any CSS colour that is not already in `rgb()` form.
   * @returns the colour in a flat form, or the value unchanged when the browser cannot resolve it.
   */
  private resolveUncached(colour: string): string {
    // The probe lives in the head, which the observer does not watch, so reading a colour never schedules another read.
    const probe = this.doc.createElement('span')
    probe.style.color = colour
    probe.style.display = 'none'
    this.doc.head.appendChild(probe)
    const computed = this.win.getComputedStyle(probe).color
    probe.remove()
    if (computed === '') return colour
    // A browser may compute the colour in `oklch()` or `color()`, which `theme-color` does not take; the canvas paints it
    // and hands back the `#rrggbb` form every browser reads. WebKit keeps the modern form in `fillStyle`, so the painted
    // pixel is read instead.
    const canvas = this.doc.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    // A document without a canvas implementation, such as a test environment's, keeps the computed form.
    if (typeof canvas.getContext !== 'function') return computed
    const context = canvas.getContext('2d')
    if (context === null) return computed
    context.fillStyle = computed
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
    if (red === undefined || green === undefined || blue === undefined) return computed
    return `#${[red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
  }

  /**
   * Read the safe-area insets the page resolves, which `edges.css` publishes as custom properties.
   * @returns the top and bottom insets in pixels; zero where the page resolves none, as a desktop window does.
   */
  private safeAreaInsets(): { readonly top: number; readonly bottom: number } {
    const style = this.win.getComputedStyle(this.doc.documentElement)
    const read = (name: string): number => {
      const value = Number.parseFloat(style.getPropertyValue(name))
      return Number.isFinite(value) && value > 0 ? value : 0
    }
    return { top: read(SAFE_AREA_VARIABLES.top), bottom: read(SAFE_AREA_VARIABLES.bottom) }
  }

  /** Read the surfaces' colours again and apply them everywhere; call it after a theme, accent, colour-scheme or view change. */
  refresh(): void {
    this.claimThemeColor()
    const style = this.win.getComputedStyle(this.doc.body)
    const phone = this.win.innerWidth <= PHONE_WIDTH
    const fallback = edgeColours(token => style.getPropertyValue(token).trim(), phone)
    const viewport = { width: this.win.innerWidth, height: this.win.innerHeight }
    const { colours: declared, covered } = edgeColoursAt(
      this.surfaceBoxes(),
      (element, name) => this.resolved(this.win.getComputedStyle(element).getPropertyValue(name)),
      viewport,
    )
    // The surfaces state the studio's own edges; the stack is what lies over them, so a dialog's mask tints the colour
    // the surface states and a full-screen surface replaces it. A surface that covers the screen at an edge is what is
    // painted there, so nothing tints it. An edge no surface states keeps the theme's token.
    const base = { top: declared.top ?? fallback.top, bottom: declared.bottom ?? fallback.bottom }
    const stacked = stackedEdgeColours(base, edgeSurfaces(this.doc))
    const colours = {
      top: this.resolved(covered.top === true ? base.top : stacked.top),
      bottom: this.resolved(covered.bottom === true ? base.bottom : stacked.bottom),
    }
    const html = this.doc.documentElement
    html.style.setProperty(EDGE_RESOLVED.top, colours.top)
    html.style.setProperty(EDGE_RESOLVED.bottom, colours.bottom)
    // One flat colour cannot be both edges, so the page carries the top one and the bottom strip carries the other.
    html.style.background = colours.top
    this.doc.body.style.background = colours.top
    this.ownThemeColor.content = colours.top
    // The shell takes the screen, so the surface reaches the physical edges; the keyboard's shorter visual viewport is
    // the one case it follows, and a pinned PWA's safe areas are not.
    const height = shellHeight(this.win.innerHeight, this.win.visualViewport?.height, this.safeAreaInsets())
    if (height !== undefined) html.style.setProperty(VIEWPORT_HEIGHT_VARIABLE, `${String(Math.round(height))}px`)
    else html.style.removeProperty(VIEWPORT_HEIGHT_VARIABLE)
    // Strips draw a visible 5px band over the header art; they are for a touch device's bars, which a desktop window has none of.
    const coarse = typeof this.win.matchMedia === 'function' && this.win.matchMedia('(pointer: coarse)').matches
    for (const strip of this.strips) strip.hidden = !(phone || coarse)
  }

  /** Remove the strips and listeners and restore every style and tag this controller changed. */
  dispose(): void {
    for (const stop of this.listeners) stop()
    this.listeners.length = 0
    this.observer.disconnect()
    if (this.frame !== undefined && typeof this.win.cancelAnimationFrame === 'function') this.win.cancelAnimationFrame(this.frame)
    this.frame = undefined
    // The set-aside tags go back before the nodes this controller added, which some of them may precede.
    for (const { meta, parent, next } of this.removed) parent.insertBefore(meta, next?.parentNode === parent ? next : null)
    for (const strip of this.strips) strip.remove()
    this.sheet.remove()
    this.ownThemeColor.remove()
    const html = this.doc.documentElement
    html.style.removeProperty(EDGE_RESOLVED.top)
    html.style.removeProperty(EDGE_RESOLVED.bottom)
    html.style.removeProperty(VIEWPORT_HEIGHT_VARIABLE)
    html.style.background = this.saved.htmlBackground
    this.doc.body.style.background = this.saved.bodyBackground
    if (this.viewportMeta !== null && this.saved.viewport !== undefined) this.viewportMeta.setAttribute('content', this.saved.viewport)
  }
}
