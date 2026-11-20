// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateKeeper } from '../../src/layout/keep.ts'

let frames: Array<() => void>
const flush = (count = 1): void => {
  for (let i = 0; i < count; i += 1) {
    const due = frames
    frames = []
    for (const run of due) run()
  }
}

beforeEach(() => {
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(() => callback(0)))
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frames = [] })
  Element.prototype.scrollTo = function scrollTo(this: Element, x: number | ScrollToOptions, y?: number): void {
    this.scrollLeft = typeof x === 'number' ? x : x.left ?? 0
    this.scrollTop = typeof x === 'number' ? y ?? 0 : x.top ?? 0
  } as typeof Element.prototype.scrollTo
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function setup() {
  const root = document.createElement('div')
  const scroller = document.createElement('div')
  const input = document.createElement('input')
  root.append(scroller, input)
  document.body.append(root)
  const keeper = new StateKeeper(root)
  const scrollTo = (top: number): void => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event('scroll'))
  }
  return { root, scroller, input, keeper, scrollTo }
}

describe('StateKeeper', () => {
  it('puts back a scroll offset that the layout change reset', () => {
    const { scroller, keeper, scrollTo } = setup()
    scrollTo(120)
    keeper.freeze()
    scroller.scrollTop = 0
    keeper.release()
    flush(3)
    expect(scroller.scrollTop).toBe(120)
  })

  it('records no scrolling while frozen, so a reset during the change is not remembered', () => {
    const { scroller, keeper, scrollTo } = setup()
    scrollTo(80)
    keeper.freeze()
    scrollTo(0)
    keeper.release()
    flush(3)
    expect(scroller.scrollTop).toBe(80)
  })

  it('waits the extra frames it is given before restoring', () => {
    const { scroller, keeper, scrollTo } = setup()
    scrollTo(50)
    keeper.freeze()
    scroller.scrollTop = 0
    keeper.release(2)
    flush(3)
    expect(scroller.scrollTop).toBe(0)
    flush(1)
    expect(scroller.scrollTop).toBe(50)
  })

  it('forgets an element that left the page', () => {
    const { scroller, keeper, scrollTo } = setup()
    scrollTo(70)
    keeper.freeze()
    scroller.remove()
    scroller.scrollTop = 0
    keeper.release()
    flush(3)
    expect(scroller.scrollTop).toBe(0)
  })

  it('gives focus back to the element that held it when the page took it', () => {
    const { input, keeper } = setup()
    input.focus()
    keeper.freeze()
    input.blur()
    keeper.release()
    flush(3)
    expect(document.activeElement).toBe(input)
  })

  it('leaves focus where it went when another element took it', () => {
    const { root, input, keeper } = setup()
    const other = document.createElement('button')
    root.append(other)
    input.focus()
    keeper.freeze()
    other.focus()
    keeper.release()
    flush(3)
    expect(document.activeElement).toBe(other)
  })

  it('cancels a restore that is waiting when a new change starts, and when it is disposed', () => {
    const { scroller, keeper, scrollTo } = setup()
    scrollTo(30)
    keeper.freeze()
    scroller.scrollTop = 0
    keeper.release()
    keeper.freeze()
    expect(frames).toHaveLength(0)
    keeper.release()
    keeper.dispose()
    expect(frames).toHaveLength(0)
    scrollTo(5)
    scroller.scrollTop = 0
    keeper.freeze()
    keeper.release()
    flush(3)
    expect(scroller.scrollTop).toBe(0)
  })
})
