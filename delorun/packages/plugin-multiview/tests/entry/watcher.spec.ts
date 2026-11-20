import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { HandOffWatcher } from '../../src/entry/watcher.ts'

const id = (value: string): SessionId => value as SessionId
const entries = (...ids: string[]) => ids.map(value => ({ id: id(value) }))

describe('HandOffWatcher', () => {
  it('reports nothing while no chat is shown or its catalog is unread', () => {
    const watcher = new HandOffWatcher()
    expect(watcher.observe(undefined, undefined)).toEqual([])
    expect(watcher.observe(id('chat'), undefined)).toEqual([])
  })

  it('treats the agents present when the chat opened as the baseline and reports only later ones', () => {
    const watcher = new HandOffWatcher()
    expect(watcher.observe(id('chat'), entries('old-1', 'old-2'))).toEqual([])
    expect(watcher.observe(id('chat'), entries('old-1', 'old-2'))).toEqual([])
    expect(watcher.observe(id('chat'), entries('old-1', 'old-2', 'new'))).toEqual([id('new')])
  })

  it('reports each new agent once', () => {
    const watcher = new HandOffWatcher()
    watcher.observe(id('chat'), entries())
    expect(watcher.observe(id('chat'), entries('a'))).toEqual([id('a')])
    expect(watcher.observe(id('chat'), entries('a'))).toEqual([])
    expect(watcher.observe(id('chat'), entries('a', 'b', 'c'))).toEqual([id('b'), id('c')])
  })

  it('takes a catalog that was read late as the baseline, not as hand-offs', () => {
    const watcher = new HandOffWatcher()
    watcher.observe(id('chat'), undefined)
    expect(watcher.observe(id('chat'), entries('existing'))).toEqual([])
  })

  it('starts a new baseline each time another chat becomes the main view', () => {
    const watcher = new HandOffWatcher()
    watcher.observe(id('one'), entries('a'))
    watcher.observe(id('two'), entries('x'))
    // Back in the first chat, agents it gained meanwhile were present when it opened again.
    expect(watcher.observe(id('one'), entries('a', 'gained'))).toEqual([])
    expect(watcher.observe(id('one'), entries('a', 'gained', 'fresh'))).toEqual([id('fresh')])
  })
})
