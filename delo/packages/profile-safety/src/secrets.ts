/**
 * Values of secret-role fields in profile files. A plugin's Config schema marks a field that holds a credential with
 * `role('secret')`; Delo keeps such a value in upstream's credentials file and never in a patch file, which the profile
 * history saves in git (contract C1). These functions find a value for a secret-role field in a plugin's config, in a
 * patch layer's text or in the files of a history version, by reading each row's config against the Config schema of
 * the loaded plugin the row configures: by the row's id, or by its plugin name for an inserted row without one.
 *
 * A literal counts as a value unless it is empty or null. A `!!js` expression counts as a value too, unless it only
 * reads one environment variable (`process.env.NAME` or `env.NAME`), which is the way to give a plugin a key it cannot
 * name in the credentials file. Only rows of loaded plugins are checked, because only a loaded plugin's schema says
 * which fields are secret. A patch whose text is not YAML is not checked; the Host refuses to load it.
 *
 * The descriptions name each place, the file, the row and the field, and never the value.
 *
 * @module @delo/profile-safety/secrets
 */
import type { VersionAdmission } from '@deepseek-ai/dsh-plugin-manager/history'
import { redactSecrets } from '@deepseek-ai/dsh-settings/redact'
import { parseDocument } from 'yaml'
import { HOME_PATCH_COPY_FILENAME, PROFILE_PATCH_FILENAME } from './files.ts'

/** A patch row as the schema lookup reads it: its id, its plugin name, or both. */
export interface PatchRowIdentity {
  /** The row's patch id. */
  readonly id?: string
  /** The row's plugin name, which an inserted row declares. */
  readonly name?: string
}

/**
 * The live Config schemas of the loaded plugins a patch row configures: the loaded rows with its id, or, for a row
 * without an id, the loaded rows of its plugin name.
 * @param row - the row's id and name.
 * @returns each matching loaded row's Config schema; empty when none matches or has a schema.
 */
export type ConfigSchemasOf = (row: PatchRowIdentity) => readonly unknown[]

/** The first `credential-ref` field beside a secret field, where the plugin takes the name of a stored credential. */
export interface SecretReference {
  /** The reference field's name. */
  readonly field: string
  /** The value the row's config gives it, absent when the config does not set it. */
  readonly value?: unknown
  /** The schema's default for it, absent when the schema declares none. */
  readonly default?: unknown
}

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
  /** The row's patch id, or its plugin name for an inserted row without one. */
  readonly entryId: string
}

/** A place with what moving its value needs; only the migration that moves it reads `value`. */
export interface SecretValueFound extends SecretValuePlace {
  /** The YAML path from the document's root to the row's config. */
  readonly location: readonly (string | number)[]
  /** The value as the patch holds it: a string, an `{ __jsExpr }` node or another literal. */
  readonly value: unknown
  /** The first reference field beside it, when it has one. */
  readonly reference?: SecretReference
}

/** The structural view of a schemastery node that the reference lookup walks. */
interface SchemaNode {
  readonly type?: string
  readonly meta?: { readonly role?: unknown; readonly default?: unknown }
  readonly dict?: Readonly<Record<string, SchemaNode>>
  readonly inner?: SchemaNode
}

/** The schema type {@link redactSecrets} walks. */
type ConfigSchema = Parameters<typeof redactSecrets>[0]

/** Upstream's `!!js` tag, which Cordis's Loader reads as an `{ __jsExpr }` node. */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ __jsExpr: source }) }

/** The `!!js` expressions that only read one environment variable, which carry no value of their own. */
const ENVIRONMENT_READ = /^\s*(?:process\.env|env)\.[A-Za-z_][A-Za-z0-9_]*\s*$/u

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
  return (typeof value === 'function' || isRecord(value)) && 'toJSON' in value && 'meta' in value
}

/**
 * @param value - a parsed value.
 * @returns the expression's source when the value is a `!!js` node, otherwise undefined.
 */
export function expressionOf(value: unknown): string | undefined {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value['__jsExpr'] === 'string' ? value['__jsExpr'] : undefined
}

/**
 * @param value - a raw config value.
 * @returns the value with every unset leaf removed, so only a value counts as set: an empty string, null and a `!!js`
 *   expression that only reads an environment variable become undefined.
 */
function withoutUnset(value: unknown): unknown {
  if (value === '' || value === null) return undefined
  const expression = expressionOf(value)
  if (expression !== undefined) return ENVIRONMENT_READ.test(expression) ? undefined : value
  if (Array.isArray(value)) return value.map(withoutUnset)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withoutUnset(child)]))
}

/**
 * The schema node of the object that holds a field.
 * @param schema - the row's Config schema.
 * @param path - the field's path.
 * @returns the holder's node when it is an object schema reached through object properties, dictionaries and arrays.
 */
function holderOf(schema: SchemaNode, path: readonly string[]): SchemaNode | undefined {
  let node: SchemaNode | undefined = schema
  for (const key of path.slice(0, -1)) {
    node = node?.type === 'object' ? node.dict?.[key] : node?.inner
  }
  return node?.type === 'object' ? node : undefined
}

/**
 * @param schema - the row's Config schema.
 * @param path - the secret field's path.
 * @returns the names of the `credential-ref` fields beside it.
 */
function referencesBeside(schema: SchemaNode, path: readonly string[]): string[] {
  return Object.entries(holderOf(schema, path)?.dict ?? {}).filter(([, field]) => field.meta?.role === 'credential-ref').map(([name]) => name)
}

/**
 * Find the secret-role fields that hold a value in one row's config.
 * @param config - the row's raw config.
 * @param schemas - the Config schemas of the loaded plugins the row configures; a value that is not a schemastery schema
 *   is skipped.
 * @returns each field once, in the order the schemas declare them.
 */
export function secretFieldsSet(config: unknown, schemas: readonly unknown[]): SecretField[] {
  return fieldsWithSchema(config, schemas).map(({ field }) => field)
}

/**
 * {@link secretFieldsSet} with the schema that declared each field.
 * @param config - the row's raw config.
 * @param schemas - the candidate schemas.
 * @returns each field once with its schema.
 */
function fieldsWithSchema(config: unknown, schemas: readonly unknown[]): Array<{ field: SecretField; schema: SchemaNode }> {
  const set = withoutUnset(config)
  const found = new Map<string, { field: SecretField; schema: SchemaNode }>()
  for (const schema of schemas) {
    if (!isConfigSchema(schema)) continue
    const node = schema as SchemaNode
    for (const secret of redactSecrets(schema, set).secrets) {
      const key = JSON.stringify(secret.path)
      if (secret.set && !found.has(key)) found.set(key, { field: { path: secret.path, references: referencesBeside(node, secret.path) }, schema: node })
    }
  }
  return [...found.values()]
}

/** One row config of a patch list, with where it lies in the document. */
interface RowConfig {
  readonly row: PatchRowIdentity
  readonly config: unknown
  readonly location: readonly (string | number)[]
}

/**
 * Each row config of a parsed patch list: the config of a row an entry targets by id, and of every row an `insert` list
 * adds, a group's rows included.
 * @param rows - the parsed patch list.
 * @param location - the list's YAML path.
 * @returns the rows' identities, configs and YAML paths.
 */
function rowConfigs(rows: unknown, location: readonly (string | number)[]): RowConfig[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row, index): RowConfig[] => {
    if (!isRecord(row)) return []
    if (Array.isArray(row['insert'])) return rowConfigs(row['insert'], [...location, index, 'insert'])
    const identity: PatchRowIdentity = {
      ...typeof row['id'] === 'string' ? { id: row['id'] } : {},
      ...typeof row['name'] === 'string' ? { name: row['name'] } : {},
    }
    if (identity.id === undefined && identity.name === undefined) return []
    if (Array.isArray(row['config'])) return rowConfigs(row['config'], [...location, index, 'config'])
    return row['config'] === undefined ? [] : [{ row: identity, config: row['config'], location: [...location, index, 'config'] }]
  })
}

/**
 * Read a value at a path of string keys, where array indexes are digits.
 * @param value - the root.
 * @param path - the keys.
 * @returns the value, or undefined when a step is missing.
 */
function valueAt(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, key) => Array.isArray(node) ? node[Number(key)] : isRecord(node) ? node[key] : undefined, value)
}

/**
 * Find the values for secret-role fields that one patch layer holds, with what moving each one needs.
 * @param file - the patch file's name, which each place carries.
 * @param text - the file's text.
 * @param schemasOf - the loaded plugins' Config schemas.
 * @returns each place, in file order; empty for text that is not YAML.
 */
export function findSecretValues(file: string, text: string, schemasOf: ConfigSchemasOf): SecretValueFound[] {
  const document = parseDocument(text, { customTags: [JS_TAG], logLevel: 'silent' })
  // Text that is not YAML holds no row the Loader reads, and the Host refuses to load it; there is nothing to check.
  if (document.errors.length > 0) return []
  return rowConfigs(document.toJS(), []).flatMap(({ row, config, location }) =>
    fieldsWithSchema(config, schemasOf(row)).map(({ field, schema }): SecretValueFound => {
      const [first] = field.references
      const holder = valueAt(config, field.path.slice(0, -1))
      const reference = first === undefined ? undefined : {
        field: first,
        ...isRecord(holder) && holder[first] !== undefined ? { value: holder[first] } : {},
        ...holderOf(schema, field.path)?.dict?.[first]?.meta?.default === undefined ? {} : { default: holderOf(schema, field.path)?.dict?.[first]?.meta?.default },
      }
      return {
        file, entryId: row.id ?? row.name ?? '', location, value: valueAt(config, field.path), ...field,
        ...reference === undefined ? {} : { reference },
      }
    }))
}

/**
 * Find the values for secret-role fields that one patch layer holds.
 * @param file - the patch file's name, which each place carries.
 * @param text - the file's text.
 * @param schemasOf - the loaded plugins' Config schemas.
 * @returns each place, in file order, without its value; empty for text that is not YAML.
 */
export function secretValuesInPatch(file: string, text: string, schemasOf: ConfigSchemasOf): SecretValuePlace[] {
  return findSecretValues(file, text, schemasOf).map(({ file: name, entryId, path, references }) => ({ file: name, entryId, path, references }))
}

/**
 * Find the values for secret-role fields in the patch layers of one profile history version: the profile's own
 * `cordis.patch.yml` and Delo's copy of the home patch.
 * @param files - the version's files by name relative to the profile, as {@link VersionAdmission} receives them.
 * @param schemasOf - the loaded plugins' Config schemas.
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
 * @param entryId - the row's patch id, or its plugin name.
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
 * How to give a plugin a key without writing it into a patch file, for the fields named.
 * @param references - whether the plugin names a stored credential in a reference field.
 * @returns the remedy sentence.
 */
export function secretFieldRemedy(references: boolean): string {
  const store = 'store the key in `.credentials.yaml` in the Delorun home (`~/.delo` unless DELO_HOME names another), a file of mode 0600 whose first line is `version: 1` and which lists keys under `refs:` as `NAME: <key>`, NAME being a POSIX identifier such as MY_SEARCH_KEY, and set the plugin\'s credential field to NAME'
  const environment = 'export the key as an environment variable NAME where you start Delorun and set the field to `!!js process.env.NAME`'
  return references ? `To give the plugin a key, ${store}.` : `This field has no credential field beside it, so to give the plugin a key, ${environment}.`
}

/**
 * The history admission that refuses a version whose patch layers hold a value for a secret-role field.
 * @param schemasOf - the loaded plugins' Config schemas.
 * @returns the admission for upstream's `ProfileHistory` and the plugin manager's `plugin-manager/before-record`.
 */
export function secretFieldAdmission(schemasOf: ConfigSchemasOf): VersionAdmission {
  return (files) => {
    const places = secretValuesInVersion(files, schemasOf)
    if (places.length === 0) return undefined
    return `${describeSecretValues(places)}. Delorun keeps secrets out of patch files, which the profile history saves in git, so the history saves no version until the value is gone from the patch. ${secretFieldRemedy(places.every(place => place.references.length > 0))}`
  }
}
