/** The replica's timeline and its two stand-in sessions: what each chapter shows when, and that every step names data that exists. */
import { describe, expect, it } from 'vitest'
import { chapterLength, chapterStart, nextChange, shiftClock, stateAt, type ChapterFile } from '../src/replica/model.ts'
import { CHAPTER_FILES, loadFixture } from '../src/replica/sessions/index.ts'
import { SESSION_IDS } from '../src/replica/model.ts'

const FILE: ChapterFile = {
  session: 'ordinary-work',
  workspace: 'w',
  chats: ['c'],
  start: { screen: 'chat', shown: 0, changes: '', groups: [], versions: '' },
  chapters: [
    { id: 'a', title: 'A', caption: 'A.', steps: [{ kind: 'type', text: 'abc', perChar: 10, hold: 5 }, { kind: 'send', hold: 0 }, { kind: 'show', through: 1, hold: 20 }] },
    { id: 'b', title: 'B', caption: 'B.', steps: [{ kind: 'press', target: { dictionary: 'approval', key: 'allowOnce' }, hold: 10 }, { kind: 'screen', screen: 'changes', hold: 10 }] },
  ],
}

describe('stateAt', () => {
  it('types one character per step of its pace and keeps the caret while typing', () => {
    expect(stateAt(FILE, 0, 0).state).toMatchObject({ draft: '', typing: true })
    expect(stateAt(FILE, 0, 15).state).toMatchObject({ draft: 'a', typing: true })
    expect(stateAt(FILE, 0, 30).state).toMatchObject({ draft: 'abc', typing: false })
  })

  it('clears the composer on send and shows the events through the named index', () => {
    expect(stateAt(FILE, 0, 35).state).toMatchObject({ draft: '', shown: 2 })
  })

  it('starts a chapter from the state every earlier chapter left', () => {
    expect(chapterStart(FILE, 1)).toMatchObject({ shown: 2, draft: '', screen: 'chat' })
    expect(stateAt(FILE, 1, Number.POSITIVE_INFINITY).state.screen).toBe('changes')
  })

  it('lists the presses the timeline has reached, in order', () => {
    expect(stateAt(FILE, 1, 0).presses).toEqual([{ step: 0, target: { dictionary: 'approval', key: 'allowOnce' } }])
    expect(stateAt(FILE, 0, Number.POSITIVE_INFINITY).presses).toEqual([])
  })
})

describe('nextChange and chapterLength', () => {
  it('steps through each typed character, then each step start, then reports the end', () => {
    const chapter = FILE.chapters[0]!
    expect([0, 10, 20].map(at => nextChange(chapter, at))).toEqual([10, 20, 30])
    expect(nextChange(chapter, 30)).toBe(35)
    expect(nextChange(chapter, 35)).toBeUndefined()
    expect(chapterLength(chapter)).toBe(55)
  })
})

describe('shiftClock', () => {
  it('moves ISO times and the numbers under `at`, and nothing else', () => {
    const moved = shiftClock({ createdAt: '2026-11-17T10:00:00Z', at: 1000, count: 3, note: '2026' }, 60_000)
    expect(moved).toEqual({ createdAt: '2026-11-17T10:01:00.000Z', at: 61_000, count: 3, note: '2026' })
  })
})

describe('the sessions', () => {
  for (const id of SESSION_IDS) {
    it(`${id}: is a marked stand-in whose every step names data the fixture has`, async () => {
      const file = CHAPTER_FILES[id]
      const fixture = await loadFixture(id)
      expect(fixture.id).toBe(id)
      expect(fixture.standIn).toBe(true)
      expect(new Set(file.chapters.map(chapter => chapter.id)).size).toBe(file.chapters.length)
      for (const [index, chapter] of file.chapters.entries()) {
        expect(chapter.caption.length).toBeGreaterThan(0)
        expect(chapter.caption).not.toMatch(/[–—]/)
        const end = stateAt(file, index, Number.POSITIVE_INFINITY).state
        expect(end.shown).toBeLessThanOrEqual(fixture.events.length)
        if (end.changes !== '') expect(fixture.changes).toHaveProperty([end.changes])
        if (end.versions !== '') expect(fixture.versions).toHaveProperty([end.versions])
        for (const step of chapter.steps) {
          if (step.kind === 'changes') expect(fixture.changes).toHaveProperty([step.state])
          if (step.kind === 'versions') expect(fixture.versions).toHaveProperty([step.state])
        }
      }
    })
  }
})
