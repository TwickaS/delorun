/**
 * The answers `delorun setup` applies (contract C11, "Answer schema" and
 * "The --yes and --config forms"): the `--config` document, the `--yes`
 * defaults, and the refusals that keep reach and credential forwarding off in
 * the unattended forms, the refusal of a document that asks for the stock-home import, which shows a preview first, and
 * a document that carries a question setup no longer asks. A refusal names the field and never echoes a value.
 * A version-2 document, written before the release-check question, reads as the current version with the check on.
 *
 * @module @delo/cli/setup/answers
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  IDENTITY_FACTORS,
  PROMPTS_OPTIONS,
  REMOVED_ANSWER_KEYS,
  SECTION_STATUSES,
  SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS,
  SETUP_ANSWERS_SCHEMA_VERSION,
  SETUP_DEFAULT_CREDENTIAL_VARIABLE,
  SETUP_DEFAULTS,
  type SetupAnswers,
} from '@delo/contract-setup-answers'
import { CliError, EXIT } from '../exit.ts'
import { selectProfile } from '../profile.ts'

/** An environment variable name. A credential value never matches it, so one passed as a name is refused. */
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/

/** The ports a studio may listen on without privileges. */
const MIN_PORT = 1024
const MAX_PORT = 65_535

const modelCredential = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('prompt') }),
  z.strictObject({ source: z.literal('environment'), name: z.string().regex(ENVIRONMENT_NAME) }),
])

const reach = z.strictObject({
  option: z.enum(['none', 'tailscale-private', 'tailscale-funnel', 'self-hosted-relay']),
  identityFactor: z.enum(IDENTITY_FACTORS).nullable(),
})

/** The fields every schema version carries, but `sections`, which comes last. */
const answerFields = {
  modelProvider: z.strictObject({ id: z.string().min(1), credential: modelCredential }),
  prompts: z.enum(PROMPTS_OPTIONS),
  background: z.boolean(),
  profile: z.strictObject({ name: z.string().min(1).nullable(), port: z.number().int().min(MIN_PORT).max(MAX_PORT).nullable() }),
  reach,
  importStockHome: z.boolean(),
}

const sections = z.array(z.strictObject({ id: z.string().min(1), status: z.enum(SECTION_STATUSES) })).default([])

/**
 * The answers document schema of the current version: the fields and their value types, before the rules that need
 * two fields at once. The fields keep the order of {@link SETUP_DEFAULTS}, so a record writes the same text however it was read.
 */
const answersSchema = z.strictObject({
  schemaVersion: z.literal(SETUP_ANSWERS_SCHEMA_VERSION),
  ...answerFields,
  updateCheck: z.boolean().default(SETUP_DEFAULTS.updateCheck),
  sections,
})

/** The version-2 document, which has no `updateCheck`, read as the current version with the check on. */
const version2Schema = z.strictObject({ schemaVersion: z.literal(2), ...answerFields, sections })
  .transform(({ sections: record, ...answers }) => ({ ...answers, schemaVersion: SETUP_ANSWERS_SCHEMA_VERSION, updateCheck: SETUP_DEFAULTS.updateCheck, sections: record }))

/**
 * The schema of a document's declared version.
 * @param document - a parsed JSON value.
 * @returns the version-2 schema for a document that declares version 2, otherwise the current one.
 */
function schemaFor(document: unknown): typeof answersSchema | typeof version2Schema {
  return typeof document === 'object' && document !== null && Reflect.get(document, 'schemaVersion') === 2 ? version2Schema : answersSchema
}

/**
 * Check answers against the schema of their declared version; a version-2 document comes back as the current version.
 * @param document - a parsed JSON value: an answers document, or the answers of a setup record.
 * @returns zod's result, whose data is current-version answers.
 */
export function parseAnswers(document: unknown): z.ZodSafeParseResult<SetupAnswers> {
  return schemaFor(document).safeParse(document)
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
 * @returns the answers, with every field set.
 * @throws {CliError} `EXIT.failed` for an unreadable, malformed or refused document.
 */
export function readAnswersDocument(path: string): SetupAnswers {
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
  const checked = parseAnswers(parsed)
  if (!checked.success) {
    // A failed parse carries at least one issue.
    const issue = checked.error.issues[0] as (typeof checked.error.issues)[number]
    const field = issue.path.map(String).join('.')
    // Only a version-2 document lacks the field at the top level.
    if (issue.code === 'unrecognized_keys' && field === '' && issue.keys.includes('updateCheck')) throw refusal('updateCheck', `needs schemaVersion ${String(SETUP_ANSWERS_SCHEMA_VERSION)}`)
    if (issue.code === 'unrecognized_keys') throw refusal(field === '' ? 'the document' : field, 'holds a field the answers document does not define; a credential value is never accepted in it')
    if (field === 'modelProvider.credential.name') throw refusal(field, 'must be the name of an environment variable; a credential value is never accepted in it')
    if (field === 'schemaVersion') throw refusal(field, `must be ${String(SETUP_ANSWERS_SCHEMA_VERSION)}, or ${SETUP_ANSWERS_EARLIER_SCHEMA_VERSIONS.join(' or ')} for an earlier document; setup refuses any other version`)
    throw refusal(field === '' ? 'the document' : field, 'is not a value the answers document accepts')
  }
  const answers = checked.data
  // Reach is switched on in the interactive form only, so a document cannot enable it.
  if (answers.reach.option !== 'none') throw refusal('reach.option', 'must be "none" in --config: reach is set up in the studio, not by a document')
  if (answers.modelProvider.credential.source === 'prompt') throw refusal('modelProvider.credential.source', 'must be "environment" in --config: a document cannot take the key at a prompt')
  if (answers.reach.identityFactor !== null) throw refusal('reach.identityFactor', 'must be null: reach is not set up by a document')
  if (answers.sections.length > 0) throw refusal('sections', 'is written by setup; remove it from the document')
  // The stock-home import shows its preview before anything changes, which no document can stand in for.
  if (answers.importStockHome) throw refusal('importStockHome', 'must be false in --config: the import shows what it copies before it asks, so run delorun import-home in a terminal')
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

/**
 * The answers `--yes` applies: every default, with the model key read from the environment variable the defaults name.
 * @param env - the environment `delorun` inherited.
 * @returns the answers.
 * @throws {CliError} `EXIT.failed` when the variable is unset; the message names it.
 */
export function yesAnswers(env: Readonly<Record<string, string | undefined>>): SetupAnswers {
  const name = SETUP_DEFAULT_CREDENTIAL_VARIABLE
  if (env[name] === undefined || env[name] === '') {
    throw new CliError(EXIT.failed, `delorun setup --yes: ${name} is not set; set it to the model key, or run delorun setup in a terminal to enter it`)
  }
  return { ...SETUP_DEFAULTS, modelProvider: { id: SETUP_DEFAULTS.modelProvider.id, credential: { source: 'environment', name } } }
}
