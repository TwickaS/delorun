// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Film } from '../src/home/Film.tsx'
import { MS } from '../src/home/motion.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined

/**
 * Stubs the browser features the film reads.
 * @param reduced - whether the visitor asked for reduced motion.
 */
function browser(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced && query.includes('reduce'), addEventListener: () => undefined, removeEventListener: () => undefined }))
  vi.stubGlobal('IntersectionObserver', class { observe() { return undefined } disconnect() { return undefined } })
  vi.stubGlobal('ResizeObserver', class { observe() { return undefined } disconnect() { return undefined } })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 750 })
  // The section has reached the top of the window, which is when the camera may push in.
  Element.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 750)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** The transform on the active chapter's picture. */
async function transformAfter(ms: number): Promise<string> {
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => { root!.render(createElement(Film, { id: 'film', heading: 'Watch it do one real job' })) })
  await act(async () => { vi.advanceTimersByTime(ms) })
  return container.querySelector<HTMLElement>('[data-active="true"] img')?.style.transform ?? ''
}

describe('the film', () => {
  it('cuts wide and then pushes the camera in on the part that matters', async () => {
    browser(false)
    const wide = await transformAfter(0)
    const pushed = await transformAfter(MS.scene)
    expect(wide).toMatch(/^translate\(/)
    expect(pushed).not.toBe(wide)
  })

  it('stays on the wide shot of each chapter under reduced motion, however long it waits', async () => {
    browser(true)
    const wide = await transformAfter(0)
    expect(wide).toMatch(/^translate\(/)
    const later = document.querySelector<HTMLElement>('[data-active="true"] img')?.style.transform
    await act(async () => { vi.advanceTimersByTime(MS.scene * 4) })
    expect(document.querySelector<HTMLElement>('[data-active="true"] img')?.style.transform).toBe(later)
  })

  it('has one picture per chapter that can be enlarged, and names the chapters for screen readers', async () => {
    browser(true)
    await transformAfter(0)
    const buttons = [...document.querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThanOrEqual(4)
    for (const button of buttons) expect(button.getAttribute('aria-label')).toMatch(/^Enlarge: /)
    expect(document.querySelector('section')?.getAttribute('aria-labelledby')).toBe('film')
  })
})
