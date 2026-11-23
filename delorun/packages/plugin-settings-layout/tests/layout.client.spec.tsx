// @vitest-environment jsdom
import { Context, FiberState } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsLayoutRegistry } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import { projectLayout, searchNav, type SettingsNav } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/layout.ts'
import { describe, expect, it } from 'vitest'
import { apply, delorunSettingsLayout, HIDDEN_ITEMS, inject, ITEMS, PANEL_STYLE, PHONE_NAV_STYLE, PLUGIN_ID, SECTIONS } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

/** The General rows the studio composition registers, by registration id. */
const REGISTERED_ITEMS = [
  'language', 'permission', 'appearance', 'font-size', 'transcript-view', 'developer-tools', 'shortcuts', 'link-opening',
  'composer-enter', 'performance-usage', 'session-log-deepseek', 'current-version', 'delorun-onboarding', 'delorun-look',
  'delorun-update-check', 'delorun-versions', 'delorun-typeface', 'delorun-density', 'delorun-effort-labels',
]
/** The sections the studio composition registers: every placed id. */
const SECTION_ROWS = [
  { id: 'general', order: 0, label: 'General' },
  ...Object.values(SECTIONS).map((id, order) => ({ id, order: order + 1, label: id })),
]
const layout = delorunSettingsLayout(makeTranslate(en))

/** The row ids a projected navigation places, outside the trailing group. */
function placedItems(nav: SettingsNav): string[] {
  return nav.groups.filter(group => group.id !== 'other')
    .flatMap(group => group.pages.flatMap(page => page.blocks.flatMap(block => (block.kind === 'items' ? block.items.map(item => item.id) : []))))
}

/** Each page of a projected navigation as its title, then each block as `section id` or `Heading: row ids`. */
function pages(nav: SettingsNav): Record<string, string[]> {
  return Object.fromEntries(nav.groups.flatMap(group => group.pages.map(page => [
    page.label,
    page.blocks.map(block => (block.kind === 'section' ? block.id : `${block.heading ?? ''}: ${block.items.map(item => item.id).join(', ')}`)),
  ])))
}

describe("Delorun's layout", () => {
  it('groups the panes as General, Agent, Safety, Devices and Data, and hides the rows Delorun replaces', () => {
    const nav = projectLayout(layout, SECTION_ROWS, REGISTERED_ITEMS)
    expect(nav.groups.map(group => [group.label, group.pages.map(page => page.label)])).toEqual([
      ['General', ['General', 'Appearance', 'Sidebar', 'Replies', 'Message box', 'Account']],
      ['Agent', ['Models', 'Modes', 'Tools', 'Plugins', 'Browser']],
      ['Safety', ['Permissions', 'External agents', 'Network', 'Privacy', 'PIN mode']],
      ['Devices', ['Devices']],
      ['Data', ['Trash', 'Setup versions', 'Changes', 'About']],
    ])
    // Every page carries the layout's own title: Modes and Plugins, not upstream's section names.
    expect(nav.groups.every(group => group.pages.every(page => page.titled))).toBe(true)
    expect(placedItems(nav).toSorted()).toEqual(REGISTERED_ITEMS.filter(id => !HIDDEN_ITEMS.some(hidden => hidden === id)).toSorted())
  })

  it('stacks each pane\'s sections and headed cards in the spec\'s order', () => {
    expect(pages(projectLayout(layout, SECTION_ROWS, REGISTERED_ITEMS))).toEqual({
      General: [
        ': language', 'Look: delorun-look', 'Updates: delorun-update-check, delorun-versions', ': shortcuts',
        'Getting started: delorun-onboarding', 'delorun-setup-commands', 'Advanced: developer-tools',
      ],
      Appearance: ['delorun-appearance', 'Text and density: delorun-typeface, font-size, delorun-density'],
      Sidebar: ['delorun-sidebar', 'delorun-chat-states'],
      Replies: ['delorun-conversation'],
      'Message box': ['Composer: composer-enter, delorun-effort-labels', 'Links and usage: link-opening, performance-usage'],
      Account: ['account'],
      Models: ['models'],
      Modes: ['agent-presets'],
      Tools: ['delorun-tool-settings'],
      Plugins: ['plugins', 'delorun-plugin-installs', 'delorun-create-plugin'],
      Browser: ['delorun-browser'],
      Permissions: ['New chats: permission', 'delorun-permissions'],
      'External agents': ['delorun-external-agents'],
      Network: ['delorun-network'],
      Privacy: ['delorun-privacy'],
      'PIN mode': ['delorun-pin-mode'],
      Devices: ['delorun-devices'],
      Trash: ['delorun-trash'],
      'Setup versions': ['delorun-setup-versions'],
      Changes: ['delorun-changes'],
      About: ['delorun-about'],
    })
  })

  it('leaves the About page to its section, which draws the one Versions card, and hides the stock version row', () => {
    const about = layout.groups.flatMap(group => group.pages).find(page => page.id === 'about')
    expect(about?.blocks.map(block => block.kind)).toEqual(['section'])
    expect(HIDDEN_ITEMS).toContain('current-version')
    expect(JSON.stringify(projectLayout(layout, SECTION_ROWS, REGISTERED_ITEMS))).not.toContain('"current-version"')
  })

  it('leaves out External agents and Network where their sections are not registered', () => {
    const absent: readonly string[] = [SECTIONS.externalAgents, SECTIONS.network]
    const nav = projectLayout(layout, SECTION_ROWS.filter(row => !absent.includes(row.id)), REGISTERED_ITEMS)
    expect(nav.groups.find(group => group.id === 'safety')?.pages.map(page => page.label)).toEqual(['Permissions', 'Privacy', 'PIN mode'])
  })

  it('gives every pane a heading of its own and a distinct icon, and leaves Devices and Trash to their sections\' icons', () => {
    const icons = layout.groups.flatMap(group => group.pages.map(page => page.icon))
    const drawn = icons.filter(icon => icon !== undefined)
    expect(new Set(drawn).size).toBe(drawn.length)
    expect(layout.groups.flatMap(group => group.pages.filter(page => page.icon === undefined).map(page => page.id))).toEqual([SECTIONS.pinMode, SECTIONS.devices, SECTIONS.trash])
    const headings = layout.groups.flatMap(group => group.pages.flatMap(page => page.blocks.flatMap(block => (block.kind === 'items' ? [block.heading?.()] : []))))
    expect(headings.every(heading => heading === undefined || /^[A-Z][a-z]/.test(heading))).toBe(true)
  })

  it('names only ids in its exported lists, and every listed id', () => {
    const sections = layout.groups.flatMap(group => group.pages.flatMap(page => page.blocks.flatMap(block => (block.kind === 'section' ? [block.id] : []))))
    const items = layout.groups.flatMap(group => group.pages.flatMap(page => page.blocks.flatMap(block => (block.kind === 'items' ? block.items.map(item => item.id) : []))))
    expect(sections.toSorted()).toEqual(Object.values(SECTIONS).toSorted())
    expect(items.toSorted()).toEqual(Object.values(ITEMS).toSorted())
    expect(HIDDEN_ITEMS.filter(id => items.includes(id))).toEqual([])
  })

  it('shows an unattributed section or an unplaced row under Other, and never shows a hidden row', () => {
    const sections = [...SECTION_ROWS, { id: 'third-party', order: 99, label: 'Third party' }]
    const nav = projectLayout(layout, sections, [...REGISTERED_ITEMS, 'third-party-row'])
    const other = nav.groups.at(-1)
    expect([other?.id, other?.label]).toEqual(['other', 'Other'])
    expect(other?.pages.map(page => page.label)).toEqual(['Other settings', 'Third party'])
    expect(other?.pages[0]?.blocks).toEqual([{ kind: 'items', id: 'general', items: [{ id: 'third-party-row', label: '', keywords: '' }] }])
    expect(JSON.stringify(nav)).not.toContain('transcript-view')
  })

  it('gives an attributed third-party section a group titled with its plugin, after Data and before Other', () => {
    const labels: Record<string, string> = { 'bot-chat': 'Bot chat', 'bot-voice': 'Voice' }
    const plugins = [{ id: 'ds-bot', label: () => 'DS Bot', sections: ['bot-chat', 'bot-voice', 'bot-absent', SECTIONS.models] }]
    const attributed = delorunSettingsLayout(makeTranslate(en), plugins, id => labels[id] ?? id)
    const sections = [...SECTION_ROWS, { id: 'bot-chat', order: 90, label: 'Bot chat' }, { id: 'bot-voice', order: 91, label: 'Voice' }, { id: 'stray', order: 92, label: 'Stray' }]
    const nav = projectLayout(attributed, sections, REGISTERED_ITEMS)
    expect(nav.groups.slice(-3).map(group => [group.id, group.label, group.pages.map(page => [page.id, page.label])])).toEqual([
      ['data', 'Data', [[SECTIONS.trash, 'Trash'], ['setup-versions', 'Setup versions'], ['changes', 'Changes'], ['about', 'About']]],
      ['plugin:ds-bot', 'DS Bot', [['bot-chat', 'Bot chat'], ['bot-voice', 'Voice']]],
      ['other', 'Other', [['stray', 'Stray']]],
    ])
    // A section the layout places stays on its own page.
    expect(nav.groups.find(group => group.id === 'agent')?.pages[0]?.blocks).toEqual([{ kind: 'section', id: SECTIONS.models, label: SECTIONS.models }])
  })

  it('titles a plugin group page with the section id until a label is known', () => {
    const attributed = delorunSettingsLayout(makeTranslate(en), [{ id: 'p', label: () => 'P', sections: ['p-section'] }])
    expect(attributed.groups.at(-1)?.pages[0]?.label()).toBe('p-section')
  })

  it('leaves out a page whose sections and rows are absent, and Other with nothing to hold', () => {
    const nav = projectLayout(layout, [{ id: 'general', order: 0, label: 'General' }, { id: SECTIONS.models, order: 1, label: 'Models' }], ['language'])
    expect(nav.groups.map(group => [group.id, group.pages.map(page => page.id)])).toEqual([
      ['general', ['studio-general']],
      ['agent', ['agent-models']],
    ])
  })

  it('finds a page, a card and a row by name and by keyword', () => {
    const nav = projectLayout(layout, SECTION_ROWS, REGISTERED_ITEMS)
    expect(searchNav(nav, 'onboarding').map(result => result.path)).toEqual([['General'], ['General', 'Getting started', 'Show onboarding again']])
    expect(searchNav(nav, 'telemetry').map(result => result.pageId)).toEqual(['privacy'])
    expect(searchNav(nav, 'newline').map(result => result.path)).toEqual([['Message box', 'Composer', 'Send behaviour while busy']])
    expect(searchNav(nav, 'release').map(result => result.path)).toEqual([
      ['General'], ['General', 'Updates', 'Check for new releases'], ['General', 'Updates', 'Current versions'], ['About'],
    ])
  })

  it('has Chinese copy for every English key', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
    expect(Object.values(zh).every(value => value !== '')).toBe(true)
  })
})

/** A stub for the services the plugin reads, recording what it registers. */
function bench(options: { readonly layout?: false } = {}) {
  const ctx = new Context()
  const registry = new SettingsLayoutRegistry()
  if (options.layout !== false) ctx.provide('settingsLayout', registry)
  const dictionaries = new Map<string, unknown>()
  ctx.provide('locale', {
    bind: () => makeTranslate(en),
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
  })
  const sections = new Set<{ readonly id?: string; readonly label?: () => string; readonly inject?: () => object }>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => register(),
    register: (options: { readonly id?: string; readonly label?: () => string; readonly inject?: () => object }) => { sections.add(options); return () => { sections.delete(options) } },
    entries: () => [...sections].map(options => ({ options })),
  })
  return { ctx, registry, dictionaries, sections, style: () => document.head.querySelector(`style[data-plugin="${PLUGIN_ID}"]`) }
}

describe('the client plugin', () => {
  it('registers nothing until the Delorun look provides delorunStudio, and removes everything when it leaves', async () => {
    const { ctx, registry, dictionaries, sections, style } = bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(registry.getSnapshot()).toBeUndefined()
    expect([dictionaries.size, sections.size, style()]).toEqual([0, 0, null])

    const studio = ctx.plugin({ apply: (scope: Context) => { scope.provide('delorunStudio', {}) } })
    await studio.await()
    expect([...sections].map(section => section.id)).toEqual([SECTIONS.toolSettings])
    expect([...sections][0]?.label?.()).toBe('Tool settings')
    expect(Object.keys([...sections][0]?.inject?.() ?? {}).toSorted()).toEqual(['open', 'tools'])
    expect(registry.getSnapshot()?.groups.map(group => group.id)).toEqual(['general', 'agent', 'safety', 'devices', 'data'])
    expect(dictionaries.has('settings.delorunLayout')).toBe(true)
    expect(style()?.textContent).toBe(`${PANEL_STYLE}\n${PHONE_NAV_STYLE}`)

    await studio.dispose()
    expect(registry.getSnapshot()).toBeUndefined()
    expect([dictionaries.size, sections.size, style()]).toEqual([0, 0, null])
  })

  it('stays active and registers nothing without upstream\'s general Settings, as where a plugin draws its own Settings, and follows settingsLayout as it comes and goes', async () => {
    const { ctx, registry, dictionaries, sections, style } = bench({ layout: false })
    ctx.provide('delorunStudio', {})
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect([dictionaries.size, sections.size, style()]).toEqual([0, 0, null])

    const shell = ctx.plugin({ apply: (scope: Context) => { scope.provide('settingsLayout', registry) } })
    await shell.await()
    expect(registry.getSnapshot()?.groups.map(group => group.id)).toEqual(['general', 'agent', 'safety', 'devices', 'data'])
    expect([dictionaries.size, sections.size, style()?.textContent]).toEqual([1, 1, `${PANEL_STYLE}\n${PHONE_NAV_STYLE}`])

    await shell.dispose()
    expect(registry.getSnapshot()).toBeUndefined()
    expect([dictionaries.size, sections.size, style()]).toEqual([0, 0, null])
  })

  it('removes the layout, the copy, the section and the style element when the plugin is disposed', async () => {
    const { ctx, registry, dictionaries, sections, style } = bench()
    ctx.provide('delorunStudio', {})
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

  it('provides settingsPluginGroups, whose groups join the registered layout until they are removed', async () => {
    const { ctx, registry, sections } = bench()
    ctx.provide('delorunStudio', {})
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    sections.add({ id: 'bot-chat', label: () => 'Bot chat' })
    const remove = ctx.settingsPluginGroups.register({ id: 'ds-bot', label: () => 'DS Bot', sections: ['bot-chat', 'bot-unlabelled'] })
    const group = registry.getSnapshot()?.groups.at(-1)
    expect([group?.id, group?.label(), group?.pages.map(page => page.label())]).toEqual(['plugin:ds-bot', 'DS Bot', ['Bot chat', 'bot-unlabelled']])
    expect(() => ctx.settingsPluginGroups.register({ id: 'ds-bot', label: () => 'Again', sections: [] })).toThrow('"ds-bot" is registered already')
    remove()
    remove()
    expect(registry.getSnapshot()?.groups.map(entry => entry.id)).toEqual(['general', 'agent', 'safety', 'devices', 'data'])
    await fiber.dispose()
    expect(registry.getSnapshot()).toBeUndefined()
  })

  it('styles the card headings as the sentence-case section headings', () => {
    expect(PANEL_STYLE.startsWith('body{')).toBe(true)
    expect(PANEL_STYLE).toContain('--dsh-settings-card-heading-transform:none')
    expect(PANEL_STYLE).toContain('--dsh-settings-card-heading-color:var(--dsw-alias-label-primary)')
  })
})
