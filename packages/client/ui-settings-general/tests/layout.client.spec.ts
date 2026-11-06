import { describe, expect, it, vi } from 'vitest'
import { projectLayout, searchNav, SettingsLayoutRegistry, type SettingsLayout } from '../src/client/layout.ts'

const layout: SettingsLayout = {
  groups: [
    {
      id: 'you',
      label: () => 'You',
      pages: [
        { id: 'chat', label: () => 'Chat', keywords: () => 'transcript', sectionTitle: true, blocks: [{ kind: 'items', id: 'work', heading: () => 'Work details', items: [{ id: 'transcript-view', label: () => 'Tool call detail', keywords: () => 'verbose compact' }, { id: 'gone', label: () => 'Gone' }] }] },
        { id: 'empty', label: () => 'Empty', blocks: [{ kind: 'section', id: 'not-registered' }] },
      ],
    },
    { id: 'agent', label: () => 'Agent', pages: [{ id: 'agent-models', label: () => 'Models', sectionTitle: true, blocks: [{ kind: 'section', id: 'models' }] }] },
  ],
  hiddenItems: ['appearance'],
  other: { label: () => 'More', itemsLabel: () => 'General' },
  search: { placeholder: () => 'Search', empty: () => 'None' },
}
const sections = [{ id: 'general', order: 0, label: 'General' }, { id: 'models', order: 10, label: 'Models' }, { id: 'plugins', order: 15, label: 'Built-in plugins' }]

describe('projectLayout', () => {
  it('keeps what is registered, hides what the layout hides and collects the rest under the trailing group', () => {
    const nav = projectLayout(layout, sections, ['appearance', 'transcript-view', 'language'])
    expect(nav.groups.map(group => [group.label, group.pages.map(page => page.id)])).toEqual([
      ['You', ['chat']],
      ['Agent', ['agent-models']],
      ['More', ['general', 'plugins']],
    ])
    expect(nav.groups[0]?.pages[0]?.blocks).toEqual([{ kind: 'items', id: 'work', heading: 'Work details', items: [{ id: 'transcript-view', label: 'Tool call detail', keywords: 'verbose compact' }] }])
    expect(nav.groups[2]?.pages[0]?.blocks).toEqual([{ kind: 'items', id: 'general', items: [{ id: 'language', label: '', keywords: '' }] }])
    // A section-titled page keeps the shell's title when it opens with a card.
    expect(nav.groups.flatMap(group => group.pages.map(page => [page.id, page.titled]))).toEqual([['chat', true], ['agent-models', false], ['general', true], ['plugins', false]])
  })

  it('drops the trailing group when everything is placed', () => {
    const nav = projectLayout(layout, sections.slice(0, 2), ['transcript-view'])
    expect(nav.groups.map(group => group.id)).toEqual(['you', 'agent'])
  })
})

describe('searchNav', () => {
  const nav = projectLayout(layout, sections, ['transcript-view'])

  it('matches pages, cards and rows by every word, in navigation order', () => {
    expect(searchNav(nav, 'verbose')).toEqual([{ pageId: 'chat', anchor: 'transcript-view', path: ['Chat', 'Work details', 'Tool call detail'] }])
    expect(searchNav(nav, 'work')).toEqual([{ pageId: 'chat', anchor: 'work', path: ['Chat', 'Work details'] }])
    expect(searchNav(nav, 'built plugins')).toEqual([{ pageId: 'plugins', path: ['Built-in plugins'] }])
    expect(searchNav(nav, 'transcript')).toEqual([{ pageId: 'chat', path: ['Chat'] }])
  })

  it('returns nothing for a blank query', () => {
    expect(searchNav(nav, '   ')).toEqual([])
  })
})

describe('SettingsLayoutRegistry', () => {
  it('serves the latest layout and restores the one before on disposal', () => {
    const registry = new SettingsLayoutRegistry()
    const listener = vi.fn()
    const off = registry.subscribe(listener)
    const second = { ...layout, hiddenItems: [] }
    const disposeFirst = registry.register(layout)
    const disposeSecond = registry.register(second)
    expect(registry.getSnapshot()).toBe(second)
    disposeSecond()
    expect(registry.getSnapshot()).toBe(layout)
    disposeSecond()
    disposeFirst()
    expect(registry.getSnapshot()).toBeUndefined()
    off()
    registry.register(layout)
    expect(listener).toHaveBeenCalledTimes(4)
  })
})
