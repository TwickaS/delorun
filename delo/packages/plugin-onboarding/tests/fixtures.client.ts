/** Test doubles the client specs share: translate stubs, live settings forms and step services. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { vi } from 'vitest'
import { DEFAULT_SETTINGS, type OnboardingSettings } from '../src/config.ts'
import type { BundleInstaller, BundleView } from '../src/client/bundles.ts'
import { en } from '../src/client/locales.ts'
import type { ThemeSettings } from '@delo/plugin-theme'
import type { LanguageFace, NoticeFace, SchemeFace, SchemePreference, StepServices } from '../src/client/types.ts'

/** This plugin's copy. */
export const t: StepServices['t'] = makeTranslate(en)

/** The theme's labels the look step shows, as the theme words them. */
export const appearance: StepServices['appearance'] = makeTranslate({
  'mode': 'Mode', 'mode.light': 'Light', 'mode.dark': 'Dark', 'mode.system': 'System',
  'palette': 'Theme', 'palette.soft': 'Soft', 'palette.t3-code': 'T3 Code', 'palette.t3-chat': 'T3 Chat', 'palette.grove': 'Grove',
  'palette.ocean': 'Ocean', 'palette.ember': 'Ember', 'palette.iris': 'Iris',
  'accent': 'Accent', 'accent.peach': 'Peach', 'accent.cobalt': 'Cobalt', 'accent.moss': 'Moss', 'accent.mono': 'Mono',
  'accent.byTheme': 'Set by the theme. Choose Soft to pick your own.',
  'look.delo': 'Delo', 'look.stock': 'Stock',
})

/** A settings form that keeps what is written, as the settings service does. */
export function liveForm<T extends object>(initial: T | undefined, options: { readonly writable?: boolean; readonly result?: boolean | 'reject'; readonly status?: ConfigFormSnapshot<T>['status'] } = {}) {
  let snapshot: ConfigFormSnapshot<T> = {
    status: options.status ?? (initial === undefined ? 'loading' : 'ready'), value: initial, base: undefined, user: undefined, revision: 1, writable: options.writable ?? true,
  }
  const listeners = new Set<() => void>()
  const publish = (next: Partial<ConfigFormSnapshot<T>>): void => {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }
  const set = vi.fn((field: string, value: unknown): Promise<boolean> => {
    if (options.result === 'reject') return Promise.reject(new Error('transport'))
    if (options.result === false) return Promise.resolve(false)
    publish({ value: { ...snapshot.value, [field]: value } as T })
    return Promise.resolve(true)
  })
  const form: ConfigForm<T> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set, unset: () => Promise.resolve(true), mutate: () => Promise.resolve(true),
  }
  return { form, set, publish, listeners, value: () => snapshot.value }
}

/** Delo's look with its defaults, as the theme's host half stores it. */
export const THEME: ThemeSettings = {
  accent: 'peach', customAccent: '#E5734A', typeface: 'delo', density: 'comfortable', studioAdditions: true, palette: 'soft', contrast: 100, effort: 'label',
}

/** The row's settings with some fields changed. */
export const settings = (change: Partial<OnboardingSettings> = {}): OnboardingSettings => ({ ...DEFAULT_SETTINGS, ...change })

/** The two languages a browser offers. */
export const LOCALES: LocaleSnapshot = {
  active: 'en', revision: 1,
  locales: [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文', fallback: 'en' }],
}

/** A language face over a store, recording the language chosen. */
export function languageFace() {
  const store = createSnapshotStore(LOCALES)
  const setLocale = vi.fn((id: string) => { store.set({ ...store.getSnapshot(), active: id, revision: store.getSnapshot().revision + 1 }) })
  const face: LanguageFace = { getSnapshot: store.getSnapshot, subscribe: store.subscribe, setLocale }
  return { face, setLocale }
}

/** A colour-scheme face over a store. */
export function schemeFace(initial: SchemePreference = 'system') {
  const store = createSnapshotStore<SchemePreference>(initial)
  const set = vi.fn((preference: SchemePreference) => { store.set(preference) })
  const face: SchemeFace = { get: store.getSnapshot, subscribe: store.subscribe, set }
  return { face, set }
}

/** A notice face with the copy bundle-local gives, recording the acknowledgement. */
export function noticeFace(acknowledged = false) {
  let done = acknowledged
  const acknowledge = vi.fn(() => { done = true })
  const face: NoticeFace = {
    title: () => 'Preview',
    paragraphs: () => ['Delo is a pre-release community fork.', 'It has no telemetry of its own.'],
    acknowledged: () => done,
    acknowledge,
  }
  return { face, acknowledge }
}

/** A bundle installer over a store, recording what it is asked. */
export function installerFake(views: Readonly<Record<string, BundleView>> = {}) {
  const store = createSnapshotStore<Readonly<Record<string, BundleView>>>(views)
  const refresh = vi.fn()
  const install = vi.fn(() => Promise.resolve())
  const openPlugins = vi.fn()
  const installer: BundleInstaller = { views: store, refresh, install, openPlugins }
  return { installer, store, refresh, install, openPlugins }
}

/** Step services with every part faked; each can be replaced. */
export function stepServices(change: Partial<StepServices> = {}): StepServices & { readonly spies: ReturnType<typeof installerFake> } {
  const bundles = installerFake()
  const theme = liveForm<ThemeSettings>(THEME)
  return {
    t, appearance, plugins: [],
    notice: undefined,
    language: languageFace().face,
    scheme: schemeFace().face,
    look: { settings: theme.form, useStockLook: () => Promise.resolve(true) },
    bundles: bundles.installer,
    resolveText: text => (typeof text === 'string' ? text : text.en),
    spies: bundles,
    ...change,
  }
}
