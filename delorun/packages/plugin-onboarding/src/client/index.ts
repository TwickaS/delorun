/**
 * Delorun's onboarding, studio half: the first minute of the studio as one flow ending in a chat. It is one step of
 * upstream's `settings.onboarding` flow, placed before every other step, so upstream's coordinator decides when it may
 * show. The steps are Welcome (language, the preview notice and the model providers with their key test), Look, Agents,
 * Recommended plugins, Browser while its plugin pack is offered or added, Phone access while reach is not set up, Workspace and Ready; Ready's button opens a new chat in
 * the chosen workspace, whose empty state offers starter prompts that fit the folder and write into the message box.
 * The Workspace step makes a workspace by opening the new-workspace dialog (`ctx.delorunNewWorkspace`) over the guide.
 * It loads only while the Delorun look is on (the `delorunStudio` service exists), so the stock look keeps the preview
 * notice's own step. `ctx.delorunOnboarding` lets other Delorun plugins add steps.
 * @module @delorun/plugin-onboarding/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.sessions merge.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the ctx.workspaces merge and the workspace id.
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: the 'tool.call.toolview' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: the ctx.conversation merge and the 'conversation.input.dock' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.layout merge.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the ctx.pluginNavigation merge.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.configForms and ctx.settingsShell merges and the 'settings.onboarding' and 'settings.general.item' SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.modelKeyStatus merge this plugin provides.
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
// Type-only: the 'sidebar.footer.action' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the ctx.theme merge.
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: the ctx.uiWorkspace merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the ctx.delorunNotice merge and the 'delorunPrivacy' dictionary.
import type {} from '@delorun/bundle-local/client'
// Type-only: the ctx.delorunNewWorkspace merge.
import type {} from '@delorun/plugin-new-workspace/client'
// Type-only: the ctx.delorunStudio merge and the 'settings.delorunAppearance' dictionary.
import type {} from '@delorun/plugin-theme/client'
import { DELEGATION_CONSENT_ROW, type DelegationConsentSettings } from '@delorun/plugin-delegation-consent/wire'
import type { ThemeSettings } from '@delorun/plugin-theme'
import { DEFAULT_SETTINGS, ONBOARDING_ROW_ID, THEME_ROW_ID, type OnboardingSettings } from '../config.ts'
import { NO_RECORD, SETUP_RECORD_PATH, SetupRecord } from '../wire.ts'
import { createPreviewFlagsStore } from '@delorun/preview-flags/client'
import { createBrowserSetup, REAL_BROWSER_BUNDLE } from '@delorun/browser-setup'
import { runBrowserInstall, runBrowserTest } from '@delorun/bundle-local/browser-check-api'
import { BROWSER_DOWNLOAD_KEY, startPageDownload } from '@delorun/plugin-downloads/row'
import { turnBrowserOff } from './browser-pack.ts'
import { BrowserSettings, type BrowserSettingsInjected } from './browser/BrowserSettings.tsx'
import { createBundleInstaller } from './bundles.ts'
import { closeSidebarDrawer } from './focus.ts'
import { hostApi, isLoopbackHostname, readStartId, readWorkspaceNotice } from './host-api.ts'
import { createKeyStatus } from './key-status.ts'
import { DICTIONARIES, type OnboardingLocaleKey } from './locales.ts'
import { createProvidersFace } from './providers-face.ts'
import { OnboardingStepEntry } from './Onboarding.tsx'
import { ShowAgainRow, type ShowAgainInjected } from './ShowAgainRow.tsx'
import { KeyBanner, type KeyBannerInjected } from './KeyBanner.tsx'
import { RenameRow } from './RenameRow.tsx'
import { DeferredSetupEntry, type DeferredSetupInjected } from './DeferredSetupEntry.tsx'
import { SetAsideBanner, type SetAsideInjected } from './SetAsideBanner.tsx'
import type {
  AgentRowSettings, BrowserFace, DelorunOnboarding, NoticeFace, OnboardingInjected, OnboardingStep, SchemePreference, StartFace, StartTarget,
  StaticServices,
} from './types.ts'
import { AGENT_ROWS } from './steps/agent-rows.ts'

export { createBundleInstaller, stateOf } from './bundles.ts'
export type { BundleInstaller, BundleState, BundleView, RowView } from './bundles.ts'
export type { OnboardingStepEntryProps } from './Onboarding.tsx'
export type { OnboardingLocaleKey } from './locales.ts'
export type { ShowAgainInjected, ShowAgainRowProps } from './ShowAgainRow.tsx'
export type { KeyBannerInjected, KeyBannerProps } from './KeyBanner.tsx'
export type { RenameModel, RenameRowProps } from './RenameRow.tsx'
export { renameModel } from './RenameRow.tsx'
export type { SetAsideInjected, SetAsideBannerProps } from './SetAsideBanner.tsx'
export { hostApi, readReach, readReachAddress, readStartId, readWorkspaceNotice, REACH_STATUS_PATH } from './host-api.ts'
export type {
  AddedFolder, AppearanceTranslate, DelorunOnboarding, HostFace, LanguageFace, LookFace, NewWorkspaceOutcome, NoticeFace, OnboardingInjected, OnboardingStep,
  OnboardingStepProps, ReachState, SchemeFace, SchemePreference, StartFace, StartTarget, StaticServices, StepServices,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delorun's onboarding, for other Delorun plugins' setup steps. */
    delorunOnboarding: DelorunOnboarding
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The onboarding's copy. */
    'delorunOnboarding': OnboardingLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'delorunOnboarding'

/** The step's id in upstream's onboarding flow and its place: before the preview notice's own step (-100). */
export const ONBOARDING_STEP = { id: ONBOARDING_ROW_ID, order: -200 } as const

/** The General row that opens onboarding again, by the id Delorun's Settings layout places it under. */
export const SHOW_AGAIN_ROW = { id: ONBOARDING_ROW_ID, order: 50 } as const

/** The `settings.section` id and place of the Browser page: right after the plugin downloads section (16), before Privacy (20). */
export const BROWSER_SECTION = { id: 'delorun-browser', order: 17 } as const

/** The no-key banner's place in the input dock. */
export const KEY_BANNER_ENTRY = { id: 'delorun-onboarding.key-banner', order: 5 } as const

/** The set-aside notice's place in the input dock: beside the no-key banner. */
export const SET_ASIDE_ENTRY = { id: 'delorun-onboarding.set-aside', order: 6 } as const

/** The `sidebar.footer.action` id and order of the entry that counts the steps a phone left for this computer. */
export const DEFERRED_ENTRY = { id: 'delorun-onboarding.deferred-steps', order: 40 } as const

/** The wire name of the model tool whose row {@link RenameRow} draws; `@delorun/plugin-workspaces` defines the tool. */
export const RENAME_TOOL = 'rename_workspace'

/** The id of the PIN mode section in Settings, which bundle-local registers. */
const PIN_MODE_SECTION_ID = 'delorun-pin-mode'
const CHECKING: StartTarget = { kind: 'checking' }
const OTHER: StartTarget = { kind: 'other' }
const NONE: StartTarget = { kind: 'none' }

/**
 * Services every registration needs. `delorunStudio`, which `@delorun/plugin-theme` provides only while the Delorun look is on,
 * is injected inside {@link apply} instead, so the entry stays active under the stock look and registers nothing there.
 * The Settings shell (`settingsShell`) is looked up when Show again is pressed, so the entry also stays active where a
 * plugin turns upstream's general Settings off and draws its own Settings.
 */
export const inject = ['slots', 'locale', 'configForms', 'theme', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings']

/**
 * Read what the terminal setup recorded from the harness. Any failure leaves every step in the flow.
 * @returns the record, or a record that covers nothing when the harness cannot be asked or answers something else.
 */
export async function loadSetupRecord(): Promise<SetupRecord> {
  try {
    const response = await fetch(SETUP_RECORD_PATH.slice(1), { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`answered ${String(response.status)}`)
    return SetupRecord.parse(await response.json())
  } catch (error) {
    console.warn('delorun onboarding: the setup record was not read; every step shows', error)
    return NO_RECORD
  }
}

/**
 * While the Delorun look provides `delorunStudio`, register the dictionaries, the onboarding service, the onboarding step, the General row and the starter prompts.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['delorunStudio'], applyStudio)
}

/**
 * Everything the plugin registers while the Delorun look is on; disposed with the `delorunStudio` service.
 * @param ctx - the browser plugin context, holding `delorunStudio`.
 */
export function applyStudio(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'delorun-onboarding: dictionaries')
  const progress = ctx.configForms.get<OnboardingSettings>(ONBOARDING_ROW_ID)
  const keyT = ctx.locale.bind(NS)
  const keyStatus = createKeyStatus(() => hostApi.keyTest(), () => ({ failed: keyT('keyStatus.failed'), unverified: keyT('keyStatus.unverified'), retry: keyT('keyStatus.retry'), test: keyT('keyStatus.test'), testing: keyT('keyStatus.testing') }))
  ctx.effect(() => ctx.provide('modelKeyStatus', keyStatus), 'delorun-onboarding: key status')
  const extra = createSnapshotStore<readonly OnboardingStep[]>([])
  /** Bumps when a step is deferred or cleared, so the sidebar entry reads again. */
  const deferredChanged = createSnapshotStore(0)
  ctx.effect(() => ctx.provide('delorunOnboarding', {
    registerStep: (step) => {
      extra.set([...extra.getSnapshot().filter(each => each.id !== step.id), step])
      return () => { extra.set(extra.getSnapshot().filter(each => each !== step)) }
    },
  } satisfies DelorunOnboarding), 'delorun-onboarding: service')

  const writeProgress = (field: keyof OnboardingSettings, value: unknown): void => {
    progress.set(field, value).catch((error: unknown) => { console.warn('delorun onboarding: progress was not saved', error) })
  }

  // One read of the preview flags and one copy of Browser's setup for the page, however often the dialog opens.
  const previewFlags = createPreviewFlagsStore()
  const browserSetup = createBrowserSetup((input, init) => globalThis.fetch(input, init), () => ctx.locale.getLocale().active)
  const ownBrowserSetup = createBrowserSetup((input, init) => globalThis.fetch(input, init), () => ctx.locale.getLocale().active, REAL_BROWSER_BUNDLE)

  const browserFace: BrowserFace = {
    setup: browserSetup,
    ownSetup: ownBrowserSetup,
    choice: {
      getSnapshot: () => progress.getSnapshot().value?.browser ?? '',
      subscribe: listener => progress.subscribe(listener),
      // Each choice starts a new observation of the pack, so an earlier `disabled` never reads a later restart as a re-enable.
      record: async (next) => {
        const accepted = await progress.set('browser', next)
        if (accepted) await progress.set('browserPack', '')
        return accepted
      },
    },
    packSeen: {
      getSnapshot: () => progress.getSnapshot().value?.browserPack ?? '',
      subscribe: listener => progress.subscribe(listener),
      record: next => progress.set('browserPack', next),
    },
    fresh: {
      getSnapshot: () => progress.getSnapshot().value?.done === false,
      subscribe: listener => progress.subscribe(listener),
    },
    test: () => runBrowserTest((input, init) => globalThis.fetch(input, init)),
    download: async () => {
      // The browser download runs outside the Host's install queue; the downloads panel shows it from this page.
      const shown = startPageDownload(BROWSER_DOWNLOAD_KEY)
      const answer = await runBrowserInstall((input, init) => globalThis.fetch(input, init))
      if (answer.ok) shown.done()
      else shown.failed(answer.message)
      return answer
    },
    turnOff: () => turnBrowserOff(ctx),
    // Looked up on click, as for the PIN link above.
    openSettings: (section) => { ctx.get('settingsShell')?.openSection(section) },
  }
  /** The preview notice, when bundle-local provides one. */
  const notice = (): NoticeFace | undefined => {
    const service = ctx.get('delorunNotice')
    if (service === undefined) return undefined
    const privacy = ctx.locale.bind('delorunPrivacy')
    return {
      title: () => privacy('notice.title'),
      paragraphs: () => privacy('notice.body').split('\n\n'),
      acknowledged: () => service.acknowledged(),
      acknowledge: () => { service.acknowledge() },
    }
  }
  // One installer for the guide and the Settings Browser page, so an add one starts shows in the other.
  const installer = createBundleInstaller(ctx, {
    addWaitMs: () => (progress.getSnapshot().value?.addWaitSeconds ?? DEFAULT_SETTINGS.addWaitSeconds) * 1000,
    pollMs: 3000,
  })
  const services = (): StaticServices => ({
    notice: notice(),
    language: {
      getSnapshot: () => ctx.locale.getLocale(),
      subscribe: listener => ctx.locale.subscribe(listener),
      setLocale: id => { ctx.locale.setLocale(id) },
    },
    scheme: {
      get: () => ctx.theme.getTheme().preference as SchemePreference,
      subscribe: listener => ctx.on('theme/change', () => { listener() }),
      set: (preference) => { ctx.theme.setTheme(preference) },
    },
    look: {
      settings: ctx.configForms.get<ThemeSettings>(THEME_ROW_ID),
      useStockLook: () => ctx.delorunStudio.useStockLook(),
    },
    appearance: ctx.locale.bind('settings.delorunAppearance'),
    agents: {
      rows: {
        'claude-code': ctx.configForms.get<AgentRowSettings>(AGENT_ROWS['claude-code']),
        'codex': ctx.configForms.get<AgentRowSettings>(AGENT_ROWS.codex),
      },
      limit: ctx.configForms.get<DelegationConsentSettings>(DELEGATION_CONSENT_ROW),
    },
    bundles: installer,
    host: {
      ...hostApi,
      keyTest: () => keyStatus.refresh(),
      defer: async (id, deferred) => {
        const now = await hostApi.defer(id, deferred)
        deferredChanged.set(deferredChanged.getSnapshot() + 1)
        return now
      },
    },
    providers: createProvidersFace(ctx),
    start,
    resolveText: text => ctx.locale.resolveText(text),
    pin: {
      fetch: (input, init) => globalThis.fetch(input, init),
      // Looked up on click, as for the Models link above.
      openSettings: () => { ctx.get('settingsShell')?.openSection(PIN_MODE_SECTION_ID) },
    },
    browser: browserFace,
    previewFlags,
  })

  /** Where the chat opens; the dialog starts resolving it when it opens, and the last button waits for it. */
  const startTarget = createSnapshotStore<StartTarget>(CHECKING)
  let resolution: Promise<StartTarget> | undefined
  /**
   * Ask for the default workspace, which the host creates only while it holds no workspace and no chat and otherwise reuses.
   * @returns where the chat opens; it never rejects.
   */
  const resolveTarget = async (): Promise<StartTarget> => {
    const workspaces = ctx.get('workspaces')
    if (workspaces === undefined) return OTHER
    try {
      const view = await workspaces.initializeDefault()
      if (view !== undefined) return { kind: 'default', workspaceId: view.workspaceId, path: view.path }
    } catch (error) {
      console.warn('delorun onboarding: the default workspace was not resolved', error)
    }
    return workspaces.list.getSnapshot().items.length > 0 ? OTHER : NONE
  }
  const resolve = (): Promise<StartTarget> => {
    startTarget.set(CHECKING)
    const run = resolveTarget()
    resolution = run
    void run.then((target) => { if (resolution === run) startTarget.set(target) })
    return run
  }
  const holdNotice = (): ((told: boolean) => void) => {
    const release = ctx.get('uiWorkspace')?.holdDefaultWorkspaceNotice()
    return (told) => { release?.({ told }) }
  }
  const hasWorkspace = (): boolean => (ctx.get('workspaces')?.list.getSnapshot().items.length ?? 0) > 0
  const start: StartFace = {
    target: startTarget,
    resolve: () => { void resolve() },
    // Read when the Workspace step renders: `delorunNewWorkspace` is not in this plugin's `inject`, so a profile without it
    // still loads onboarding, and the face keeps one identity for the dialog's notice hold.
    get openNewWorkspace() {
      const service = ctx.get('delorunNewWorkspace')
      return service === undefined ? undefined : () => service.open({ from: 'onboarding' })
    },
    holdNotice,
    hasWorkspace,
  }

  /**
   * Open a new chat. Without a workspace the person chose or a default one, the workspace UI's own New Session
   * choice applies.
   */
  const startChat = async (chosen?: WorkspaceId, keepCurrent = false): Promise<void> => {
    const workspace = ctx.get('uiWorkspace')
    if (workspace === undefined) return
    let target = chosen
    if (target === undefined && !keepCurrent) {
      const resolved = await (resolution ?? resolve())
      target = resolved.kind === 'default' ? resolved.workspaceId : undefined
    }
    if (target === undefined) {
      workspace.startSession()
      return
    }
    try {
      await workspace.openWorkspace(target)
    } catch (error) {
      // The workspace UI already told the person why no chat opened.
      console.warn('delorun onboarding: the chat was not opened', error)
    }
  }

  // "Complete setup later" is kept in the home as the id of the start it was pressed in, so a reload or another tab keeps the
  // guide closed and the next start of Delorun shows it again. Where the start id cannot be read, as on a phone, the
  // flag lasts only until the page reloads.
  const laterBase = createSnapshotStore(false)
  // Read the first time it is needed, so a studio that never sets the guide aside does not ask.
  let startRead: Promise<string | undefined> | undefined
  const currentStart = (): Promise<string | undefined> => (startRead ??= readStartId())
  // Set once the person opens the guide again, so a saved pause that has not been cleared yet does not close it.
  let reopened = false
  const syncLater = (): void => {
    const saved = progress.getSnapshot().value?.pausedStart ?? ''
    if (reopened || saved === '') return
    void currentStart().then((id) => { if (!reopened && id === saved) laterBase.set(true) })
  }
  ctx.effect(() => {
    syncLater()
    return progress.subscribe(syncLater)
  }, 'delorun-onboarding: finish later')
  const laterStore = {
    ...laterBase,
    set: (next: boolean, remember = true): void => {
      reopened = !next
      laterBase.set(next)
      if (!remember) return
      void currentStart().then((id) => {
        if (id !== undefined && (next || (progress.getSnapshot().value?.pausedStart ?? '') !== '')) writeProgress('pausedStart', next ? id : '')
      })
    },
  }
  const deferredOnly = createSnapshotStore(false)
  const face = (): OnboardingInjected => ({ progress, extra, loadRecord: loadSetupRecord, services: services(), startChat, aside: laterStore, deferredOnly })
  const deferredEntry: DeferredSetupInjected = {
    host: { reach: hostApi.reach, reachAddress: hostApi.reachAddress, defer: hostApi.defer },
    loadRecord: loadSetupRecord,
    fetch: (input, init) => globalThis.fetch(input, init),
    atComputer: () => isLoopbackHostname(location.hostname),
    progress,
    deferredOnly,
    changed: deferredChanged,
    open: () => {
      laterStore.set(false)
      ctx.get('settingsShell')?.openOnboarding(ONBOARDING_STEP.id)
    },
  }
  const browserPage: BrowserSettingsInjected = {
    services: {
      bundles: installer,
      browser: browserFace,
      // A studio opened from a phone cannot add or turn on packs; the page then points to the computer.
      remote: !isLoopbackHostname(location.hostname),
    },
    // Looked up on click: `settingsShell` is not in this plugin's `inject`, so the property read does not reach the service.
    openPlugins: () => { ctx.get('settingsShell')?.openSection('plugins') },
  }
  const showAgain: ShowAgainInjected = {
    show: () => {
      // Unfinished from its first screen, so a reload shows the guide again, as the explicit opening does now.
      writeProgress('done', false)
      writeProgress('step', '')
      // Without upstream's Settings shell the guide shows at the next reload, because the progress is now unfinished.
      ctx.get('settingsShell')?.openOnboarding(ONBOARDING_STEP.id)
      // On a phone Settings opens from the sidebar drawer, which would stay open beneath the guide.
      const layout = ctx.get('layout')
      if (layout !== undefined) closeSidebarDrawer(document, layout)
    },
  }
  const keyBanner: KeyBannerInjected = {
    keyTest: () => keyStatus.refresh(),
    // Looked up on click: `settingsShell` is not in this plugin's `inject`, so the property read does not reach the service.
    openModels: () => { ctx.get('settingsShell')?.openSection('models') },
  }
  const dismissedStore = createSnapshotStore(false)
  const setAside: SetAsideInjected = {
    setAside: readWorkspaceNotice,
    dismissed: dismissedStore,
    dismiss: () => { dismissedStore.set(true) },
  }
  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: RENAME_TOOL, locale: NS }, RenameRow,
  )), 'delorun-onboarding: rename_workspace row')
  ctx.effect(() => ctx.configForms.whileServed([ONBOARDING_ROW_ID], () => {
    const disposers = [
      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding', id: ONBOARDING_STEP.id, order: ONBOARDING_STEP.order, locale: NS, inject: face,
      }, OnboardingStepEntry)),
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: BROWSER_SECTION.id, order: BROWSER_SECTION.order, label: () => keyT('page.nav'), locale: NS, inject: () => browserPage,
      }, BrowserSettings)),
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item', id: SHOW_AGAIN_ROW.id, order: SHOW_AGAIN_ROW.order, locale: NS, inject: () => showAgain,
      }, ShowAgainRow)),
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: DEFERRED_ENTRY.id, order: DEFERRED_ENTRY.order, locale: NS, inject: () => deferredEntry,
      }, DeferredSetupEntry)),
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: SET_ASIDE_ENTRY.id, order: SET_ASIDE_ENTRY.order, locale: NS, inject: () => setAside,
      }, SetAsideBanner)),
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: KEY_BANNER_ENTRY.id, order: KEY_BANNER_ENTRY.order, locale: NS, inject: () => keyBanner,
      }, KeyBanner)),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }), 'delorun-onboarding: registrations')
}
