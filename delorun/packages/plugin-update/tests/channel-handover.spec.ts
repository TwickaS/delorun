/**
 * The update channel's hand-over: the first one wins, a second is refused, and taking it back clears it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { UpdateChannelAccess } from '@delorun/home-process'
import { handUpdateChannel, heldUpdateChannel } from '../src/channel-handover.ts'

const channel: UpdateChannelAccess = { send: () => Promise.resolve([]) }
const other: UpdateChannelAccess = { send: () => Promise.resolve([]) }
const release: (() => void)[] = []

afterEach(() => {
  for (const off of release.splice(0)) off()
})

describe('the update channel hand-over', () => {
  it('holds nothing until the Host hands one over, and takes it back on teardown', () => {
    expect(heldUpdateChannel()).toBeUndefined()
    const off = handUpdateChannel(channel)
    expect(heldUpdateChannel()).toBe(channel)
    off()
    expect(heldUpdateChannel()).toBeUndefined()
  })

  it('refuses a second hand-over, so a later plugin cannot replace the Host\'s channel', () => {
    release.push(handUpdateChannel(channel))
    expect(() => handUpdateChannel(other)).toThrow('already handed')
    expect(heldUpdateChannel()).toBe(channel)
  })
})
