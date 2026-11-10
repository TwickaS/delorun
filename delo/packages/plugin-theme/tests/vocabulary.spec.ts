import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COPY, COPY_ZH } from '../src/client/copy.ts'
import { chatChinese, chatEnglish, generate, OUT, render, SOURCES, vocabularyOf } from '../scripts/gen-vocabulary.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

describe('the studio vocabulary', () => {
  it.each([
    ['New Session', 'New chat'],
    ['Sessions', 'Chats'],
    ['{n} Sessions', '{n} chats'],
    ['Select a session first. Session logs stay.', 'Select a chat first. Chat logs stay.'],
    ['From session {session}', 'From chat {session}'],
    ['Run `session/create` in /sessions', undefined],
    ['Possession', undefined],
  ])('says chat for session in English, sentence case, leaving code, placeholders and commands: %j', (text, expected) => {
    expect(chatEnglish(text)).toBe(expected)
  })

  it('says 对话 for 会话 in Chinese, and leaves other texts alone', () => {
    expect(chatChinese('新建会话')).toBe('新建对话')
    expect(chatChinese('工作区')).toBeUndefined()
  })

  it('keeps only the namespaces and keys that change, in either locale', () => {
    const dictionaries = new Map([
      ['a', { en: { b: 'Session', a: 'Workspace' }, zh: { b: '会话', a: '工作区' } }],
      ['c', { en: { a: 'Files' }, zh: { a: '文件' } }],
    ])
    expect(vocabularyOf(dictionaries)).toEqual({ a: { en: { b: 'Chat' }, zh: { b: '对话' } } })
    expect(vocabularyOf(new Map([['d', { en: { a: 'Session' }, zh: {} }]]))).toEqual({ d: { en: { a: 'Chat' }, zh: {} } })
  })

  it('renders a module that names the generator and holds the overrides', () => {
    const text = render({ a: { en: { b: 'Chat' }, zh: {} } })
    expect(text).toContain('scripts/gen-vocabulary.ts')
    expect(text).toContain('a: {')
    expect(text).toContain('b: "Chat"')
  })

  it('is current: the committed vocabulary is what the generator writes from upstream\'s dictionaries', async () => {
    expect(readFileSync(`${ROOT}${OUT}`, 'utf8')).toBe(await generate())
  })

  it('has hand-written copy that names only keys upstream\'s English dictionaries have', async () => {
    for (const [ns, texts] of Object.entries(COPY)) {
      const source = SOURCES.find(entry => entry.ns === ns)
      if (source === undefined) throw new Error(`no source for ${ns}`)
      const { en } = await import(`${ROOT}${source.module}`) as { en: Record<string, string> }
      expect(Object.keys(texts).filter(key => !(key in en))).toEqual([])
    }
  })
})

describe('the hand-written Chinese copy', () => {
  it('names only keys upstream\'s Chinese dictionaries have', async () => {
    for (const [ns, texts] of Object.entries(COPY_ZH)) {
      const source = SOURCES.find(entry => entry.ns === ns)
      if (source === undefined) throw new Error(`no source for ${ns}`)
      const { zh } = await import(`${ROOT}${source.module}`) as { zh: Record<string, string> }
      expect(Object.keys(texts).filter(key => !(key in zh))).toEqual([])
    }
  })

  it('renames the row menu\'s session ID and the trace ancestors', () => {
    expect(COPY_ZH.workspace?.['menu.sessionId']).toBe('复制对话 ID')
    expect(COPY_ZH.conversation?.['detail.trace.ancestors']).toBe('上级对话')
  })
})

describe('the effort bars', () => {
  it('draw the attributes that upstream\'s model picker puts on its effort caption', () => {
    const picker = readFileSync(`${ROOT}packages/client/ui-model-selection/src/client/ModelSelect.tsx`, 'utf8')
    expect(picker).toContain("'data-effort-level'")
    expect(picker).toContain("'data-effort-levels'")
  })
})
