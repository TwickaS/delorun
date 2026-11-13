import { MutableSessionEventSource, type SessionEventLikeEntry, type SessionEventSource, type SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm/message'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { ReadingFeed, readingWords, type FrameScheduler } from '../src/client/feed.ts'
import type { ReadingPage } from '../src/client/types.ts'

const ATTEMPT = LlmAttemptId('attempt-1')

let seq = 0

function live(chunk: StreamChunk, turn = 1, step = 1, attemptId = ATTEMPT): SessionEventLikeEntry {
  seq += 1
  return { type: 'transient', event: { type: 'assistant/live-chunk', seq, time: seq, data: { attemptId, turn, step, chunk } } }
}

// A settled message whose stream spells the given blocks, as the durable log records them.
function settled(blocks: readonly ContentBlock[], turn = 1, step = 1): Extract<SessionEventLikeEntry, { type: 'event' }> & { readonly event: { readonly type: 'assistant/message' } } {
  seq += 1
  const chunks: StreamChunk[] = blocks.flatMap((block, index): StreamChunk[] => {
    if (block.type === 'reasoning') return [{ type: 'block-start', index, blockType: 'reasoning' }, { type: 'reasoning-delta', index, text: block.text }, { type: 'block-end', index, block }]
    if (block.type === 'text') return [{ type: 'block-start', index, blockType: 'text' }, { type: 'text-delta', index, text: block.text }, { type: 'block-end', index, block }]
    return []
  })
  return {
    type: 'event',
    event: {
      type: 'assistant/message', seq: SessionSeq(seq), time: seq,
      data: { turn, step, message: createAssistantMessage({ content: [...blocks], source: { provider: 'mock', model: 'mock' } }), stream: chunks.map(chunk => ({ type: 'chunk', time: seq, chunk })) },
      surfaceOp: 'append',
    },
  }
}

const reasoning = (text: string): ContentBlock => ({ type: 'reasoning', text })
const reply = (text: string): ContentBlock => ({ type: 'text', text })

// Frames that run only when the spec flushes them.
function manualFrames(): FrameScheduler & { flush(): void; readonly pending: number } {
  const queue = new Map<number, () => void>()
  let next = 0
  return {
    request: (callback) => { next += 1; queue.set(next, callback); return next },
    cancel: (handle) => { queue.delete(handle) },
    flush: () => {
      const callbacks = [...queue.values()]
      queue.clear()
      for (const callback of callbacks) callback()
    },
    get pending() { return queue.size },
  }
}

function setup(clock = () => 1_000) {
  const source = new MutableSessionEventSource()
  const frames = manualFrames()
  const feed = new ReadingFeed(source, frames, clock)
  const pages: ReadingPage[] = []
  const unsubscribe = feed.subscribe(() => { pages.push(feed.getSnapshot()) })
  return { source, frames, feed, pages, unsubscribe }
}

const texts = (page: ReadingPage): string[] => readingWords(page, 'both').map(word => word.text)

describe('the reading feed', () => {
  it('holds an empty, complete page before the Session has any reasoning or reply', () => {
    const { feed } = setup()
    expect(feed.getSnapshot()).toEqual({ turn: undefined, parts: [], complete: true })
  })

  it('reads a streaming block’s complete words as chunks arrive, keeping each earlier word’s object', () => {
    let now = 5_000
    const { source, frames, feed } = setup(() => now)
    source.append(live({ type: 'block-start', index: 0, blockType: 'reasoning' }))
    source.append(live({ type: 'reasoning-delta', index: 0, text: 'Let me th' }))
    frames.flush()
    const first = feed.getSnapshot()
    expect(first).toMatchObject({ turn: 1, complete: false, parts: [{ key: '1:1:0', kind: 'reasoning', text: 'Let me th', streaming: true }] })
    expect(texts(first)).toEqual(['Let', 'me'])
    now = 5_400
    source.append(live({ type: 'reasoning-delta', index: 0, text: 'ink it over.' }))
    frames.flush()
    const second = feed.getSnapshot()
    expect(texts(second)).toEqual(['Let', 'me', 'think', 'it'])
    expect(second.parts[0]?.words[0]).toBe(first.parts[0]?.words[0])
    expect(second.parts[0]?.words.map(word => word.readyAt)).toEqual([5_000, 5_000, 5_400, 5_400])
    source.append(live({ type: 'block-end', index: 0, block: reasoning('Let me think it over.') }))
    frames.flush()
    expect(texts(feed.getSnapshot())).toEqual(['Let', 'me', 'think', 'it', 'over.'])
    expect(feed.getSnapshot().complete).toBe(true)
  })

  it('reads the reasoning and the reply as parts in stream order, and skips tool calls', () => {
    const { source, frames, feed } = setup()
    source.append(live({ type: 'block-start', index: 0, blockType: 'reasoning' }))
    source.append(live({ type: 'reasoning-delta', index: 0, text: 'Check it ' }))
    source.append(live({ type: 'block-start', index: 1, blockType: 'text' }))
    source.append(live({ type: 'text-delta', index: 1, text: 'Done here ' }))
    source.append(live({ type: 'block-start', index: 2, blockType: 'tool-call' }))
    frames.flush()
    const page = feed.getSnapshot()
    expect(page.parts.map(part => [part.key, part.kind])).toEqual([['1:1:0', 'reasoning'], ['1:1:1', 'reply']])
    expect(readingWords(page, 'reasoning').map(word => word.text)).toEqual(['Check', 'it'])
    expect(readingWords(page, 'reply').map(word => word.text)).toEqual(['Done', 'here'])
  })

  it('publishes at most once a frame however many chunks arrive', () => {
    const { source, frames, pages } = setup()
    expect(pages).toHaveLength(0)
    source.append(live({ type: 'block-start', index: 0, blockType: 'text' }))
    source.append(live({ type: 'text-delta', index: 0, text: 'one ' }))
    source.append(live({ type: 'text-delta', index: 0, text: 'two ' }))
    expect(frames.pending).toBe(1)
    frames.flush()
    expect(pages).toHaveLength(1)
    frames.flush()
    expect(pages).toHaveLength(1)
  })

  it('keeps a settled block that confirms what streamed, with its words and their times', () => {
    const { source, frames, feed } = setup(() => 7_000)
    source.append(live({ type: 'block-start', index: 0, blockType: 'text' }))
    source.append(live({ type: 'text-delta', index: 0, text: 'All good so' }))
    frames.flush()
    const streamed = feed.getSnapshot().parts[0]?.words
    source.settleAssistant(ATTEMPT, settled([reply('All good so far.')]))
    frames.flush()
    const page = feed.getSnapshot()
    expect(page).toMatchObject({ complete: true, parts: [{ key: '1:1:0', text: 'All good so far.', streaming: false }] })
    expect(page.parts[0]?.words.slice(0, 2)).toEqual(streamed)
    expect(page.parts[0]?.words.map(word => [word.text, word.readyAt])).toEqual([['All', 7_000], ['good', 7_000], ['so', 0], ['far.', 0]])
  })

  it('replaces a block the settlement contradicts in place, keeping its position', () => {
    const { source, frames, feed } = setup()
    source.append(live({ type: 'block-start', index: 0, blockType: 'reasoning' }))
    source.append(live({ type: 'reasoning-delta', index: 0, text: 'first draft ' }))
    source.append(live({ type: 'block-start', index: 1, blockType: 'text' }))
    source.append(live({ type: 'text-delta', index: 1, text: 'reply ' }))
    source.settleAssistant(ATTEMPT, settled([reasoning('second version'), reply('reply text')]))
    frames.flush()
    const page = feed.getSnapshot()
    expect(page.parts.map(part => [part.key, part.text])).toEqual([['1:1:0', 'second version'], ['1:1:1', 'reply text']])
    expect(texts(page)).toEqual(['second', 'version', 'reply', 'text'])
  })

  it('drops the parts of an attempt that settles with nothing', () => {
    const { source, frames, feed } = setup()
    source.append(live({ type: 'block-start', index: 0, blockType: 'text' }))
    source.append(live({ type: 'text-delta', index: 0, text: 'abandoned ' }))
    frames.flush()
    source.settleAssistant(ATTEMPT)
    frames.flush()
    expect(feed.getSnapshot()).toEqual({ turn: 1, parts: [], complete: true })
  })

  it('starts a new page for a newer turn and ignores an older one', () => {
    const { source, frames, feed } = setup()
    source.append(settled([reply('turn one')], 1))
    source.append(settled([reply('turn two')], 2))
    source.append(settled([reply('late one')], 1))
    frames.flush()
    expect(feed.getSnapshot()).toMatchObject({ turn: 2, parts: [{ key: '2:1:0', text: 'turn two' }] })
  })

  it('rebuilds from a replaced window, with every word settled', () => {
    const { source, frames, feed } = setup()
    source.append(live({ type: 'block-start', index: 0, blockType: 'text' }))
    source.append(live({ type: 'text-delta', index: 0, text: 'stale ' }))
    source.replace([settled([reasoning('from history'), reply('and its reply')], 4)], false)
    frames.flush()
    const page = feed.getSnapshot()
    expect(page).toMatchObject({ turn: 4, complete: true })
    expect(texts(page)).toEqual(['from', 'history', 'and', 'its', 'reply'])
    expect(readingWords(page, 'both').every(word => word.readyAt === 0)).toBe(true)
  })

  it('rebuilds when it missed a revision, keeping each word’s key', () => {
    const entries: SessionEventLikeEntry[] = [settled([reply('one two three')])]
    let window: SessionEventWindow = { entries, hasMore: false, revision: 3, change: { kind: 'replace', entries } }
    const listeners = new Set<() => void>()
    const source: SessionEventSource = { getSnapshot: () => window, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const frames = manualFrames()
    const feed = new ReadingFeed(source, frames, () => 0)
    feed.subscribe(() => {})
    const keys = readingWords(feed.getSnapshot(), 'both').map(word => word.key)
    const appended = live({ type: 'block-start', index: 1, blockType: 'text' })
    // Two revisions on: the feed cannot tell what the one between held, so it reads the whole window.
    window = { entries: [...entries, appended], hasMore: false, revision: 5, change: { kind: 'append', entries: [appended] } }
    for (const listener of listeners) listener()
    frames.flush()
    expect(readingWords(feed.getSnapshot(), 'both').map(word => word.key)).toEqual(keys)
    expect(feed.getSnapshot().parts.map(part => part.key)).toEqual(['1:1:0', '1:1:1'])
  })

  it('reads the window only while observed, and publishes nothing once disposed', () => {
    const source = new MutableSessionEventSource()
    const subscribe = vi.spyOn(source, 'subscribe')
    const frames = manualFrames()
    const feed = new ReadingFeed(source, frames, () => 0)
    expect(subscribe).not.toHaveBeenCalled()
    const listener = vi.fn()
    const unsubscribe = feed.subscribe(listener)
    expect(subscribe).toHaveBeenCalledTimes(1)
    unsubscribe()
    source.append(settled([reply('unseen while away')]))
    expect(frames.pending).toBe(0)
    // Observed again, it catches up from the window.
    feed.subscribe(listener)
    expect(texts(feed.getSnapshot())).toEqual(['unseen', 'while', 'away'])
    feed.dispose()
    source.append(settled([reply('after dispose')], 2))
    frames.flush()
    expect(texts(feed.getSnapshot())).toEqual(['unseen', 'while', 'away'])
    feed.subscribe(listener)
    expect(subscribe).toHaveBeenCalledTimes(2)
  })
})
