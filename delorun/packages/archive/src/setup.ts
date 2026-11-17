/**
 * The setup archive of contract C8: the plugins, model choices and settings of one profile as a signed archive that
 * `delorun setup import` reads. It is the C8 archive container (manifest, `objects/<sha256>`, signature, limits) with
 * `content` `setup`, one `setup-document` entry and one `plugin-file` entry for each distinct file of a plugin the
 * person made on this computer.
 *
 * The setup document is a closed JSON schema and data only: a field it does not define is refused, a text value is
 * refused when it holds a control or bidirectional character, begins with `!` or carries `!!`, and a plugin file's path
 * goes through the archive path rules, so a crafted document cannot name a path outside the folder it is written into.
 * Which settings a profile may take from a setup is a policy of the caller, not of the format.
 *
 * @module @delorun/archive/setup
 */
import { createHash } from 'node:crypto'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, type ArchiveOrigin, type ArchiveSignature } from '@delorun/contract-archive-and-trash'
import { ArchiveError } from './errors.ts'
import { ObjectSet, writeArchive } from './exporter.ts'
import { checkArchivePath, checkPathCollisions } from './paths.ts'
import { hasControlCharacter } from './text.ts'

/** The schema version of the setup document. */
export const SETUP_DOCUMENT_SCHEMA_VERSION = 1 as const

/** The setup document's path inside the archive's object directory is its digest; this is its name in messages. */
export const SETUP_DOCUMENT_NAME = 'setup document'

/** The most plugins one setup lists. */
export const SETUP_MAX_PLUGINS = 200

/** The most files one local plugin carries. */
export const SETUP_MAX_PLUGIN_FILES = 20_000

/** The most patch entries one setup carries. */
export const SETUP_MAX_PATCH_ENTRIES = 500

/** The longest note, in characters. */
export const SETUP_MAX_NOTE = 500

/** The deepest nesting a patch entry may have. */
const SETUP_MAX_DEPTH = 12

/** The longest text value a setup document holds, in characters. */
const SETUP_MAX_TEXT = 8192

/** A package name, in npm's form with an optional scope. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u

/** An exact plugin version: a semantic version with its prerelease and build parts. */
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

/** A lockfile integrity string. */
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u

/** A lowercase hexadecimal SHA-256 digest. */
const DIGEST = /^[0-9a-f]{64}$/u

/** The fields of a setup document. */
const DOCUMENT_FIELDS = ['schemaVersion', 'profile', 'note', 'includesSettings', 'plugins', 'models', 'settings'] as const

/** The fields of a plugin the registry serves. */
const REGISTRY_FIELDS = ['name', 'source', 'version', 'integrity'] as const

/** The fields of a plugin made on the exporting computer. */
const LOCAL_FIELDS = ['name', 'source', 'version', 'files'] as const

/** The fields of one carried file. */
const FILE_FIELDS = ['path', 'sha256', 'size', 'executable'] as const

/** A JSON value without a function, a symbol or an undefined. */
export type SetupJson = string | number | boolean | null | readonly SetupJson[] | { readonly [key: string]: SetupJson }

/** One file of a local plugin. */
export interface SetupPluginFile {
  /** The path inside the plugin's folder, relative, with `/` separators. */
  readonly path: string
  /** The SHA-256 of the file's bytes, which names its `plugin-file` entry. */
  readonly sha256: string
  /** The size in bytes. */
  readonly size: number
  /** Whether the owner execute bit is set. */
  readonly executable: boolean
}

/** A plugin the registry serves, named by its exact version and, when the exporter's lockfile has it, the tarball's integrity. */
export interface SetupRegistryPlugin {
  readonly name: string
  readonly source: 'registry'
  /** The exact version installed. */
  readonly version: string
  /** The lockfile's integrity of that version. */
  readonly integrity?: string
}

/** A plugin the person made on the exporting computer, carried as the approved copy's files. */
export interface SetupLocalPlugin {
  readonly name: string
  readonly source: 'local'
  /** The version its `package.json` declares, when it has one. */
  readonly version?: string
  /** The files of the approved copy; empty when the exporter left the plugin's code out, so the plugin is named only. */
  readonly files: readonly SetupPluginFile[]
}

/** One plugin of a setup. */
export type SetupPlugin = SetupRegistryPlugin | SetupLocalPlugin

/** The setup document, `objects/<sha256>` of the entry of kind `setup-document`. */
export interface SetupDocument {
  readonly schemaVersion: typeof SETUP_DOCUMENT_SCHEMA_VERSION
  /** The name of the profile it was exported from; informational. */
  readonly profile: string
  /** A note the exporter wrote for the person who imports; optional. */
  readonly note?: string
  /** Whether the exporter included the settings; when false, `settings` is empty. */
  readonly includesSettings: boolean
  /** The plugins, in the order the exporting profile lists them. */
  readonly plugins: readonly SetupPlugin[]
  /** The patch entries that set the default model, the model providers and the models settings, as data; they always travel. */
  readonly models: readonly { readonly [key: string]: SetupJson }[]
  /** The other patch entries a setup carries (the studio's look, the rows of the carried plugins), as data. */
  readonly settings: readonly { readonly [key: string]: SetupJson }[]
}

/** What a setup export reads. */
export interface SetupExportInput {
  /** The Delorun version that writes the archive. */
  readonly createdBy: string
  /** The exporting home's key. */
  readonly origin: ArchiveOrigin
  /** The document. */
  readonly document: SetupDocument
  /** The bytes of each local plugin file, by the SHA-256 the document names. */
  readonly files: ReadonlyMap<string, Uint8Array>
  /** The time the export finished, RFC 3339 in UTC; now by default. */
  readonly exportedAt?: string | undefined
  /** Signs the manifest. */
  readonly sign?: ((manifestBytes: Uint8Array) => ArchiveSignature) | undefined
}

/**
 * Export one setup archive.
 * @param input - the document, the files it names and the origin.
 * @returns the archive bytes.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the document breaks the schema or a file it names is missing or is not the bytes it names, and the size and ratio refusals when the finished archive breaks a limit an import applies.
 */
export function exportSetupArchive(input: SetupExportInput): Uint8Array {
  const documentBytes = new TextEncoder().encode(JSON.stringify(input.document, null, 2))
  // The exporter holds its own document to the schema an importer applies, so it never writes a file its own import refuses.
  parseSetupDocument(documentBytes)
  const objects = new ObjectSet()
  objects.add(documentBytes, 'setup-document')
  for (const plugin of input.document.plugins) {
    if (plugin.source !== 'local') continue
    for (const file of plugin.files) {
      const bytes = input.files.get(file.sha256)
      if (bytes === undefined || bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the file ${JSON.stringify(file.path)} of ${plugin.name} is not the content the setup names`)
      }
      objects.add(bytes, 'plugin-file')
    }
  }
  return writeArchive({
    createdBy: input.createdBy,
    origin: input.origin,
    exportedAt: input.exportedAt,
    content: 'setup',
    workspaces: [],
    objects,
    customisation: { schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: [] },
    sign: input.sign,
  })
}

/**
 * Parse and validate one setup document.
 * @param bytes - the document's bytes.
 * @returns the validated document.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` for text that is not UTF-8 JSON, a field the schema does not define, a value of the wrong type or a name, version, digest or path the rules refuse; `ARCHIVE_EXPRESSION_REFUSED` for a text value that begins with `!` or carries `!!`; `ARCHIVE_PATH_REJECTED` and `ARCHIVE_CASE_COLLISION` for the file paths of a plugin.
 */
export function parseSetupDocument(bytes: Uint8Array): SetupDocument {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the ${SETUP_DOCUMENT_NAME} is not UTF-8 JSON`)
  }
  const document = requireObject(value, SETUP_DOCUMENT_NAME)
  requireOnly(document, DOCUMENT_FIELDS, SETUP_DOCUMENT_NAME)
  if (document['schemaVersion'] !== SETUP_DOCUMENT_SCHEMA_VERSION) {
    throw new ArchiveError('ARCHIVE_UNSUPPORTED_VERSION', `the ${SETUP_DOCUMENT_NAME} declares schema version ${JSON.stringify(document['schemaVersion'])}, and this reader reads version ${String(SETUP_DOCUMENT_SCHEMA_VERSION)}`)
  }
  const plugins = requireArray(document['plugins'], `${SETUP_DOCUMENT_NAME} plugins`).map((plugin, index) => parsePlugin(plugin, index))
  if (plugins.length > SETUP_MAX_PLUGINS) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the ${SETUP_DOCUMENT_NAME} lists more than ${String(SETUP_MAX_PLUGINS)} plugins`)
  const names = plugins.map(plugin => plugin.name)
  if (new Set(names).size !== names.length) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the ${SETUP_DOCUMENT_NAME} lists one plugin twice`)
  if (typeof document['includesSettings'] !== 'boolean') throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${SETUP_DOCUMENT_NAME} includesSettings is not true or false`)
  const includesSettings = document['includesSettings']
  const models = entries(document['models'], 'models')
  const settings = entries(document['settings'], 'settings')
  if (!includesSettings && settings.length > 0) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the ${SETUP_DOCUMENT_NAME} says it includes no settings and lists some`)
  const note = document['note'] === undefined ? undefined : requireText(document['note'], `${SETUP_DOCUMENT_NAME} note`)
  if (note !== undefined && note.length > SETUP_MAX_NOTE) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the ${SETUP_DOCUMENT_NAME} note is longer than ${String(SETUP_MAX_NOTE)} characters`)
  return {
    schemaVersion: SETUP_DOCUMENT_SCHEMA_VERSION,
    profile: requireText(document['profile'], `${SETUP_DOCUMENT_NAME} profile`),
    ...note === undefined ? {} : { note },
    includesSettings,
    plugins,
    models,
    settings,
  }
}

/**
 * Parse one list of patch entries.
 * @param value - the parsed list.
 * @param name - the field's name.
 * @returns the entries, as data.
 * @throws ArchiveError as {@link parseSetupDocument} lists for a patch entry.
 */
function entries(value: unknown, name: string): { readonly [key: string]: SetupJson }[] {
  const list = requireArray(value, `${SETUP_DOCUMENT_NAME} ${name}`)
  if (list.length > SETUP_MAX_PATCH_ENTRIES) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the ${SETUP_DOCUMENT_NAME} carries more than ${String(SETUP_MAX_PATCH_ENTRIES)} ${name} entries`)
  return list.map((entry, index) => requireObject(requireData(entry, `${SETUP_DOCUMENT_NAME} ${name}[${String(index)}]`, 0), `${SETUP_DOCUMENT_NAME} ${name}[${String(index)}]`) as { readonly [key: string]: SetupJson })
}

/**
 * Parse one plugin of the document.
 * @param value - the parsed plugin.
 * @param index - its position, for the refusal's message.
 * @returns the plugin.
 * @throws ArchiveError as {@link parseSetupDocument} lists for a plugin.
 */
function parsePlugin(value: unknown, index: number): SetupPlugin {
  const where = `${SETUP_DOCUMENT_NAME} plugins[${String(index)}]`
  const plugin = requireObject(value, where)
  const name = requireText(plugin['name'], `${where} name`)
  if (!PACKAGE_NAME.test(name)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} name is not a package name`)
  if (plugin['source'] === 'registry') {
    requireOnly(plugin, REGISTRY_FIELDS, where)
    const version = requireText(plugin['version'], `${where} version`)
    if (!EXACT_VERSION.test(version)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} version is not an exact version`)
    if (plugin['integrity'] === undefined) return { name, source: 'registry', version }
    const integrity = requireText(plugin['integrity'], `${where} integrity`)
    if (!INTEGRITY.test(integrity)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} integrity is not a lockfile integrity string`)
    return { name, source: 'registry', version, integrity }
  }
  if (plugin['source'] !== 'local') throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} source is neither registry nor local`)
  requireOnly(plugin, LOCAL_FIELDS, where)
  let version: string | undefined
  if (plugin['version'] !== undefined) {
    version = requireText(plugin['version'], `${where} version`)
    if (!EXACT_VERSION.test(version)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} version is not an exact version`)
  }
  const files = requireArray(plugin['files'], `${where} files`).map((file, fileIndex) => parseFile(file, `${where} files[${String(fileIndex)}]`))
  if (files.length > SETUP_MAX_PLUGIN_FILES) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} carries more than ${String(SETUP_MAX_PLUGIN_FILES)} files`)
  checkPathCollisions(files.map(file => file.path))
  if (files.length > 0 && !files.some(file => file.path === 'package.json')) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} carries no package.json`)
  return { name, source: 'local', ...version === undefined ? {} : { version }, files }
}

/**
 * Parse one carried file.
 * @param value - the parsed file.
 * @param where - its place, for the refusal's message.
 * @returns the file.
 * @throws ArchiveError as {@link parseSetupDocument} lists for a file.
 */
function parseFile(value: unknown, where: string): SetupPluginFile {
  const file = requireObject(value, where)
  requireOnly(file, FILE_FIELDS, where)
  const path = checkArchivePath(requireText(file['path'], `${where} path`))
  const sha256 = requireText(file['sha256'], `${where} sha256`)
  if (!DIGEST.test(sha256)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} sha256 is not a lowercase SHA-256 digest`)
  const size = file['size']
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} size is not a whole byte size`)
  if (typeof file['executable'] !== 'boolean') throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} executable is not true or false`)
  return { path, sha256, size, executable: file['executable'] }
}

/**
 * Require a value to be data: JSON without an expression, within the depth and text bounds.
 * @param value - the parsed value.
 * @param where - its place, for the refusal's message.
 * @param depth - how deep the value sits.
 * @returns the same value.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` for a value too deep, a text that is too long or holds a control character, or a key that would reach an object's prototype; `ARCHIVE_EXPRESSION_REFUSED` for a text that begins with `!` or carries `!!`.
 */
function requireData(value: unknown, where: string, depth: number): unknown {
  if (depth > SETUP_MAX_DEPTH) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} nests deeper than ${String(SETUP_MAX_DEPTH)} levels`)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} holds a number that is not finite`)
    return value
  }
  if (typeof value === 'string') {
    checkDataText(value, where)
    return value
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => requireData(item, `${where}[${String(index)}]`, depth + 1))
    return value
  }
  const fields = requireObject(value, where)
  for (const [key, item] of Object.entries(fields)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} holds the key ${JSON.stringify(key)}, which a setup never carries`)
    checkDataText(key, `${where} key`)
    requireData(item, `${where}.${key}`, depth + 1)
  }
  return value
}

/**
 * Hold one text of the document to the data rules.
 * @param text - the text.
 * @param where - its place.
 * @throws ArchiveError as {@link requireData} lists for a text.
 */
function checkDataText(text: string, where: string): void {
  if (text.length > SETUP_MAX_TEXT) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} holds a text longer than ${String(SETUP_MAX_TEXT)} characters`)
  if (hasControlCharacter(text)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} holds a control character, which a setup's text may not carry`)
  if (/^\s*!/u.test(text) || text.includes('!!')) throw new ArchiveError('ARCHIVE_EXPRESSION_REFUSED', `${where} holds text that reads as an expression, which a setup never carries`)
}

/**
 * @param value - a parsed value.
 * @param where - its place.
 * @returns the object's fields.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the value is no object.
 */
function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} is not a JSON object`)
  return value as Record<string, unknown>
}

/**
 * @param value - a parsed value.
 * @param where - its place.
 * @returns the array.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the value is no array.
 */
function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} is not a JSON array`)
  return value
}

/**
 * @param value - a parsed value.
 * @param where - its place.
 * @returns the text.
 * @throws ArchiveError as {@link checkDataText} lists, and `ARCHIVE_SCHEMA_INVALID` when the value is no non-empty text.
 */
function requireText(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} is not a non-empty string`)
  checkDataText(value, where)
  return value
}

/**
 * Refuse a field the schema does not define.
 * @param value - the object's fields.
 * @param allowed - the fields the schema defines for it.
 * @param where - its place.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` for a field outside `allowed`.
 */
function requireOnly(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const stray = Object.keys(value).find(key => !allowed.includes(key))
  if (stray !== undefined) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} carries the field ${JSON.stringify(stray)}, which the schema does not define`)
}
