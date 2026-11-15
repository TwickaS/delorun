/**
 * What the onboarding's pieces share: the step type other plugins add, and the services the built-in steps draw with.
 * @module @delorun/plugin-onboarding/client/types
 */
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { LocaleRuntime, LocaleSnapshot, TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { ThemeSettings } from '@delorun/plugin-theme'
import type { ComponentType, ReactNode } from 'react'
import type { OnboardingSettings } from '../config.ts'
import type { DirectoryEntry, KeyProbe } from './providers.ts'
import type { CloneProblem, CloneRequest, CloneStatus, FolderKind, KeyTestAnswer, LocalServer, LocationProblem, Readiness, RecommendAnswer, SetupRecord } from '../wire.ts'
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

/** What adding a folder through the harness's route came to. */
export type AddOutcome =
  /** The folder was added as this workspace, or already was one; `folder` is what it holds. */
  | ({ readonly kind: 'chosen' } & AddedFolder)
  /** The folder is one Delorun never adds as a workspace; nothing was registered. */
  | { readonly kind: 'refused'; readonly problem: LocationProblem }
  /** The harness could not add the folder, or could not be asked; nothing was registered. */
  | { readonly kind: 'failed' }

/** A folder the Workspace step added: the workspace, its folder and what the folder holds. */
export interface AddedFolder {
  readonly workspaceId: WorkspaceId
  readonly path: string
  readonly folder: FolderKind
}

/** What choosing a folder came to. */
export type FolderChoice =
  | AddOutcome
  /** The person closed the chooser; nothing changed. */
  | { readonly kind: 'cancelled' }
  /** The host has no native chooser, so the Workspace step shows its own; see {@link StartFace.browse}. */
  | { readonly kind: 'in-step' }
  /** The studio has no workspace navigation; the workspace UI's own New Session applies. */
  | { readonly kind: 'unavailable' }

/** The host's folders, as the Workspace step's own chooser lists and creates them. */
export interface FolderBrowse {
  /**
   * List one folder's child folders.
   * @param path - the folder; absent lists the home directory.
   * @param signal - cancels a listing a newer one replaced.
   * @returns the folder, its ancestors and its child folders.
   * @throws when the host cannot list the folder.
   */
  readonly list: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /**
   * Create a child folder.
   * @param path - the existing parent folder.
   * @param name - the new folder's name.
   * @returns the new folder's absolute path.
   * @throws when the host cannot create the folder.
   */
  readonly create: (path: string, name: string) => Promise<string>
}

/** The Workspace step's face: where the chat opens without a choice, and how a folder is chosen or added. */
export interface StartFace {
  /** Where the chat opens, once resolved. */
  readonly target: { getSnapshot(): StartTarget; subscribe(listener: () => void): () => void }
  /** Begin resolving the default workspace, which the host reuses if it already exists; the dialog calls it when it opens. */
  readonly resolve: () => void
  /**
   * Open the host's native folder chooser and add the chosen folder through the harness's route.
   * @returns what the choice came to; `in-step` where the host has no native chooser. It never rejects.
   */
  readonly chooseFolder: () => Promise<FolderChoice>
  /**
   * Add a folder through the harness's route, which refuses the folders Delorun never adds.
   * @param path - the folder's absolute path.
   * @returns what adding it came to; it never rejects.
   */
  readonly addFolder: (path: string) => Promise<AddOutcome>
  /** The host's folders, for the Workspace step's own chooser. */
  readonly browse: FolderBrowse
  /**
   * Keep the workspace UI's "Unable to create default workspace" notice back while the dialog shows.
   * @returns the release; `told` true says the Workspace step told the person there is no default workspace, which drops
   * the notice, and false shows a kept notice.
   */
  readonly holdNotice: () => (told: boolean) => void
}

/** What starting a clone came to: its job, why it was refused, or that the harness could not be asked. */
export type CloneStartOutcome =
  | { readonly kind: 'started'; readonly job: string }
  | { readonly kind: 'refused'; readonly problem: CloneProblem }
  | { readonly kind: 'failed' }

/** The harness's routes the guide reads; each resolves `undefined` when the harness cannot be asked or answers something else, and never rejects. */
export interface HostFace {
  /** @returns this computer's readiness for the agents and reach steps. */
  readonly readiness: () => Promise<Readiness | undefined>
  /** @returns each model provider's key test. */
  readonly keyTest: () => Promise<KeyTestAnswer | undefined>
  /** @returns the local model servers found on this computer; undefined when the route cannot be read. */
  readonly localModels: () => Promise<readonly LocalServer[] | undefined>
  /**
   * @param registry - whether to read packages that are not installed from the npm registry.
   * @returns which connections each recommended plugin is for.
   */
  readonly recommend: (registry: boolean) => Promise<RecommendAnswer | undefined>
  /** @returns whether the reach step applies. */
  readonly reach: () => Promise<ReachState>
  /**
   * Start cloning a repository into a new folder.
   * @param request - the address, the folder to clone into and the new folder's name.
   * @returns the job, or why it did not start.
   */
  readonly cloneStart: (request: CloneRequest) => Promise<CloneStartOutcome>
  /**
   * @param job - a started clone.
   * @returns where it stands; `unknown` when the harness cannot be asked.
   */
  readonly cloneStatus: (job: string) => Promise<CloneStatus>
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
}

/** The services that do not change while the dialog is open. */
export interface StaticServices {
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
   */
  readonly startChat: (workspaceId?: WorkspaceId, folder?: FolderKind) => Promise<void>
}
