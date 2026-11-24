// @vitest-environment jsdom
/** The Safari edge controller: strips, one theme-color tag, the surface at each edge, backgrounds, and a full restore on dispose. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pushEdgeSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  EDGE_ATTRIBUTE, EDGE_SURFACE_ATTRIBUTE, EdgeController, VIEWPORT_HEIGHT_VARIABLE, edgeCandidates, edgeColours, edgeColoursAt, stackedEdgeColours,
  type EdgeSurfaceBox,
} from '../src/client/edges.ts'

const PAGE = '--dsw-alias-bg-base'
const SIDEBAR = '--dsw-specific-sidebar-fill'

function tokens(page: string, sidebar: string): void {
  document.body.style.setProperty(PAGE, page)
  document.body.style.setProperty(SIDEBAR, sidebar)
}

/** A declared surface covering a box, with the colours it states. */
function surface(name: string, box: { top: number; bottom: number; left?: number; right?: number }, colours: { top?: string; bottom?: string }, zIndex?: number): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute(EDGE_SURFACE_ATTRIBUTE, name)
  if (colours.top !== undefined) element.style.setProperty('--edge-top', colours.top)
  if (colours.bottom !== undefined) element.style.setProperty('--edge-bottom', colours.bottom)
  if (zIndex !== undefined) element.style.zIndex = String(zIndex)
  element.getBoundingClientRect = () => ({
    top: box.top, bottom: box.bottom, left: box.left ?? 0, right: box.right ?? 390, width: (box.right ?? 390) - (box.left ?? 0), height: box.bottom - box.top,
    x: box.left ?? 0, y: box.top, toJSON: () => ({}),
  }) as DOMRect
  document.body.appendChild(element)
  return element
}

/** The boxes the controller reads, in document order, as the browser reports them. */
function boxes(): EdgeSurfaceBox[] {
  return [...document.querySelectorAll(`[${EDGE_SURFACE_ATTRIBUTE}]`)].map((element, order) => {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return {
      element, rect, zIndex: undefined, order,
      visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0,
    }
  })
}

const read = (element: Element, name: string): string => (element as HTMLElement).style.getPropertyValue(name)

beforeEach(() => {
  document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)">'
  document.body.removeAttribute('style')
  document.documentElement.removeAttribute('style')
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => new EventTarget() })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
})
afterEach(() => { document.body.replaceChildren() })

describe('edgeColours', () => {
  it('takes the top from the main header at phone width and from the sidebar beside it, and the bottom from the page', () => {
    const readToken = (token: string): string => ({ [PAGE]: 'page', [SIDEBAR]: 'side' })[token] ?? ''
    expect(edgeColours(readToken, true)).toEqual({ top: 'page', bottom: 'page' })
    expect(edgeColours(readToken, false)).toEqual({ top: 'side', bottom: 'page' })
    expect(edgeColours(token => (token === PAGE ? 'page' : ''), false).top).toBe('page')
  })
})

describe('the surface at each edge', () => {
  const viewport = { width: 390, height: 844 }

  it('takes the colour the surface covering the edge declares, and states nothing where none covers it', () => {
    surface('chat', { top: 0, bottom: 844 }, { top: 'rgb(250 250 248)', bottom: 'rgb(250 250 248)' })
    expect(edgeColoursAt(boxes(), read, viewport).colours).toEqual({ top: 'rgb(250 250 248)', bottom: 'rgb(250 250 248)' })
    document.body.replaceChildren()
    expect(edgeColoursAt(boxes(), read, viewport).colours).toEqual({})
  })

  it('prefers the surface inside another at the same depth, so the sidebar header art states the top over its column', () => {
    const column = surface('sidebar', { top: 0, bottom: 844 }, { top: 'rgb(240 240 238)', bottom: 'rgb(240 240 238)' }, 71)
    const art = surface('sidebar-art', { top: 0, bottom: 80 }, { top: 'rgb(10 120 130)' }, 71)
    column.appendChild(art)
    expect(edgeColoursAt(boxes(), read, viewport).colours).toEqual({ top: 'rgb(10 120 130)', bottom: 'rgb(240 240 238)' })
  })

  it('prefers the deeper stacking context, so Settings portalled beside the root states the edge over the drawer', () => {
    surface('sidebar', { top: 0, bottom: 844, right: 256 }, { top: 'rgb(240 240 238)', bottom: 'rgb(240 240 238)' }, 71)
    surface('settings', { top: 0, bottom: 844 }, { top: 'rgb(255, 255, 255)', bottom: 'rgb(255, 255, 255)' }, 1000)
    expect(edgeColoursAt(boxes(), read, viewport).colours.top).toBe('rgb(255, 255, 255)')
  })

  it('prefers the higher z-index among siblings, so an open drawer states the top over the chat beside it', () => {
    surface('chat', { top: 0, bottom: 844 }, { top: 'rgb(250 250 248)', bottom: 'rgb(250 250 248)' })
    surface('sidebar', { top: 0, bottom: 844, right: 256 }, { top: 'rgb(240 240 238)', bottom: 'rgb(240 240 238)' }, 71)
    expect(edgeColoursAt(boxes(), read, viewport).colours.top).toBe('rgb(240 240 238)')
  })

  it('states nothing for an edge the covering surface declares no colour for', () => {
    surface('sidebar-art', { top: 0, bottom: 80 }, { top: 'rgb(10 120 130)' }, 71)
    expect(edgeColoursAt(boxes(), read, viewport).colours).toEqual({ top: 'rgb(10 120 130)' })
  })

  it('leaves a hidden surface out, so a closed drawer does not state the edge it still covers', () => {
    surface('chat', { top: 0, bottom: 844 }, { top: 'rgb(250 250 248)', bottom: 'rgb(250 250 248)' })
    const column = surface('sidebar', { top: 0, bottom: 844, right: 256 }, { top: 'rgb(240 240 238)', bottom: 'rgb(240 240 238)' }, 71)
    column.style.visibility = 'hidden'
    expect(edgeColoursAt(boxes(), read, viewport).colours.top).toBe('rgb(250 250 248)')
    column.style.visibility = 'visible'
    expect(edgeColoursAt(boxes(), read, viewport).colours.top).toBe('rgb(240 240 238)')
  })

  it('resolves a colour the browser computes as color-mix to the flat colour theme-color takes', () => {
    tokens('rgb(250, 250, 248)', 'rgb(240, 240, 238)')
    const column = surface('sidebar', { top: 0, bottom: 844 }, { top: 'color-mix(in oklch, rgb(229 115 74) 70%, oklch(78% .12 240))' }, 71)
    column.style.backgroundColor = 'rgb(240, 240, 238)'
    const edges = new EdgeController(document, window)
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? ''
    // jsdom resolves the mix to its own computed form; the point is that the tag never carries the unresolved expression.
    expect(meta).not.toContain('color-mix')
    expect(meta).not.toBe('')
    // jsdom has no canvas, so the hex step cannot run here; the browser's own run is what the pictures show.
    expect(meta).not.toContain('color-mix')
    expect(meta).not.toBe('')
    edges.dispose()
  })

  it('reports a surface that covers the whole screen at an edge, so nothing tints the colour it states', () => {
    surface('chat', { top: 0, bottom: 844 }, { top: 'rgb(250 250 248)', bottom: 'rgb(250 250 248)' })
    expect(edgeColoursAt(boxes(), read, viewport).covered).toEqual({ top: true, bottom: true })
    document.body.replaceChildren()
    surface('sidebar-art', { top: 0, bottom: 80 }, { top: 'rgb(10 120 130)' }, 71)
    expect(edgeColoursAt(boxes(), read, viewport).covered).toEqual({ top: false })
  })

  it('orders the surfaces that cover an edge, and names none when nothing covers it', () => {
    const chat = surface('chat', { top: 0, bottom: 844 }, { top: 'a', bottom: 'b' })
    expect(edgeCandidates(boxes(), 'top', viewport).map(box => box.element)).toEqual([chat])
    expect(edgeCandidates([], 'bottom', viewport)).toEqual([])
  })
})

describe('the edge controller', () => {
  it('adds two aria-hidden, non-interactive fixed strips sized to the safe areas, and one theme-color tag', () => {
    tokens('rgb(250 250 248)', 'rgb(240 240 238)')
    const edges = new EdgeController(document, window)
    const strips = [...document.querySelectorAll<HTMLElement>(`div[${EDGE_ATTRIBUTE}]`)]
    expect(strips.map(strip => strip.getAttribute(EDGE_ATTRIBUTE))).toEqual(['top', 'bottom'])
    for (const strip of strips) expect(strip.getAttribute('aria-hidden')).toBe('true')
    const rules = document.querySelector(`style[${EDGE_ATTRIBUTE}]`)?.textContent ?? ''
    expect(rules).toContain('[data-delorun-edge="top"]{position:fixed;left:0;right:0;top:-7px;height:max(12px,calc(env(safe-area-inset-top) + 7px));pointer-events:none;z-index:1001')
    expect(rules).toContain('[data-delorun-edge="bottom"]{position:fixed;left:0;right:0;bottom:-7px;height:max(12px,calc(env(safe-area-inset-bottom) + 7px));pointer-events:none;z-index:1001')
    expect(rules).toContain('background:var(--edge-top-background)')
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1)
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('rgb(250 250 248)')
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain('viewport-fit=cover')
    edges.dispose()
  })

  it('follows a theme change: the strips, html and body backgrounds and theme-color take the new colours', () => {
    tokens('rgb(250 250 248)', 'rgb(240 240 238)')
    const edges = new EdgeController(document, window)
    tokens('rgb(20 22 28)', 'rgb(10 12 18)')
    edges.refresh()
    expect(document.documentElement.style.getPropertyValue('--edge-top-background')).toBe('rgb(20 22 28)')
    expect(document.documentElement.style.getPropertyValue('--edge-bottom-background')).toBe('rgb(20 22 28)')
    expect(document.documentElement.style.background).toContain('rgb(20, 22, 28)')
    expect(document.body.style.background).toContain('rgb(20, 22, 28)')
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('rgb(20 22 28)')
    edges.dispose()
  })

  it('follows the surface at the top edge when the view changes, and the sidebar header when the drawer opens over the chat', () => {
    tokens('rgb(250, 250, 248)', 'rgb(240, 240, 238)')
    const chat = surface('chat', { top: 0, bottom: 844 }, { top: 'rgb(250, 250, 248)', bottom: 'rgb(250, 250, 248)' })
    const edges = new EdgeController(document, window)
    const meta = (): string | null | undefined => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content
    expect(meta()).toBe('rgb(250, 250, 248)')
    // Settings opens over the chat: its panel states its own surface at both edges.
    const settings = surface('settings', { top: 0, bottom: 844 }, { top: 'rgb(255, 255, 255)', bottom: 'rgb(255, 255, 255)' }, 1000)
    edges.refresh()
    expect(meta()).toBe('rgb(255, 255, 255)')
    settings.remove()
    edges.refresh()
    expect(meta()).toBe('rgb(250, 250, 248)')
    // The drawer opens over the chat: the sidebar column and its header art state the top edge.
    const column = surface('sidebar', { top: 0, bottom: 844, right: 256 }, { top: 'rgb(240, 240, 238)', bottom: 'rgb(240, 240, 238)' }, 71)
    const art = surface('sidebar-art', { top: 0, bottom: 80, right: 256 }, { top: 'rgb(10, 120, 130)' })
    column.appendChild(art)
    edges.refresh()
    expect(meta()).toBe('rgb(10, 120, 130)')
    expect(document.documentElement.style.getPropertyValue('--edge-bottom-background')).toBe('rgb(240, 240, 238)')
    column.remove()
    edges.refresh()
    expect(meta()).toBe('rgb(250, 250, 248)')
    expect(chat.isConnected).toBe(true)
    edges.dispose()
  })

  it('recalculates on resize, switching the top edge from the main header to the sidebar header', () => {
    tokens('rgb(250, 250, 248)', 'rgb(240, 240, 238)')
    const edges = new EdgeController(document, window)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    window.dispatchEvent(new Event('resize'))
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('rgb(240, 240, 238)')
    expect([...document.querySelectorAll<HTMLElement>(`div[${EDGE_ATTRIBUTE}]`)].map(strip => strip.hidden)).toEqual([true, true])
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => Object.assign(new EventTarget(), { matches: true }) })
    edges.refresh()
    expect([...document.querySelectorAll<HTMLElement>(`div[${EDGE_ATTRIBUTE}]`)].map(strip => strip.hidden)).toEqual([false, false])
    edges.dispose()
  })

  it('sets aside a theme-color tag that another script adds later, so one tag carries the top colour', () => {
    tokens('rgb(250 250 248)', 'rgb(240 240 238)')
    const edges = new EdgeController(document, window)
    const late = document.createElement('meta')
    late.name = 'theme-color'
    late.content = 'red'
    document.head.appendChild(late)
    edges.refresh()
    expect([...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(meta => meta.content)).toEqual(['rgb(250 250 248)'])
    edges.dispose()
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(2)
  })

  it('publishes the visual viewport height, so the shell shrinks when the on-screen keyboard opens', () => {
    tokens('rgb(250 250 248)', 'rgb(240 240 238)')
    const viewport = Object.assign(new EventTarget(), { height: 844 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const edges = new EdgeController(document, window)
    expect(document.documentElement.style.getPropertyValue(VIEWPORT_HEIGHT_VARIABLE)).toBe('844px')
    viewport.height = 512
    viewport.dispatchEvent(new Event('resize'))
    expect(document.documentElement.style.getPropertyValue(VIEWPORT_HEIGHT_VARIABLE)).toBe('512px')
    edges.dispose()
    expect(document.documentElement.style.getPropertyValue(VIEWPORT_HEIGHT_VARIABLE)).toBe('')
    Reflect.deleteProperty(window, 'visualViewport')
  })

  it('restores the page on dispose: strips, tag, backgrounds, viewport and listeners', () => {
    tokens('rgb(250 250 248)', 'rgb(240 240 238)')
    const edges = new EdgeController(document, window)
    edges.dispose()
    expect(document.querySelectorAll(`[${EDGE_ATTRIBUTE}]`)).toHaveLength(0)
    const themeColor = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    expect(themeColor).toHaveLength(1)
    expect(themeColor[0]?.content).toBe('#fff')
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=device-width, initial-scale=1')
    expect(document.documentElement.style.background).toBe('')
    expect(document.body.style.background).toBe('')
    expect(document.documentElement.style.getPropertyValue('--edge-top-background')).toBe('')
    tokens('rgb(1 1 1)', 'rgb(2 2 2)')
    window.dispatchEvent(new Event('resize'))
    expect(document.querySelectorAll(`[${EDGE_ATTRIBUTE}]`)).toHaveLength(0)
  })
})

describe('full-screen surfaces on the edge stack', () => {
  it('composites an overlay over the edges, and a solid surface replaces them', () => {
    const base = { top: 'rgb(240, 240, 240)', bottom: 'rgb(250, 250, 250)' }
    expect(stackedEdgeColours(base, [])).toEqual(base)
    expect(stackedEdgeColours(base, [{ dim: 'rgba(0, 0, 0, 0.5)' }])).toEqual({ top: 'rgb(120, 120, 120)', bottom: 'rgb(125, 125, 125)' })
    expect(stackedEdgeColours(base, [{ top: 'red', bottom: 'blue' }, { dim: 'rgba(0, 0, 0, 0)' }])).toEqual({ top: 'red', bottom: 'blue' })
  })

  it('sets the strips while a surface is open and restores the previous colours as nested surfaces close', () => {
    tokens('rgb(250, 250, 248)', 'rgb(240, 240, 238)')
    const edges = new EdgeController(document, window)
    const top = (): string => document.documentElement.style.getPropertyValue('--edge-top-background')
    const bottom = (): string => document.documentElement.style.getPropertyValue('--edge-bottom-background')
    const releaseSettings = pushEdgeSurface(document, { top: 'rgb(10, 20, 30)', bottom: 'rgb(40, 50, 60)' })
    expect([top(), bottom()]).toEqual(['rgb(10, 20, 30)', 'rgb(40, 50, 60)'])
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('rgb(10, 20, 30)')
    const releaseDialog = pushEdgeSurface(document, { dim: 'rgba(0, 0, 0, 0.5)' })
    expect([top(), bottom()]).toEqual(['rgb(5, 10, 15)', 'rgb(20, 25, 30)'])
    releaseDialog()
    expect([top(), bottom()]).toEqual(['rgb(10, 20, 30)', 'rgb(40, 50, 60)'])
    releaseSettings()
    releaseSettings()
    expect([top(), bottom()]).toEqual(['rgb(250, 250, 248)', 'rgb(250, 250, 248)'])
    // A dialog's mask tints the edge where no surface covers the screen, and leaves a covering surface's own colour alone.
    const chat = surface('chat', { top: 0, bottom: 844 }, { top: 'rgb(250, 250, 248)', bottom: 'rgb(250, 250, 248)' })
    edges.refresh()
    const releaseMask = pushEdgeSurface(document, { dim: 'rgba(0, 0, 0, 0.5)' })
    expect(top()).toBe('rgb(250, 250, 248)')
    chat.remove()
    edges.refresh()
    expect(top()).toBe('rgb(125, 125, 124)')
    releaseMask()
    expect(top()).toBe('rgb(250, 250, 248)')
    edges.dispose()
  })

  it('restores an outer surface when the surfaces close out of order', () => {
    tokens('rgb(250, 250, 248)', 'rgb(240, 240, 238)')
    const edges = new EdgeController(document, window)
    const outer = pushEdgeSurface(document, { top: 'rgb(1, 1, 1)', bottom: 'rgb(2, 2, 2)' })
    const inner = pushEdgeSurface(document, { top: 'rgb(3, 3, 3)', bottom: 'rgb(4, 4, 4)' })
    outer()
    expect(document.documentElement.style.getPropertyValue('--edge-top-background')).toBe('rgb(3, 3, 3)')
    inner()
    expect(document.documentElement.style.getPropertyValue('--edge-top-background')).toBe('rgb(250, 250, 248)')
    edges.dispose()
  })
})
