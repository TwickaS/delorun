// @vitest-environment jsdom
/**
 * The real replica frame when its live part fails: the chunk fails to load (a dropped connection, or a tab left open
 * across a deploy), or the live replica throws while rendering. In both the server's still and its caption stay, and so
 * does the rest of the page.
 */
import { act, type ComponentType } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAPTER_FILES } from '../src/replica/sessions/index.ts'
import type { ReplicaLiveProps } from '../src/replica/ReplicaLive.tsx'

// How the live part fails in the current test; read when the frame imports it.
let failure: 'load' | 'render' = 'load'
vi.mock('../src/replica/ReplicaLive.tsx', async (importOriginal) => {
  if (failure === 'load') throw new Error('chunk failed to load')
  return { ...await importOriginal<object>(), ReplicaLive: () => { throw new Error('render failed') } }
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let report: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
  vi.stubGlobal('IntersectionObserver', class {
    readonly #callback: (entries: readonly { isIntersecting: boolean }[]) => void
    constructor(callback: (entries: readonly { isIntersecting: boolean }[]) => void) { this.#callback = callback }
    observe(): void { queueMicrotask(() => { this.#callback([{ isIntersecting: true }]) }) }
    disconnect(): void {}
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Put the hero's server markup in the document, hydrate the real frame over it, and let its chunk settle.
 * @returns the page's container.
 */
async function hero(): Promise<HTMLElement> {
  const actual = await vi.importActual<{ ReplicaLive: ComponentType<ReplicaLiveProps> }>('../src/replica/ReplicaLive.tsx')
  const { ReplicaFrame } = await import('../src/replica/ReplicaFrame.tsx')
  const container = document.body.appendChild(document.createElement('main'))
  container.innerHTML = `<h1>Your harness. No limits.</h1><div>${renderToString(<actual.ReplicaLive session="ordinary-work" width="responsive" />)}</div>`
  await act(async () => {
    root = hydrateRoot(container, <><h1>Your harness. No limits.</h1><ReplicaFrame session="ordinary-work" width="responsive" /></>)
  })
  for (let tick = 0; tick < 10; tick++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  return container
}

/**
 * Check that the page and the frame's still with its caption are there.
 * @param container - the page's container.
 */
function expectStillAndPage(container: HTMLElement): void {
  expect(container.querySelector('h1')?.textContent).toBe('Your harness. No limits.')
  expect(container.querySelector('figure[aria-label]')).not.toBeNull()
  expect(container.querySelector('[data-replica-still]')).not.toBeNull()
  expect(container.textContent).toContain(CHAPTER_FILES['ordinary-work'].chapters[0]!.caption)
}

describe('the replica frame when its live part fails', () => {
  it('keeps the server\'s still and caption, and the page, when the chunk fails to load', async () => {
    failure = 'load'
    const container = await hero()
    expectStillAndPage(container)
    expect(report).toHaveBeenCalledWith('The studio replay did not load.', expect.any(Error))
  })

  it('puts the server\'s still and caption back, and keeps the page, when the live replica throws', async () => {
    failure = 'render'
    const container = await hero()
    expectStillAndPage(container)
    expect(report).toHaveBeenCalledWith('A part of the page did not load.', expect.any(Error), expect.any(String))
  })
})
