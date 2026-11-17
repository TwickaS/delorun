/**
 * The runner's turn for the plugin manager's install: calls run one at a time in the order they came, and a call that is
 * cancelled while it waits leaves the line without letting the next one start early.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { oneAtATime } from '../src/runner.ts'

describe('the install turn', () => {
  it('runs calls one at a time, in the order they came', async () => {
    const turn = oneAtATime()
    const events: string[] = []
    const work = (name: string, ms: number) => async () => {
      events.push(`start ${name}`)
      await sleep(ms)
      events.push(`end ${name}`)
      return name
    }
    const signal = new AbortController().signal
    const results = await Promise.all([turn(signal, work('a', 30)), turn(signal, work('b', 5)), turn(signal, work('c', 5))])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })

  it('lets a call cancelled while it waits leave, and the next still waits for the work before it', async () => {
    const turn = oneAtATime()
    const events: string[] = []
    const first = turn(new AbortController().signal, async () => {
      events.push('start a')
      await sleep(40)
      events.push('end a')
    })
    const cancelled = new AbortController()
    const second = turn(cancelled.signal, async () => { events.push('start b') })
    const third = turn(new AbortController().signal, async () => { events.push('start c') })
    cancelled.abort(new Error('cancelled'))
    await expect(second).rejects.toThrow('cancelled')
    expect(events).toEqual(['start a'])
    await Promise.all([first, third])
    expect(events).toEqual(['start a', 'end a', 'start c'])
  })

  it('refuses a call whose signal is already aborted without running its work', async () => {
    const turn = oneAtATime()
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    let ran = false
    await expect(turn(aborted.signal, async () => { ran = true })).rejects.toThrow('cancelled')
    expect(ran).toBe(false)
  })
})
