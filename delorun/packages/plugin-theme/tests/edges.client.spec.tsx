// @vitest-environment jsdom
/** The Safari edge controller: strips, one theme-color tag, backgrounds, and a full restore on dispose. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EDGE_ATTRIBUTE, EdgeController, edgeColours } from '../src/client/edges.ts'

const PAGE = '--dsw-alias-bg-base'
const SIDEBAR = '--dsw-specific-sidebar-fill'

function tokens(page: string, sidebar: string): void {
  document.body.style.setProperty(PAGE, page)
  document.body.style.setProperty(SIDEBAR, sidebar)
}

beforeEach(() => {
  document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)">'
  document.body.removeAttribute('style')
  document.documentElement.removeAttribute('style')
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => new EventTarget() })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
})
afterEach(() => { document.body.replaceChildren() })

describe('edgeColours', () => {
  it('takes the top from the main header at phone width and from the sidebar beside it, and the bottom from the page', () => {
    const read = (token: string): string => ({ [PAGE]: 'page', [SIDEBAR]: 'side' })[token] ?? ''
    expect(edgeColours(read, true)).toEqual({ top: 'page', bottom: 'page' })
    expect(edgeColours(read, false)).toEqual({ top: 'side', bottom: 'page' })
    expect(edgeColours(token => (token === PAGE ? 'page' : ''), false).top).toBe('page')
  })
})

describe('the edge controller', () => {
  it('lets the body paint only where the top and bottom colours differ, so the strips stay visible', () => {
    tokens('rgb(250 250 248)', 'rgb(240 240 238)')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    const edges = new EdgeController(document, window)
    expect(document.documentElement.style.background).toContain('rgb(240, 240, 238)')
    expect(document.body.style.background).toContain('rgb(250, 250, 248)')
    edges.dispose()
  })

  it('adds two aria-hidden, non-interactive fixed strips sized to the safe areas, and one theme-color tag', () => {
    tokens('rgb(250 250 248)', 'rgb(240 240 238)')
    const edges = new EdgeController(document, window)
    const strips = [...document.querySelectorAll<HTMLElement>(`div[${EDGE_ATTRIBUTE}]`)]
    expect(strips.map(strip => strip.getAttribute(EDGE_ATTRIBUTE))).toEqual(['top', 'bottom'])
    for (const strip of strips) expect(strip.getAttribute('aria-hidden')).toBe('true')
    const rules = document.querySelector(`style[${EDGE_ATTRIBUTE}]`)?.textContent ?? ''
    expect(rules).toContain('[data-delorun-edge="top"]{position:fixed;left:0;right:0;top:0;height:max(12px,env(safe-area-inset-top));pointer-events:none')
    expect(rules).toContain('[data-delorun-edge="bottom"]{position:fixed;left:0;right:0;bottom:0;height:max(12px,env(safe-area-inset-bottom));pointer-events:none')
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
    expect(document.body.style.background).toBe('')
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('rgb(20 22 28)')
    edges.dispose()
  })

  it('recalculates on resize, switching the top edge from the main header to the sidebar header', () => {
    tokens('rgb(250 250 248)', 'rgb(240 240 238)')
    const edges = new EdgeController(document, window)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    window.dispatchEvent(new Event('resize'))
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('rgb(240 240 238)')
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

  it('restores the page on dispose: strips, tag, backgrounds, padding, viewport and listeners', () => {
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
    expect(document.body.style.padding).toBe('')
    expect(document.documentElement.style.getPropertyValue('--edge-top-background')).toBe('')
    tokens('rgb(1 1 1)', 'rgb(2 2 2)')
    window.dispatchEvent(new Event('resize'))
    expect(document.querySelectorAll(`[${EDGE_ATTRIBUTE}]`)).toHaveLength(0)
  })
})
