// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Effect, EffectRun } from '../src/home/effects.ts'

type Queue = typeof import('../src/home/effects.ts')

/** An effect whose end the test decides, recording when it started and with what run controls. */
function controlled(name: string, log: string[]): { effect: Effect; finish: () => void; run: () => EffectRun | undefined } {
  let release: () => void = () => undefined
  let seen: EffectRun | undefined
  const effect: Effect = {
    label: `theme → ${name}`,
    done: `✓ ${name}`,
    value: name,
    run: run => {
      seen = run
      log.push(`start ${name}`)
      return new Promise<void>(resolve => { release = () => { log.push(`end ${name}`); resolve() } })
    },
  }
  return { effect, finish: () => { release() }, run: () => seen }
}

/** Lets promise callbacks run. */
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

describe('the effects queue', () => {
  let queue: Queue
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    queue = await import('../src/home/effects.ts')
  })
  afterEach(() => { vi.useRealTimers() })

  it('plays effects one at a time, each to its end, in the order they were asked for, so two never overlap', async () => {
    const log: string[] = []
    const a = controlled('A', log)
    const b = controlled('B', log)
    queue.enqueue(a.effect)
    queue.enqueue(b.effect)
    expect(log).toEqual(['start A'])
    a.finish()
    await settle()
    expect(log).toEqual(['start A', 'end A', 'start B'])
    b.finish()
    await settle()
    expect(log).toEqual(['start A', 'end A', 'start B', 'end B'])
  })

  it('holds at most five, the running one included, and a further request replaces the last waiting effect', async () => {
    const log: string[] = []
    const all = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(name => controlled(name, log))
    for (const each of all) queue.enqueue(each.effect)
    expect(queue.LIMIT).toBe(5)
    // A runs; B, C, D, E wait; F then G each replaced the last waiting one, so only G is left of the late requests.
    expect(queue.lastQueued()?.value).toBe('G')
    const played: string[] = []
    for (let i = 0; i < 8 && log.length > played.length; i++) {
      const name = log[log.length - 1]?.replace('start ', '')
      played.push(name ?? '')
      all.find(each => each.effect.value === name)?.finish()
      await settle()
    }
    expect(log.filter(line => line.startsWith('start')).map(line => line.slice(6))).toEqual(['A', 'B', 'C', 'D', 'G'])
  })

  it('plays faster while effects wait, and its running effect speeds up when more arrive', async () => {
    const log: string[] = []
    const a = controlled('A', log)
    queue.enqueue(a.effect)
    const run = a.run()
    expect(run?.speed()).toBe(1)
    const animation = { playbackRate: 1 } as Animation
    run?.track(animation)
    expect(animation.playbackRate).toBe(1)
    queue.enqueue(controlled('B', log).effect)
    expect(run?.speed()).toBeCloseTo(1.8)
    expect(animation.playbackRate).toBeCloseTo(1.8)
    queue.enqueue(controlled('C', log).effect)
    expect(run?.speed()).toBeCloseTo(2.6)
  })

  it('shows what runs and what waits, then the last result, then goes back to idle', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    function Readout() {
      const { running, waiting, done } = queue.useEffects()
      return createElement('p', null, running === undefined ? done ?? 'idle' : waiting > 0 ? `${running} · ${String(waiting)} queued` : running)
    }
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    await act(async () => { root.render(createElement(Readout)) })
    expect(container.textContent).toBe('idle')
    const log: string[] = []
    const a = controlled('A', log)
    await act(async () => { queue.enqueue(a.effect) })
    expect(container.textContent).toBe('theme → A')
    await act(async () => { queue.enqueue(controlled('B', log).effect) })
    expect(container.textContent).toBe('theme → A · 1 queued')
    await act(async () => { a.finish(); await settle() })
    expect(container.textContent).toBe('theme → B')
    await act(async () => { vi.advanceTimersByTime(10) })
    act(() => root.unmount())
  })

  it('goes on to the next effect when one fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log: string[] = []
    queue.enqueue({ label: 'bad', done: 'bad', value: 'bad', run: () => Promise.reject(new Error('broken')) })
    queue.enqueue(controlled('B', log).effect)
    await settle()
    await settle()
    expect(log).toEqual(['start B'])
    expect(error).toHaveBeenCalled()
  })

  it('shows a note only while no effect runs', () => {
    const log: string[] = []
    queue.note('✓ copied')
    const a = controlled('A', log)
    queue.enqueue(a.effect)
    queue.note('✓ copied again')
    expect(log).toEqual(['start A'])
  })
})
