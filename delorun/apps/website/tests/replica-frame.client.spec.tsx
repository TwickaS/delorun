// @vitest-environment jsdom
/**
 * The replica as the page places it: what the server sends (the still, the rail, the first caption, the captions for
 * scripts off), the rail as a tab list whose choice changes the announced caption, the drawn studio inert, stills under
 * reduced motion, and every press a chapter script names finding its control in the real sections.
 */
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_IDS, stateAt, stepLength, type ChapterFile } from '../src/replica/model.ts'
import { ReplicaFrame } from '../src/replica/ReplicaFrame.tsx'
import { CHAPTER_FILES } from '../src/replica/sessions/index.ts'
import { ReplicaLive } from '../src/replica/ReplicaLive.tsx'
import Studio, { type StudioHandle } from '../src/replica/ReplicaStudio.tsx'

// The site renders with React 19; this spec mounts through `react-dom/client` itself so no other React copy renders.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let reduced = false
const mounted: Root[] = []

/**
 * Mount an element in a fresh container.
 * @param element - the element.
 * @returns the container and a way to draw it again.
 */
function mount(element: ReactNode): { readonly container: HTMLElement, readonly rerender: (next: ReactNode) => void } {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  mounted.push(root)
  act(() => { root.render(element) })
  return { container, rerender: (next) => { act(() => { root.render(next) }) } }
}

/**
 * Wait until a check stops throwing.
 * @param check - the check.
 * @param timeout - how long to try, in milliseconds.
 */
async function until(check: () => unknown, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout
  for (;;) {
    try {
      await act(async () => { await check() })
      return
    } catch (error) {
      if (Date.now() > end) throw error
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    }
  }
}

/**
 * The rail's tabs.
 * @param container - the replica's container.
 * @returns the tabs, in order.
 */
const tabsIn = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')]

/**
 * The replica's buttons named by their text.
 * @param container - the replica's container.
 * @param name - the text.
 * @returns the buttons.
 */
const buttonsNamed = (container: HTMLElement, name: string): HTMLButtonElement[] => [...container.querySelectorAll('button')].filter(button => button.textContent?.trim() === name)

beforeEach(() => {
  reduced = false
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion') ? reduced : query.includes('min-width'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  // Every observed element is on screen at once.
  vi.stubGlobal('IntersectionObserver', class {
    readonly #callback: (entries: readonly { isIntersecting: boolean }[]) => void
    constructor(callback: (entries: readonly { isIntersecting: boolean }[]) => void) { this.#callback = callback }
    observe(): void { queueMicrotask(() => { this.#callback([{ isIntersecting: true }]) }) }
    disconnect(): void {}
  })
})

afterEach(() => {
  for (const root of mounted.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('ReplicaFrame', () => {
  it('sends the still, the rail, the first caption and every caption for scripts off, and no live studio', () => {
    // The server's `ReplicaFrame` writes exactly this render as its markup (`virtual:replica-island`).
    const html = renderToString(<ReplicaLive session="ordinary-work" width="responsive" />)
    const file = CHAPTER_FILES['ordinary-work']
    expect(html).toContain('role="tablist"')
    for (const chapter of file.chapters) expect(html).toContain(chapter.title)
    expect(html).toContain('<noscript>')
    expect(html.match(/inert/g)).toBeNull()
  })

  it('draws the studio inert and announces the chapter the visitor picks on the rail', async () => {
    const file = CHAPTER_FILES['changes-and-versions']
    const { container } = mount(<ReplicaFrame session="changes-and-versions" width="desktop" />)
    await until(() => { expect(container.querySelector('.studio-replica[inert]')).not.toBeNull() }, 15_000)
    const tabs = tabsIn(container)
    expect(tabs.map(tab => tab.textContent)).toEqual(file.chapters.map(chapter => chapter.title))
    act(() => { tabs[2]!.click() })
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(file.chapters[2]!.caption)
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true')
    expect(buttonsNamed(container, 'Pause')).toHaveLength(1)
  })

  it('shows each chapter as a still under reduced motion, with no pause', async () => {
    reduced = true
    const file = CHAPTER_FILES['ordinary-work']
    const { container } = mount(<ReplicaFrame session="ordinary-work" width="desktop" />)
    await until(() => { expect(container.querySelector('.studio-replica[inert]')).not.toBeNull() }, 15_000)
    expect(buttonsNamed(container, 'Pause')).toHaveLength(0)
    act(() => { tabsIn(container).at(-1)!.click() })
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(file.chapters.at(-1)!.caption)
  })
})

/**
 * The time a step starts within its chapter.
 * @param file - the chapters.
 * @param chapter - the chapter's index.
 * @param step - the step's index.
 * @returns milliseconds from the chapter's start.
 */
function stepStart(file: ChapterFile, chapter: number, step: number): number {
  return file.chapters[chapter]!.steps.slice(0, step).reduce((total, each) => total + stepLength(each), 0)
}

describe('the chapter scripts', () => {
  for (const session of SESSION_IDS) {
    const file = CHAPTER_FILES[session]
    for (const [index, chapter] of file.chapters.entries()) {
      const presses = stateAt(file, index, Number.POSITIVE_INFINITY).presses
      if (presses.length === 0) continue
      it(`${session} / ${chapter.id}: every press finds its control`, async () => {
        const handle = createRef<StudioHandle>()
        const ready = vi.fn()
        const draw = (at: number) => <Studio file={file} width="desktop" state={stateAt(file, index, at).state} epoch={index} handle={handle} onReady={ready} />
        const view = mount(draw(0))
        await until(() => { expect(ready).toHaveBeenCalled() }, 15_000)
        for (const press of presses) {
          view.rerender(draw(stepStart(file, index, press.step)))
          await until(async () => { expect(await handle.current?.press(press.target)).toBe(true) })
        }
      })
    }
  }
})
