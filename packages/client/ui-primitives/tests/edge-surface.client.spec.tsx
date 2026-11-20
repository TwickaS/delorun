// @vitest-environment jsdom
/** The edge surface stack: ordering, release, and the colour maths. */
import { describe, expect, it, vi } from 'vitest'
import { compositeOver, edgeSurfaces, pushEdgeSurface, subscribeEdgeSurfaces } from '../src/edge-surface.ts'

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
