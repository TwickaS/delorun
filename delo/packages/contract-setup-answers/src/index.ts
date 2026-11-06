/**
 * Answer types, defaults and upstream profile row names of `delorun setup`, as
 * specified by `delo/docs/contracts/c11-setup-answers.md`. This module holds
 * readonly constants and types only.
 *
 * @module @delo/contract-setup-answers
 */

/** Schema version of the answers document. Setup refuses any other value. */
export const SETUP_ANSWERS_SCHEMA_VERSION = 1 as const

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

/** Docker shapes that setup offers. */
export const DOCKER_SHAPES = ['S2', 'S3'] as const

/** One Docker shape of {@link DOCKER_SHAPES}. */
export type DockerShape = (typeof DOCKER_SHAPES)[number]

/** Resource presets. Their values are defined by the Docker runtime contract. */
export const RESOURCE_PRESETS = ['small', 'balanced', 'large', 'advanced'] as const

/** One resource preset of {@link RESOURCE_PRESETS}. */
export type ResourcePreset = (typeof RESOURCE_PRESETS)[number]

/** Where the model credential comes from. `prompt` is accepted only in the interactive form. */
export type ModelCredential =
  | { readonly source: 'prompt' }
  | { readonly source: 'environment'; readonly name: string }

/** The runtime answer: `native`, or `docker` with a shape and a resource preset. */
export type RuntimeAnswer =
  | { readonly kind: 'native' }
  | { readonly kind: 'docker'; readonly shape: DockerShape; readonly preset: ResourcePreset }

/** The reach answer. `identityFactor` is `null` exactly when `option` is `none`. */
export interface ReachAnswer {
  readonly option: ReachOption
  readonly identityFactor: IdentityFactor | null
}

/** The answers document read by the interactive setup and by `--config`. */
export interface SetupAnswers {
  readonly schemaVersion: typeof SETUP_ANSWERS_SCHEMA_VERSION
  readonly modelProvider: { readonly id: string; readonly credential: ModelCredential }
  readonly studioAdditions: boolean
  readonly runtime: RuntimeAnswer
  readonly reach: ReachAnswer
  readonly helpSetUpModels: boolean
  readonly sessionLogUpload: boolean
  readonly desktopAnalytics: boolean
  readonly importStockHome: boolean
}

/** The value setup applies to each question the person does not answer. */
export const SETUP_DEFAULTS = {
  schemaVersion: 1,
  modelProvider: { id: 'deepseek-official', credential: { source: 'prompt' } },
  studioAdditions: true,
  runtime: { kind: 'native' },
  reach: { option: 'none', identityFactor: null },
  helpSetUpModels: false,
  sessionLogUpload: false,
  desktopAnalytics: false,
  importStockHome: false,
} as const satisfies SetupAnswers

/** Upstream profile row that each opt-in answer writes its `config.enabled` field to. */
export const SETUP_OPT_IN_ROWS = {
  sessionLogUpload: 'session-log-deepseek',
  desktopAnalytics: 'product-analytics',
} as const
