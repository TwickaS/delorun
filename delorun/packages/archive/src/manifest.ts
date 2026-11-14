/**
 * The manifest of contract C8: `manifest.json`. The manifest is a closed
 * document — a field it does not define is refused — and its entry list is
 * checked against the format's own naming: a document entry is
 * `customisation.json`, and every other entry is `objects/<sha256>` with the
 * digest its `sha256` field names. The paths go through the path rules, so a
 * manifest cannot name a path the ZIP reader would refuse, and the sizes go
 * through the limit checks.
 *
 * @module @delorun/archive/manifest
 */
import {
  ARCHIVE_ENTRY_KINDS,
  ARCHIVE_FORMAT_VERSION,
  type ArchiveEntry,
  type ArchiveEntryKind,
  type ArchiveManifest,
  type ArchiveOrigin,
  type ArchiveWorkspace,
} from '@delorun/contract-archive-and-trash'
import { ArchiveError } from './errors.ts'
import { keyFingerprint } from './fingerprint.ts'
import { checkArchivePath } from './paths.ts'
import { hasControlCharacter } from './text.ts'

/** The path of the customisation document, which every archive carries. */
export const CUSTOMISATION_PATH = 'customisation.json'

/** The path of the manifest itself. */
export const MANIFEST_PATH = 'manifest.json'

/** The path of the signature document, which only a signed archive carries. */
export const SIGNATURE_PATH = 'signature.json'

/** The directory every object entry lives in. */
export const OBJECTS_DIRECTORY = 'objects'

/** A lowercase hexadecimal SHA-256 digest. */
const DIGEST = /^[0-9a-f]{64}$/u

/** A base64url run, the only encoding the manifest's keys use. */
const BASE64URL = /^[A-Za-z0-9_-]+$/u

/** An RFC 3339 timestamp in UTC. */
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/u

/** The fields `manifest.json` defines and no others. */
const MANIFEST_FIELDS = ['formatVersion', 'createdBy', 'exportedAt', 'origin', 'workspaces', 'entries'] as const

/** The fields one manifest entry defines and no others. */
const ENTRY_FIELDS = ['path', 'sha256', 'size', 'kind'] as const

/** The fields one manifest workspace defines and no others. */
const WORKSPACE_FIELDS = ['id', 'name', 'chats', 'attachments', 'objects'] as const

/** The fields the manifest's origin defines and no others. */
const ORIGIN_FIELDS = ['homeKeyId', 'publicKey'] as const

/** The bytes an Ed25519 public key has. */
const ED25519_PUBLIC_KEY_BYTES = 32

/** The UTF-8 decoder, which refuses a document that is not UTF-8 rather than replacing bytes. */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })

/**
 * Parse and validate one `manifest.json`.
 * @param bytes - the bytes of the document.
 * @returns the validated manifest.
 * @throws ArchiveError `ARCHIVE_UNSUPPORTED_VERSION` for another format version, `ARCHIVE_SCHEMA_INVALID` for a document or a field that the format does not define, and the path, collision and limit refusals of {@link checkPathCollisions} and {@link checkEntrySizes}.
 */
export function parseManifest(bytes: Uint8Array): ArchiveManifest {
  const document = parseDocument(bytes, MANIFEST_PATH)
  requireFields(document, MANIFEST_FIELDS, MANIFEST_PATH)
  if (document.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveError(
      'ARCHIVE_UNSUPPORTED_VERSION',
      `the archive declares format version ${JSON.stringify(document.formatVersion)}, and this reader reads version ${String(ARCHIVE_FORMAT_VERSION)}`,
    )
  }
  const createdBy = requireText(document.createdBy, `${MANIFEST_PATH} createdBy`)
  const exportedAt = requireText(document.exportedAt, `${MANIFEST_PATH} exportedAt`)
  if (!RFC3339_UTC.test(exportedAt) || Number.isNaN(Date.parse(exportedAt))) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${MANIFEST_PATH} exportedAt is not an RFC 3339 time in UTC`)
  }
  const origin = parseOrigin(document.origin)
  const entries = requireArray(document.entries, `${MANIFEST_PATH} entries`).map((entry, index) => parseEntry(entry, index))
  const listed = new Set(entries.map(entry => entry.path))
  const workspaces = requireArray(document.workspaces, `${MANIFEST_PATH} workspaces`).map((workspace, index) => parseWorkspace(workspace, index, listed))
  checkWorkspaceIdentifiers(workspaces)
  return { formatVersion: ARCHIVE_FORMAT_VERSION, createdBy, exportedAt, origin, workspaces, entries }
}

/**
 * The origin of an archive: the exporting home's key identifier and public key.
 * @param value - the parsed `origin` field.
 * @returns the origin.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when a field is missing, is not a base64url string, or the public key is not 32 bytes.
 */
function parseOrigin(value: unknown): ArchiveOrigin {
  const origin = requireObject(value, `${MANIFEST_PATH} origin`)
  requireFields(origin, ORIGIN_FIELDS, `${MANIFEST_PATH} origin`)
  const homeKeyId = requireText(origin.homeKeyId, `${MANIFEST_PATH} origin homeKeyId`)
  const publicKey = requireText(origin.publicKey, `${MANIFEST_PATH} origin publicKey`)
  if (!BASE64URL.test(homeKeyId)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${MANIFEST_PATH} origin homeKeyId is not base64url`)
  }
  if (!BASE64URL.test(publicKey) || Buffer.from(publicKey, 'base64url').length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${MANIFEST_PATH} origin publicKey is not a base64url Ed25519 key`)
  }
  if (homeKeyId !== keyFingerprint(publicKey)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${MANIFEST_PATH} origin homeKeyId is not the fingerprint of its publicKey`)
  }
  return { homeKeyId, publicKey }
}

/**
 * Parse one entry of the manifest's `entries` array.
 * @param value - the parsed entry.
 * @param index - the entry's position, for the refusal's message.
 * @returns the entry.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` for an unknown kind, a field the format does not define, or a path that does not match the format's naming, and `ARCHIVE_PATH_REJECTED` from {@link checkArchivePath}.
 */
function parseEntry(value: unknown, index: number): ArchiveEntry {
  const entry = requireObject(value, `${MANIFEST_PATH} entries[${String(index)}]`)
  requireFields(entry, ENTRY_FIELDS, `${MANIFEST_PATH} entries[${String(index)}]`)
  const path = requireText(entry.path, `${MANIFEST_PATH} entries[${String(index)}] path`)
  const sha256 = requireText(entry.sha256, `${MANIFEST_PATH} entries[${String(index)}] sha256`)
  if (!DIGEST.test(sha256)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the entry ${JSON.stringify(path)} carries no lowercase SHA-256 digest`)
  }
  const size = entry.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the entry ${JSON.stringify(path)} carries no whole byte size`)
  }
  const kind = entry.kind
  if (typeof kind !== 'string' || !(ARCHIVE_ENTRY_KINDS as readonly string[]).includes(kind)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the entry ${JSON.stringify(path)} carries the unknown kind ${JSON.stringify(kind)}`)
  }
  requireEntryPath(path, sha256, kind as ArchiveEntryKind)
  return { path, sha256, size, kind: kind as ArchiveEntryKind }
}

/**
 * Require an entry's path to be the path the format gives its kind.
 * @param path - the entry's already-checked path.
 * @param sha256 - the entry's digest.
 * @param kind - the entry's kind.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when a document entry is not `customisation.json` or an object entry is not `objects/<sha256>` with its own digest.
 */
function requireEntryPath(path: string, sha256: string, kind: ArchiveEntryKind): void {
  if (kind === 'customisation') {
    if (path !== CUSTOMISATION_PATH) {
      throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the customisation entry names ${JSON.stringify(path)} where the format names ${CUSTOMISATION_PATH}`)
    }
    return
  }
  if (path !== `${OBJECTS_DIRECTORY}/${sha256}`) {
    throw new ArchiveError(
      'ARCHIVE_SCHEMA_INVALID',
      `the ${kind} entry ${JSON.stringify(path)} is not named by its own digest ${JSON.stringify(sha256)}`,
    )
  }
}

/**
 * Parse one workspace of the manifest's `workspaces` array.
 * @param value - the parsed workspace.
 * @param index - the workspace's position, for the refusal's message.
 * @param listed - every path the manifest lists, which the workspace's references must name.
 * @returns the workspace.
 * @throws ArchiveError `ARCHIVE_PATH_REJECTED` for an identifier that is not one safe path segment, and `ARCHIVE_SCHEMA_INVALID` for a reference to a path the manifest does not list or a field the format does not define.
 */
function parseWorkspace(value: unknown, index: number, listed: ReadonlySet<string>): ArchiveWorkspace {
  const workspace = requireObject(value, `${MANIFEST_PATH} workspaces[${String(index)}]`)
  requireFields(workspace, WORKSPACE_FIELDS, `${MANIFEST_PATH} workspaces[${String(index)}]`)
  const id = checkArchivePath(requireText(workspace.id, `${MANIFEST_PATH} workspaces[${String(index)}] id`))
  if (id.includes('/')) {
    throw new ArchiveError('ARCHIVE_PATH_REJECTED', `the workspace identifier ${JSON.stringify(id)} is not one path segment`)
  }
  const name = requireText(workspace.name, `${MANIFEST_PATH} workspaces[${String(index)}] name`)
  return {
    id,
    name,
    chats: references(workspace.chats, `${MANIFEST_PATH} workspaces[${String(index)}] chats`, listed),
    attachments: references(workspace.attachments, `${MANIFEST_PATH} workspaces[${String(index)}] attachments`, listed),
    objects: references(workspace.objects, `${MANIFEST_PATH} workspaces[${String(index)}] objects`, listed),
  }
}

/**
 * Check every workspace identifier of one manifest for the two collisions an
 * import cannot stage: two workspaces that name one identifier, whose staged
 * directories would overwrite each other, and two that differ only in letter
 * case, which collide on a case-insensitive file system.
 * @param workspaces - every workspace the manifest declares, in its order.
 * @throws ArchiveError `ARCHIVE_PATH_REJECTED` for a repeated identifier and `ARCHIVE_CASE_COLLISION` for an identifier that differs from an earlier one only in letter case.
 */
function checkWorkspaceIdentifiers(workspaces: readonly ArchiveWorkspace[]): void {
  const seen = new Map<string, string>()
  for (const { id } of workspaces) {
    const folded = id.toLowerCase()
    const previous = seen.get(folded)
    if (previous === id) {
      throw new ArchiveError('ARCHIVE_PATH_REJECTED', `${MANIFEST_PATH} declares the workspace identifier ${JSON.stringify(id)} twice`)
    }
    if (previous !== undefined) {
      throw new ArchiveError(
        'ARCHIVE_CASE_COLLISION',
        `${MANIFEST_PATH} declares the workspace identifiers ${JSON.stringify(previous)} and ${JSON.stringify(id)}, which differ only in letter case`,
      )
    }
    seen.set(folded, id)
  }
}

/**
 * Read one list of entry paths that a workspace refers to.
 * @param value - the parsed list.
 * @param where - the field's name, for the refusal's message.
 * @param listed - every path the manifest lists.
 * @returns the paths.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the list holds a path the manifest does not list.
 */
function references(value: unknown, where: string, listed: ReadonlySet<string>): string[] {
  return requireArray(value, where).map((item) => {
    const path = requireText(item, where)
    if (!listed.has(path)) {
      throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} names ${JSON.stringify(path)}, which the manifest does not list as an entry`)
    }
    return path
  })
}

/**
 * Parse a document's bytes as one JSON object.
 * @param bytes - the bytes of the document.
 * @param name - the document's path, for the refusal's message.
 * @returns the parsed object.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the document is not UTF-8 JSON or does not hold an object.
 */
function parseDocument(bytes: Uint8Array, name: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(TEXT_DECODER.decode(bytes))
  } catch {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${name} is not UTF-8 JSON`)
  }
  return requireObject(value, name)
}

/**
 * Require a parsed value to be a JSON object.
 * @param value - the parsed value.
 * @param where - the value's name, for the refusal's message.
 * @returns the object's fields.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the value is not an object.
 */
function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} is not a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * Require an object to carry exactly the fields the format defines for it.
 * @param value - the object's fields.
 * @param fields - the fields the format defines.
 * @param where - the object's name, for the refusal's message.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when a field is missing or another field is present.
 */
function requireFields(value: Record<string, unknown>, fields: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter(key => !fields.includes(key))
  if (unknown.length > 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} carries the field ${JSON.stringify(unknown[0])}, which the format does not define`)
  }
  const missing = fields.filter(field => !Object.hasOwn(value, field))
  if (missing.length > 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} has no ${JSON.stringify(missing[0])} field`)
  }
}

/**
 * Require a parsed value to be a non-empty string without a control character.
 * @param value - the parsed value.
 * @param where - the value's name, for the refusal's message.
 * @returns the string.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the value is not a non-empty string, or holds a C0 or C1 control, DEL or a bidirectional control.
 */
function requireText(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} is not a non-empty string`)
  }
  if (hasControlCharacter(value)) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} holds a control character, which an archive's text may not carry`)
  }
  return value
}

/**
 * Require a parsed value to be a JSON array.
 * @param value - the parsed value.
 * @param where - the value's name, for the refusal's message.
 * @returns the array.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when the value is not an array.
 */
function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `${where} is not a JSON array`)
  return value
}
