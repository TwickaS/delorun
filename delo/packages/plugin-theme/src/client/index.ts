/**
 * Studio half of Delo's theme and the owner of C16 switch `studio_additions`
 * (the `studioAdditions` setting). While the switch is on it applies the
 * theme settings (the palette, the accent and the type as override layers on
 * upstream's theme, plus Delo's font faces), registers the Appearance and
 * Conversation sections of Settings, Delo's New Session headline and Delo's
 * vocabulary, and provides `ctx.deloStudio`, which Delo's other studio
 * plugins list in `inject`, so turning the switch off unloads them all and
 * leaves upstream's studio. While it is off the plugin registers one thing, a
 * row in Settings → General that turns it back on, and nothing else is
 * visible. Light, dark and system stay upstream's preference.
 * @module @delo/plugin-theme/client
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
// Type-only: the 'conversation.hero.headline' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { THEME_ROW_ID, type ThemeSettings } from '../config.ts'
import { STOCK_ATTRIBUTE } from '../palette/layers.ts'
import { AppearanceSection, type AppearanceInjected, type SchemePreference } from './AppearanceSection.tsx'
import { HeroHeadline } from './brand.tsx'
import { en as brandEn, zh as brandZh, type BrandLocaleKey } from './brand-locales.ts'
import { ThemeController } from './controller.ts'
import { effortBarsCss } from './effort.ts'
import { COPY } from './copy.ts'
import { VOCABULARY } from './vocabulary.ts'
import fonts from './fonts.css?inline'
import { CHAT_NAMESPACE, type ChatDisplaySettings } from './conversation.ts'
import { en as conversationEn, zh as conversationZh, type ConversationLocaleKey } from './conversation-locales.ts'
import { ConversationSection, type ConversationInjected } from './ConversationSection.tsx'
import { en, zh, type AppearanceLocaleKey } from './locales.ts'
import { en as lookEn, zh as lookZh, type LookLocaleKey } from './look-locales.ts'
import { LookRow, type LookRowInjected } from './LookRow.tsx'

export { LAYERS, PLUGIN_ID, ThemeController } from './controller.ts'
export {
  ACCENT_CHOICES, CONTRAST, DEFAULT_SETTINGS, DENSITIES, EFFORT_DISPLAYS, PALETTES, THEME_ROW_ID, TYPEFACES,
  type AccentChoice, type Density, type EffortDisplay, type PaletteChoice, type ThemeSettings, type Typeface,
} from '../config.ts'
export { STOCK_ATTRIBUTE } from '../palette/layers.ts'
export type { ConversationInjected, ConversationSectionProps } from './ConversationSection.tsx'
export type { ConversationLocaleKey } from './conversation-locales.ts'
export type { AppearanceInjected, AppearanceSectionProps, SchemePreference } from './AppearanceSection.tsx'
export type { AppearanceLocaleKey } from './locales.ts'
export type { BrandLocaleKey } from './brand-locales.ts'
export type { LookLocaleKey } from './look-locales.ts'
export type { LookRowInjected, LookRowProps } from './LookRow.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delo's studio additions, present while C16 switch `studio_additions` is on; a Delo studio plugin lists it in `inject`, so the stock look unloads it. */
    deloStudio: DeloStudio
  }
}

/** What `ctx.deloStudio` shares. */
export interface DeloStudio {
  /**
   * Turn the studio additions off, which withdraws this service and so unloads every plugin that requires it.
   * @returns whether the Host accepted the write.
   */
  useStockLook(): Promise<boolean>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Appearance section's copy. */
    'settings.deloAppearance': AppearanceLocaleKey
    /** The Conversation section's copy. */
    'settings.deloConversation': ConversationLocaleKey
    /** The General row's copy. */
    'settings.deloLook': LookLocaleKey
    /** The New Session headline's copy. */
    'deloBrand': BrandLocaleKey
  }
}

/** Dictionary namespace of the Appearance section. */
export const NS = 'settings.deloAppearance'

/** The Appearance section's id in Settings. */
export const SECTION_ID = 'delo-appearance'

/** Its place in Settings: right after General (0). */
export const SECTION_ORDER = 1

/** The Conversation section's id, its dictionary namespace and its place, after Appearance. */
export const CONVERSATION = { id: 'delo-conversation', ns: 'settings.deloConversation', order: 2 } as const

/** The General row that turns the studio additions on again: its id, dictionary namespace and place, after Language (0). */
export const LOOK_ROW = { id: 'delo-look', ns: 'settings.deloLook', order: 1 } as const

/** The New Session headline's dictionary namespace. */
export const BRAND_NS = 'deloBrand'

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
 * is on, the General row while it is off, and nothing until the Host has
 * answered. Every registration is released when the setting flips and when
 * the plugin is disposed, which restores upstream's look.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  const form = ctx.configForms.get<ThemeSettings>(THEME_ROW_ID)
  ctx.effect(() => {
    let mode: 'studio' | 'stock' | undefined
    let active = NOTHING
    const sync = (): void => {
      const snapshot = form.getSnapshot()
      const stored = snapshot.status === 'ready' ? snapshot.value : undefined
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
    }
  }, 'delo-theme: studio additions switch')
}

/**
 * The stock look's one registration: the General row that turns the studio
 * additions on, and the mark that retires a first-paint style the page holds.
 * @param ctx - the plugin's context.
 * @param form - the theme row's settings form.
 * @returns the registration set.
 */
function registerStockEntry(ctx: Context, form: ConfigForm<ThemeSettings>): Registration {
  const root = document.documentElement
  root.setAttribute(STOCK_ATTRIBUTE, '')
  const disposers = [
    ctx.locale.register(LOOK_ROW.ns, { en: lookEn, zh: lookZh }),
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item', id: LOOK_ROW.id, order: LOOK_ROW.order, locale: LOOK_ROW.ns,
      inject: (): LookRowInjected => ({ settings: form, useDeloLook: () => form.set('studioAdditions', true) }),
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
 * Everything Delo's look adds: the theme layers and faces, the Appearance and
 * Conversation sections, the New Session headline, Delo's vocabulary over
 * upstream's texts, and `ctx.deloStudio`.
 * @param ctx - the plugin's context.
 * @param form - the theme row's settings form.
 * @param initial - the settings the Host last accepted.
 * @returns the registration set, which leaves upstream's look in place again once disposed.
 */
function registerStudio(ctx: Context, form: ConfigForm<ThemeSettings>, initial: ThemeSettings): Registration {
  const controller = new ThemeController(ctx.theme, `${fonts}\n${effortBarsCss()}`, document)
  const t = ctx.locale.bind(NS)
  const conversationT = ctx.locale.bind(CONVERSATION.ns)
  const appearance: AppearanceInjected = {
    settings: form,
    useStockLook: () => form.set('studioAdditions', false),
    scheme: {
      get: () => ctx.theme.getTheme().preference as SchemePreference,
      subscribe: listener => ctx.on('theme/change', () => { listener() }),
      set: (preference) => { ctx.theme.setTheme(preference) },
    },
  }
  const chat: ConversationInjected = { settings: ctx.configForms.get<ChatDisplaySettings>(CHAT_NAMESPACE) }
  const studio: DeloStudio = { useStockLook: () => form.set('studioAdditions', false) }
  controller.update(initial)
  const disposers = [
    ctx.locale.register(NS, { en, zh }),
    ctx.locale.register(CONVERSATION.ns, { en: conversationEn, zh: conversationZh }),
    ctx.locale.register(BRAND_NS, { en: brandEn, zh: brandZh }),
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: () => appearance,
    }, AppearanceSection)),
    ctx.configForms.whileServed([CHAT_NAMESPACE], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: CONVERSATION.id, order: CONVERSATION.order, label: () => conversationT('title'), locale: CONVERSATION.ns, inject: () => chat,
    }, ConversationSection))),
    ctx.slots.inject('conversation.hero.headline', () => ctx.slots.register({ name: 'conversation.hero.headline', locale: BRAND_NS }, HeroHeadline)),
    ...Object.entries(VOCABULARY).flatMap(([ns, { en: english, zh: chinese }]) => [ctx.locale.override(ns, 'en', english), ctx.locale.override(ns, 'zh', chinese)]),
    // After the vocabulary, so a hand-written text wins over a generated one.
    ...Object.entries(COPY).map(([ns, english]) => ctx.locale.override(ns, 'en', english)),
    ctx.provide('deloStudio', studio),
  ]
  return {
    update: (stored) => { controller.update(stored) },
    dispose: () => {
      for (const dispose of disposers) dispose()
      controller.dispose()
    },
  }
}
