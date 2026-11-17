// @vitest-environment jsdom
/**
 * The player's presses: a press is handed to the drawn studio a frame after the timeline reaches it, looks for its control
 * for a short while, and is dropped without a word when its chapter run has ended by then.
 */
import { act, createElement, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESS_RETRY_MS, usePlayer, type Player } from '../src/replica/player.ts'
import { CHAPTER_FILES } from '../src/replica/sessions/index.ts'

const FILE = CHAPTER_FILES['ordinary-work']
/** The chapter whose script presses "Allow once" 4.2 s in, and the one that follows it 0.9 s later. */
const ASKS_FIRST = FILE.chapters.findIndex(chapter => chapter.id === 'asks-first')

/** Animation frames the test releases by hand, so a frame can be as late as a throttled tab makes it. */
let frames: FrameRequestCallback[] = []
const releaseFrames = (): void => {
  const due = frames
  frames = []
  for (const run of due) run(performance.now())
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined

beforeEach(() => {
  vi.useFakeTimers()
  frames = []
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => { frames.push(run); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
  vi.stubGlobal('IntersectionObserver', class {
    readonly #callback: (entries: readonly { isIntersecting: boolean }[]) => void
    constructor(callback: (entries: readonly { isIntersecting: boolean }[]) => void) { this.#callback = callback }
    observe(): void { this.#callback([{ isIntersecting: true }]) }
    disconnect(): void {}
  })
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Plays the "asks first" chapter until its press is queued, with the frame that would run it still unreleased. */
function playToThePress(press: (target: unknown) => Promise<boolean>): { readonly player: () => Player; readonly unmount: () => void } {
  const frame: RefObject<Element | null> = { current: document.createElement('div') }
  let latest: Player | undefined
  const Probe = () => { latest = usePlayer({ file: FILE, ready: true, frame, press: press as never, opening: ASKS_FIRST }); return null }
  root = createRoot(document.createElement('div'))
  act(() => { root?.render(createElement(Probe)) })
  act(() => { vi.advanceTimersByTime(4300) })
  return { player: () => latest!, unmount: () => { act(() => { root?.unmount() }); root = undefined } }
}

describe('the player\'s presses', () => {
  it('drops a press quietly when its chapter has changed before the queued frame runs', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const press = vi.fn(async () => false)
    const hook = playToThePress(press)
    expect(hook.player().chapter).toBe(ASKS_FIRST)
    // The frame is slow: the next chapter starts before it runs.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(hook.player().chapter).toBe(ASKS_FIRST + 1)
    await act(async () => { releaseFrames(); await vi.advanceTimersByTimeAsync(500); releaseFrames(); await vi.advanceTimersByTimeAsync(500) })
    expect(press).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('looks again each frame until the control is drawn, within its own chapter run', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const answers = [false, false, true]
    const press = vi.fn(async () => answers.shift() ?? true)
    playToThePress(press)
    for (let frame = 0; frame < 6; frame++) await act(async () => { releaseFrames(); await vi.advanceTimersByTimeAsync(20) })
    expect(press).toHaveBeenCalledTimes(3)
    expect(report).not.toHaveBeenCalled()
  })

  it('stops a press that is retrying when the player unmounts: no press and no report afterwards', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const press = vi.fn(async () => false)
    const hook = playToThePress(press)
    // One frame runs, the control is not there yet, and the next look is queued.
    for (let frame = 0; frame < 6 && press.mock.calls.length === 0; frame++) await act(async () => { releaseFrames(); await vi.advanceTimersByTimeAsync(20) })
    const looked = press.mock.calls.length
    expect(looked).toBeGreaterThan(0)
    hook.unmount()
    for (let frame = 0; frame < 30; frame++) await act(async () => { releaseFrames(); await vi.advanceTimersByTimeAsync(20) })
    expect(press).toHaveBeenCalledTimes(looked)
    expect(report).not.toHaveBeenCalled()
  })

  it('holds every press in both sessions longer than the time it looks for its control', () => {
    for (const file of Object.values(CHAPTER_FILES)) {
      const holds = file.chapters.flatMap(chapter => chapter.steps.filter(step => step.kind === 'press').map(step => step.hold))
      expect(holds.length).toBeGreaterThan(0)
      for (const hold of holds) expect(hold, file.session).toBeGreaterThanOrEqual(PRESS_RETRY_MS)
    }
  })

  it('reports a control that never appears in its own chapter run, once, after the retry window', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const press = vi.fn(async () => false)
    playToThePress(press)
    for (let frame = 0; frame < 30; frame++) await act(async () => { releaseFrames(); await vi.advanceTimersByTimeAsync(20) })
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(expect.stringContaining('no control "allowOnce"'))
  })
})
