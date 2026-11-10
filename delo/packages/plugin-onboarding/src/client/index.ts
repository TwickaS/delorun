/**
 * Delo's onboarding, studio half: the first minute of the studio as one flow ending in a chat. It is one step of
 * upstream's `settings.onboarding` flow, placed before every other step, so upstream's coordinator decides when it may
 * show. The steps are the preview notice, language and look, agents, recommended plugins and, where `ctx.deloReach`
 * says reach is available and not set up, reach; the last button opens a new chat in the default workspace, whose empty
 * state offers starter prompts that write into the message box. Where no default workspace resolves, the button
 * chooses a folder first.
 * It loads only while the Delo look is on (the `deloStudio` service exists), so the stock look keeps the preview
 * notice's own step. `ctx.deloOnboarding` lets other Delo plugins add steps.
 * @module @delo/plugin-onboarding/client
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
// Type-only: the ctx.conversation merge and the 'conversation.input.dock' SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ctx.pluginNavigation merge.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.configForms and ctx.settingsShell merges and the 'settings.onboarding' and 'settings.general.item' SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.theme merge.
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: the ctx.uiWorkspace merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the ctx.deloNotice merge and the 'deloPrivacy' dictionary.
import type {} from '@delo/bundle-local/client'
// Type-only: the ctx.deloStudio merge and the 'settings.deloAppearance' dictionary.
import type {} from '@delo/plugin-theme/client'
// Type-only: the ctx.deloSidebar merge.
import type {} from '@delo/plugin-sidebar/client'
import type { ThemeSettings } from '@delo/plugin-theme'
import { ONBOARDING_ROW_ID, PENDING_STARTERS, THEME_ROW_ID, type OnboardingSettings } from '../config.ts'
import { NO_RECORD, SETUP_RECORD_PATH, SetupRecord } from '../wire.ts'
import { createBundleInstaller } from './bundles.ts'
import { en, zh, type OnboardingLocaleKey } from './locales.ts'
import { OnboardingStepEntry } from './Onboarding.tsx'
import { ShowAgainRow, type ShowAgainInjected } from './ShowAgainRow.tsx'
import { StarterPrompts, type StarterInjected } from './StarterPrompts.tsx'
import type {
  DeloOnboarding, DeloReach, FolderChoice, NoticeFace, OnboardingInjected, OnboardingStep, ReachFace, ReachState, SchemePreference, SidebarWorkspaceAdder, StartFace, StartTarget, StaticServices,
} from './types.ts'

export { createBundleInstaller, stateOf } from './bundles.ts'
export type { BundleInstaller, BundleState, BundleView } from './bundles.ts'
export type { OnboardingStepEntryProps } from './Onboarding.tsx'
export type { OnboardingLocaleKey } from './locales.ts'
export type { ShowAgainInjected, ShowAgainRowProps } from './ShowAgainRow.tsx'
export type { StarterInjected, StarterPromptsProps } from './StarterPrompts.tsx'
export type {
  AppearanceTranslate, DeloOnboarding, DeloReach, FolderChoice, LanguageFace, LookFace, NoticeFace, OnboardingInjected, OnboardingStep, OnboardingStepProps, ReachFace, ReachState,
  SchemeFace, SchemePreference, StartFace, StartTarget, StaticServices, StepServices,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delo's onboarding, for other Delo plugins' setup steps. */
    deloOnboarding: DeloOnboarding
    /** Reach, where this installation can turn it on; provided by the reach plugin, absent otherwise. */
    deloReach: DeloReach
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The onboarding's copy. */
    'deloOnboarding': OnboardingLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'deloOnboarding'

/** The step's id in upstream's onboarding flow and its place: before the preview notice's own step (-100). */
export const ONBOARDING_STEP = { id: ONBOARDING_ROW_ID, order: -200 } as const

/** The General row that opens onboarding again, by the id Delo's Settings layout places it under. */
export const SHOW_AGAIN_ROW = { id: ONBOARDING_ROW_ID, order: 50 } as const

/** The starter prompts' place in the input dock: just above the message box. */
export const STARTER_ENTRY = { id: 'delo-onboarding.starters', order: 10 } as const

const CHECKING: StartTarget = { kind: 'checking' }
const OTHER: StartTarget = { kind: 'other' }
const NONE: StartTarget = { kind: 'none' }

/**
 * Services every registration needs. `settingsShell` is the Settings shell's, which also hosts the onboarding step and
 * is provided under every look. `deloStudio`, which `@delo/plugin-theme` provides only while the Delo look is on, is
 * injected inside {@link apply} instead, so the entry stays active under the stock look and registers nothing there.
 */
export const inject = ['slots', 'locale', 'configForms', 'theme', 'settingsShell']

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
    console.warn('delo onboarding: the setup record was not read; every step shows', error)
    return NO_RECORD
  }
}

/**
 * While the Delo look provides `deloStudio`, register the dictionaries, the onboarding service, the onboarding step, the General row and the starter prompts.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['deloStudio'], applyStudio)
}

/**
 * Everything the plugin registers while the Delo look is on; disposed with the `deloStudio` service.
 * @param ctx - the browser plugin context, holding `deloStudio`.
 */
export function applyStudio(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delo-onboarding: dictionaries')
  const progress = ctx.configForms.get<OnboardingSettings>(ONBOARDING_ROW_ID)
  const extra = createSnapshotStore<readonly OnboardingStep[]>([])
  ctx.effect(() => ctx.provide('deloOnboarding', {
    registerStep: (step) => {
      extra.set([...extra.getSnapshot().filter(each => each.id !== step.id), step])
      return () => { extra.set(extra.getSnapshot().filter(each => each !== step)) }
    },
  } satisfies DeloOnboarding), 'delo-onboarding: service')

  const writeProgress = (field: keyof OnboardingSettings, value: unknown): void => {
    progress.set(field, value).catch((error: unknown) => { console.warn('delo onboarding: progress was not saved', error) })
  }

  /** The preview notice, when bundle-local provides one. */
  const notice = (): NoticeFace | undefined => {
    const service = ctx.get('deloNotice')
    if (service === undefined) return undefined
    const privacy = ctx.locale.bind('deloPrivacy')
    return {
      title: () => privacy('notice.title'),
      paragraphs: () => privacy('notice.body').split('\n\n'),
      acknowledged: () => service.acknowledged(),
      acknowledge: () => { service.acknowledge() },
    }
  }
  const reach: ReachFace = {
    getSnapshot: (): ReachState => {
      const service = ctx.get('deloReach')
      if (service === undefined) return 'unavailable'
      return service.setUp() ? 'set-up' : 'available'
    },
    subscribe: listener => ctx.on('internal/service', (name: string) => { if (name === 'deloReach') listener() }),
  }
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
      useStockLook: () => ctx.deloStudio.useStockLook(),
    },
    appearance: ctx.locale.bind('settings.deloAppearance'),
    bundles: createBundleInstaller(ctx),
    reach,
    start,
    resolveText: text => ctx.locale.resolveText(text),
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
      if (view !== undefined) return { kind: 'default', workspaceId: view.workspaceId }
    } catch (error) {
      console.warn('delo onboarding: the default workspace was not resolved', error)
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
  // Delo's sidebar provides `ctx.deloSidebar` while its list is mounted; onboarding needs only its add-workspace flow.
  const sidebar = (): SidebarWorkspaceAdder | undefined => ctx.get('deloSidebar')
  const inPage = (): FolderChoice => (sidebar()?.canAddWorkspace() === true ? { kind: 'in-page' } : { kind: 'unavailable' })
  const chooseFolder = async (): Promise<FolderChoice> => {
    const workspace = ctx.get('uiWorkspace')
    const workspaces = ctx.get('workspaces')
    if (workspace === undefined || workspaces === undefined) return inPage()
    let path: string | null
    try {
      path = await workspace.pickDirectory()
    } catch (error) {
      // A host that picks folders in a page dialog has no native chooser; the sidebar's add-workspace flow has that dialog.
      console.warn('delo onboarding: the native folder chooser did not open', error)
      return inPage()
    }
    if (path === null) return { kind: 'cancelled' }
    try {
      return { kind: 'chosen', workspaceId: (await workspaces.create({ path })).workspaceId }
    } catch (error) {
      console.warn('delo onboarding: the folder was not added', error)
      return { kind: 'unavailable' }
    }
  }
  const openInPage = (): void => {
    writeProgress('starterSession', PENDING_STARTERS)
    sidebar()?.addWorkspace()
  }
  const holdNotice = (): ((told: boolean) => void) => {
    const release = ctx.get('uiWorkspace')?.holdDefaultWorkspaceNotice()
    return (told) => { release?.({ told }) }
  }
  const start: StartFace = { target: startTarget, resolve: () => { void resolve() }, chooseFolder, openInPage, holdNotice }

  /**
   * Open a new chat and keep it as the one whose empty state offers starter prompts. Without a workspace the person
   * chose or a default one, the workspace UI's own New Session choice applies and no prompts follow.
   */
  const startChat = async (chosen?: WorkspaceId): Promise<void> => {
    const workspace = ctx.get('uiWorkspace')
    if (workspace === undefined) return
    let target = chosen
    if (target === undefined) {
      const resolved = await (resolution ?? resolve())
      target = resolved.kind === 'default' ? resolved.workspaceId : undefined
    }
    if (target === undefined) {
      workspace.startSession()
      return
    }
    try {
      await workspace.openWorkspace(target, (sessionId) => { writeProgress('starterSession', sessionId) })
    } catch (error) {
      // The workspace UI already told the person why no chat opened.
      console.warn('delo onboarding: the chat was not opened', error)
    }
  }

  const face = (): OnboardingInjected => ({ progress, extra, loadRecord: loadSetupRecord, services: services(), startChat })
  const showAgain: ShowAgainInjected = { show: () => { ctx.settingsShell.openOnboarding(ONBOARDING_STEP.id) } }
  const starters: StarterInjected = {
    starter: { getSnapshot: () => progress.getSnapshot().value?.starterSession ?? '', subscribe: listener => progress.subscribe(listener) },
    prefill: (sessionId, text) => {
      const scope = ctx.get('sessions')?.scope(sessionId)
      const input = scope?.get('conversation')?.input.for(scope)
      if (input === undefined) return
      input.setDraft(text)
      // Keyboard-less devices keep their keyboard down until the person taps the box.
      if (window.matchMedia('(pointer: fine)').matches) input.focus()
    },
    bind: (sessionId) => { writeProgress('starterSession', sessionId) },
    dismiss: () => { writeProgress('starterSession', '') },
  }
  ctx.effect(() => ctx.configForms.whileServed([ONBOARDING_ROW_ID], () => {
    const disposers = [
      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding', id: ONBOARDING_STEP.id, order: ONBOARDING_STEP.order, locale: NS, inject: face,
      }, OnboardingStepEntry)),
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item', id: SHOW_AGAIN_ROW.id, order: SHOW_AGAIN_ROW.order, locale: NS, inject: () => showAgain,
      }, ShowAgainRow)),
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: STARTER_ENTRY.id, order: STARTER_ENTRY.order, locale: NS, inject: () => starters,
      }, StarterPrompts)),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }), 'delo-onboarding: registrations')
}
