/**
 * Answer types, defaults and upstream profile row names of `delorun setup`, as
 * specified by `delo/docs/contracts/c11-setup-answers.md`. This module holds
 * readonly constants and types only.
 *
 * @module @delo/contract-setup-answers
 */

/** Schema version of the answers document. Setup refuses any other value. */
export const SETUP_ANSWERS_SCHEMA_VERSION = 2 as const

/** Provider id applied when the person accepts the provider question's default. */
export const SETUP_DEFAULT_PROVIDER_ID = 'deepseek-official' as const

/** Environment variable that holds the model credential when the answers name the environment as its source. */
export const SETUP_DEFAULT_CREDENTIAL_VARIABLE = 'DEEPSEEK_API_KEY' as const

/** Reach options that setup offers. The Delo relay is not among them. */
export const REACH_OPTIONS = ['none', 'tailscale-private', 'tailscale-funnel', 'self-hosted-relay'] as const

/** One reach option of {@link REACH_OPTIONS}. */
export type ReachOption = (typeof REACH_OPTIONS)[number]

/** Identity factors that setup can request for a reach address. */
export const IDENTITY_FACTORS = ['passkey', 'oidc', 'tailnet'] as const

/** One identity factor of {@link IDENTITY_FACTORS}. */
export type IdentityFactor = (typeof IDENTITY_FACTORS)[number]

/** Where the model credential comes from. `prompt` is accepted only in the interactive form. */
export type ModelCredential =
  | { readonly source: 'prompt' }
  | { readonly source: 'environment'; readonly name: string }

/** The reach answer. `identityFactor` is `null` exactly when `option` is `none`. */
export interface ReachAnswer {
  readonly option: ReachOption
  readonly identityFactor: IdentityFactor | null
}

/** The prompts answers. `safer` keeps Delo's consent and permission defaults; `stock` sets them to upstream's behaviour. */
export const PROMPTS_OPTIONS = ['safer', 'stock'] as const

/** One prompts answer of {@link PROMPTS_OPTIONS}. */
export type PromptsAnswer = (typeof PROMPTS_OPTIONS)[number]

/** Port the studio listens on when the person does not choose one; upstream's Web profile default. */
export const SETUP_DEFAULT_PORT = 3080 as const

/** The profile section's answers: `null` keeps the profile the command line selected, and the default port. */
export interface ProfileAnswer {
  readonly name: string | null
  readonly port: number | null
}

/** What the person did with a section: `seen` is shown with no question, `answered` was asked and answered, `skipped` took its default without being asked. */
export const SECTION_STATUSES = ['seen', 'answered', 'skipped'] as const

/** One status of {@link SECTION_STATUSES}. */
export type SectionStatus = (typeof SECTION_STATUSES)[number]

/** One row of the `sections` record: a section id and what happened to it in this run. */
export interface SectionRecord {
  readonly id: string
  readonly status: SectionStatus
}

/** The answers document read by the interactive setup and by `--config`. */
export interface SetupAnswers {
  readonly schemaVersion: typeof SETUP_ANSWERS_SCHEMA_VERSION
  readonly modelProvider: { readonly id: string; readonly credential: ModelCredential }
  readonly prompts: PromptsAnswer
  readonly background: boolean
  readonly profile: ProfileAnswer
  readonly reach: ReachAnswer
  /** Whether setup imports the stock DeepSeek Harness home after showing its preview; never true in a `--config` document. */
  readonly importStockHome: boolean
  /** The sections this run showed, in order; the studio's onboarding leaves out what the terminal covered. */
  readonly sections: readonly SectionRecord[]
}

/** The value setup applies to each question the person does not answer. */
export const SETUP_DEFAULTS = {
  schemaVersion: 2,
  modelProvider: { id: 'deepseek-official', credential: { source: 'prompt' } },
  prompts: 'safer',
  background: true,
  profile: { name: null, port: null },
  reach: { option: 'none', identityFactor: null },
  importStockHome: false,
  sections: [],
} as const satisfies SetupAnswers

/** Keys that earlier answers documents carried and that setup no longer asks; a document holding one is refused. */
export const REMOVED_ANSWER_KEYS = ['studioAdditions', 'runtime', 'helpSetUpModels', 'sessionLogUpload', 'desktopAnalytics'] as const

/** Upstream profile row that each opt-in's `config.enabled` is written to; the Privacy section in Settings owns them. */
export const SETUP_OPT_IN_ROWS = {
  sessionLogUpload: 'session-log-deepseek',
  desktopAnalytics: 'product-analytics',
} as const
