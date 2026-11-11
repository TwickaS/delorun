/**
 * Values of secret-role fields in profile files. A plugin's Config schema marks a field that holds a credential with
 * `role('secret')`; Delo keeps such a value in upstream's credentials file and never in a patch file, which the profile
 * history saves in git (contract C1). These functions find a value for a secret-role field in a plugin's config, in a
 * patch layer's text or in the files of a history version, by reading each row's config against the Config schema of
 * the loaded plugin with that row's id. They name each place, the file, the row and the field, and never the value.
 *
 * Only rows of loaded plugins are checked, because only a loaded plugin's schema says which fields are secret. A `!!js`
 * expression is code that computes a value, such as one read from the environment, and is not a value. A patch whose
 * text is not YAML is not checked; the Host refuses to load it.
 *
 * @module @delo/profile-safety/secrets
 */
import type { VersionAdmission } from '@deepseek-ai/dsh-plugin-manager/history'
import { redactSecrets } from '@deepseek-ai/dsh-settings/redact'
import { parse } from 'yaml'
import { HOME_PATCH_COPY_FILENAME, PROFILE_PATCH_FILENAME } from './files.ts'

/**
 * The live Config schemas of the loaded plugin rows with one patch id.
 * @param entryId - the row's patch id.
 * @returns each loaded row's Config schema; empty when no loaded row has the id or a schema.
 */
export type ConfigSchemasOf = (entryId: string) => readonly unknown[]

/** One secret-role field that holds a value. */
export interface SecretField {
  /** The field's path inside the row's config, with concrete dictionary keys and array indexes. */
  readonly path: readonly string[]
  /** The fields beside it whose role is `credential-ref`, where the plugin takes the name of a stored credential. */
  readonly references: readonly string[]
}

/** One place in a patch layer that holds a value for a secret-role field. */
export interface SecretValuePlace extends SecretField {
  /** The patch file, as the caller named it. */
  readonly file: string
  /** The patch id of the row whose config holds the value. */
  readonly entryId: string
}

/** The structural view of a schemastery node that the reference lookup walks. */
interface SchemaNode {
  readonly type?: string
  readonly meta?: { readonly role?: unknown }
  readonly dict?: Readonly<Record<string, SchemaNode>>
  readonly inner?: SchemaNode
}

/** The schema type {@link redactSecrets} walks. */
type ConfigSchema = Parameters<typeof redactSecrets>[0]

/** Upstream's `!!js` tag, which Cordis's Loader reads as an `{ __jsExpr }` node. */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ __jsExpr: source }) }

/**
 * @param value - a parsed value.
 * @returns whether it is a mapping.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param value - a value a Loader entry's runtime declares as its `Config`.
 * @returns whether it is a schemastery schema, the only kind whose fields carry roles.
 */
function isConfigSchema(value: unknown): value is ConfigSchema {
  return (typeof value === 'function' || isRecord(value)) && value !== null && 'toJSON' in value && 'meta' in value
}

/**
 * @param value - a raw config value.
 * @returns the value with every `!!js` expression node removed, so only literal values count as set.
 */
function withoutExpressions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutExpressions)
  if (!isRecord(value)) return value
  if (Object.keys(value).length === 1 && typeof value['__jsExpr'] === 'string') return undefined
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withoutExpressions(child)]))
}

/**
 * The `credential-ref` fields of the object that holds a field.
 * @param schema - the row's Config schema.
 * @param path - the secret field's path.
 * @returns the names of the reference fields beside it; empty when the holder is not an object schema reached through
 *   object properties, dictionaries and arrays.
 */
function referencesBeside(schema: SchemaNode, path: readonly string[]): string[] {
  let node: SchemaNode | undefined = schema
  for (const key of path.slice(0, -1)) {
    node = node?.type === 'object' ? node.dict?.[key] : node?.inner
  }
  if (node?.type !== 'object') return []
  return Object.entries(node.dict ?? {}).filter(([, field]) => field.meta?.role === 'credential-ref').map(([name]) => name)
}

/**
 * Find the secret-role fields that hold a literal value in one row's config.
 * @param config - the row's raw config.
 * @param schemas - the Config schemas of the loaded plugins the row configures; a value that is not a schemastery schema
 *   is skipped.
 * @returns each field once, in the order the schemas declare them.
 */
export function secretFieldsSet(config: unknown, schemas: readonly unknown[]): SecretField[] {
  const literal = withoutExpressions(config)
  const found = new Map<string, SecretField>()
  for (const schema of schemas) {
    if (!isConfigSchema(schema)) continue
    for (const secret of redactSecrets(schema, literal).secrets) {
      const key = JSON.stringify(secret.path)
      if (secret.set && !found.has(key)) found.set(key, { path: secret.path, references: referencesBeside(schema as SchemaNode, secret.path) })
    }
  }
  return [...found.values()]
}

/**
 * Each row config of a parsed patch list: the config of a row an entry targets by id, and of every row an `insert` list
 * adds, a group's rows included.
 * @param rows - the parsed patch list.
 * @returns the rows' ids and configs.
 */
function rowConfigs(rows: unknown): Array<{ entryId: string; config: unknown }> {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row): Array<{ entryId: string; config: unknown }> => {
    if (!isRecord(row)) return []
    if (Array.isArray(row['insert'])) return rowConfigs(row['insert'])
    if (typeof row['id'] !== 'string') return []
    if (Array.isArray(row['config'])) return rowConfigs(row['config'])
    return row['config'] === undefined ? [] : [{ entryId: row['id'], config: row['config'] }]
  })
}

/**
 * Find the values for secret-role fields that one patch layer holds.
 * @param file - the patch file's name, which each place carries.
 * @param text - the file's text.
 * @param schemasOf - the loaded plugins' Config schemas by row id.
 * @returns each place, in file order; empty for text that is not YAML.
 */
export function secretValuesInPatch(file: string, text: string, schemasOf: ConfigSchemasOf): SecretValuePlace[] {
  let rows: unknown
  try {
    rows = parse(text, { customTags: [JS_TAG], logLevel: 'silent' })
  } catch (_notYaml) {
    // Text that is not YAML holds no row the Loader reads, and the Host refuses to load it; there is nothing to check.
    return []
  }
  return rowConfigs(rows).flatMap(({ entryId, config }) =>
    secretFieldsSet(config, schemasOf(entryId)).map(field => ({ file, entryId, ...field })))
}

/**
 * Find the values for secret-role fields in the patch layers of one profile history version: the profile's own
 * `cordis.patch.yml` and Delo's copy of the home patch.
 * @param files - the version's files by name relative to the profile, as {@link VersionAdmission} receives them.
 * @param schemasOf - the loaded plugins' Config schemas by row id.
 * @returns each place.
 */
export function secretValuesInVersion(files: ReadonlyMap<string, string | undefined>, schemasOf: ConfigSchemasOf): SecretValuePlace[] {
  return [PROFILE_PATCH_FILENAME, HOME_PATCH_COPY_FILENAME].flatMap((name) => {
    const text = files.get(name)
    return text === undefined ? [] : secretValuesInPatch(name, text, schemasOf)
  })
}

/**
 * Name one secret field of a row, with where the plugin takes a credential's name instead.
 * @param entryId - the row's patch id.
 * @param field - the field.
 * @returns e.g. `the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead)`.
 */
export function describeSecretField(entryId: string, field: SecretField): string {
  const reference = field.references.length === 0 ? '' : ` (name a stored credential in ${field.references.join(' or ')} instead)`
  return `the secret field ${field.path.join('.')} of ${entryId}${reference}`
}

/**
 * Name every place, for a refusal.
 * @param places - the places, at least one.
 * @returns e.g. `cordis.patch.yml holds a value for the secret field apiKey of web-deepseek-api (…)`, joined by `; `.
 */
export function describeSecretValues(places: readonly SecretValuePlace[]): string {
  return places.map(place => `${place.file} holds a value for ${describeSecretField(place.entryId, place)}`).join('; ')
}

/**
 * The history admission that refuses a version whose patch layers hold a value for a secret-role field.
 * @param schemasOf - the loaded plugins' Config schemas by row id.
 * @returns the admission for upstream's `ProfileHistory` and the plugin manager's `plugin-manager/before-record`.
 */
export function secretFieldAdmission(schemasOf: ConfigSchemasOf): VersionAdmission {
  return (files) => {
    const places = secretValuesInVersion(files, schemasOf)
    if (places.length === 0) return undefined
    return `${describeSecretValues(places)}. Delo keeps secrets out of patch files, which the profile history saves in git: store the value in the credentials file under a name, name it in the plugin's credential field, and delete the value from the patch`
  }
}
