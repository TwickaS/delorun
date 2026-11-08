/** Question-composer Session store behavior. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPersistenceHostId } from '@deepseek-ai/dsh-client-store'
import { createQuestionDraftStore, type QuestionDraftProgress } from '../src/client/draft-store.ts'

const FIRST: QuestionDraftProgress = {
  index: 1,
  drafts: [{ selected: ['Fast'], custom: '', skipped: false }],
}

afterEach(() => {
  setPersistenceHostId(undefined)
  vi.unstubAllGlobals()
})

describe('createQuestionDraftStore', () => {
  it('persists unfinished answers across Session store recreation', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    try {
      const first = createQuestionDraftStore().create('session-one')
      first.actions.replace('question:one', FIRST)

      const restored = createQuestionDraftStore().create('session-one')
      const other = createQuestionDraftStore().create('session-two')
      expect(restored.getSnapshot()).toEqual({ progressByRequest: { 'question:one': FIRST } })
      expect(other.getSnapshot()).toEqual({ progressByRequest: {} })

      restored.actions.clear('question:one')
      expect(createQuestionDraftStore().create('session-one').getSnapshot())
        .toEqual({ progressByRequest: {} })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps request progress and ignores cleanup for another request', () => {
    const store = createQuestionDraftStore().create('session-one')

    store.actions.replace('question:one', FIRST)
    expect(store.getSnapshot()).toEqual({ progressByRequest: { 'question:one': FIRST } })

    store.actions.clear('question:older')
    expect(store.getSnapshot()).toEqual({ progressByRequest: { 'question:one': FIRST } })

    store.actions.clear('question:one')
    expect(store.getSnapshot()).toEqual({ progressByRequest: {} })
  })

  it('keeps simultaneous request drafts isolated', () => {
    const store = createQuestionDraftStore().create('session-one')
    const second: QuestionDraftProgress = {
      index: 0,
      drafts: [{ selected: [], custom: 'Careful', skipped: false }],
    }

    store.actions.replace('question:one', FIRST)
    store.actions.replace('question:two', second)

    expect(store.getSnapshot()).toEqual({
      progressByRequest: { 'question:one': FIRST, 'question:two': second },
    })

    store.actions.clear('question:two')
    expect(store.getSnapshot()).toEqual({ progressByRequest: { 'question:one': FIRST } })
  })

  it('prunes every draft that no live card owns', () => {
    const store = createQuestionDraftStore().create('session-one')
    store.actions.replace('question:session-one:call-live', FIRST)
    store.actions.replace('question:session-one:call-closed', FIRST)
    store.actions.replace('question:7', FIRST)

    store.actions.prune(['question:session-one:call-live'])

    expect(store.getSnapshot()).toEqual({ progressByRequest: { 'question:session-one:call-live': FIRST } })
  })
})

describe('host-qualified persistence', () => {
  it('keeps two connections with one Session id in separate drafts', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    const hostA = '0b9e8c52-6a17-4b8e-9a2f-1d3c5e7f9a01'
    const hostB = 'c2f4a6d8-3e50-4f19-b7a2-8c0e2d4b6f83'

    setPersistenceHostId(hostA)
    createQuestionDraftStore().create('session-one').actions.replace('question:one', FIRST)
    expect(values.has(`dsh.user-questions.drafts.v1.${hostA}.session-one`)).toBe(true)

    // The same Session id on another connection starts empty and writes its own entry.
    setPersistenceHostId(hostB)
    expect(createQuestionDraftStore().create('session-one').getSnapshot()).toEqual({ progressByRequest: {} })
    createQuestionDraftStore().create('session-one').actions.replace('question:one', FIRST)
    expect(values.has(`dsh.user-questions.drafts.v1.${hostB}.session-one`)).toBe(true)
    expect(values.get(`dsh.user-questions.drafts.v1.${hostA}.session-one`))
      .toEqual(JSON.stringify({ progressByRequest: { 'question:one': FIRST } }))
  })
})
