/** Test doubles the client specs share: translate stubs, live settings forms and step services. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { vi } from 'vitest'
import { DEFAULT_SETTINGS, type OnboardingSettings } from '../src/config.ts'
import type { BrowserReadiness, BrowserSetupStore } from '@delorun/browser-setup'
import type { BrowserInstallAnswer, BrowserTestAnswer } from '@delorun/bundle-local/browser-check-api'
import type { TurnOffOutcome } from '../src/client/browser-pack.ts'
import type { BundleInstaller, BundleView, RowView } from '../src/client/bundles.ts'
import { en } from '../src/client/locales.ts'
import type { DelegationConsentSettings } from '@delorun/plugin-delegation-consent/wire'
import type { PreviewFlagsStore, PreviewFlagView } from '@delorun/preview-flags/client'
import type { ThemeSettings } from '@delorun/plugin-theme'
import { DEFAULT_SETTINGS as THEME_DEFAULTS } from '../../plugin-theme/src/config.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentModelsAnswer, DeferrableStep, KeyTestAnswer, LocalServer, Readiness, RecommendAnswer } from '../src/wire.ts'
import type {
  AgentRowSettings, AgentsFace, BrowserFace, CustomEndpoint, HostFace, LanguageFace, NewWorkspaceOutcome, NoticeFace, ProvidersFace, ReachState, SchemeFace, SchemePreference, StartFace, StartTarget, StepServices,
} from '../src/client/types.ts'
import type { DirectoryEntry, KeyProbe } from '../src/client/providers.ts'
import { DIRECTORY } from './directory.fixture.ts'

/** This plugin's copy. */
export const t: StepServices['t'] = makeTranslate(en)

/** The theme's labels the look step shows, as the theme words them. */

export const appearance: StepServices['appearance'] = makeTranslate({
  'mode': 'Mode', 'mode.light': 'Light', 'mode.dark': 'Dark', 'mode.system': 'System',
  'palette': 'Theme', 'palette.soft': 'Soft', 'palette.t3-code': 'T3 Code', 'palette.t3-chat': 'T3 Chat', 'palette.grove': 'Grove',
  'palette.ocean': 'Ocean', 'palette.ember': 'Ember', 'palette.iris': 'Iris', 'palette.custom': 'Custom',
  'accent': 'Accent', 'accent.peach': 'Peach', 'accent.cobalt': 'Cobalt', 'accent.moss': 'Moss', 'accent.mono': 'Mono', 'accent.custom': 'Custom',
  'accent.customColor': 'Custom accent colour', 'accent.hex': 'Hex colour', 'accent.hexInvalid': 'Use six hex digits.',
  'look.delorun': 'Delorun', 'look.stock': 'Stock',
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
  const unset = vi.fn((field: string): Promise<boolean> => {
    publish({ value: { ...snapshot.value, [field]: undefined } as T })
    return Promise.resolve(true)
  })
  const set = vi.fn((field: string, value: unknown): Promise<boolean> => {
    if (options.result === 'reject') return Promise.reject(new Error('transport'))
    if (options.result === false) return Promise.resolve(false)
    publish({ value: { ...snapshot.value, [field]: value } as T })
    return Promise.resolve(true)
  })
  const form: ConfigForm<T> = {
    getSnapshot: () => snapshot,
    // The real form is a class instance whose subscribe reads `this`, so a call that detaches it fails here too.
    subscribe(this: ConfigForm<T>, listener) {
      if (this !== form) throw new TypeError('subscribe was called without its form')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set, unset,
    mutate: (ops) => {
      if (options.result === 'reject') return Promise.reject(new Error('transport'))
      if (options.result === false) return Promise.resolve(false)
      publish({ value: { ...snapshot.value, ...Object.fromEntries(ops.flatMap(op => op.op === 'set' ? [[op.path[0], op.value]] : [])) } as T })
      return Promise.resolve(true)
    },
  }
  return { form, set, unset, publish, listeners, value: () => snapshot.value }
}

/** Delorun's look with its defaults, as the theme's host half stores it. */
export const THEME: ThemeSettings = {
  accent: 'peach', customAccent: '#E5734A', typeface: 'delorun', density: 'comfortable', studioAdditions: true, palette: 'soft', contrast: 100, effort: 'label', toastPosition: 'bottom-left', branding: THEME_DEFAULTS.branding,
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
    paragraphs: () => ['Delorun is a pre-release community fork.', 'It has no telemetry of its own.'],
    acknowledged: () => done,
    acknowledge,
  }
  return { face, acknowledge }
}

/** A bundle installer over a store, recording what it is asked. */
export function installerFake(views: Readonly<Record<string, BundleView>> = {}, rows: Readonly<Record<string, RowView>> = {}) {
  const store = createSnapshotStore<Readonly<Record<string, BundleView>>>(views)
  const refresh = vi.fn()
  const install = vi.fn(() => Promise.resolve())
  const openPlugins = vi.fn()
  const rowStore = createSnapshotStore<Readonly<Record<string, RowView>>>(rows)
  const refreshRows = vi.fn()
  const enableRow = vi.fn(() => Promise.resolve())
  const installer: BundleInstaller = { views: store, refresh, install, rows: rowStore, refreshRows, enableRow, openPlugins }
  return { installer, store, refresh, install, rowStore, refreshRows, enableRow, openPlugins }
}

/** A workspace id the specs use as the default workspace. */
export const DEFAULT_WORKSPACE = 'workspace-1' as WorkspaceId

/** The default workspace's folder in the specs. */
export const DEFAULT_PATH = '/home/person/Delorun'

/**
 * A text matcher for a path the card breaks into parts after each slash.
 * @param path - the whole path.
 * @returns a matcher for `getByText` that finds the element holding the whole path.
 */
export const pathText = (path: string) => (_content: string, element: Element | null): boolean => element?.textContent === path

/** A computer with both agents signed in and Tailscale ready. */
export const READY: Readiness = { agents: { 'claude-code': 'found', 'codex': 'found' }, tailscale: { state: 'ready', dnsName: 'box.example.ts.net' } }

/** One DeepSeek key that works. */
export const KEYS: KeyTestAnswer = { providers: [{ provider: 'deepseek-official', name: 'DeepSeek', result: 'works' }] }

/** The harness's routes, each a spy that answers what it is given. */
export function hostFake(change: {
  readonly readiness?: Readiness | undefined
  readonly keys?: KeyTestAnswer | undefined
  readonly recommend?: RecommendAnswer | undefined
  readonly agentModels?: AgentModelsAnswer
  readonly reach?: ReachState
  readonly reachAddress?: string | undefined
  readonly localModels?: readonly LocalServer[] | undefined
} = {}) {
  const deferred = new Set<DeferrableStep>()
  const readiness = vi.fn(() => Promise.resolve('readiness' in change ? change.readiness : READY))
  const keyTest = vi.fn(() => Promise.resolve('keys' in change ? change.keys : KEYS))
  const localModels = vi.fn(() => Promise.resolve('localModels' in change ? change.localModels : []))
  const recommend = vi.fn((_registry: boolean) => Promise.resolve('recommend' in change ? change.recommend : { plugins: [], registry: 'not-asked' as const }))
  const reach = vi.fn(() => Promise.resolve(change.reach ?? 'absent'))
  const reachAddress = vi.fn(() => Promise.resolve(change.reachAddress))
  const agentModels = vi.fn((_agent: 'claude-code' | 'codex') => Promise.resolve(change.agentModels ?? { state: 'unavailable' as const, reason: 'not-running' as const }))
  const defer = vi.fn((id: DeferrableStep, on: boolean) => {
    if (on) deferred.add(id)
    else deferred.delete(id)
    return Promise.resolve([...deferred] as readonly DeferrableStep[] | undefined)
  })
  const host: HostFace = { agentModels, readiness, keyTest, localModels, recommend, reach, reachAddress, defer }
  return { host, agentModels, readiness, keyTest, localModels, recommend, reach, reachAddress, defer }
}

/** The home directory the folder listings start at. */
export const HOME = '/home/person'

/**
 * A start face over a store, recording the dialog opening, the new-workspace dialog and the notice hold.
 * @param initial - where the chat opens.
 * @param outcome - how the new-workspace dialog ends, or `absent` for a profile without it.
 * @param hasWorkspace - whether the studio already holds a workspace.
 * @returns the face and its spies.
 */
export function startFace(
  initial: StartTarget = { kind: 'default', workspaceId: DEFAULT_WORKSPACE, path: DEFAULT_PATH },
  outcome: NewWorkspaceOutcome | 'absent' = { kind: 'cancelled' },
  hasWorkspace = true,
) {
  const store = createSnapshotStore<StartTarget>(initial)
  const resolve = vi.fn()
  const openNewWorkspace = vi.fn((): Promise<NewWorkspaceOutcome> => Promise.resolve(outcome === 'absent' ? { kind: 'cancelled' } : outcome))
  const release = vi.fn((_told: boolean) => {})
  const holdNotice = vi.fn(() => release)
  const face: StartFace = { target: store, resolve, openNewWorkspace: outcome === 'absent' ? undefined : openNewWorkspace, holdNotice, hasWorkspace: () => hasWorkspace }
  return { face, set: store.set, resolve, openNewWorkspace, holdNotice, release }
}

/** The providers service with every call a spy; each can be replaced. */
export function providersFake(change: { readonly directory?: readonly DirectoryEntry[] | undefined; readonly probe?: KeyProbe; readonly save?: boolean; readonly declareLocal?: boolean; readonly declareCustom?: boolean } = {}) {
  const directory = vi.fn(() => Promise.resolve('directory' in change ? change.directory : DIRECTORY))
  const probe = vi.fn((_entry: DirectoryEntry, _key: string, _baseURL: string | undefined) => Promise.resolve(change.probe ?? { kind: 'works', models: 12, defaultModel: 'deepseek-chat' } as KeyProbe))
  const save = vi.fn((_entry: DirectoryEntry, _key: string, _baseURL: string | undefined) => Promise.resolve(change.save ?? true))
  const declareLocal = vi.fn((_server: LocalServer) => Promise.resolve(change.declareLocal ?? true))
  const declareCustom = vi.fn((_request: CustomEndpoint) => Promise.resolve(change.declareCustom ?? true))
  const face: ProvidersFace = { directory, probe, save, declareLocal, declareCustom }
  return { face, directory, probe, save, declareLocal, declareCustom }
}

/**
 * The agents' settings forms, faked.
 * @param options - whether the agents' rows exist, and the saved time limit.
 * @returns each form with its spies, and the face made of them.
 */
export function agentsFake(options: { readonly rows?: boolean; readonly minutes?: number } = {}) {
  const claude = liveForm<AgentRowSettings>(options.rows === false ? undefined : {}, { status: options.rows === false ? 'unavailable' : 'ready' })
  const codex = liveForm<AgentRowSettings>(options.rows === false ? undefined : {}, { status: options.rows === false ? 'unavailable' : 'ready' })
  const limit = liveForm<DelegationConsentSettings>({ enabled: true, runTimeoutMinutes: options.minutes ?? 30, fullAccessStartsAgents: true, claudeCodeLevel: 'standard', codexLevel: 'standard' })
  return { claude, codex, limit, face: { rows: { 'claude-code': claude.form, 'codex': codex.form }, limit: limit.form } satisfies AgentsFace }
}

/**
 * Browser's setup over a store: `refresh` answers the queued states in order and then repeats the last.
 * @param states - where Browser stands at each read; `checking` until the first.
 * @returns the face, its store's setter and the spies.
 */
export function browserFake(...states: readonly BrowserReadiness[]) {
  const store = createSnapshotStore<BrowserReadiness>({ kind: 'checking' })
  const queue = [...states.length === 0 ? [{ kind: 'not-added' } as const] : states]
  const refresh = vi.fn((): Promise<BrowserReadiness> => {
    const next = (queue.length > 1 ? queue.shift() : queue[0]) as BrowserReadiness
    store.set(next)
    return Promise.resolve(next)
  })
  const openSettings = vi.fn((_section: string) => {})
  const setup: BrowserSetupStore = { getSnapshot: store.getSnapshot, subscribe: store.subscribe, refresh }
  /** The own-Chrome pack's readiness, which a spec sets. */
  const own = createSnapshotStore<BrowserReadiness>({ kind: 'not-added' })
  const ownRefresh = vi.fn((): Promise<BrowserReadiness> => Promise.resolve(own.getSnapshot()))
  const ownSetup: BrowserSetupStore = { getSnapshot: own.getSnapshot, subscribe: own.subscribe, refresh: ownRefresh }
  /** How turning Browser off ends; a spec replaces it. */
  const outcome: { value: TurnOffOutcome } = { value: 'off' }
  const turnOff = vi.fn(() => Promise.resolve(outcome.value))
  /** What the person recorded: empty, `on` or `off`; recording stores it, and a spec can make the Host refuse. */
  const recorded = createSnapshotStore('')
  const accepted: { value: boolean } = { value: true }
  /** What the pack was last seen as while off; recording a choice clears it, as the real face does. */
  const packSeen = createSnapshotStore<'' | 'enabled' | 'disabled'>('')
  const record = vi.fn((next: 'on' | 'off') => {
    if (accepted.value) { recorded.set(next); packSeen.set('') }
    return Promise.resolve(accepted.value)
  })
  const recordSeen = vi.fn((next: 'enabled' | 'disabled') => { packSeen.set(next); return Promise.resolve(true) })
  /** Whether the home is new (setup not finished); a spec sets it. A home is new unless a spec says otherwise. */
  const fresh = createSnapshotStore(true)
  const test = vi.fn((): Promise<BrowserTestAnswer> => Promise.resolve({ ok: true, image: 'data:image/png;base64,iVBORw0KGgo=', title: 'Delorun browser test' }))
  const download = vi.fn((): Promise<BrowserInstallAnswer> => Promise.resolve({ ok: true }))
  const face: BrowserFace = { setup, ownSetup, choice: { getSnapshot: recorded.getSnapshot, subscribe: recorded.subscribe, record }, packSeen: { getSnapshot: packSeen.getSnapshot, subscribe: packSeen.subscribe, record: recordSeen }, fresh: { getSnapshot: fresh.getSnapshot, subscribe: fresh.subscribe }, test, download, openSettings, turnOff }
  return { face, set: store.set, setOwn: own.set, refresh, ownRefresh, openSettings, turnOff, outcome, recorded, record, accepted, fresh, packSeen, recordSeen, test, download }
}

/**
 * The page's preview flags, already read.
 * @param on - the flag ids that are declared and on.
 * @returns the store.
 */
export function flagsFake(...on: readonly string[]): PreviewFlagsStore {
  const flags: PreviewFlagView[] = on.map(id => ({ id, kind: 'boolean', owner: '@delorun/plugin-onboarding', title: { en: id, zh: id }, description: { en: id, zh: id }, on: true }))
  const snapshot = { status: 'ready' as const, flags }
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, load: () => Promise.resolve(), refresh: () => Promise.resolve() }
}

/** Step services with every part faked; each can be replaced. */
export function stepServices(change: Partial<StepServices> = {}): StepServices & { readonly spies: ReturnType<typeof installerFake> } {
  const bundles = installerFake()
  const theme = liveForm<ThemeSettings>(THEME)
  return {
    agents: agentsFake().face,
    t, appearance, remote: false, plugins: [], optionalRows: [],
    notice: undefined,
    language: languageFace().face,
    scheme: schemeFace().face,
    look: { settings: theme.form, useStockLook: () => Promise.resolve(true) },
    bundles: bundles.installer,
    host: hostFake().host,
    providers: providersFake().face,
    start: startFace().face,
    renderSection: (id: string) => `section ${id}`,
    resolveText: text => (typeof text === 'string' ? text : text.en),
    pin: { fetch: () => Promise.reject(new Error('no PIN requests in this spec')), openSettings: () => undefined },
    browser: browserFake().face,
    previewFlags: flagsFake(),
    spies: bundles,
    ...change,
  }
}
