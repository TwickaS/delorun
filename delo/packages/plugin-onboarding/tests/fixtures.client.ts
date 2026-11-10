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
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  AddOutcome, FolderBrowse, FolderChoice, LanguageFace, NoticeFace, ReachFace, ReachState, SchemeFace, SchemePreference, StartFace, StartTarget, StepServices,
} from '../src/client/types.ts'

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

/** A workspace id the specs use as the default workspace. */
export const DEFAULT_WORKSPACE = 'workspace-1' as WorkspaceId

/** A reach face over a store: the state `ctx.deloReach` gives, changeable. */
export function reachFace(initial: ReachState = 'unavailable') {
  const store = createSnapshotStore<ReachState>(initial)
  const face: ReachFace = { getSnapshot: store.getSnapshot, subscribe: store.subscribe }
  return { face, set: store.set }
}

/** The home directory the folder listings start at. */
export const HOME = '/home/person'

/**
 * One folder's listing as the host gives it: its ancestors from the filesystem root, and its child folders.
 * @param path - the folder, absolute, without a trailing separator except for the root.
 * @param names - the child folders' names; a dot-led name is hidden.
 * @param truncated - whether the host cut the list.
 * @returns the listing.
 */
export function listingOf(path: string, names: readonly string[], truncated = false): DirectoryListing {
  const parts = path.split('/').filter(part => part !== '')
  const crumbs = [{ name: '/', path: '/', hidden: false }, ...parts.map((part, index) => ({ name: part, path: `/${parts.slice(0, index + 1).join('/')}`, hidden: false }))]
  const base = path === '/' ? '' : path
  return { path, home: HOME, crumbs, entries: names.map(name => ({ name, path: `${base}/${name}`, hidden: name.startsWith('.') })), truncated }
}

/** A host's folders: the home directory with a few folders, each folder empty unless listed here. */
export function browseFake(listings: Readonly<Record<string, DirectoryListing>> = { [HOME]: listingOf(HOME, ['.config', 'notes', 'projects']) }) {
  const list = vi.fn(async (path?: string, _signal?: AbortSignal): Promise<DirectoryListing> => listings[path ?? HOME] ?? listingOf(path ?? HOME, []))
  const create = vi.fn(async (path: string, name: string): Promise<string> => `${path}/${name}`)
  const browse: FolderBrowse = { list, create }
  return { browse, list, create }
}

/** A start face over a store, recording the dialog opening it, the folder chosen or added, and the notice hold. */
export function startFace(
  initial: StartTarget = { kind: 'default', workspaceId: DEFAULT_WORKSPACE },
  choice: FolderChoice = { kind: 'cancelled' },
  outcome: AddOutcome = { kind: 'chosen', workspaceId: DEFAULT_WORKSPACE },
) {
  const store = createSnapshotStore<StartTarget>(initial)
  const resolve = vi.fn()
  const chooseFolder = vi.fn((): Promise<FolderChoice> => Promise.resolve(choice))
  const addFolder = vi.fn((_path: string): Promise<AddOutcome> => Promise.resolve(outcome))
  const folders = browseFake()
  const release = vi.fn((_told: boolean) => {})
  const holdNotice = vi.fn(() => release)
  const face: StartFace = { target: store, resolve, chooseFolder, addFolder, browse: folders.browse, holdNotice }
  return { face, set: store.set, resolve, chooseFolder, addFolder, folders, holdNotice, release }
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
    reach: reachFace().face,
    start: startFace().face,
    resolveText: text => (typeof text === 'string' ? text : text.en),
    spies: bundles,
    ...change,
  }
}
