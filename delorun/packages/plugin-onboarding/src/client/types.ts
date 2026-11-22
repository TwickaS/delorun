/**
 * What the onboarding's pieces share: the step type other plugins add, and the services the built-in steps draw with.
 * @module @delorun/plugin-onboarding/client/types
 */
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { LocaleRuntime, LocaleSnapshot, TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { DelegationConsentSettings } from '@delorun/plugin-delegation-consent/wire'
import type { HostFetch } from '@delorun/bundle-local/host-api'
import type { ThemeSettings } from '@delorun/plugin-theme'
import type { PreviewFlagsStore } from '@delorun/preview-flags/client'
import type { ComponentType, ReactNode } from 'react'
import type { OnboardingSettings } from '../config.ts'
import type { DirectoryEntry, KeyProbe } from './providers.ts'
import type { AgentModelsAnswer, DeferrableStep, FolderKind, KeyTestAnswer, LocalServer, Readiness, RecommendAnswer, SetupRecord } from '../wire.ts'
import type { BrowserSetupStore } from '@delorun/browser-setup'
import type { BrowserInstallAnswer, BrowserTestAnswer } from '@delorun/bundle-local/browser-check-api'
import type { TurnOffOutcome } from './browser-pack.ts'
import type { BundleInstaller } from './bundles.ts'

/** What a step added by another plugin draws with. */
export interface OnboardingStepProps {
  /** Go on to the next step, or finish after the last. */
  readonly next: () => void
}

/** One step a plugin adds to onboarding. */
export interface OnboardingStep {
  /** Unique among the steps: lower-case letters, digits, dots and hyphens, such as `thinking.reader`. */
  readonly id: string
  /** Its place: the built-in steps take 100 to 500 and the last two, Workspace and Ready, 1000 and 1100; a plugin's steps take 600 to 999. */
  readonly order: number
  /** Its name in the list of steps and its heading. */
  readonly title: () => string
  /** Its body; the dialog draws the heading, Back and Continue around it. */
  readonly component: ComponentType<OnboardingStepProps>
}

/** What `ctx.delorunOnboarding` shares. */
export interface DelorunOnboarding {
  /**
   * Add a step to onboarding; a step with the id of an earlier one replaces it.
   * @param step - the step.
   * @returns the disposer that removes it.
   */
  registerStep(step: OnboardingStep): () => void
}

/** The preview notice's face: bundle-local's copy and acknowledgement, present only where its notice exists. */
export interface NoticeFace {
  /** The notice's title in the active language. */
  readonly title: () => string
  /** The notice's paragraphs in the active language. */
  readonly paragraphs: () => readonly string[]
  /** @returns whether this browser acknowledged the current notice. */
  readonly acknowledged: () => boolean
  /** Record the acknowledgement, as the notice's own button does. */
  readonly acknowledge: () => void
}

/** The interface languages. */
export interface LanguageFace {
  /** @returns the active language and the selectable ones. */
  readonly getSnapshot: () => LocaleSnapshot
  /**
   * @param listener - called after each change.
   * @returns the unsubscriber.
   */
  readonly subscribe: (listener: () => void) => () => void
  /**
   * Switch the interface language.
   * @param id - a selectable language id.
   */
  readonly setLocale: LocaleRuntime['setLocale']
}

/** Light, dark or follow the system, as upstream's theme service keeps it. */
export type SchemePreference = 'light' | 'dark' | 'system'

/** The colour-scheme preference. */
export interface SchemeFace {
  /** @returns the current preference. */
  readonly get: () => SchemePreference
  /**
   * @param listener - called after each change.
   * @returns the unsubscriber.
   */
  readonly subscribe: (listener: () => void) => () => void
  /**
   * Choose a preference.
   * @param preference - the new preference.
   */
  readonly set: (preference: SchemePreference) => void
}

/** The theme's settings the look step edits. */
export interface LookFace {
  /** The theme settings, stored by the theme's host half. */
  readonly settings: ConfigForm<ThemeSettings>
  /**
   * Turn Delorun's look and every Delorun studio plugin off, which unloads onboarding.
   * @returns whether the setting was saved.
   */
  readonly useStockLook: () => Promise<boolean>
}

/** The theme's labels for palettes, accents and schemes, which the look step shows unchanged. */
export type AppearanceTranslate = TranslateNS<'settings.delorunAppearance'>

/**
 * Whether the reach step applies, from the home's reach status: `absent` where this profile has no reach service or it
 * cannot be read, `set-up` once an option is ready, otherwise `off`. `remote` is a studio opened through reach: the person
 * is already on the phone, and the computer's own setup steps do not apply.
 */
export type ReachState = 'absent' | 'set-up' | 'off' | 'remote'

/** Where the first chat opens unless the person chooses another folder. */
export type StartTarget =
  /** The default workspace is still being resolved. */
  | { readonly kind: 'checking' }
  /** The default workspace resolved, with its folder. */
  | { readonly kind: 'default'; readonly workspaceId: WorkspaceId; readonly path: string }
  /** No default workspace, but other workspaces exist; the workspace UI's own New Session applies. */
  | { readonly kind: 'other' }
  /** No default workspace and no other: the person chooses a folder first. */
  | { readonly kind: 'none' }

/** A workspace the new-workspace dialog made: the workspace, its folder and what the folder holds. */
export interface AddedFolder {
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly folder: FolderKind
}

/** How the new-workspace dialog ended. */
export type NewWorkspaceOutcome =
  /** The dialog made, or chose, this workspace; the id is the plain string the dialog's service answers. */
  | { readonly kind: 'created'; readonly workspaceId: string; readonly path: string; readonly folder: FolderKind }
  /** The person closed the dialog; nothing changed. */
  | { readonly kind: 'cancelled' }

/** The Workspace step's face: where the chat opens without a choice, and how a workspace is made. */
export interface StartFace {
  /** Where the chat opens, once resolved. */
  readonly target: { getSnapshot(): StartTarget; subscribe(listener: () => void): () => void }
  /** Begin resolving the default workspace, which the host reuses if it already exists; the dialog calls it when it opens. */
  readonly resolve: () => void
  /**
   * Open the new-workspace dialog over onboarding; undefined where the profile has no new-workspace plugin. It is read
   * each time the Workspace step renders, so a plugin that loads later appears.
   * @returns how the dialog ended.
   */
  readonly openNewWorkspace: (() => Promise<NewWorkspaceOutcome>) | undefined
  /**
   * Keep the workspace UI's "Unable to create default workspace" notice back while the dialog shows.
   * @returns the release; `told` true says the Workspace step told the person there is no default workspace, which drops
   * the notice, and false shows a kept notice.
   */
  readonly holdNotice: () => (told: boolean) => void
  /** @returns whether the studio already holds a workspace, which a re-run's Skip on Workspace keeps. */
  readonly hasWorkspace: () => boolean
}

/** The harness's routes the guide reads; each resolves `undefined` when the harness cannot be asked or answers something else, and never rejects. */
export interface HostFace {
  /** @returns this computer's readiness for the agents and reach steps. */
  readonly readiness: () => Promise<Readiness | undefined>
  /** @returns each model provider's key test. */
  readonly keyTest: () => Promise<KeyTestAnswer | undefined>
  /** @returns the local model servers found on this computer; undefined when the route cannot be read. */
  readonly localModels: () => Promise<readonly LocalServer[] | undefined>
  /**
   * Ask an installed agent which models it offers.
   * @param agent - the agent's connection id.
   * @returns the models, or `unavailable` when the agent is not installed and running, did not answer or the route failed.
   */
  readonly agentModels: (agent: 'claude-code' | 'codex') => Promise<AgentModelsAnswer>
  /**
   * @param registry - whether to read packages that are not installed from the npm registry.
   * @returns which connections each recommended plugin is for.
   */
  readonly recommend: (registry: boolean) => Promise<RecommendAnswer | undefined>
  /** @returns whether the reach step applies. */
  readonly reach: () => Promise<ReachState>
  /** @returns the studio's address over Tailscale while an option is ready; undefined when none is or the route cannot be read. */
  readonly reachAddress: () => Promise<string | undefined>
  /**
   * Note that a step waits for the computer, or that it is done.
   * @param id - the step.
   * @param deferred - true to defer it, false to clear it.
   * @returns every step deferred now; undefined when the route cannot be asked.
   */
  readonly defer: (id: DeferrableStep, deferred: boolean) => Promise<readonly DeferrableStep[] | undefined>
}

/** The model providers' directory, key test and key saving, which go through the studio's own credential and settings routes. */
export interface ProvidersFace {
  /** @returns the configurable provider routes; undefined when the harness cannot be asked. It never rejects. */
  readonly directory: () => Promise<readonly DirectoryEntry[] | undefined>
  /**
   * Ask the provider for its model list with a typed key: the free request, no message and no spend. The key is not stored.
   * @param entry - the provider route.
   * @param key - the typed key.
   * @param baseURL - the endpoint typed under More settings, when one was typed.
   * @returns what the request answered; it never rejects.
   */
  readonly probe: (entry: DirectoryEntry, key: string, baseURL: string | undefined) => Promise<KeyProbe>
  /**
   * Save a key where the Models settings page saves it: the credential store, with the profile naming its reference.
   * @param entry - the provider route.
   * @param key - the typed key; never read back.
   * @param baseURL - the endpoint typed under More settings, when one was typed.
   * @returns true when the key was saved; it never rejects.
   */
  readonly save: (entry: DirectoryEntry, key: string, baseURL: string | undefined) => Promise<boolean>
  /**
   * Declare a found local server as an OpenAI-compatible provider route, as the Models page's custom provider card does:
   * a profile with the server's own base URL and model ids, and no key. Refuses a base URL that is not on the loopback interface.
   * @param server - the server the host found.
   * @returns true when the route was written; it never rejects.
   */
  readonly declareLocal: (server: LocalServer) => Promise<boolean>
  /**
   * Declare an OpenAI-compatible endpoint a person typed, as the Models page's custom provider card does: it lists the
   * endpoint's models with the key (the free request), writes a profile under an id made from the name, and stores the key.
   * @param request - the typed name, base URL and key; the key is never read back.
   * @returns true when the route and its key were written; it never rejects.
   */
  readonly declareCustom: (request: CustomEndpoint) => Promise<boolean>
}

/** What a person typed to declare an OpenAI-compatible endpoint. */
export interface CustomEndpoint {
  /** The display name; the route id is made from it. */
  readonly name: string
  /** The endpoint's base URL. */
  readonly baseURL: string
  /** The API key. */
  readonly key: string
}

/** The field of an agent provider's row that the agents step writes. */
export interface AgentRowSettings {
  /** The model the agent runs, or absent for the agent's own default. */
  readonly model?: string | undefined
}

/** The settings the agents step reads and writes, by the agent's connection id. */
export interface AgentsFace {
  /** The row of an agent's provider; its form is unavailable until the package is installed and running. */
  readonly rows: Readonly<Record<'claude-code' | 'codex', ConfigForm<AgentRowSettings>>>
  /** The external-agent consent's row, which holds the run time limit. */
  readonly limit: ConfigForm<DelegationConsentSettings>
}

/** The services that do not change while the dialog is open. */
export interface StaticServices {
  /** The agents' settings. */
  readonly agents: AgentsFace
  /** The model providers. */
  readonly providers: ProvidersFace
  /** The preview notice, or undefined where there is none. */
  readonly notice: NoticeFace | undefined
  /** The interface languages. */
  readonly language: LanguageFace
  /** The colour-scheme preference. */
  readonly scheme: SchemeFace
  /** The theme's settings. */
  readonly look: LookFace
  /** The theme's labels. */
  readonly appearance: AppearanceTranslate
  /** The plugin manager's bundles. */
  readonly bundles: BundleInstaller
  /** The harness's routes. */
  readonly host: HostFace
  /** Where the chat opens. */
  readonly start: StartFace
  /** Resolve a package's localized text in the active language. */
  readonly resolveText: (text: LocalizedText) => string
  /** The PIN mode step's requests and its link to Settings. */
  readonly pin: PinFace
  /** The Browser step's read of whether Browser is ready, its link to Settings and its way to turn Browser off. */
  readonly browser: BrowserFace
  /** The page's preview flags, which a step reads under a `PreviewFlagsProvider`. */
  readonly previewFlags: PreviewFlagsStore
}

/** What the Browser step reads, opens and turns off. */
export interface BrowserFace {
  /** Whether the Browser plugin pack is ready, from the Host's requirement check. */
  readonly setup: BrowserSetupStore
  /** Whether the pack for the person's own Chrome is ready (paired), from the same check. */
  readonly ownSetup: BrowserSetupStore
  /** What the person chose for Browser in this home: `on`, `off`, or empty while they never chose. */
  readonly choice: {
    /** @returns the stored choice, a stable string. */
    getSnapshot(): string
    /**
     * Observe changes.
     * @param listener - called after each change.
     * @returns the unsubscribe function.
     */
    subscribe(listener: () => void): () => void
    /**
     * Record the choice.
     * @param next - the choice.
     * @returns whether the Host accepted it.
     */
    record(next: 'on' | 'off'): Promise<boolean>
  }
  /** While the choice is off: whether the pack was last seen enabled or disabled, empty until seen; recording a choice clears it. */
  readonly packSeen: {
    /** @returns the stored observation, a stable string. */
    getSnapshot(): '' | 'enabled' | 'disabled'
    /**
     * Observe changes.
     * @param listener - called after each change.
     * @returns the unsubscribe function.
     */
    subscribe(listener: () => void): () => void
    /**
     * Record an observation.
     * @param next - what the pack was seen as.
     * @returns whether the Host accepted it.
     */
    record(next: 'enabled' | 'disabled'): Promise<boolean>
  }
  /** Whether this home is new: its setup has not been finished, and it has been read. An unread home is not fresh. */
  readonly fresh: {
    /** @returns whether the home is new, a stable boolean. */
    getSnapshot(): boolean
    /**
     * Observe changes.
     * @param listener - called after each change.
     * @returns the unsubscribe function.
     */
    subscribe(listener: () => void): () => void
  }
  /**
   * Open a fixed page in the built-in browser on the Host and read its thumbnail; no model turn.
   * @returns the answer; it never rejects.
   */
  readonly test: () => Promise<BrowserTestAnswer>
  /**
   * Download the browser build the built-in browser needs, and wait for the Host to finish.
   * @returns the answer; it never rejects.
   */
  readonly download: () => Promise<BrowserInstallAnswer>
  /**
   * Turn the Browser plugin pack off, for the No browser choice.
   * @returns how it ended; it never rejects.
   */
  readonly turnOff: () => Promise<TurnOffOutcome>
  /**
   * Open a Settings section, where a need is met there.
   * @param section - the section's id.
   */
  readonly openSettings: (section: string) => void
}

/** What the PIN step reaches the home with. */
export interface PinFace {
  /** Sends the step's same-origin requests: the browser's `fetch`, or a spec's fake. */
  readonly fetch: HostFetch
  /** Open Settings at the PIN mode section. */
  readonly openSettings: () => void
}

/** The services the built-in steps draw with: the static ones, this plugin's copy, the recommended packages and the Settings section drawer. */
export interface StepServices extends StaticServices {
  /** This plugin's copy. */
  readonly t: TranslateNS<'delorunOnboarding'>
  /** Whether the studio is opened from a phone through reach, which cannot install or turn on packages. */
  readonly remote: boolean
  /** The packages the recommended-plugins step offers. */
  readonly plugins: readonly string[]
  /** The bundled rows, by row id, that the recommended-plugins step offers to turn on. */
  readonly optionalRows: readonly string[]
  /**
   * Draw a Settings section inside a step, as the Settings panel draws it.
   * @param id - the section's id, such as `models`.
   * @returns the section.
   */
  readonly renderSection: (id: string) => ReactNode
}

/** Everything the dialog reads and calls. */
export interface OnboardingInjected {
  /** The row's settings: progress and the recommended packages. */
  readonly progress: ConfigForm<OnboardingSettings>
  /** The steps other plugins added. */
  readonly extra: { getSnapshot(): readonly OnboardingStep[]; subscribe(listener: () => void): () => void }
  /** What the terminal setup recorded; resolves with a record that covers nothing when it cannot be read. */
  readonly loadRecord: () => Promise<SetupRecord>
  /** The services that do not change while the dialog is open. */
  readonly services: StaticServices
  /**
   * Open a new chat, as the last step's button does: in the workspace given, else the default workspace when it
   * resolved, else through the workspace UI's own New Session.
   * @param workspaceId - a workspace the person chose.
   * @param folder - what that workspace's folder holds, which picks the starting prompts.
   * @param keepCurrent - when no workspace was chosen, leave the chat in the workspace it is in (the workspace UI's own New Session) instead of the default workspace.
   */
  readonly startChat: (workspaceId?: WorkspaceId, keepCurrent?: boolean) => Promise<void>
  /** Whether the person chose Complete setup later since Delorun started; the Finish setup chip reads it and the dialog sets it. */
  readonly aside: LaterStore
  /** Whether the dialog shows only the steps a phone deferred to this computer; the sidebar's Finish setup entry sets it, and the dialog clears it when it closes. */
  readonly deferredOnly: LaterStore
}

/** The flag that the guide was set aside in this visit. */
export interface LaterStore {
  /** @returns whether the guide was set aside. */
  getSnapshot(): boolean
  /**
   * @param listener - called after each change.
   * @returns the unsubscriber.
   */
  subscribe(listener: () => void): () => void
  /**
   * @param value - whether the guide is set aside.
   * @param remember - whether to keep the pause in the home so a reload keeps the guide closed; default true. Escape sets it aside for this page only.
   */
  set(value: boolean, remember?: boolean): void
}
