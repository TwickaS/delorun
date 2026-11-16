/**
 * What a setup may carry between profiles, and what it never does. The same functions run when a setup is exported and
 * again when an archive is imported, because an archive is hostile input whoever wrote it.
 *
 * A setup carries the plugins the person added (never a package of Delorun's own scope or upstream's) and the profile's
 * patch entries that set a model, the studio's look, or a row of one of those plugins. Every other patch entry stays
 * on the computer it was set on: a sandbox, permission, consent, network, device, reach or credential setting
 * protects one computer, and a settings row of Delorun's own packages can switch such protection off.
 *
 * @module @delorun/changes/setup-transfer/policy
 */
import { SECRET_PATTERNS } from '@delorun/archive'

/** The scopes of the packages that make up Delorun and upstream's harness. A setup neither carries nor removes them. */
const PRODUCT_SCOPES = ['@delorun/', '@deepseek-ai/'] as const

/** The row ids whose settings a setup carries: the default model, the model providers, the models settings and the look. */
export const CARRIED_ROW_IDS: ReadonlySet<string> = new Set([
  'agent-default-model',
  'llm-deepseek',
  'llm-pi-ai',
  'ui-settings-models',
  'delorun-theme',
  'delorun-cost-meter',
  'delorun-thinking-rsvp',
])

/** The fields a carried patch entry, and a row it inserts, may hold. */
const ENTRY_FIELDS: ReadonlySet<string> = new Set(['id', 'name', 'config', 'disabled'])

/** The fields of a patch entry that inserts rows. */
const INSERT_FIELDS: ReadonlySet<string> = new Set(['insert'])

/** A config field name that holds a credential's value: a key, secret, token, password, passphrase or credential. */
const SECRET_FIELD = /(?:key|secret|token|password|passphrase|credential)s?$/iu

/** A suffix that makes such a field the name of a place a credential is read from, which a setup carries. */
const REFERENCE_FIELD = /(?:env|ref|name|file|path|var|id|url)$/iu

/** The field names that hold an endpoint a request is sent to. */
const ENDPOINT_FIELD = /^(?:base_?url|endpoint|api_?base)$/iu

/**
 * Whether a package belongs to Delorun or upstream's harness.
 * @param name - a package name.
 * @returns true for the `@delorun/` and `@deepseek-ai/` scopes.
 */
export function isProductPackage(name: string): boolean {
  return PRODUCT_SCOPES.some(scope => name.startsWith(scope))
}

/** One patch entry as a plain object. */
export type PatchEntry = Readonly<Record<string, unknown>>

/** Whether a patch entry is carried, and why not when it is not. */
export type EntryVerdict =
  | { readonly carry: true }
  /** `secret` is set when the entry would be carried but for a value that looks like a credential, which stops an export. */
  | { readonly carry: false, readonly reason: string, readonly secret?: true }

/**
 * @param value - any value.
 * @returns whether it is a plain object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * How a person reads a patch entry: the row id it sets, or the plugin of the rows it inserts.
 * @param entry - the entry.
 * @returns the label.
 */
export function entryLabel(entry: PatchEntry): string {
  if (typeof entry['id'] === 'string') return entry['id']
  const inserted = entry['insert']
  if (Array.isArray(inserted)) {
    const names = inserted.flatMap(row => isPlainObject(row) && typeof row['name'] === 'string' ? [row['name']] : [])
    return names.length === 0 ? 'inserted rows' : `rows of ${names.join(', ')}`
  }
  return 'a patch entry'
}

/**
 * Decide whether a setup carries one patch entry.
 * @param entry - the entry, as data.
 * @param plugins - the names of the non-product plugins the setup carries; rows of these plugins may travel.
 * @returns the verdict.
 */
export function judgeEntry(entry: PatchEntry, plugins: ReadonlySet<string>): EntryVerdict {
  const label = entryLabel(entry)
  let rows: readonly unknown[]
  if (Object.hasOwn(entry, 'insert')) {
    const inserted = entry['insert']
    if (Object.keys(entry).some(key => !INSERT_FIELDS.has(key)) || !Array.isArray(inserted) || inserted.length === 0) {
      return { carry: false, reason: `${label}: an insert entry of a form a setup does not carry` }
    }
    rows = inserted
    for (const row of rows) {
      const problem = classProblem(row, plugins, false)
      if (problem !== undefined) return { carry: false, reason: `${label}: ${problem}` }
    }
  } else {
    rows = [entry]
    const problem = classProblem(entry, plugins, true)
    if (problem !== undefined) return { carry: false, reason: `${label}: ${problem}` }
  }
  const settings = rows.map(row => (row as Record<string, unknown>)['config'])
  const secret = settings.flatMap(config => secretPlaces(config))[0]
  if (secret !== undefined) return { carry: false, secret: true, reason: `${label}: ${secret}` }
  const endpoint = settings.flatMap(config => endpointProblems(config))[0]
  if (endpoint !== undefined) return { carry: false, reason: `${label}: ${endpoint}` }
  return { carry: true }
}

/**
 * The reason one row, or one entry that sets a row, is not of a class a setup carries.
 * @param row - the row or entry.
 * @param plugins - the non-product plugins the setup carries.
 * @param setsExisting - true for an entry that sets a row some bundle declares, false for a row an entry inserts.
 * @returns why it is not carried, or undefined when it is.
 */
function classProblem(row: unknown, plugins: ReadonlySet<string>, setsExisting: boolean): string | undefined {
  if (!isPlainObject(row)) return 'is not a mapping'
  const stray = Object.keys(row).find(key => !ENTRY_FIELDS.has(key))
  if (stray !== undefined) return `uses the field ${JSON.stringify(stray)}, which a setup does not carry`
  const { id, name } = row
  if (id !== undefined && typeof id !== 'string') return 'has an id that is no text'
  if (name !== undefined && typeof name !== 'string') return 'has a plugin name that is no text'
  if (row['disabled'] !== undefined && typeof row['disabled'] !== 'boolean') return 'has a disabled value that is not true or false'
  if (row['config'] !== undefined && !isPlainObject(row['config'])) return 'has settings that are not a mapping'
  const ofPlugin = typeof name === 'string' && plugins.has(name)
  const ofModelOrLook = setsExisting && typeof id === 'string' && CARRIED_ROW_IDS.has(id) && (name === undefined || isProductPackage(name))
  return ofPlugin || ofModelOrLook ? undefined : 'sets something that belongs to this computer, so it is not carried'
}

/**
 * Whether a patch entry sets something of the class a setup carries, whatever values it holds. An import replaces the
 * profile's entries of this class with the setup's and leaves every other entry alone.
 * @param entry - the entry.
 * @param plugins - the non-product plugins whose rows count as carried.
 * @returns true when the entry is of the carried class.
 */
export function entryClass(entry: PatchEntry, plugins: ReadonlySet<string>): boolean {
  if (Object.hasOwn(entry, 'insert')) {
    const inserted = entry['insert']
    return Object.keys(entry).every(key => INSERT_FIELDS.has(key)) && Array.isArray(inserted) && inserted.length > 0 && inserted.every(row => classProblem(row, plugins, false) === undefined)
  }
  return classProblem(entry, plugins, true) === undefined
}

/**
 * Where a config holds a value that looks like a credential: a field named for one that holds text, or any text a
 * secret pattern matches. Places are named by field path, never by value.
 * @param config - a row's config, or any value.
 * @param path - the path so far.
 * @returns each place, such as `providers.openai.apiKey`.
 */
export function secretPlaces(config: unknown, path = ''): string[] {
  if (typeof config === 'string') return SECRET_PATTERNS.some(({ pattern }) => pattern.test(config)) ? [`holds text that looks like a credential at ${path === '' ? 'the top' : path}`] : []
  if (Array.isArray(config)) return config.flatMap((item, index) => secretPlaces(item, `${path}[${String(index)}]`))
  if (!isPlainObject(config)) return []
  return Object.entries(config).flatMap(([key, value]) => {
    const here = path === '' ? key : `${path}.${key}`
    const named = SECRET_FIELD.test(key) && !REFERENCE_FIELD.test(key) && typeof value === 'string' && value !== ''
    return named ? [`holds a value for the credential field ${here}`] : secretPlaces(value, here)
  })
}

/**
 * Where a config names an endpoint a request would go to that is not https, or http on this computer.
 * @param config - a row's config.
 * @param path - the path so far.
 * @returns a sentence for each such endpoint, naming the field and never the whole URL's query.
 */
export function endpointProblems(config: unknown, path = ''): string[] {
  if (Array.isArray(config)) return config.flatMap((item, index) => endpointProblems(item, `${path}[${String(index)}]`))
  if (!isPlainObject(config)) return []
  return Object.entries(config).flatMap(([key, value]) => {
    const here = path === '' ? key : `${path}.${key}`
    if (ENDPOINT_FIELD.test(key) && typeof value === 'string') return endpointProblem(value, here)
    return endpointProblems(value, here)
  })
}

/**
 * @param value - an endpoint's text.
 * @param field - its field path.
 * @returns a one-element list naming the field when the endpoint is no https URL and no http URL for this computer.
 */
function endpointProblem(value: string, field: string): string[] {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return [`has ${field}, which is no URL`]
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.username === '' && url.password === '' ? [] : [`has ${field} with a user name or password in it`]
  return [`has ${field}, which is not an https URL`]
}
