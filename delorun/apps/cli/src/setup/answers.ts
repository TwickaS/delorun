/**
 * The answers `delorun setup` applies (contract C11, "Answer schema" and
 * "The --yes and --config forms"): the `--config` document, the `--yes`
 * defaults, and the refusals that keep reach and credential forwarding off in
 * the unattended forms, the refusal of a document that asks for the stock-home import, which shows a preview first, or
 * for changes protection, which only a terminal proof changes, and a document that carries a question setup no longer
 * asks. A refusal names the field and never echoes a value.
 * An answers record written before the use-case question reads as `local`, and a `mode` of `quick` or `full` in it is ignored.
 * A version-2 document, written before the release-check question, reads as the current version with the check on; a
 * version-2 or version-3 document, written before the provider question, reads with DeepSeek and the profile's default
 * model as its provider, which is what setup of those versions applied.
 *
 * @module @delorun/cli/setup/answers
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  IDENTITY_FACTORS,
  IGNORED_ANSWER_KEYS,
  LEGACY_SETUP_MODE_KEY,
  PAIRING_ASKERS,
  PROMPTS_OPTIONS,
  REMOVED_ANSWER_KEYS,
  SECTION_STATUSES,
  SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS,
  SETUP_ANSWERS_SCHEMA_VERSION,
  SETUP_DEFAULT_PROVIDER_ID,
  SETUP_DEFAULT_USE_CASE,
  SETUP_DEFAULTS,
  SETUP_PROVIDER_IDS,
  SETUP_USE_CASES,
  type ModelProviderAnswer,
  type SetupAnswers,
} from '@delorun/contract-setup-answers'
import { CliError, EXIT } from '../exit.ts'
import { selectProfile } from '../profile.ts'
import { refuseDangerousAsRoot } from './dangerous.ts'
import { isSetupProviderId, SETUP_PROVIDERS, type ProviderCatalog } from './providers.ts'

/** An environment variable name. A credential value never matches it, so one passed as a name is refused. */
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/

/**
 * A model id: the characters provider catalogs and servers use in model names. Setup refuses any other text in a model
 * field, so a document or flag cannot carry a key with spaces or quotes there, and a refusal never echoes the value.
 */
const MODEL_ID = /^[A-Za-z0-9._:/@~+-]{1,200}$/

/** The characters a base URL may hold: no whitespace, and no `?`, `#` or `@`, which a query, fragment or user name needs. */
const BASE_URL_TEXT = /^[A-Za-z0-9._~:/[\]%-]{1,2000}$/

/** The ports a studio may listen on without privileges. */
const MIN_PORT = 1024
const MAX_PORT = 65_535

const modelCredential = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('prompt') }),
  z.strictObject({ source: z.literal('environment'), name: z.string().regex(ENVIRONMENT_NAME) }),
])

/**
 * The provider answer: a provider setup offers; a base URL for `openai-compatible` alone; a model for every provider
 * but DeepSeek, where `null` keeps the profile's default.
 */
const modelProvider = z.strictObject({
  id: z.enum(SETUP_PROVIDER_IDS),
  credential: modelCredential,
  baseURL: z.string().min(1).nullable(),
  model: z.string().nullable(),
}).superRefine((answer, context) => {
  const custom = SETUP_PROVIDERS[answer.id].adapter === 'custom'
  if (custom !== (answer.baseURL !== null)) context.addIssue({ code: 'custom', path: ['baseURL'], message: custom ? 'is needed for openai-compatible' : 'is set for openai-compatible only' })
  else if (answer.baseURL !== null && baseURLProblem(answer.baseURL) !== undefined) context.addIssue({ code: 'custom', path: ['baseURL'], message: BASE_URL_RULE })
  if (answer.model !== null && !MODEL_ID.test(answer.model)) context.addIssue({ code: 'custom', path: ['model'], message: MODEL_RULE })
  if (answer.model === null && answer.id !== SETUP_DEFAULT_PROVIDER_ID) context.addIssue({ code: 'custom', path: ['model'], message: `is needed for ${answer.id}` })
})

/**
 * The provider answer of a version-2 or version-3 document, which setup of those versions applied as DeepSeek's. Its id
 * must be DeepSeek's: another id would now name another provider, which only a version-4 document can set up.
 */
const earlierModelProvider = z.strictObject({ id: z.string().min(1), credential: modelCredential })
  .superRefine((answer, context) => {
    if (answer.id !== SETUP_DEFAULT_PROVIDER_ID) context.addIssue({ code: 'custom', path: ['id'], message: `needs schemaVersion ${String(SETUP_ANSWERS_SCHEMA_VERSION)} to name a provider other than ${SETUP_DEFAULT_PROVIDER_ID}` })
  })
  .transform(({ credential }): ModelProviderAnswer => ({ id: SETUP_DEFAULT_PROVIDER_ID, credential, baseURL: null, model: null }))

const reach = z.strictObject({
  option: z.enum(['none', 'tailscale-private', 'tailscale-funnel', 'self-hosted-relay']),
  identityFactor: z.enum(IDENTITY_FACTORS).nullable(),
  pairing: z.enum(PAIRING_ASKERS).optional(),
})

/** The fields every schema version carries, but the provider, which comes first, and `sections`, which comes last. */
const answerFields = {
  prompts: z.enum(PROMPTS_OPTIONS),
  background: z.boolean(),
  // An absent answer reads as no: a document written before the question existed installs no unit.
  autostart: z.boolean().default(SETUP_DEFAULTS.autostart),
  profile: z.strictObject({ name: z.string().min(1).nullable(), port: z.number().int().min(MIN_PORT).max(MAX_PORT).nullable() }),
  reach,
  importStockHome: z.boolean(),
  protectChanges: z.boolean().default(SETUP_DEFAULTS.protectChanges),
}

const sections = z.array(z.strictObject({ id: z.string().min(1), status: z.enum(SECTION_STATUSES) })).default([])

/**
 * The answers document schema of the current version: the fields and their value types, before the rules that need
 * two fields at once. The fields keep the order of {@link SETUP_DEFAULTS}, so a record writes the same text however it was read.
 */
const answersSchema = z.strictObject({
  schemaVersion: z.literal(SETUP_ANSWERS_SCHEMA_VERSION),
  useCase: z.enum(SETUP_USE_CASES).default(SETUP_DEFAULT_USE_CASE),
  modelProvider: modelProvider.nullable(),
  ...answerFields,
  updateCheck: z.boolean().default(SETUP_DEFAULTS.updateCheck),
  sections,
  /** A `--config` document's statement that it has read what dangerous mode allows; {@link readAnswersDocument} requires it with `prompts: "dangerous"` and drops it. */
  acceptDangerousMode: z.boolean().optional(),
})

/**
 * The version-4 document, which may still hold `phonePowers` (ignored: {@link parseAnswers} drops it), read as the current version.
 */
const version4Schema = answersSchema.extend({ schemaVersion: z.literal(4) })
  .transform(({ schemaVersion: _version, ...answers }) => ({ ...answers, schemaVersion: SETUP_ANSWERS_SCHEMA_VERSION }))

/** The version-3 document, which has no provider question, read as the current version with DeepSeek as its provider. */
const version3Schema = z.strictObject({ schemaVersion: z.literal(3), modelProvider: earlierModelProvider, ...answerFields, updateCheck: z.boolean().default(SETUP_DEFAULTS.updateCheck), sections })
  .transform(({ modelProvider: provider, sections: record, schemaVersion: _version, ...answers }) => ({ schemaVersion: SETUP_ANSWERS_SCHEMA_VERSION, useCase: SETUP_DEFAULT_USE_CASE, modelProvider: provider, ...answers, sections: record }))

/** The version-2 document, which has no `updateCheck` either, read as the current version with the check on. */
const version2Schema = z.strictObject({ schemaVersion: z.literal(2), modelProvider: earlierModelProvider, ...answerFields, sections })
  .transform(({ modelProvider: provider, sections: record, schemaVersion: _version, ...answers }) => ({ schemaVersion: SETUP_ANSWERS_SCHEMA_VERSION, useCase: SETUP_DEFAULT_USE_CASE, modelProvider: provider, ...answers, updateCheck: SETUP_DEFAULTS.updateCheck, sections: record }))

/**
 * The schema of a document's declared version.
 * @param document - a parsed JSON value.
 * @returns the schema of version 2 or 3 for a document that declares it, otherwise the current one.
 */
function schemaFor(document: unknown): typeof answersSchema | typeof version4Schema | typeof version3Schema | typeof version2Schema {
  const version = typeof document === 'object' && document !== null ? Reflect.get(document, 'schemaVersion') : undefined
  if (version === 2) return version2Schema
  if (version === 4) return version4Schema
  return version === 3 ? version3Schema : answersSchema
}

/** What a base URL must be, as a refusal states it. */
const BASE_URL_RULE = 'must be an http or https URL without a user name, password, query or fragment'

/** What a model id must be, as a refusal states it. */
const MODEL_RULE = 'must be a model id: letters, digits and . _ : / @ ~ + -'

/**
 * The check of a base URL a person gives for an endpoint: an `http` or `https` URL with no user name, password, query
 * or fragment, so the URL carries no credential and the key check's path joins it cleanly.
 * @param value - the entry.
 * @returns the message to show, which never repeats the entry, or `undefined` for a usable base URL.
 */
export function baseURLProblem(value: string): string | undefined {
  const problem = 'Enter an http or https URL without a user name, password, query or fragment, such as http://127.0.0.1:11434/v1.'
  if (!BASE_URL_TEXT.test(value)) return problem
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // `new URL` rejects text that is not a URL.
    return problem
  }
  const bare = url.username === '' && url.password === '' && url.search === '' && url.hash === ''
  return (url.protocol === 'https:' || url.protocol === 'http:') && bare ? undefined : problem
}

/**
 * The warning for a base URL whose requests anyone on the network path can read: plain `http` to a host other than
 * this computer's loopback addresses. It is a warning, not a refusal, because a server on the local network may offer
 * nothing else.
 * @param value - a base URL {@link baseURLProblem} accepts.
 * @returns the warning, or `undefined` for `https` or a loopback host.
 */
export function baseURLWarning(value: string): string | undefined {
  const url = new URL(value)
  if (url.protocol !== 'http:') return undefined
  const host = url.hostname
  if (host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(host)) return undefined
  return `${url.origin} is reached over plain http, so the key and every prompt cross the network unencrypted; use https unless the network to it is your own.`
}

/**
 * The check of a model id a person types.
 * @param value - the entry.
 * @returns the message to show, which never repeats the entry, or `undefined` for a model id.
 */
export function modelIdProblem(value: string): string | undefined {
  return MODEL_ID.test(value) ? undefined : 'Enter the model id: letters, digits and . _ : / @ ~ + -.'
}

/** A parsed answers document: the answers, and a `--config` document's `acceptDangerousMode`, which {@link readAnswersDocument} consumes. */
export type ParsedAnswers = SetupAnswers & { readonly acceptDangerousMode?: boolean | undefined }

/**
 * Check answers against the schema of their declared version; a version-2 document comes back as the current version.
 * @param document - a parsed JSON value: an answers document, or the answers of a setup record.
 * @returns zod's result, whose data is current-version answers.
 */
export function parseAnswers(document: unknown): z.ZodSafeParseResult<ParsedAnswers> {
  return schemaFor(document).safeParse(withoutIgnoredKeys(withoutLegacyMode(document)))
}

/**
 * @param document - a parsed JSON value.
 * @returns whether it declares a version before the current one, whose documents may hold a key of {@link IGNORED_ANSWER_KEYS}.
 */
function isEarlierDocument(document: unknown): boolean {
  const version = typeof document === 'object' && document !== null ? Reflect.get(document, 'schemaVersion') : undefined
  return typeof version === 'number' && (SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS as readonly number[]).includes(version)
}

/**
 * Drop the keys of {@link IGNORED_ANSWER_KEYS}, which an answers document written before their question was removed may hold.
 * @param document - a parsed JSON value.
 * @returns the value without those keys when it declares a version before the current one; any other value is returned as it is.
 */
function withoutIgnoredKeys(document: unknown): unknown {
  if (typeof document !== 'object' || document === null || Array.isArray(document) || !isEarlierDocument(document)) return document
  return Object.fromEntries(Object.entries(document).filter(([key]) => !(IGNORED_ANSWER_KEYS as readonly string[]).includes(key)))
}

/**
 * Drop the Quick or Full choice that an answers record written before the use-case question may hold.
 * @param document - a parsed JSON value.
 * @returns the value without a `mode` of `quick` or `full`; any other value is returned as it is.
 */
function withoutLegacyMode(document: unknown): unknown {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return document
  const mode: unknown = Reflect.get(document, LEGACY_SETUP_MODE_KEY)
  if (mode !== 'quick' && mode !== 'full') return document
  const { [LEGACY_SETUP_MODE_KEY]: _mode, ...rest } = document as Record<string, unknown>
  return rest
}

/**
 * The refusal for a document field, naming the field by path only.
 * @param path - the field's dotted path.
 * @param reason - what the document may hold there.
 * @returns the typed usage error.
 */
function refusal(path: string, reason: string): CliError {
  return new CliError(EXIT.failed, `delorun setup --config: ${path} ${reason}`)
}

/**
 * Read and check an answers document. The document is data from the person's file, so the refusals name the
 * field and never the value; a field the schema does not define is refused with no name echoed, which keeps a
 * credential value written under an unknown key out of the message.
 * @param path - the document's file.
 * @param note - receives one line when the document holds a key of {@link IGNORED_ANSWER_KEYS}, which is read and ignored.
 * @returns the answers, with every field set.
 * @throws {CliError} `EXIT.failed` for an unreadable, malformed or refused document.
 */
export function readAnswersDocument(path: string, note: (line: string) => void = () => {}): SetupAnswers {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new CliError(EXIT.failed, `delorun setup --config: cannot read ${path}: ${String(Reflect.get(Object(error), 'message'))}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError(EXIT.failed, `delorun setup --config: ${path} is not a JSON document`)
  }
  const removed = typeof parsed === 'object' && parsed !== null ? REMOVED_ANSWER_KEYS.filter(key => key in parsed) : []
  if (removed.length > 0) {
    throw new CliError(EXIT.failed, `delorun setup --config: ${path} holds ${removed.join(', ')}, which setup no longer asks; remove ${removed.length === 1 ? 'it' : 'them'} from the document`)
  }
  const ignored = typeof parsed === 'object' && parsed !== null && isEarlierDocument(parsed) ? IGNORED_ANSWER_KEYS.filter(key => key in parsed) : []
  if (ignored.length > 0) note(`delorun setup --config: ${path} holds ${ignored.join(', ')}, which Delorun no longer has; it is ignored`)
  const checked = parseAnswers(parsed)
  if (!checked.success) {
    // A failed parse carries at least one issue.
    const issue = checked.error.issues[0] as (typeof checked.error.issues)[number]
    const field = issue.path.map(String).join('.')
    // Only a version-2 document lacks the field at the top level.
    if (issue.code === 'unrecognized_keys' && field === '' && issue.keys.includes('updateCheck')) throw refusal('updateCheck', `needs schemaVersion ${String(SETUP_ANSWERS_SCHEMA_VERSION)}`)
    if (issue.code === 'unrecognized_keys' && field === 'modelProvider' && (issue.keys.includes('baseURL') || issue.keys.includes('model'))) throw refusal('modelProvider', `needs schemaVersion ${String(SETUP_ANSWERS_SCHEMA_VERSION)} to name a base URL or a model`)
    if (field === 'modelProvider.id' && issue.code !== 'custom') throw refusal(field, `must be one of ${SETUP_PROVIDER_IDS.join(', ')}`)
    if (issue.code === 'custom') throw refusal(field, issue.message)
    if (issue.code === 'unrecognized_keys') throw refusal(field === '' ? 'the document' : field, 'holds a field the answers document does not define; a credential value is never accepted in it')
    if (field === 'modelProvider.credential.name') throw refusal(field, 'must be the name of an environment variable; a credential value is never accepted in it')
    if (field === 'schemaVersion') throw refusal(field, `must be ${String(SETUP_ANSWERS_SCHEMA_VERSION)}, or ${SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS.join(' or ')} for an earlier document; setup refuses any other version`)
    throw refusal(field === '' ? 'the document' : field, 'is not a value the answers document accepts')
  }
  const { acceptDangerousMode, ...answers } = checked.data
  // The two-step consent of the terminal is stood in for by this field, so a document cannot select dangerous mode without it.
  if (answers.prompts === 'dangerous' && acceptDangerousMode !== true) throw refusal('acceptDangerousMode', 'must be true when prompts is "dangerous": dangerous mode lets any chat switch to full access without asking, so the document has to state that you accepted it (delorun setup prompts shows the warning)')
  if (answers.prompts !== 'dangerous' && acceptDangerousMode !== undefined) throw refusal('acceptDangerousMode', 'applies to prompts "dangerous" only; remove it from the document')
  refuseDangerousAsRoot(answers.prompts, 'delorun setup --config')
  // Reach is switched on in the interactive form only, so a document cannot enable it.
  if (answers.reach.option !== 'none') throw refusal('reach.option', 'must be "none" in --config: reach is set up in the studio, not by a document')
  if (answers.modelProvider?.credential.source === 'prompt') throw refusal('modelProvider.credential.source', 'must be "environment" in --config: a document cannot take the key at a prompt')
  if (answers.reach.identityFactor !== null) throw refusal('reach.identityFactor', 'must be null: reach is not set up by a document')
  if (answers.reach.pairing !== undefined) throw refusal('reach.pairing', 'must be absent: who may ask to pair a device is chosen in delorun setup reach, not by a document')
  if (answers.sections.length > 0) throw refusal('sections', 'is written by setup; remove it from the document')
  // The stock-home import shows its preview before anything changes, which no document can stand in for.
  if (answers.importStockHome) throw refusal('importStockHome', 'must be false in --config: the import shows what it copies before it asks, so run delorun import-home in a terminal')
  // Only a terminal proof changes the protection setting (C21), which no document can stand in for.
  if (answers.protectChanges) throw refusal('protectChanges', 'must be false in --config: changes protection is turned on only at a terminal, so run delorun changes protection on in one')
  if (answers.profile.name !== null) {
    try {
      selectProfile(answers.profile.name, {})
    } catch {
      // selectProfile names its own option in the message; here the field is the document's.
      throw refusal('profile.name', 'is not a profile name setup accepts')
    }
  }
  return answers
}

/** The provider `--yes` sets up, from `--provider`, `--model`, `--base-url` and `--key-env`. */
export interface ProviderChoice {
  /** `--provider`. */
  readonly id: string
  /** `--model`, if given. */
  readonly model: string | undefined
  /** `--base-url`, if given. */
  readonly baseURL: string | undefined
  /** `--key-env`, if given; the provider's own variable otherwise. */
  readonly keyEnv: string | undefined
}

/**
 * The provider answer of a `--yes` command line. The key is read from the environment at each start, from the
 * provider's own variable or the one `--key-env` names; a key is never taken from the command line.
 * @param choice - the flags.
 * @returns the provider answer.
 * @throws {CliError} `EXIT.usage` for an unknown provider, a missing or misplaced base URL or model, or a malformed variable name.
 */
export function chosenProvider(choice: ProviderChoice): ModelProviderAnswer {
  const usage = (text: string): CliError => new CliError(EXIT.usage, `delorun setup --provider: ${text}`)
  // The flag's text is not repeated: it could be a key typed in the wrong place.
  if (!isSetupProviderId(choice.id)) throw usage(`--provider names no provider setup offers; choose one of ${SETUP_PROVIDER_IDS.join(', ')}`)
  const provider = SETUP_PROVIDERS[choice.id]
  const name = choice.keyEnv ?? provider.keyVariable
  // A key passed where a variable name belongs is refused without being echoed.
  if (!ENVIRONMENT_NAME.test(name)) throw usage('--key-env must be the name of an environment variable; a key is never accepted on the command line')
  if (provider.adapter === 'custom' && choice.baseURL === undefined) throw usage(`${provider.id} needs --base-url, the endpoint's base URL`)
  if (provider.adapter !== 'custom' && choice.baseURL !== undefined) throw usage(`--base-url applies to openai-compatible only; ${provider.id} uses the endpoint its adapter ships`)
  if (choice.baseURL !== undefined && baseURLProblem(choice.baseURL) !== undefined) throw usage(`--base-url ${BASE_URL_RULE}`)
  const model = choice.model?.trim()
  if ((model === undefined || model === '') && provider.adapter !== 'deepseek') throw usage(`${provider.id} needs --model, the model new chats start on`)
  if (model !== undefined && model !== '' && !MODEL_ID.test(model)) throw usage(`--model ${MODEL_RULE}`)
  return { id: provider.id, credential: { source: 'environment', name }, baseURL: choice.baseURL ?? null, model: model === undefined || model === '' ? null : model }
}

/**
 * Refuse a provider answer that names a model its adapter's installed catalogue does not serve. The `openai-compatible`
 * route serves the model the answer names, so any model is accepted there.
 * @param answer - the provider answer, or `null`.
 * @param catalog - the installed catalogues.
 * @param source - the form the answer came from, which starts the message.
 * @param field - the flag or document field that named the model.
 * @throws {CliError} `EXIT.failed` for a model the catalog does not list; the message names the field and not its value.
 */
export function checkCatalogModel(answer: ModelProviderAnswer | null, catalog: ProviderCatalog, source: string, field: string): void {
  if (answer === null || answer.model === null || SETUP_PROVIDERS[answer.id].adapter === 'custom') return
  if (!catalog.models(answer.id).some(model => model.id === answer.model)) {
    throw new CliError(EXIT.failed, `${source}: ${field} names a model that is not in ${answer.id}'s installed catalogue; delorun setup key lists the models it serves`)
  }
}

/**
 * The answers `--yes` applies: every default, with the provider `--provider` names and its key read from the
 * environment, or no provider.
 * @param env - the environment `delorun` inherited.
 * @param choice - the `--provider` flags, if given.
 * @returns the answers.
 * @throws {CliError} `EXIT.failed` when the provider's variable is unset; the message names it.
 */
export function yesAnswers(env: Readonly<Record<string, string | undefined>>, choice?: ProviderChoice): SetupAnswers {
  if (choice === undefined) return { ...SETUP_DEFAULTS, modelProvider: null }
  const answer = chosenProvider(choice)
  const name = answer.credential.source === 'environment' ? answer.credential.name : SETUP_PROVIDERS[answer.id].keyVariable
  if (env[name] === undefined || env[name] === '') {
    throw new CliError(EXIT.failed, `delorun setup --yes: ${name} is not set; set it to the ${SETUP_PROVIDERS[answer.id].label} key, or run delorun setup in a terminal to enter it`)
  }
  return { ...SETUP_DEFAULTS, modelProvider: answer }
}
