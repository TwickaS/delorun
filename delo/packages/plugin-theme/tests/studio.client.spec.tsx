// @vitest-environment jsdom
/** The switch: with the studio additions on, Delo's look and `ctx.deloStudio`; off, upstream's look and one General row. */
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, THEME_ROW_ID } from '../src/config.ts'
import {
  apply, BRAND_NS, CONVERSATION, inject, LAYERS, LOOK_ROW, NS, PLUGIN_ID, SECTION_ID, STOCK_ATTRIBUTE,
} from '../src/client/index.ts'
import { en as brandEn, zh as brandZh } from '../src/client/brand-locales.ts'
import { bootStyle } from '../src/palette/layers.ts'
import { COPY, COPY_ZH } from '../src/client/copy.ts'
import { VOCABULARY } from '../src/client/vocabulary.ts'
import type { AppearanceInjected } from '../src/client/AppearanceSection.tsx'
import type { LookRowInjected } from '../src/client/LookRow.tsx'
import { en, zh } from '../src/client/locales.ts'
import { en as lookEn, zh as lookZh } from '../src/client/look-locales.ts'
import { en as conversationEn, zh as conversationZh } from '../src/client/conversation-locales.ts'
import { EFFORT_ATTRIBUTE } from '../src/client/effort.ts'
import { STUDIO_ON, themeForm, type ThemeFormHandle } from './theme-form.client.ts'

type Layer = Readonly<Record<string, { light: string; dark: string }>>

interface Registered {
  readonly options: { readonly id?: string; readonly name: string; readonly order?: number; readonly locale?: string; readonly label?: () => string; readonly inject?: () => unknown }
  readonly component: ComponentType<Record<string, unknown>>
}

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute(STOCK_ATTRIBUTE)
})

/**
 * Mount the plugin on the studio services it uses, as far as it uses them.
 * @param form - the theme row's settings form.
 * @param served - the settings namespaces the Host serves besides the theme row's.
 */
async function mount(form: ThemeFormHandle, served: readonly string[] = ['ui-chat']) {
  const ctx = new Context()
  const layers = new Map<string, Layer>()
  let preference: 'light' | 'dark' | 'system' = 'system'
  ctx.provide('theme', {
    overrideTokens: (source: string, tokens: Layer) => {
      layers.set(source, tokens)
      return () => { if (layers.get(source) === tokens) layers.delete(source) }
    },
    getTheme: () => ({ preference }),
    setTheme: (next: typeof preference) => { preference = next },
  })
  ctx.provide('configForms', {
    get: (namespace: string) => (namespace === THEME_ROW_ID ? form.scope : themeForm(undefined).scope),
    whileServed: (namespaces: readonly string[], register: (set: ReadonlySet<string>) => () => void) =>
      (namespaces.some(namespace => served.includes(namespace)) ? register(new Set(namespaces)) : () => {}),
  })
  const dictionaries = new Map<string, unknown>()
  const overrides = new Set<string>()
  ctx.provide('locale', {
    bind: (ns: string) => makeTranslate(ns === CONVERSATION.ns ? conversationEn : en),
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
    override: (ns: string, locale: string) => { overrides.add(`${ns}/${locale}`); return () => { overrides.delete(`${ns}/${locale}`) } },
  })
  const slots = new Map<string, Registered>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => register(),
    register: (options: Registered['options'], component: Registered['component']) => {
      const key = options.id ?? options.name
      slots.set(key, { options, component })
      return () => { slots.delete(key) }
    },
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const faces = () => document.head.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)
  return { ctx, fiber, layers, slots, dictionaries, overrides, faces, preference: () => preference }
}

/** The plugin's General row, rendered. */
function renderRow(slots: Map<string, Registered>) {
  const row = slots.get(LOOK_ROW.id)
  if (row === undefined) throw new Error('no General row')
  const Row = row.component
  render(<Row t={makeTranslate(lookEn)} {...row.options.inject?.() as LookRowInjected} />)
}

describe('with the studio additions off', () => {
  it('registers only the General row: no service, no layers, no faces, no sections, no headline, no vocabulary', async () => {
    const form = themeForm(DEFAULT_SETTINGS)
    const { ctx, fiber, layers, slots, dictionaries, overrides, faces } = await mount(form)
    expect(ctx.get('deloStudio')).toBeUndefined()
    expect(layers.size).toBe(0)
    expect(faces()).toBeNull()
    expect([...slots.keys()]).toEqual([LOOK_ROW.id])
    expect(slots.get(LOOK_ROW.id)?.options).toMatchObject({ name: 'settings.general.item', order: LOOK_ROW.order, locale: LOOK_ROW.ns })
    expect([...dictionaries.keys()]).toEqual([LOOK_ROW.ns])
    expect(dictionaries.get(LOOK_ROW.ns)).toEqual({ en: lookEn, zh: lookZh })
    expect(overrides.size).toBe(0)
    expect(document.documentElement.hasAttribute(STOCK_ATTRIBUTE)).toBe(true)
    expect(document.documentElement.hasAttribute(EFFORT_ATTRIBUTE)).toBe(false)
    await fiber.dispose()
    expect(slots.size).toBe(0)
    expect(dictionaries.size).toBe(0)
    expect(document.documentElement.hasAttribute(STOCK_ATTRIBUTE)).toBe(false)
  })

  it('turns the studio additions on from the row, and the studio comes up with its service and layers', async () => {
    const form = themeForm(DEFAULT_SETTINGS)
    const { ctx, fiber, layers, slots, faces } = await mount(form)
    renderRow(slots)
    expect(screen.getByText(lookEn.description)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: lookEn.title })) })
    expect(form.writes).toEqual([['studioAdditions', true]])
    expect(ctx.get('deloStudio')).toBeDefined()
    expect([...layers.keys()]).toEqual([LAYERS.palette, LAYERS.accent, LAYERS.type, LAYERS.density])
    expect(faces()).not.toBeNull()
    expect(slots.has(LOOK_ROW.id)).toBe(false)
    expect(document.documentElement.hasAttribute(STOCK_ATTRIBUTE)).toBe(false)
    await fiber.dispose()
  })

  it('ignores a settings change that does not flip the switch', async () => {
    const form = themeForm(DEFAULT_SETTINGS)
    const { slots, layers, fiber } = await mount(form)
    form.publish({ value: { ...DEFAULT_SETTINGS, accent: 'moss' } })
    expect([...slots.keys()]).toEqual([LOOK_ROW.id])
    expect(layers.size).toBe(0)
    await fiber.dispose()
  })
})

describe('with the studio additions on', () => {
  it('provides ctx.deloStudio, lays the layers and faces, and registers the sections, headline, dictionaries and vocabulary', async () => {
    const form = themeForm(STUDIO_ON)
    const { ctx, fiber, layers, slots, dictionaries, overrides, faces } = await mount(form)
    expect(ctx.get('deloStudio')).toBeDefined()
    expect([...layers.keys()]).toEqual([LAYERS.palette, LAYERS.accent, LAYERS.type, LAYERS.density])
    expect(layers.get(LAYERS.density)).toMatchObject({ '--dsh-density': { light: '1', dark: '1' }, '--delo-space-5': { light: 'calc(12px * var(--dsh-density, 1))' } })
    expect(layers.get(LAYERS.accent)?.['--dsw-alias-brand-primary']?.light).toBe('rgb(229 115 74)')
    // Vitest compiles stylesheets to empty text, so the spec checks the element, not its rules.
    expect(document.head.querySelector(`style[data-plugin-css="${PLUGIN_ID}/fonts.css"]`)).not.toBeNull()
    expect(faces()?.textContent).toContain("[data-effort-levels='3']")
    expect([...slots.keys()].sort()).toEqual(['conversation.hero.brand.mark', 'conversation.hero.headline', CONVERSATION.id, SECTION_ID].sort())
    expect(slots.get(SECTION_ID)?.options).toMatchObject({ name: 'settings.section', order: 1, locale: NS })
    expect(slots.get(CONVERSATION.id)?.options).toMatchObject({ order: 2, locale: CONVERSATION.ns })
    expect(slots.get(SECTION_ID)?.options.label?.()).toBe(en.nav)
    expect(slots.get(CONVERSATION.id)?.options.label?.()).toBe(conversationEn.title)
    expect(slots.get(CONVERSATION.id)?.options.inject?.()).toHaveProperty('settings')
    expect(dictionaries.get(NS)).toEqual({ en, zh })
    expect(dictionaries.get(CONVERSATION.ns)).toEqual({ en: conversationEn, zh: conversationZh })
    expect(dictionaries.get(BRAND_NS)).toEqual({ en: brandEn, zh: brandZh })
    expect(dictionaries.has(LOOK_ROW.ns)).toBe(false)
    const vocabulary = [...new Set([...Object.keys(VOCABULARY).flatMap(ns => [`${ns}/en`, `${ns}/zh`]), ...Object.keys(COPY).map(ns => `${ns}/en`), ...Object.keys(COPY_ZH).map(ns => `${ns}/zh`)])]
    expect([...overrides].sort()).toEqual([...vocabulary].sort())
    expect(document.documentElement.hasAttribute(STOCK_ATTRIBUTE)).toBe(false)
    await fiber.dispose()
    expect(layers.size).toBe(0)
    expect(faces()).toBeNull()
    expect(slots.size + dictionaries.size + overrides.size).toBe(0)
    expect(ctx.get('deloStudio')).toBeUndefined()
  })

  it('leaves the Conversation section out while the Host does not serve upstream\'s chat settings', async () => {
    const { slots, fiber } = await mount(themeForm(STUDIO_ON), [])
    expect([...slots.keys()].sort()).toEqual(['conversation.hero.brand.mark', 'conversation.hero.headline', SECTION_ID].sort())
    await fiber.dispose()
  })

  it('puts the text wordmark in the hero\'s brand-mark seat, sized to upstream\'s mark, and takes it out with the look', async () => {
    const { slots, fiber } = await mount(themeForm(STUDIO_ON))
    const Mark = slots.get('conversation.hero.brand.mark')?.component
    if (Mark === undefined) throw new Error('no brand mark')
    render(<Mark t={makeTranslate(brandEn)} size={34} className="fish" />)
    const mark = screen.getByText(brandEn['hero.mark'])
    expect(mark.textContent).toBe('Delo')
    expect(mark.className).toContain('fish')
    expect(mark.style.minWidth).toBe('34px')
    expect(mark.style.height).toBe('25px')
    cleanup()
    render(<Mark t={makeTranslate(brandEn)} size={34} />)
    expect(screen.getByText('Delo').className).not.toContain('undefined')
    await fiber.dispose()
    expect(slots.has('conversation.hero.brand.mark')).toBe(false)
  })

  it('shows the headline, which says what the chat is for', async () => {
    const { slots, fiber } = await mount(themeForm(STUDIO_ON))
    const Headline = slots.get('conversation.hero.headline')?.component
    if (Headline === undefined) throw new Error('no headline')
    render(<Headline t={makeTranslate(brandEn)} />)
    expect(screen.getByText(brandEn['hero.headline'])).toBeTruthy()
    expect(brandZh['hero.headline']).not.toBe('')
    await fiber.dispose()
  })

  it('follows each settings change: another accent, density, the system typeface, contrast, a theme and the effort bars', async () => {
    const form = themeForm(STUDIO_ON)
    const { fiber, layers, faces } = await mount(form)
    const change = async (field: string, value: unknown) => { await form.scope.set(field, value) }
    await change('accent', 'cobalt')
    expect(layers.get(LAYERS.accent)?.['--dsw-alias-brand-primary']?.light).toBe('rgb(58 94 232)')
    await change('density', 'compact')
    expect(layers.get(LAYERS.density)?.['--dsh-density']?.light).toBe('0.8')
    await change('typeface', 'system')
    expect(layers.has(LAYERS.type)).toBe(false)
    // The faces stay declared for the Appearance typeface preview.
    expect(faces()).not.toBeNull()
    await change('contrast', 160)
    expect(layers.get(LAYERS.contrast)?.['--dsw-alias-label-tertiary']).toBeDefined()
    await change('palette', 'iris')
    expect(layers.get(LAYERS.accent)?.['--dsw-alias-brand-primary']?.light).not.toBe('rgb(58 94 232)')
    await change('effort', 'bars')
    expect(document.documentElement.getAttribute(EFFORT_ATTRIBUTE)).toBe('bars')
    await change('effort', 'label')
    expect(document.documentElement.hasAttribute(EFFORT_ATTRIBUTE)).toBe(false)
    await fiber.dispose()
  })

  it('offers the Appearance section, which saves its choices and the colour scheme through the injected services', async () => {
    const form = themeForm(STUDIO_ON)
    const { ctx, fiber, slots, preference } = await mount(form)
    const section = slots.get(SECTION_ID)
    if (section === undefined) throw new Error('no Appearance section')
    const Section = section.component
    const face = section.options.inject?.() as AppearanceInjected
    render(<Section t={makeTranslate(en)} {...face} />)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Moss' })) })
    await act(async () => { fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Mode' })).getByRole('radio', { name: /Dark/ })) })
    expect(form.writes).toEqual([['accent', 'moss']])
    expect(preference()).toBe('dark')
    const changed = vi.fn()
    const stop = face.scheme.subscribe(changed)
    ctx.emit('theme/change', { preference: 'dark' } as ThemeSnapshot)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(face.scheme.get()).toBe('dark')
    stop()
    await fiber.dispose()
  })
})

describe('turning the studio additions off', () => {
  it('through ctx.deloStudio: writes false, unloads the plugins that require the service, and leaves the General row', async () => {
    const form = themeForm(STUDIO_ON)
    const { ctx, fiber, layers, slots, dictionaries, overrides, faces } = await mount(form)
    const lifecycle = vi.fn()
    const dependent = ctx.plugin({ inject: ['deloStudio'], apply: (child: Context) => { lifecycle(true); child.effect(() => () => { lifecycle(false) }) } })
    await dependent.await()
    expect(lifecycle.mock.calls).toEqual([[true]])
    const service = ctx.get('deloStudio')
    expect(await service?.useStockLook()).toBe(true)
    expect(form.writes).toEqual([['studioAdditions', false]])
    await vi.waitFor(() => { expect(lifecycle.mock.calls).toEqual([[true], [false]]) })
    expect(ctx.get('deloStudio')).toBeUndefined()
    expect(layers.size).toBe(0)
    expect(faces()).toBeNull()
    expect([...slots.keys()]).toEqual([LOOK_ROW.id])
    expect([...dictionaries.keys()]).toEqual([LOOK_ROW.ns])
    expect(overrides.size).toBe(0)
    expect(document.documentElement.hasAttribute(STOCK_ATTRIBUTE)).toBe(true)
    expect(document.documentElement.hasAttribute(EFFORT_ATTRIBUTE)).toBe(false)
    await form.scope.set('studioAdditions', true)
    await vi.waitFor(() => { expect(lifecycle.mock.calls).toHaveLength(3) })
    await fiber.dispose()
  })

  it('reports a refusal and keeps the studio additions on', async () => {
    const form = themeForm(STUDIO_ON)
    form.answer = false
    const { ctx, fiber, layers } = await mount(form)
    expect(await ctx.get('deloStudio')?.useStockLook()).toBe(false)
    expect(ctx.get('deloStudio')).toBeDefined()
    expect(layers.size).toBeGreaterThan(0)
    await fiber.dispose()
  })

  it('through the Look choice in the Appearance section', async () => {
    const form = themeForm(STUDIO_ON)
    const { ctx, fiber, slots } = await mount(form)
    const section = slots.get(SECTION_ID)
    if (section === undefined) throw new Error('no Appearance section')
    const Section = section.component
    render(<Section t={makeTranslate(en)} {...section.options.inject?.() as AppearanceInjected} />)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: en['look.stock'] })) })
    expect(form.writes).toEqual([['studioAdditions', false]])
    expect(ctx.get('deloStudio')).toBeUndefined()
    await fiber.dispose()
  })
})

describe('the first-paint style the host printed', () => {
  /** Print the style as the host does, next to a style that is not Delo's. */
  function printFirstPaint() {
    const printed = document.createElement('style')
    printed.textContent = bootStyle(STUDIO_ON)
    const other = document.createElement('style')
    other.textContent = 'body{margin:0}'
    document.head.append(printed, other)
    return { printed, other }
  }

  it('is gone when the plugin is disposed while the look is on, so upstream\'s colours return without a reload', async () => {
    const { printed, other } = printFirstPaint()
    expect(printed.textContent).toContain('--dsw-alias-brand-primary')
    const { fiber } = await mount(themeForm(STUDIO_ON))
    expect(printed.isConnected).toBe(true)
    await fiber.dispose()
    expect(printed.isConnected).toBe(false)
    expect(other.isConnected).toBe(true)
    other.remove()
  })

  it('is gone when the look leaves, while the plugin keeps running', async () => {
    const { printed, other } = printFirstPaint()
    const form = themeForm(STUDIO_ON)
    const { fiber } = await mount(form)
    await form.scope.set('studioAdditions', false)
    expect(printed.isConnected).toBe(false)
    expect(other.isConnected).toBe(true)
    await fiber.dispose()
    other.remove()
  })
})

describe('before the Host has answered', () => {
  it('registers nothing while the form loads, then follows its first answer', async () => {
    const form = themeForm(undefined)
    const { ctx, fiber, layers, slots, dictionaries } = await mount(form)
    expect(ctx.get('deloStudio')).toBeUndefined()
    expect(layers.size + slots.size + dictionaries.size).toBe(0)
    expect(document.documentElement.hasAttribute(STOCK_ATTRIBUTE)).toBe(false)
    form.publish({ status: 'ready', value: STUDIO_ON })
    expect(ctx.get('deloStudio')).toBeDefined()
    await fiber.dispose()
  })

  it('releases everything when the form stops being ready', async () => {
    const form = themeForm(STUDIO_ON)
    const { ctx, fiber, layers, slots, dictionaries } = await mount(form)
    form.publish({ status: 'loading', value: undefined })
    expect(ctx.get('deloStudio')).toBeUndefined()
    expect(layers.size + slots.size + dictionaries.size).toBe(0)
    await fiber.dispose()
  })

  it('registers nothing when the Host does not serve the theme row', async () => {
    const { ctx, fiber, layers, slots } = await mount(themeForm(undefined, 'unavailable'))
    expect(ctx.get('deloStudio')).toBeUndefined()
    expect(layers.size + slots.size).toBe(0)
    await fiber.dispose()
  })
})
