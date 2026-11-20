// @vitest-environment jsdom
/** The Safari edge controller: strips, one theme-color tag, backgrounds, and a full restore on dispose. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pushEdgeSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import { EDGE_ATTRIBUTE, EdgeController, edgeColours, stackedEdgeColours } from '../src/client/edges.ts'

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
