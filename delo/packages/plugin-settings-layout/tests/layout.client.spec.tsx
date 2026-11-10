// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsLayoutRegistry } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import { projectLayout, searchNav, type SettingsNav } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/layout.ts'
import { describe, expect, it } from 'vitest'
import { apply, deloSettingsLayout, HIDDEN_ITEMS, inject, ITEMS, PANEL_STYLE, PLUGIN_ID, SECTIONS } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

/** The General rows the studio composition registers, by registration id. */
const REGISTERED_ITEMS = [
  'language', 'permission', 'appearance', 'font-size', 'transcript-view', 'developer-tools', 'shortcuts', 'link-opening',
  'composer-enter', 'performance-usage', 'session-log-deepseek', 'current-version', 'delo-onboarding',
]
const SECTION_ROWS = [{ id: 'general', order: 0, label: 'General' }, ...Object.values(SECTIONS).map((id, order) => ({ id, order: order + 1, label: id }))]
const layout = deloSettingsLayout(makeTranslate(en))

/** The row ids a projected navigation places, outside the trailing group. */
function placedItems(nav: SettingsNav): string[] {
  return nav.groups.filter(group => group.id !== 'other')
    .flatMap(group => group.pages.flatMap(page => page.blocks.flatMap(block => (block.kind === 'items' ? block.items.map(item => item.id) : []))))
}

describe("Delo's layout", () => {
  it('places every section and General row the composition registers, and hides the rows Delo replaces', () => {
    const nav = projectLayout(layout, SECTION_ROWS, REGISTERED_ITEMS)
    expect(nav.groups.map(group => [group.label, group.pages.map(page => page.label)])).toEqual([
      ['You', ['Appearance', 'Sidebar', 'Chat', 'Language', 'Privacy', 'Account']],
      ['Agent', ['Models', 'Modes', 'Permissions', 'Tools']],
      ['Delo', ['About']],
    ])
    // Every page carries the layout's own title: Modes and Tools, not upstream's section names.
    expect(nav.groups.every(group => group.pages.every(page => page.titled))).toBe(true)
    expect(placedItems(nav).toSorted()).toEqual(REGISTERED_ITEMS.filter(id => !HIDDEN_ITEMS.some(hidden => hidden === id)).toSorted())
  })

  it('names only ids in its exported lists, and every listed id', () => {
    const sections = layout.groups.flatMap(group => group.pages.flatMap(page => page.blocks.flatMap(block => (block.kind === 'section' ? [block.id] : []))))
    const items = layout.groups.flatMap(group => group.pages.flatMap(page => page.blocks.flatMap(block => (block.kind === 'items' ? block.items.map(item => item.id) : []))))
    expect(sections.toSorted()).toEqual(Object.values(SECTIONS).toSorted())
    expect(items.toSorted()).toEqual(Object.values(ITEMS).toSorted())
    expect(HIDDEN_ITEMS.filter(id => items.includes(id))).toEqual([])
  })

  it('shows a section or row no page places under More, and never shows a hidden row', () => {
    const sections = [...SECTION_ROWS, { id: 'third-party', order: 99, label: 'Third party' }]
    const nav = projectLayout(layout, sections, [...REGISTERED_ITEMS, 'third-party-row'])
    const more = nav.groups.find(group => group.id === 'other')
    expect(more?.label).toBe('More')
    expect(more?.pages.map(page => page.label)).toEqual(['General', 'Third party'])
    expect(more?.pages[0]?.blocks).toEqual([{ kind: 'items', id: 'general', items: [{ id: 'third-party-row', label: '', keywords: '' }] }])
    expect(JSON.stringify(nav)).not.toContain('transcript-view')
  })

  it('leaves out a page whose sections and rows are absent, and More with nothing to hold', () => {
    const nav = projectLayout(layout, [{ id: 'general', order: 0, label: 'General' }, { id: SECTIONS.models, order: 1, label: 'Models' }], ['language'])
    expect(nav.groups.map(group => [group.id, group.pages.map(page => page.id)])).toEqual([
      ['you', ['language']],
      ['agent', ['agent-models']],
    ])
  })

  it('finds a page, a card and a row by name and by keyword', () => {
    const nav = projectLayout(layout, SECTION_ROWS, REGISTERED_ITEMS)
    expect(searchNav(nav, 'onboarding').map(result => result.path)).toEqual([['About'], ['About', 'Getting started', 'Show onboarding again']])
    expect(searchNav(nav, 'telemetry').map(result => result.pageId)).toEqual(['privacy'])
    expect(searchNav(nav, 'newline').map(result => result.path)).toEqual([['Chat', 'Composer', 'Enter key']])
  })

  it('has Chinese copy for every English key, and keeps product words in both', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
    expect(Object.values(zh).every(value => value !== '')).toBe(true)
    expect(zh['group.delo']).toBe(en['group.delo'])
  })
})

/** A stub for the services the plugin reads, recording what it registers. */
function bench() {
  const ctx = new Context()
  const registry = new SettingsLayoutRegistry()
  ctx.provide('settingsLayout', registry)
  const dictionaries = new Map<string, unknown>()
  ctx.provide('locale', {
    bind: () => makeTranslate(en),
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
  })
  const sections = new Set<{ readonly id?: string; readonly label?: () => string; readonly inject?: () => object }>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => register(),
    register: (options: { readonly id?: string; readonly label?: () => string; readonly inject?: () => object }) => { sections.add(options); return () => { sections.delete(options) } },
  })
  return { ctx, registry, dictionaries, sections, style: () => document.head.querySelector(`style[data-plugin="${PLUGIN_ID}"]`) }
}

describe('the client plugin', () => {
  it('registers nothing until the Delo look provides deloStudio, and removes everything when it leaves', async () => {
    const { ctx, registry, dictionaries, sections, style } = bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(registry.getSnapshot()).toBeUndefined()
    expect([dictionaries.size, sections.size, style()]).toEqual([0, 0, null])

    const studio = ctx.plugin({ apply: (scope: Context) => { scope.provide('deloStudio', {}) } })
    await studio.await()
    expect([...sections].map(section => section.id)).toEqual([SECTIONS.toolSettings])
    expect([...sections][0]?.label?.()).toBe('Tool settings')
    expect(Object.keys([...sections][0]?.inject?.() ?? {}).toSorted()).toEqual(['open', 'tools'])
    expect(registry.getSnapshot()?.groups.map(group => group.id)).toEqual(['you', 'agent', 'delo'])
    expect(dictionaries.has('settings.deloLayout')).toBe(true)
    expect(style()?.textContent).toBe(PANEL_STYLE)

    await studio.dispose()
    expect(registry.getSnapshot()).toBeUndefined()
    expect([dictionaries.size, sections.size, style()]).toEqual([0, 0, null])
  })

  it('removes the layout, the copy, the section and the style element when the plugin is disposed', async () => {
    const { ctx, registry, dictionaries, sections, style } = bench()
    ctx.provide('deloStudio', {})
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(registry.getSnapshot()).toBeDefined()
    expect(style()).not.toBeNull()
    await fiber.dispose()
    expect(registry.getSnapshot()).toBeUndefined()
    expect([dictionaries.size, sections.size, style()]).toEqual([0, 0, null])
  })

  it('sizes the panel for a desktop window and keeps the navigation narrow in a narrow one', () => {
    expect(PANEL_STYLE).toContain('--dsh-settings-panel-width:1080px')
    expect(PANEL_STYLE).toContain('--dsh-settings-panel-height:88vh')
    expect(PANEL_STYLE).toContain('--dsh-settings-nav-width:min(220px,40vw)')
  })
})
