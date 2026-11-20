// @vitest-environment jsdom
/** The edge surface stack: ordering, release, and the colour maths. */
import { describe, expect, it, vi } from 'vitest'
import { compositeOver, edgeSurfaceOf, edgeSurfaces, pushEdgeSurface, subscribeEdgeSurfaces } from '../src/edge-surface.ts'

describe('the edge surface stack', () => {
  it('keeps the earliest opened first, releases one entry once and tells subscribers', () => {
    const listener = vi.fn()
    const stop = subscribeEdgeSurfaces(document, listener)
    const first = pushEdgeSurface(document, { top: 'a', bottom: 'b' })
    const second = pushEdgeSurface(document, { dim: 'rgba(0, 0, 0, 0.4)' })
    expect(edgeSurfaces(document)).toEqual([{ top: 'a', bottom: 'b' }, { dim: 'rgba(0, 0, 0, 0.4)' }])
    first()
    first()
    expect(edgeSurfaces(document)).toEqual([{ dim: 'rgba(0, 0, 0, 0.4)' }])
    second()
    stop()
    expect(edgeSurfaces(document)).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)
  })
})

describe('compositeOver', () => {
  it('blends an overlay with its alpha over an opaque colour', () => {
    expect(compositeOver('rgba(0, 0, 0, 0.5)', 'rgb(200, 100, 50)')).toBe('rgb(100, 50, 25)')
    expect(compositeOver('rgb(0 0 0 / 50%)', 'rgb(200 100 50)')).toBe('rgb(100, 50, 25)')
    expect(compositeOver('rgb(9, 9, 9)', 'rgb(200, 100, 50)')).toBe('rgb(9, 9, 9)')
  })

  it('returns the base for a colour syntax it cannot read', () => {
    expect(compositeOver('color(srgb 0 0 0 / 0.5)', 'rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)')
  })
})

describe('edgeSurfaceOf', () => {
  const rect = (width: number, height: number, top = 0) => ({ width, height, top, bottom: top + height }) as DOMRect
  const element = (background: string, size: DOMRect): HTMLElement => {
    const node = document.createElement('div')
    node.getBoundingClientRect = () => size
    node.style.background = background
    document.body.appendChild(node)
    return node
  }

  it('takes the background of a surface that fills an opaque viewport, and the mask for a card', () => {
    document.body.style.setProperty('--dsw-alias-bg-mask-1', '#0000004d')
    const win = { innerWidth: 390, innerHeight: 800, getComputedStyle: window.getComputedStyle.bind(window) }
    expect(edgeSurfaceOf(element('rgb(10, 20, 30)', rect(390, 800)), win)).toEqual({ top: 'rgb(10, 20, 30)', bottom: 'rgb(10, 20, 30)' })
    expect(edgeSurfaceOf(element('rgb(10, 20, 30)', rect(390, 792, 4)), win)).toEqual({ top: 'rgb(10, 20, 30)', bottom: 'rgb(10, 20, 30)' })
    expect(edgeSurfaceOf(element('rgb(10, 20, 30)', rect(380, 300)), win)).toEqual({ dim: expect.stringMatching(/^rgba\(0, 0, 0, 0\.3/) })
    expect(edgeSurfaceOf(element('rgb(10, 20, 30)', rect(300, 800)), win, true)).toEqual({ top: 'rgb(10, 20, 30)', bottom: 'rgb(10, 20, 30)' })
    document.body.style.removeProperty('--dsw-alias-bg-mask-1')
    expect(edgeSurfaceOf(element('rgb(10, 20, 30)', rect(380, 300)), win)).toBeUndefined()
  })
})
