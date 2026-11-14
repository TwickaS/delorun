/**
 * The export path of contract C8. An export writes each object into the archive
 * under its SHA-256 and records its digest and size in the manifest, and it
 * warns the person about the secrets it finds in chat history before it writes
 * anything: the scan runs first, and an unconfirmed export returns the findings
 * with no archive at all. The export reports the kind of secret it found and
 * never the secret itself, so the warning cannot become the leak it warns
 * about. It builds the archive in one buffer rather than streaming it to a
 * file, and a finished archive is held to the size and ratio limits an import
 * applies, so an export never hands back a file its own import refuses.
 *
 * The export reads the workspaces, chats and attachment contents a caller hands
 * it. Walking a home's stores to find them, and the guarantee that an export
 * visits only the workspaces it names, belongs to the driver that calls this
 * module, which this package does not yet carry.
 *
 * @module @delorun/archive/exporter
 */
import { createHash } from 'node:crypto'
import { ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, ARCHIVE_FORMAT_VERSION, type ArchiveCustomisation, type ArchiveEntry, type ArchiveManifest, type ArchiveOrigin, type ArchiveSignature, type ArchiveWorkspace } from '@delorun/contract-archive-and-trash'
import { checkContainerDeclarations } from './limits.ts'
import { CUSTOMISATION_PATH, MANIFEST_PATH, OBJECTS_DIRECTORY, SIGNATURE_PATH } from './manifest.ts'
import { ZipArchive } from './zip-read.ts'
import { ZipWriter } from './zip-write.ts'

/** The kinds of secret an export warns about. */
export type SecretKind = 'aws-access-key' | 'private-key' | 'api-key' | 'github-token' | 'slack-token'

/** One secret an export found, named by its kind and its place and never by its value. */
export interface SecretFinding {
  /** The workspace the finding sits in. */
  readonly workspaceId: string
  /** The chat the finding sits in. */
  readonly chatId: string
  /** The kind of secret. */
  readonly kind: SecretKind
}

/** One chat as an export reads it. */
export interface ExportChat {
  /** The chat's identifier. */
  readonly id: string
  /** The chat's text: its generations, which the export scans for secrets and stores as one object. */
  readonly text: string
}

/** One workspace as an export reads it. */
export interface ExportWorkspace {
  /** The identifier the archive gives the workspace. */
  readonly id: string
  /** The workspace's name. */
  readonly name: string
  /** The workspace entity record's bytes. */
  readonly entity: Uint8Array
  /** The workspace's chats. */
  readonly chats: readonly ExportChat[]
  /** The contents of the workspace's attachments. */
  readonly attachments: readonly Uint8Array[]
}

/** The facts an export reads. */
export interface ArchiveExportInput {
  /** The Delorun version that writes the archive. */
  readonly createdBy: string
  /** The exporting home's key. */
  readonly origin: ArchiveOrigin
  /** The workspaces the archive carries. */
  readonly workspaces: readonly ExportWorkspace[]
  /** The customisation document the archive carries. */
  readonly customisation: ArchiveCustomisation
  /** The time the export finished, RFC 3339 in UTC; now by default. */
  readonly exportedAt?: string | undefined
  /** Set once the person has seen the secret warning and chosen to continue. */
  readonly confirmSecrets?: boolean | undefined
  /** Signs the manifest, when the exporting home signs its archives. */
  readonly sign?: ((manifestBytes: Uint8Array) => ArchiveSignature) | undefined
}

/** What an export did. */
export interface ArchiveExportResult {
  /** True when the export found secrets and the person has not confirmed that it continue; no archive exists then. */
  readonly cancelled: boolean
  /** Every secret the scan found, by kind and place. */
  readonly warnings: readonly SecretFinding[]
  /** The archive, only when the export was not cancelled. */
  readonly bytes?: Uint8Array | undefined
}

/** The patterns the secret scan looks for, each with the kind it reports. */
const SECRET_PATTERNS: readonly { readonly kind: SecretKind, readonly pattern: RegExp }[] = [
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { kind: 'private-key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/u },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/u },
  { kind: 'api-key', pattern: /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}/u },
]

/**
 * Find the secrets an export would carry in the person's chat history.
 * @param workspaces - the workspaces an export reads.
 * @returns one finding per secret, by kind and place, and never the secret's value.
 */
export function findSecrets(workspaces: readonly ExportWorkspace[]): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const workspace of workspaces) {
    for (const chat of workspace.chats) {
      for (const { kind, pattern } of SECRET_PATTERNS) {
        if (pattern.test(chat.text)) findings.push({ workspaceId: workspace.id, chatId: chat.id, kind })
      }
    }
  }
  return findings
}

/**
 * Export one archive.
 * @param input - the workspaces, the customisation, the origin and the person's confirmation.
 * @returns the archive bytes, or the findings that stopped the export.
 * @throws Error when a customisation object carries another schema version than the writer writes.
 * @throws ArchiveError when the finished archive breaks a size or ratio limit an import applies, so a caller never receives a file its own import refuses.
 */
export function exportArchive(input: ArchiveExportInput): ArchiveExportResult {
  const warnings = findSecrets(input.workspaces)
  if (warnings.length > 0 && input.confirmSecrets !== true) return { cancelled: true, warnings }
  if (input.customisation.schemaVersion !== ARCHIVE_CUSTOMISATION_SCHEMA_VERSION) {
    throw new Error(`the export writes customisation schema version ${String(ARCHIVE_CUSTOMISATION_SCHEMA_VERSION)} only`)
  }
  const writer = new ZipWriter()
  const objects = new Map<string, { readonly bytes: Uint8Array, readonly kind: ArchiveEntry['kind'] }>()
  const add = (bytes: Uint8Array, kind: ArchiveEntry['kind']): string => {
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (!objects.has(digest)) objects.set(digest, { bytes, kind })
    return `${OBJECTS_DIRECTORY}/${digest}`
  }
  const workspaces: ArchiveWorkspace[] = input.workspaces.map(workspace => ({
    id: workspace.id,
    name: workspace.name,
    chats: workspace.chats.map(chat => add(new TextEncoder().encode(chat.text), 'chat-generation')),
    attachments: workspace.attachments.map(bytes => add(bytes, 'attachment')),
    objects: [add(workspace.entity, 'workspace-entity')],
  }))
  const customisationBytes = new TextEncoder().encode(JSON.stringify(input.customisation, null, 2))
  const entries: ArchiveEntry[] = [
    {
      path: CUSTOMISATION_PATH,
      sha256: createHash('sha256').update(customisationBytes).digest('hex'),
      size: customisationBytes.length,
      kind: 'customisation',
    },
    ...[...objects].map(([sha256, object]) => ({
      path: `${OBJECTS_DIRECTORY}/${sha256}`,
      sha256,
      size: object.bytes.length,
      kind: object.kind,
    })),
  ]
  const manifest: ArchiveManifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdBy: input.createdBy,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    origin: input.origin,
    workspaces,
    entries,
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  writer.add({ name: CUSTOMISATION_PATH, bytes: customisationBytes })
  for (const entry of [...objects.keys()].sort()) {
    writer.add({ name: `${OBJECTS_DIRECTORY}/${entry}`, bytes: objects.get(entry)!.bytes })
  }
  writer.add({ name: MANIFEST_PATH, bytes: manifestBytes })
  if (input.sign !== undefined) {
    const signature = input.sign(manifestBytes)
    writer.add({ name: SIGNATURE_PATH, bytes: new TextEncoder().encode(JSON.stringify(signature, null, 2)) })
  }
  const bytes = writer.finish()
  // The export promises an archive its own import accepts, so the finished container is re-opened and held to the declared sizes and ratios an import checks before it reads anything.
  checkContainerDeclarations(ZipArchive.open(bytes))
  return { cancelled: false, warnings, bytes }
}
