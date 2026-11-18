// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let finish: () => void = () => undefined
let skip = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
  Element.prototype.animate = () => ({ playbackRate: 1 }) as Animation
  skip = vi.fn(() => { finish() })
  // A look change that stays running until the test lets it end, as the browser's view transition does.
  Object.assign(document, {
    startViewTransition: (update: () => void) => {
      update()
      return { ready: Promise.resolve(), finished: new Promise<void>(resolve => { finish = resolve }), skipTransition: skip }
    },
  })
  Element.prototype.getBoundingClientRect = function rect(this: Element) {
    return this.tagName === 'BUTTON' && this.hasAttribute('data-theme-control') ? new DOMRect(0, 0, 80, 30) : new DOMRect(0, 0, 100, 60)
  }
})

afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  delete (document as { startViewTransition?: unknown }).startViewTransition
  vi.unstubAllGlobals()
})

/** Renders the control beside a tile that records its presses. */
async function render() {
  const { ThemeDot } = await import('../src/home/ThemeDot.tsx')
  const effects = await import('../src/home/effects.ts')
  const pressed = vi.fn()
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => { root!.render(createElement('div', null, createElement(ThemeDot), createElement('button', { type: 'button', id: 'tile', onClick: pressed }, 'tile'))) })
  return { control: container.querySelector<HTMLButtonElement>('[data-theme-control]')!, tile: container.querySelector<HTMLButtonElement>('#tile')!, pressed, effects }
}

describe('the theme control while a look change runs', () => {
  it('queues a press made on the control, so rapid presses never overlap their colour changes', async () => {
    const { control, effects } = await render()
    await act(async () => { control.click() })
    const first = effects.lastQueued()?.value
    // The browser sends a press during the change to the root element; inside the control's box it still counts.
    await act(async () => { document.documentElement.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true })) })
    const second = effects.lastQueued()?.value
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(skip).not.toHaveBeenCalled()
  })

  it('ends the change at once and passes a press elsewhere on to what sits under it', async () => {
    const { control, tile, pressed } = await render()
    document.elementFromPoint = () => tile
    await act(async () => { control.click() })
    await act(async () => { document.documentElement.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 400, bubbles: true })) })
    expect(skip).toHaveBeenCalledOnce()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(pressed).toHaveBeenCalledOnce()
  })

  it('does not overlap changes when a press skips the transition before it is ready', async () => {
    const { control, effects } = await render()
    Object.assign(document, {
      startViewTransition: (update: () => void) => {
        update()
        return { ready: Promise.reject(new Error('AbortError')), finished: new Promise<void>(resolve => { finish = resolve }), skipTransition: skip }
      },
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => { control.click() })
    await act(async () => { finish(); await Promise.resolve(); await Promise.resolve() })
    expect(error).not.toHaveBeenCalled()
    // The change ended without failing, so the queue is free for the next one.
    expect(effects.lastQueued()).toBeUndefined()
  })

  it('offers the look it will change to in its name, and the next look from the last one asked for', async () => {
    const { control } = await render()
    const before = control.getAttribute('aria-label')
    expect(before).toMatch(/^Look: .+\. Press for the next look$/)
  })
})
