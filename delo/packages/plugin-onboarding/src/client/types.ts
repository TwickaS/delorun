/**
 * What the onboarding's pieces share: the step type other plugins add, and the services the built-in steps draw with.
 * @module @delo/plugin-onboarding/client/types
 */
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { LocaleRuntime, LocaleSnapshot, TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { ThemeSettings } from '@delo/plugin-theme'
import type { ComponentType } from 'react'
import type { OnboardingSettings } from '../config.ts'
import type { LocationProblem, SetupRecord } from '../wire.ts'
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
  /** Its place: the built-in steps take 100 to 500 and the last, Start, 1000; a plugin's steps take 600 to 999. */
  readonly order: number
  /** Its name in the list of steps and its heading. */
  readonly title: () => string
  /** Its body; the dialog draws the heading, Back and Continue around it. */
  readonly component: ComponentType<OnboardingStepProps>
}

/** What `ctx.deloOnboarding` shares. */
export interface DeloOnboarding {
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
   * Turn Delo's look and every Delo studio plugin off, which unloads onboarding.
   * @returns whether the setting was saved.
   */
  readonly useStockLook: () => Promise<boolean>
}

/** The theme's labels for palettes, accents and schemes, which the look step shows unchanged. */
export type AppearanceTranslate = TranslateNS<'settings.deloAppearance'>

/**
 * The service the reach lane provides as `ctx.deloReach` when reach can be turned on in this installation. Absent
 * means reach is not available, and onboarding leaves its step out.
 */
export interface DeloReach {
  /** Always true: the service exists only where reach is available in this installation. */
  readonly available: true
  /**
   * Whether reach is already turned on at this computer. Onboarding reads it when the dialog opens and whenever the
   * service comes or goes.
   * @returns true when reach is set up.
   */
  setUp(): boolean
}

/** Whether the reach step applies: `unavailable` without `ctx.deloReach`, otherwise `available` or `set-up`. */
export type ReachState = 'unavailable' | 'available' | 'set-up'

/** Where the Start step's chat opens. */
export type StartTarget =
  /** The default workspace is still being resolved. */
  | { readonly kind: 'checking' }
  /** The default workspace resolved; the chat opens there and offers the starter prompts. */
  | { readonly kind: 'default'; readonly workspaceId: WorkspaceId }
  /** No default workspace, but other workspaces exist; the workspace UI's own New Session applies. */
  | { readonly kind: 'other' }
  /** No default workspace and no other: the person chooses a folder first. */
  | { readonly kind: 'none' }

/** What adding a folder through the harness's route came to. */
export type AddOutcome =
  /** The folder was added as this workspace, or already was one. */
  | { readonly kind: 'chosen'; readonly workspaceId: WorkspaceId }
  /** The folder is one Delo never adds as a workspace; nothing was registered. */
  | { readonly kind: 'refused'; readonly problem: LocationProblem }
  /** The harness could not add the folder, or could not be asked; nothing was registered. */
  | { readonly kind: 'failed' }

/** What choosing a folder came to. */
export type FolderChoice =
  | AddOutcome
  /** The person closed the chooser; nothing changed. */
  | { readonly kind: 'cancelled' }
  /** The host has no native chooser, so the Start step shows its own; see {@link StartFace.browse}. */
  | { readonly kind: 'in-step' }
  /** The studio has no workspace navigation; the workspace UI's own New Session applies. */
  | { readonly kind: 'unavailable' }

/** The host's folders, as the Start step's own chooser lists and creates them. */
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

/** The Start step's workspace: where the chat opens and how a folder is chosen when there is no default. */
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
   * Add a folder through the harness's route, which refuses the folders Delo never adds.
   * @param path - the folder's absolute path.
   * @returns what adding it came to; it never rejects.
   */
  readonly addFolder: (path: string) => Promise<AddOutcome>
  /** The host's folders, for the Start step's own chooser. */
  readonly browse: FolderBrowse
  /**
   * Keep the workspace UI's "Unable to create default workspace" notice back while the dialog shows.
   * @returns the release; `told` true says the Start step told the person there is no default workspace, which drops
   * the notice, and false shows a kept notice.
   */
  readonly holdNotice: () => (told: boolean) => void
}

/** The reach service's state, followed as the service comes and goes. */
export interface ReachFace {
  /** @returns whether reach is available here and whether it is already set up. */
  readonly getSnapshot: () => ReachState
  /**
   * @param listener - called when `ctx.deloReach` appears or disappears.
   * @returns the unsubscriber.
   */
  readonly subscribe: (listener: () => void) => () => void
}

/** The services that do not change while the dialog is open. */
export interface StaticServices {
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
  /** Whether reach can be turned on here. */
  readonly reach: ReachFace
  /** Where the chat opens. */
  readonly start: StartFace
  /** Resolve a package's localized text in the active language. */
  readonly resolveText: (text: LocalizedText) => string
}

/** The services the built-in steps draw with: the static ones, this plugin's copy and the recommended packages. */
export interface StepServices extends StaticServices {
  /** This plugin's copy. */
  readonly t: TranslateNS<'deloOnboarding'>
  /** The packages the recommended-plugins step offers. */
  readonly plugins: readonly string[]
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
   * @param workspaceId - a workspace the person just chose.
   */
  readonly startChat: (workspaceId?: WorkspaceId) => Promise<void>
}
