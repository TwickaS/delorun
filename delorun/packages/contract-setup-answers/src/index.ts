/**
 * Answer types, defaults and upstream profile row names of `delorun setup`, as
 * specified by `delorun/docs/contracts/c11-setup-answers.md`. This module holds
 * readonly constants and types only.
 *
 * @module @delorun/contract-setup-answers
 */

/** Schema version of the answers document that setup writes. */
export const SETUP_ANSWERS_SCHEMA_VERSION = 5 as const

/**
 * Earlier schema versions setup still reads. A version-2 document has no `updateCheck` and reads as the check on; a
 * version-2 or version-3 document's model provider reads as DeepSeek with the profile's default model, which is what
 * setup of those versions applied whatever id the document named. A document of version 2, 3 or 4 may hold
 * `phonePowers`, which version 5 removed: it is read, ignored and reported. Setup refuses every version not listed here or in
 * {@link SETUP_ANSWERS_SCHEMA_VERSION}.
 */
export const SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS = [2, 3, 4] as const

/**
 * The model providers setup can set up, by the route id the profile selects them with: DeepSeek's own adapter
 * (`deepseek-official`), the pi-ai catalog providers listed here, and `openai-compatible`, a route to any endpoint
 * that speaks OpenAI's Chat Completions API. Every other provider the profile's adapters serve is set up in the
 * studio's Settings → Agent → Models.
 */
export const SETUP_PROVIDER_IDS = [
  'anthropic',
  'deepseek-official',
  'google',
  'groq',
  'mistral',
  'moonshotai',
  'openai',
  'openai-compatible',
  'openrouter',
  'together',
  'xai',
] as const

/** One provider id of {@link SETUP_PROVIDER_IDS}. */
export type SetupProviderId = (typeof SETUP_PROVIDER_IDS)[number]

/** Provider the interactive provider question starts on. `--yes` chooses no provider unless `--provider` names one. */
export const SETUP_DEFAULT_PROVIDER_ID = 'deepseek-official' as const satisfies SetupProviderId

/** Environment variable that holds DeepSeek's key; each provider's own variable is in setup's provider table. */
export const SETUP_DEFAULT_CREDENTIAL_VARIABLE = 'DEEPSEEK_API_KEY' as const

/**
 * How the person uses Delorun, the first answer of the interactive setup: `local` is the studio on this computer alone,
 * `remote` adds a phone or another device over the person's own network, `automation` runs scripts with no studio. The
 * answer sets the defaults and decides which questions the interactive setup asks; every other answer is stored as given.
 */
export const SETUP_USE_CASES = ['local', 'remote', 'automation'] as const

/** One use case of {@link SETUP_USE_CASES}. */
export type SetupUseCase = (typeof SETUP_USE_CASES)[number]

/** The use case a document without one reads as, and `--yes` keeps. */
export const SETUP_DEFAULT_USE_CASE = 'local' as const satisfies SetupUseCase

/** Reach options that setup offers. The Delorun relay is not among them. */
export const REACH_OPTIONS = ['none', 'tailscale-private', 'tailscale-funnel', 'self-hosted-relay'] as const

/** One reach option of {@link REACH_OPTIONS}. */
export type ReachOption = (typeof REACH_OPTIONS)[number]

/** Identity factors that setup can request for a reach address. */
export const IDENTITY_FACTORS = ['passkey', 'oidc', 'tailnet', 'tailnet-membership'] as const

/** One identity factor of {@link IDENTITY_FACTORS}. */
export type IdentityFactor = (typeof IDENTITY_FACTORS)[number]

/** Where the model credential comes from. `prompt` is accepted only in the interactive form. */
export type ModelCredential =
  | { readonly source: 'prompt' }
  | { readonly source: 'environment'; readonly name: string }

/** Who may ask to pair a device without an approval window: the computer's own Tailscale user, or any device on the tailnet. */
export const PAIRING_ASKERS = ['own-user', 'tailnet'] as const

/** One asker of {@link PAIRING_ASKERS}. */
export type PairingAsker = (typeof PAIRING_ASKERS)[number]

/**
 * The reach answer. `identityFactor` is `null` exactly when `option` is `none`. `pairing` is present only with a reach
 * option and absent in an answer from before the choice existed, which setup applies as `own-user`.
 */
export interface ReachAnswer {
  readonly option: ReachOption
  readonly identityFactor: IdentityFactor | null
  readonly pairing?: PairingAsker | undefined
}

/**
 * The prompts answers. `safer` keeps Delorun's consent and permission defaults; `stock` sets them to upstream's behaviour;
 * `dangerous` sets them to upstream's behaviour too and makes full access available to every chat without a
 * per-workspace consent (see {@link DANGEROUS_PHRASE}). A reader that does not know an answer reads `safer`.
 */
export const PROMPTS_OPTIONS = ['safer', 'stock', 'dangerous'] as const

/** One prompts answer of {@link PROMPTS_OPTIONS}. */
export type PromptsAnswer = (typeof PROMPTS_OPTIONS)[number]

/**
 * The exact text a person types at the second step of the interactive `dangerous` answer; any other entry cancels and
 * keeps the previous answer.
 */
export const DANGEROUS_PHRASE = 'full access everywhere' as const

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

/**
 * The model provider answer. `baseURL` is set for `openai-compatible` only and `null` for every other provider, whose
 * endpoint is the one its adapter ships. `model` is `null` only for `deepseek-official`, where it keeps the profile's
 * default model; every other provider names the model new chats start on.
 */
export interface ModelProviderAnswer {
  readonly id: SetupProviderId
  readonly credential: ModelCredential
  readonly baseURL: string | null
  readonly model: string | null
}

/** The answers document read by the interactive setup and by `--config`. */
export interface SetupAnswers {
  readonly schemaVersion: typeof SETUP_ANSWERS_SCHEMA_VERSION
  /** How the person uses Delorun; a document may leave it out, which means `local`. */
  readonly useCase: SetupUseCase
  /** The model provider, or `null` when none was chosen: the profile then keeps its bundles' provider rows unchanged. */
  readonly modelProvider: ModelProviderAnswer | null
  readonly prompts: PromptsAnswer
  readonly background: boolean
  /**
   * Whether setup installs a systemd user unit that starts Delorun at login. A document may leave it out, which means
   * `false`: a service that installs itself without being asked is the kind of thing that surprises a person.
   */
  readonly autostart: boolean
  readonly profile: ProfileAnswer
  readonly reach: ReachAnswer
  /** Whether setup imports the stock DeepSeek Harness home after showing its preview; never true in a `--config` document. */
  readonly importStockHome: boolean
  /**
   * Whether setup turns changes protection on for the home (contract C21), only at a terminal; `false` leaves the home's
   * setting as it is. Never true in a `--config` document.
   */
  readonly protectChanges: boolean
  /** Whether Delorun checks the release channel for a newer release; a document may leave it out, which means `true`. */
  readonly updateCheck: boolean
  /** The sections this run showed, in order; the studio's onboarding leaves out what the terminal covered. */
  readonly sections: readonly SectionRecord[]
}

/** The value setup applies to each question the person does not answer. */
export const SETUP_DEFAULTS = {
  schemaVersion: 5,
  useCase: SETUP_DEFAULT_USE_CASE,
  modelProvider: { id: SETUP_DEFAULT_PROVIDER_ID, credential: { source: 'prompt' }, baseURL: null, model: null },
  prompts: 'safer',
  background: true,
  autostart: false,
  profile: { name: null, port: null },
  reach: { option: 'none', identityFactor: null },
  importStockHome: false,
  protectChanges: false,
  updateCheck: true,
  sections: [],
} as const satisfies SetupAnswers

/**
 * The key an answers record written before the use-case question may hold: the interactive setup's Quick or Full
 * choice. Readers accept it and ignore it.
 */
export const LEGACY_SETUP_MODE_KEY = 'mode' as const

/**
 * Keys that answers documents of version 4 or earlier carried for a question Delorun no longer has (`phonePowers`, the
 * removed Phone powers level). Readers of those versions accept them, ignore their values and say so; a version-5 document
 * that holds one is refused.
 */
export const IGNORED_ANSWER_KEYS = ['phonePowers'] as const

/** Keys that earlier answers documents carried and that setup no longer asks; a document holding one is refused. */
export const REMOVED_ANSWER_KEYS = ['studioAdditions', 'runtime', 'helpSetUpModels', 'sessionLogUpload', 'desktopAnalytics'] as const

/** Upstream profile row that each opt-in's `config.enabled` is written to; the Privacy section in Settings owns them. */
export const SETUP_OPT_IN_ROWS = {
  sessionLogUpload: 'session-log-deepseek',
  desktopAnalytics: 'product-analytics',
} as const

/** The `@delorun/bundle-local` row whose `config.enabled` the `updateCheck` answer and the Privacy section's release-check switch write. */
export const SETUP_UPDATE_CHECK_ROW = 'delorun-update-check' as const
