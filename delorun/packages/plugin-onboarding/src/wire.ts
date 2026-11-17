/**
 * What both halves share: the exact Connection Fetch routes under `/api`, which the harness serves only to an
 * owner peer, and their JSON messages. Browser-safe, so the studio half imports it.
 * @module @delorun/plugin-onboarding/wire
 */
import { z } from 'zod'

/** The harness's route. The studio fetches it without its leading `/`, relative to the document. `GET` answers {@link SetupRecord}. */
export const SETUP_RECORD_PATH = '/api/delorunOnboarding.setupRecord'

/** A setup section's name: lower-case letters, digits and hyphens, starting with a letter. */
export const SECTION_NAME = /^[a-z][a-z0-9-]{0,39}$/

/** The most section names the record may hold. */
export const MAX_SECTIONS = 32

/** The section names a record lists. */
export const SectionNames = z.array(z.string().regex(SECTION_NAME)).max(MAX_SECTIONS)

/** The route that records or clears a deferred step. `POST` takes {@link DeferStepRequest} and answers {@link DeferStepAnswer}. The studio fetches it without its leading `/`. */
export const DEFER_STEP_PATH = '/api/delorunOnboarding.deferStep'

/**
 * The onboarding steps only the home's own computer can do, which a phone defers: turning phone access on, setting the PIN,
 * and approving a device. The list is closed; the route refuses any other id.
 */
export const DEFERRABLE_STEPS = ['reach', 'pin', 'approve'] as const

/** One deferrable step's id. */
export const DeferrableStep = z.enum(DEFERRABLE_STEPS)

/** One deferrable step's id. */
export type DeferrableStep = z.output<typeof DeferrableStep>

/** The body of {@link DEFER_STEP_PATH}: the step, and whether it is deferred (true) or done (false). */
export const DeferStepRequest = z.strictObject({ id: DeferrableStep, deferred: z.boolean() })

/** The body of {@link DEFER_STEP_PATH}. */
export type DeferStepRequest = z.output<typeof DeferStepRequest>

/** The answer of {@link DEFER_STEP_PATH}: every step deferred now, in the order of {@link DEFERRABLE_STEPS}. */
export const DeferStepAnswer = z.strictObject({ deferred: z.array(DeferrableStep).max(DEFERRABLE_STEPS.length) })

/** The answer of {@link DEFER_STEP_PATH}. */
export type DeferStepAnswer = z.output<typeof DeferStepAnswer>

/**
 * What the terminal setup recorded, reduced to what onboarding uses: the ids of the sections the terminal showed or
 * asked when the record lists them, and whether reach is set up. `deferred` is not from the terminal: it lists the steps
 * a phone deferred to the computer, kept in the home; absent means none.
 */
export const SetupRecord = z.strictObject({
  sections: SectionNames.optional(),
  reachSetUp: z.boolean(),
  deferred: z.array(DeferrableStep).max(DEFERRABLE_STEPS.length).optional(),
})

/** What the terminal setup recorded, as {@link SetupRecord} parses it. */
export type SetupRecord = z.output<typeof SetupRecord>

/** The record of a profile with no usable setup record: nothing is covered and reach is not set up, so every step shows. */
export const NO_RECORD: SetupRecord = Object.freeze({ reachSetUp: false })

// The folder kinds are `@delorun/plugin-new-workspace`'s; the Workspace step names what a chosen folder holds.
export { FOLDER_KINDS, type FolderKind } from '@delorun/plugin-new-workspace/wire'

/** The harness's route that reports this computer's readiness. `GET` answers {@link Readiness}. */
export const READINESS_PATH = '/api/delorunOnboarding.readiness'

/** Whether a coding agent has a sign-in on this computer: `unknown` where the probe cannot see it, as Claude Code's Keychain on macOS. */
export const AGENT_SIGN_INS = ['found', 'missing', 'unknown'] as const

/** One of {@link AGENT_SIGN_INS}. */
export type AgentSignIn = typeof AGENT_SIGN_INS[number]

/** How far Tailscale is from serving the studio, by the first thing missing; `unknown` when the probe cannot tell. */
export const TailscaleReadiness = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), dnsName: z.string().min(1).max(253) }),
  z.strictObject({ state: z.enum(['not-installed', 'signed-out', 'https-off', 'needs-operator', 'unknown']) }),
])

/** {@link TailscaleReadiness}'s parsed value. */
export type TailscaleReadiness = z.output<typeof TailscaleReadiness>

/** This computer's readiness for the agents and reach steps. */
export const Readiness = z.strictObject({
  agents: z.strictObject({ 'claude-code': z.enum(AGENT_SIGN_INS), 'codex': z.enum(AGENT_SIGN_INS) }),
  tailscale: TailscaleReadiness,
})

/** {@link Readiness}'s parsed value. */
export type Readiness = z.output<typeof Readiness>

/** The official DeepSeek route, which `@deepseek-ai/dsh-llm-deepseek-api-key` registers. */
export const DEEPSEEK_ROUTE = 'deepseek-official'

/** The harness's route that tests each model provider's key with its free model listing. `POST` with no body answers {@link KeyTestAnswer}. */
export const KEY_TEST_PATH = '/api/delorunOnboarding.keyTest'

/**
 * What one provider's test came to: `works` the listing answered; `rejected` the provider refused the key;
 * `unreachable` the provider did not answer; `failed` the test failed without saying which; `no-key` no credential is
 * configured for it (for the official DeepSeek route, it is not signed in); `untested` it has a credential, or a sign-in,
 * but its models cannot be listed.
 */
export const KEY_RESULTS = ['works', 'rejected', 'unreachable', 'failed', 'no-key', 'untested'] as const

/** One of {@link KEY_RESULTS}. */
export type KeyResult = typeof KEY_RESULTS[number]

/**
 * Where a provider's key came from: `saved` the key file in Delorun's home, `environment` the environment Delorun started
 * with, `project-file` a `.env` in the folder Delorun started in, `home-file` the `.env` in Delorun's home, `unknown` a layer
 * this list does not name.
 */
export const KEY_SOURCE_KINDS = ['saved', 'environment', 'project-file', 'home-file', 'unknown'] as const

/** One of {@link KEY_SOURCE_KINDS}. */
export type KeySourceKind = typeof KEY_SOURCE_KINDS[number]

/** A variable name: letters, digits and underscores only, so a value pasted in its place is refused. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Where one provider's key came from: the kind and the NAME of the variable that holds it, never its value. */
export const KeySource = z.strictObject({ kind: z.enum(KEY_SOURCE_KINDS), variable: z.string().regex(VARIABLE_NAME).optional() })

/** {@link KeySource}'s parsed value. */
export type KeySource = z.output<typeof KeySource>

/** The most providers one test reports. */
export const MAX_PROVIDERS = 32

/**
 * Each usable provider route with its name and the test's result, in the order the harness lists them, and the route ids
 * the row's `hiddenProviders` leaves out, so the step does not offer them from the configurable-provider directory. The host always sends it; a reader treats a missing list as empty.
 */
export const KeyTestAnswer = z.strictObject({
  hidden: z.array(z.string().min(1).max(200)).max(MAX_PROVIDERS).optional(),
  providers: z.array(z.strictObject({ provider: z.string().min(1).max(200), name: z.string().min(1).max(200), result: z.enum(KEY_RESULTS), source: KeySource.optional() })).max(MAX_PROVIDERS),
})

/** {@link KeyTestAnswer}'s parsed value. */
export type KeyTestAnswer = z.output<typeof KeyTestAnswer>

/**
 * The harness's route that names this start of Delorun. `GET` answers {@link StartAnswer}. The guide's "Complete setup later"
 * keeps the guide closed while the start it was pressed in is the current one.
 */
export const START_PATH = '/api/delorunOnboarding.start'

/** The id of this start of the harness: random, new at every start, never stored by the harness. */
export const START_ID = /^[A-Za-z0-9-]{1,64}$/

/** What {@link START_PATH} answers. */
export const StartAnswer = z.strictObject({ startId: z.string().regex(START_ID) })

/** {@link StartAnswer}'s parsed value. */
export type StartAnswer = z.output<typeof StartAnswer>

/** The most set-aside file names the notice route lists. */
export const MAX_SET_ASIDE = 64

/**
 * The harness's route that tells the studio which workspace record files the registry set aside when it started.
 * `GET` answers {@link WorkspaceNoticeAnswer}; it is present only while the workspace registry is.
 */
export const WORKSPACE_NOTICE_PATH = '/api/delorunOnboarding.workspaceNotice'

/** The names, not the paths, of the files the registry set records aside into, oldest first; empty when nothing was set aside. */
export const WorkspaceNoticeAnswer = z.strictObject({
  setAside: z.array(z.string().min(1).max(300)).max(MAX_SET_ASIDE),
})

/** {@link WorkspaceNoticeAnswer}'s parsed value. */
export type WorkspaceNoticeAnswer = z.output<typeof WorkspaceNoticeAnswer>

/** The harness's route that reads which connections each recommended plugin is for. `POST` takes {@link RecommendRequest} and answers {@link RecommendAnswer}. */
export const RECOMMEND_PATH = '/api/delorunOnboarding.recommend'

/**
 * A connection id: `provider:<route>` for a model provider, `agent:<id>` for a coding agent with a sign-in on this
 * computer (`agent:claude-code`, `agent:codex`), `tool:<id>` for a tool on this computer (`tool:tailscale`).
 */
export const CONNECTION_ID = /^(?:provider|agent|tool):[a-z0-9][a-z0-9._-]{0,99}$/

/** Whether the person asked to look the plugins up in the npm registry, which is the only network request this route makes. */
export const RecommendRequest = z.strictObject({ registry: z.boolean() })

/**
 * Each configured plugin with the connections its package declares (`delorun.connections` in its `package.json`): read
 * from the installed package, from the registry when asked, or `unknown` when neither could be read. `registry` says
 * whether the registry was asked and answered.
 */
export const RecommendAnswer = z.strictObject({
  plugins: z.array(z.strictObject({
    name: z.string().min(1).max(214),
    connections: z.array(z.string().regex(CONNECTION_ID)).max(16),
    source: z.enum(['installed', 'registry', 'unknown']),
  })).max(16),
  registry: z.enum(['not-asked', 'reached', 'unreachable']),
})

/** {@link RecommendAnswer}'s parsed value. */
export type RecommendAnswer = z.output<typeof RecommendAnswer>

/** The harness's route that looks for local model servers on this computer. `GET` answers {@link LocalModelsAnswer}. */
export const LOCAL_MODELS_PATH = '/api/delorunOnboarding.localModels'

/** The local servers the step recognises, with the route id each is declared under. */
export const LOCAL_SERVER_KINDS = ['ollama', 'lm-studio'] as const

/** The most model ids one found server reports. */
export const MAX_LOCAL_MODELS = 200

/** One local server that answered its OpenAI-compatible model listing. */
export const LocalServer = z.strictObject({
  kind: z.enum(LOCAL_SERVER_KINDS),
  baseURL: z.string().min(1).max(200),
  models: z.array(z.string().min(1).max(200)).min(1).max(MAX_LOCAL_MODELS),
})

/** {@link LocalServer}'s parsed value. */
export type LocalServer = z.output<typeof LocalServer>

/** The local servers found, in the order {@link LOCAL_SERVER_KINDS} lists them. */
export const LocalModelsAnswer = z.strictObject({ servers: z.array(LocalServer).max(LOCAL_SERVER_KINDS.length) })

/** {@link LocalModelsAnswer}'s parsed value. */
export type LocalModelsAnswer = z.output<typeof LocalModelsAnswer>

/**
 * Whether a base URL is a plain-HTTP address on this computer's loopback interface, with no credentials.
 * @param baseURL - the address.
 * @returns true for `http://127.0.0.1`, `http://localhost` or `http://[::1]`, with any port and path.
 */
export function isLoopbackBaseURL(baseURL: string): boolean {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch (_notAUrl) {
    // Not an address, so not loopback.
    return false
  }
  return url.protocol === 'http:' && url.username === '' && url.password === ''
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
}

/** The harness's route that asks an installed agent which models it offers. `POST` takes {@link AgentModelsRequest} and answers {@link AgentModelsAnswer}. */
export const AGENT_MODELS_PATH = '/api/delorunOnboarding.agentModels'

/** The agents whose models the route lists. */
export const AGENT_IDS = ['claude-code', 'codex'] as const

/** Which agent's models to list. */
export const AgentModelsRequest = z.strictObject({ agent: z.enum(AGENT_IDS) })

/** {@link AgentModelsRequest}'s parsed value. */
export type AgentModelsRequest = z.output<typeof AgentModelsRequest>

/** One model an agent reports. */
export const AgentModelOption = z.strictObject({
  /** The name to configure as the agent's `model`. */
  model: z.string().min(1),
  /** The name a person knows it by. */
  displayName: z.string().min(1),
})

/** {@link AgentModelOption}'s parsed value. */
export type AgentModelOption = z.output<typeof AgentModelOption>

/**
 * What the route answers: the agent's models, or `unavailable` with why: `not-running` when the agent's package is not
 * installed and running (also the moment after it is added, before its provider registers), `timeout` when it did not
 * answer in time, `failed` when it answered with an error.
 */
export const AgentModelsAnswer = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('listed'), models: z.array(AgentModelOption) }),
  z.strictObject({ state: z.literal('unavailable'), reason: z.enum(['not-running', 'timeout', 'failed']) }),
])

/** {@link AgentModelsAnswer}'s parsed value. */
export type AgentModelsAnswer = z.output<typeof AgentModelsAnswer>
