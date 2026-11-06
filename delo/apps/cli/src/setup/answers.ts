/**
 * The answers `delorun setup` applies (contract C11, "Answer schema" and
 * "The --yes and --config forms"): the `--config` document, the `--yes`
 * defaults, and the refusals that keep reach, credential forwarding and
 * upstream's opt-ins off unless the person turns them on in the interactive
 * form. A refusal names the field and never echoes a value.
 *
 * @module @delo/cli/setup/answers
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  SETUP_ANSWERS_SCHEMA_VERSION,
  SETUP_DEFAULT_CREDENTIAL_VARIABLE,
  SETUP_DEFAULTS,
  type SetupAnswers,
} from '@delo/contract-setup-answers'
import { CliError, EXIT } from '../exit.ts'

/** An environment variable name. A credential value never matches it, so one passed as a name is refused. */
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/

const modelCredential = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('prompt') }),
  z.strictObject({ source: z.literal('environment'), name: z.string().regex(ENVIRONMENT_NAME) }),
])

const runtime = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native') }),
  z.strictObject({ kind: z.literal('docker'), shape: z.enum(['S2', 'S3']), preset: z.enum(['small', 'balanced', 'large', 'advanced']) }),
])

const reach = z.strictObject({
  option: z.enum(['none', 'tailscale-private', 'tailscale-funnel', 'self-hosted-relay']),
  identityFactor: z.enum(['passkey', 'oidc', 'tailnet']).nullable(),
})

/** The answers document schema: the fields and their value types, before the rules that need two fields at once. */
export const answersSchema = z.strictObject({
  schemaVersion: z.literal(SETUP_ANSWERS_SCHEMA_VERSION),
  modelProvider: z.strictObject({ id: z.string().min(1), credential: modelCredential }),
  studioAdditions: z.boolean(),
  runtime,
  reach,
  helpSetUpModels: z.boolean(),
  sessionLogUpload: z.boolean(),
  desktopAnalytics: z.boolean(),
  importStockHome: z.boolean(),
})

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
    throw new CliError(EXIT.failed, `delorun setup --config: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError(EXIT.failed, `delorun setup --config: ${path} is not a JSON document`)
  }
  const checked = answersSchema.safeParse(parsed)
  if (!checked.success) {
    const [issue] = checked.error.issues
    if (issue === undefined) throw refusal('the document', 'is not a value the answers document accepts')
    const field = issue.path.map(String).join('.')
    if (issue.code === 'unrecognized_keys') throw refusal(field === '' ? 'the document' : field, 'holds a field the answers document does not define; a credential value is never accepted in it')
    if (field === 'modelProvider.credential.name') throw refusal(field, 'must be the name of an environment variable; a credential value is never accepted in it')
    if (field === 'schemaVersion') throw refusal(field, `must be ${String(SETUP_ANSWERS_SCHEMA_VERSION)}; setup refuses any other version`)
    throw refusal(field === '' ? 'the document' : field, 'is not a value the answers document accepts')
  }
  const answers = checked.data
  // Reach and the upstream opt-ins are switched on in the interactive form only, so a document cannot enable them.
  if (answers.reach.option !== 'none') throw refusal('reach.option', 'must be "none" in --config: reach is set up in the studio, not by a document')
  if (answers.sessionLogUpload) throw refusal('sessionLogUpload', 'must be false in --config: turn it on in setup or on the consent screen')
  if (answers.desktopAnalytics) throw refusal('desktopAnalytics', 'must be false in --config: turn it on in setup or on the consent screen')
  if (answers.modelProvider.credential.source === 'prompt') throw refusal('modelProvider.credential.source', 'must be "environment" in --config: a document cannot take the key at a prompt')
  if (answers.reach.identityFactor !== null) throw refusal('reach.identityFactor', 'must be null: reach is not set up by a document')
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
