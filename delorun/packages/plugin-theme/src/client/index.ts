/**
 * Studio half of Delorun's theme and the owner of C16 switch `studio_additions`
 * (the `studioAdditions` setting). While the switch is on it applies the
 * theme settings (the palette, the accent and the type as override layers on
 * upstream's theme, plus Delorun's font faces), registers the Appearance and
 * Conversation sections of Settings with the Look, Typeface, Density and
 * Reasoning effort labels rows, Delorun's New Session headline and Delorun's
 * vocabulary, and provides `ctx.delorunStudio`, which Delorun's other studio
 * plugins list in `inject`, so turning the switch off unloads them all and
 * leaves upstream's studio. While it is off the plugin registers one thing, a
 * `settings.general.item` row (`delorun-look`) that turns it back on, and nothing else is
 * visible. Light, dark and system stay upstream's preference.
 * @module @delorun/plugin-theme/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.configForms merge and the 'settings.section' and 'settings.general.item' SlotMap entries.
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.theme Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: the 'conversation.hero.headline' and 'conversation.hero.brand.mark' SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readBootSettings } from '../boot-settings.ts'
import { THEME_ROW_ID, type ThemeSettings } from '../config.ts'
import { FIRST_PAINT_MARK, STOCK_ATTRIBUTE } from '../palette/layers.ts'
import { AppearanceSection, type AppearanceInjected, type SchemePreference } from './AppearanceSection.tsx'
import { DensityRow, EffortLabelsRow, StudioLookRow, TypefaceRow, type AppearanceRowInjected } from './AppearanceRows.tsx'
import { HeroHeadline, HeroWordmark } from './brand.tsx'
import { followBrandingInDocument } from './branding-dom.ts'
import { en as brandingEn, zh as brandingZh, type BrandingLocaleKey } from './branding-locales.ts'
import { publishBranding } from './branding-store.ts'
import { en as pickerEn, zh as pickerZh, type IconPickerLocaleKey } from '@delorun/brand/icon-picker-locales'
import { SidebarBrandMark, SidebarBrandName } from './SidebarBrand.tsx'
import { en as brandEn, zh as brandZh, type BrandLocaleKey } from './brand-locales.ts'
import { ThemeController } from './controller.ts'
import { installTouchInputs } from './touch-inputs.ts'
import { EdgeController } from './edges.ts'
import { effortBarsCss } from './effort.ts'
import { composerFocusCss } from './focus.ts'
import { panelGlyphsCss } from './panel-glyphs.ts'
import { markMainLandmark } from './landmark.ts'
import { COPY, COPY_ZH } from './copy.ts'
import { VOCABULARY } from './vocabulary.ts'
import fonts from './fonts.css?inline'
import { CHAT_NAMESPACE, type ChatDisplaySettings } from './conversation.ts'
import { en as conversationEn, zh as conversationZh, type ConversationLocaleKey } from './conversation-locales.ts'
import { ConversationSection, type ConversationInjected } from './ConversationSection.tsx'
import { en, zh, type AppearanceLocaleKey } from './locales.ts'
import { en as lookEn, zh as lookZh, type LookLocaleKey } from './look-locales.ts'
import { LookRow, type LookRowInjected } from './LookRow.tsx'

export { LAYERS, PLUGIN_ID, ThemeController } from './controller.ts'
export { EDGE_ATTRIBUTE, EdgeController, edgeColours, type EdgeColours } from './edges.ts'
export {
  ACCENT_CHOICES, CONTRAST, DEFAULT_SETTINGS, DENSITIES, EFFORT_DISPLAYS, PALETTES, THEME_ROW_ID, TYPEFACES,
  type AccentChoice, type Density, type EffortDisplay, type PaletteChoice, type ThemeSettings, type Typeface,
} from '../config.ts'
export { STOCK_ATTRIBUTE } from '../palette/layers.ts'
export type { ConversationInjected, ConversationSectionProps } from './ConversationSection.tsx'
export type { ConversationLocaleKey } from './conversation-locales.ts'
export type { AppearanceInjected, AppearanceSectionProps, SchemePreference } from './AppearanceSection.tsx'
export type { AppearanceRowInjected, AppearanceRowProps } from './AppearanceRows.tsx'
export type { AppearanceLocaleKey } from './locales.ts'
export type { BrandLocaleKey } from './brand-locales.ts'
export type { LookLocaleKey } from './look-locales.ts'
export type { LookRowInjected, LookRowProps } from './LookRow.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delorun's studio additions, present while C16 switch `studio_additions` is on; a Delorun studio plugin lists it in `inject`, so the stock look unloads it. */
    delorunStudio: DelorunStudio
  }
}

/** What `ctx.delorunStudio` shares. */
export interface DelorunStudio {
  /**
   * Turn the studio additions off, which withdraws this service and so unloads every plugin that requires it.
   * @returns whether the Host accepted the write.
   */
  useStockLook(): Promise<boolean>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The copy of the Appearance section and of the studio half's General rows. */
    'settings.delorunAppearance': AppearanceLocaleKey
    /** The Conversation section's copy. */
    'settings.delorunConversation': ConversationLocaleKey
    /** The General row's copy. */
    'settings.delorunLook': LookLocaleKey
    /** The Branding section's copy. */
    'settings.delorunBranding': BrandingLocaleKey
    /** The New Session headline's copy. */
    'delorunBrand': BrandLocaleKey
    /** The workspace icon picker's copy. */
    'delorunIconPicker': IconPickerLocaleKey
  }
}

/** Dictionary namespace of the Appearance section. */
export const NS = 'settings.delorunAppearance'

/** The Appearance section's id in Settings. */
export const SECTION_ID = 'delorun-appearance'

/** Its place in Settings: right after General (0). */
export const SECTION_ORDER = 1

/** The Branding block's dictionary namespace; the block sits in the Appearance section, after the colours. */
export const BRANDING = { ns: 'settings.delorunBranding' } as const

/** The Conversation section's id, its dictionary namespace and its place, after Appearance. */
export const CONVERSATION = { id: 'delorun-conversation', ns: 'settings.delorunConversation', order: 2 } as const

/**
 * The General row that turns the studio additions on again: its id, dictionary namespace and place, after Language (0).
 * The studio half's Look row (`STUDIO_ROWS.look`) has the same id and place; the two are never registered together.
 */
export const LOOK_ROW = { id: 'delorun-look', ns: 'settings.delorunLook', order: 1 } as const

/**
 * The General rows the studio half registers, with the Appearance dictionary
 * (`NS`): their ids and places among upstream's rows. Typeface sits between
 * upstream's colour scheme (10) and font size (11), Density after font size,
 * and Reasoning effort labels after the composer's Enter behaviour (20).
 */
export const STUDIO_ROWS = {
  look: { id: LOOK_ROW.id, order: LOOK_ROW.order },
  typeface: { id: 'delorun-typeface', order: 10.5 },
  density: { id: 'delorun-density', order: 11.5 },
  effortLabels: { id: 'delorun-effort-labels', order: 20.5 },
} as const

/** The New Session headline's dictionary namespace. */
export const BRAND_NS = 'delorunBrand'

/** The namespace of the workspace icon picker's copy. */
export const PICKER_NS = 'delorunIconPicker'

/** Services the studio half uses. */
export const inject = ['theme', 'slots', 'locale', 'configForms']

/** One registration set that follows the stored settings. */
interface Registration {
  /**
   * Follow a change of the stored settings.
   * @param stored - the settings the Host last accepted.
   */
  update(stored: ThemeSettings): void
  /** Release everything the set registered. */
  dispose(): void
}

/** Does nothing; the registration sets that follow no setting use it for `update`. */
const noop = (): void => {}

/** The registration set while the Host has not answered: nothing. */
const NOTHING: Registration = { update: noop, dispose: noop }

/**
 * Follow the stored `studioAdditions` setting: the studio additions while it
 * is on, the General row while it is off. Until the settings form first
 * answers, the plugin follows the settings the host half printed into the
 * page, which it prints only while Delorun's look is on, so the look and
 * `ctx.delorunStudio` are in place while the studio boots; without them it
 * registers nothing until that answer. Every registration is released when
 * the setting flips and when the plugin is disposed, which restores
 * upstream's look.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  const form = ctx.configForms.get<ThemeSettings>(THEME_ROW_ID)
  const printed = readBootSettings()
  ctx.effect(() => {
    let mode: 'studio' | 'stock' | undefined
    let active = NOTHING
    let answered = false
    const sync = (): void => {
      const snapshot = form.getSnapshot()
      if (snapshot.status !== 'loading') answered = true
      const stored = snapshot.status === 'ready' ? snapshot.value : answered ? undefined : printed
      const wanted = stored === undefined ? undefined : stored.studioAdditions ? 'studio' : 'stock'
      if (wanted !== mode) {
        active.dispose()
        mode = wanted
        active = stored === undefined ? NOTHING : stored.studioAdditions ? registerStudio(ctx, form, stored) : registerStockEntry(ctx, form)
      }
      if (stored !== undefined) active.update(stored)
    }
    sync()
    const unsubscribe = form.subscribe(sync)
    return () => {
      unsubscribe()
      active.dispose()
      retireFirstPaint(document)
    }
  }, 'delorun-theme: studio additions switch')
}

/**
 * Remove the first-paint style element the host printed into the page, so
 * upstream's colours return at once instead of at the next reload.
 * @param doc - the studio's document.
 */
function retireFirstPaint(doc: Document): void {
  for (const element of doc.querySelectorAll('style')) {
    if (String(element.textContent).startsWith(FIRST_PAINT_MARK)) element.remove()
  }
}

/**
 * The stock look's one registration: the General row that turns the studio
 * additions on, and the removal of a first-paint style the page holds.
 * @param ctx - the plugin's context.
 * @param form - the theme row's settings form.
 * @returns the registration set.
 */
function registerStockEntry(ctx: Context, form: ConfigForm<ThemeSettings>): Registration {
  const root = document.documentElement
  root.setAttribute(STOCK_ATTRIBUTE, '')
  retireFirstPaint(document)
  const disposers = [
    ctx.locale.register(LOOK_ROW.ns, { en: lookEn, zh: lookZh }),
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item', id: LOOK_ROW.id, order: LOOK_ROW.order, locale: LOOK_ROW.ns,
      inject: (): LookRowInjected => ({ settings: form, useDelorunLook: () => form.set('studioAdditions', true) }),
    }, LookRow)),
  ]
  return {
    update: noop,
    dispose: () => {
      for (const dispose of disposers) dispose()
      root.removeAttribute(STOCK_ATTRIBUTE)
    },
  }
}

/**
 * Everything Delorun's look adds: the theme layers and faces, the Appearance and
 * Conversation sections, the Look, Typeface, Density and Reasoning effort
 * labels rows, the New Session headline, Delorun's vocabulary over
 * upstream's texts, and `ctx.delorunStudio`.
 * @param ctx - the plugin's context.
 * @param form - the theme row's settings form.
 * @param initial - the settings the Host last accepted.
 * @returns the registration set, which leaves upstream's look in place again once disposed.
 */
function registerStudio(ctx: Context, form: ConfigForm<ThemeSettings>, initial: ThemeSettings): Registration {
  const controller = new ThemeController(ctx.theme, `${fonts}\n${effortBarsCss()}\n${composerFocusCss()}\n${panelGlyphsCss()}`, document)
  const t = ctx.locale.bind(NS)
  const conversationT = ctx.locale.bind(CONVERSATION.ns)
  const useStockLook = (): Promise<boolean> => form.set('studioAdditions', false)
  const appearance: AppearanceInjected = {
    settings: form,
    brandingT: ctx.locale.bind(BRANDING.ns),
    pickerT: ctx.locale.bind(PICKER_NS),
    scheme: {
      get: () => ctx.theme.getTheme().preference as SchemePreference,
      subscribe: listener => ctx.on('theme/change', () => { listener() }),
      set: (preference) => { ctx.theme.setTheme(preference) },
    },
  }
  const rowFace: AppearanceRowInjected = { settings: form, useStockLook }
  const chat: ConversationInjected = { settings: ctx.configForms.get<ChatDisplaySettings>(CHAT_NAMESPACE) }
  const studio: DelorunStudio = { useStockLook }
  const rows: ReadonlyArray<readonly [{ readonly id: string; readonly order: number }, typeof StudioLookRow]> = [
    [STUDIO_ROWS.look, StudioLookRow],
    [STUDIO_ROWS.typeface, TypefaceRow],
    [STUDIO_ROWS.density, DensityRow],
    [STUDIO_ROWS.effortLabels, EffortLabelsRow],
  ]
  publishBranding(initial.branding)
  controller.update(initial)
  const edges = new EdgeController(document, window)
  const disposers = [
    ctx.on('theme/change', () => { edges.refresh() }),
    installTouchInputs(document),
    ctx.locale.register(NS, { en, zh }),
    ctx.locale.register(CONVERSATION.ns, { en: conversationEn, zh: conversationZh }),
    ctx.locale.register(BRAND_NS, { en: brandEn, zh: brandZh }),
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: () => appearance,
    }, AppearanceSection)),
    ...rows.map(([row, component]) => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item', id: row.id, order: row.order, locale: NS, inject: () => rowFace,
    }, component))),
    ctx.configForms.whileServed([CHAT_NAMESPACE], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: CONVERSATION.id, order: CONVERSATION.order, label: () => conversationT('title'), locale: CONVERSATION.ns, inject: () => chat,
    }, ConversationSection))),
    ctx.locale.register(BRANDING.ns, { en: brandingEn, zh: brandingZh }),
    ctx.locale.register(PICKER_NS, { en: pickerEn, zh: pickerZh }),
    // Priority -2 shadows the Delorun bundle's own brand occupants, which register at -1.
    ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark', priority: -2 }, SidebarBrandMark)),
    ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', priority: -2 }, SidebarBrandName)),
    followBrandingInDocument(document),
    ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark', locale: BRAND_NS }, HeroWordmark)),
    ctx.slots.inject('conversation.hero.headline', () => ctx.slots.register({ name: 'conversation.hero.headline', locale: BRAND_NS }, HeroHeadline)),
    ...Object.entries(VOCABULARY).flatMap(([ns, { en: english, zh: chinese }]) => [ctx.locale.override(ns, 'en', english), ctx.locale.override(ns, 'zh', chinese)]),
    // After the vocabulary, so a hand-written text wins over a generated one.
    ...Object.entries(COPY).map(([ns, english]) => ctx.locale.override(ns, 'en', english)),
    ...Object.entries(COPY_ZH).map(([ns, chinese]) => ctx.locale.override(ns, 'zh', chinese)),
    ctx.provide('delorunStudio', studio),
    markMainLandmark(document),
  ]
  return {
    update: (stored) => { publishBranding(stored.branding); controller.update(stored); edges.refresh() },
    dispose: () => {
      for (const dispose of disposers) dispose()
      controller.dispose()
      edges.dispose()
    },
  }
}
