/** The home process's signal listener over this process's `SIGTERM` and `SIGINT` (`src/signals.ts`). */
import { describe, expect, it } from 'vitest'
import { listenProcessSignals, SIGNAL_EXIT_CODES, type HomeSignal } from '../src/index.ts'

describe('listenProcessSignals', () => {
  it('passes SIGTERM and SIGINT to the listener until it is disposed', () => {
    const before = { SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT') }
    const seen: HomeSignal[] = []
    const dispose = listenProcessSignals((signal) => { seen.push(signal) })
    expect({ SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT') }).toEqual({ SIGTERM: before.SIGTERM + 1, SIGINT: before.SIGINT + 1 })
    process.emit('SIGTERM', 'SIGTERM')
    process.emit('SIGINT', 'SIGINT')
    dispose()
    expect(seen).toEqual(['SIGTERM', 'SIGINT'])
    expect({ SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT') }).toEqual(before)
  })

  it('ends the process with upstream\'s codes: 0 for SIGTERM and 130 for SIGINT', () => {
    expect(SIGNAL_EXIT_CODES).toEqual({ SIGTERM: 0, SIGINT: 130 })
  })
})
