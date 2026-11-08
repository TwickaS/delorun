/**
 * The import path of contract C8. An import validates the whole archive before
 * it writes anything, in the order the contract names: the manifest, the
 * checksums, the paths, the entries, the limits, the customisation and the
 * signature. Only a fully validated archive is staged, and each workspace is
 * published from the staging directory by one rename that never replaces an
 * existing workspace. An identifier that already exists is given a new one.
 *
 * @module @delo/archive/importer
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArchiveManifest } from '@delo/contract-archive-and-trash'
import { ArchiveError } from './errors.ts'
import { customisationDiff, parseCustomisation, type CustomisationDiffRow } from './customisation.ts'
import { checkEntrySizes, type DeclaredEntrySize } from './limits.ts'
import { CUSTOMISATION_PATH, MANIFEST_PATH, OBJECTS_DIRECTORY, parseManifest, SIGNATURE_PATH } from './manifest.ts'
import { checkPathCollisions } from './paths.ts'
import { checkArchiveSignature, parseSignature, type SignatureReason, type SignatureState } from './signature.ts'
import { removeStaging, writeStaging, type StagedEntry } from './staging.ts'
import { ZipArchive } from './zip-read.ts'

/** The name of the document a staged workspace directory carries for the store that publishes it. */
export const STAGED_WORKSPACE_DOCUMENT = 'workspace.json'

/** The document a staged workspace directory carries, which the store reads beside the workspace's objects. */
export interface StagedWorkspaceDocument {
  /** The identifier the archive gave the workspace, before the import assigned one. */
  readonly archiveId: string
  /** The workspace's name. */
  readonly name: string
  /** The entry paths of the workspace's chats. */
  readonly chats: readonly string[]
  /** The entry paths of the workspace's attachments. */
  readonly attachments: readonly string[]
  /** The entry paths of the workspace's other objects. */
  readonly objects: readonly string[]
}

/** The workspace store an import publishes into. */
export interface ArchiveWorkspaceStore {
  /**
   * Whether the store already holds a workspace under an identifier.
   * @param id - the identifier to look for.
   * @returns true when the identifier is taken.
   */
  exists(id: string): Promise<boolean>

  /**
   * Publish one staged workspace directory under an identifier, by one atomic
   * rename. A store never replaces a workspace: an identifier that is taken
   * must fail rather than overwrite.
   * @param id - the identifier to publish under.
   * @param stagedDirectory - the absolute path of the staged directory, which the store's file system holds.
   */
  publish(id: string, stagedDirectory: string): Promise<void>
}

/** The workspace store of a home that keeps one directory per workspace under a root. */
export class DirectoryWorkspaceStore implements ArchiveWorkspaceStore {
  private readonly root: string

  /**
   * @param root - the absolute path of the workspace store's root.
   */
  constructor(root: string) {
    this.root = root
  }

  /**
   * Whether the store holds a workspace under an identifier.
   * @param id - the identifier to look for.
   * @returns true when a directory of that name exists.
   */
  async exists(id: string): Promise<boolean> {
    try {
      await lstat(join(this.root, id))
      return true
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Publish one staged workspace directory by renaming it into the root. A
   * rename onto an existing directory fails, so the store never overwrites.
   * @param id - the identifier to publish under.
   * @param stagedDirectory - the absolute path of the staged directory.
   */
  async publish(id: string, stagedDirectory: string): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await rename(stagedDirectory, join(this.root, id))
  }
}

/** One workspace an import published. */
export interface ImportedWorkspace {
  /** The identifier the archive gave the workspace. */
  readonly archiveId: string
  /** The identifier the workspace now carries, which a taken identifier moves to a new one. */
  readonly id: string
  /** The workspace's name. */
  readonly name: string
}

/** What an import did. */
export interface ArchiveImportReport {
  /** Whether the archive was signed by a key this home vouches for. */
  readonly state: SignatureState
  /** Why the archive is unverified; absent when it is verified. */
  readonly reason?: SignatureReason | undefined
  /** One sentence a person reads on the diff screen and in the import report, naming the source and the state. */
  readonly label: string
  /** The archive's source: its origin key identifier or the file's name. */
  readonly source: string
  /** The workspaces the import published, in the archive's order. */
  readonly workspaces: readonly ImportedWorkspace[]
  /** The customisation diff: each row's kind and target, before any row is applied. */
  readonly customisation: readonly CustomisationDiffRow[]
}

/** The facts an import reads. */
export interface ArchiveImporterConfig {
  /** The directory the staging root is created under, which must be on the workspace store's file system. */
  readonly stagingParent: string
  /** The workspace store the import publishes into. */
  readonly store: ArchiveWorkspaceStore
  /** The base64url Ed25519 keys this home vouches for. */
  readonly trustedPublicKeys?: readonly string[] | undefined
  /** The home key identifier the person confirmed by its fingerprint at import. */
  readonly confirmedHomeKeyId?: string | undefined
  /** The identifier generator for a workspace whose archive identifier is taken; a UUID by default. */
  readonly newId?: (() => string) | undefined
}

/**
 * The one sentence that states an archive's signature state to a person.
 * @param state - the state the signature check found.
 * @param reason - why the archive is unverified.
 * @param source - the archive's source.
 * @returns the sentence.
 */
export function signatureLabel(state: SignatureState, reason: SignatureReason | undefined, source: string): string {
  if (state === 'verified') return `Import from ${source}: the signature is verified.`
  if (reason === 'signature-invalid') return `Import from ${source}: the signature does not verify, so the archive is unverified.`
  if (reason === 'key-not-trusted') {
    return `Import from ${source}: the signing home key is not one this home trusts, so the archive is unverified.`
  }
  return `Import from ${source}: the archive carries no signature, so it is unverified.`
}

/**
 * The import path of one home.
 */
export class ArchiveImporter {
  private readonly config: ArchiveImporterConfig

  /**
   * @param config - the staging parent, the workspace store and the keys the home vouches for.
   */
  constructor(config: ArchiveImporterConfig) {
    this.config = config
  }

  /**
   * Validate one archive and publish its workspaces.
   * @param bytes - the whole archive.
   * @param options - `source` names the archive in the report, by its file name; the origin's key identifier is used when it is absent.
   * @returns the import report.
   * @throws ArchiveError with the code of the first refusal the archive earns, after which nothing is written.
   */
  async import(bytes: Uint8Array, options: { readonly source?: string } = {}): Promise<ArchiveImportReport> {
    const archive = ZipArchive.open(bytes)
    const manifest = parseManifest(archive.read(MANIFEST_PATH))
    const contents = this.verifyChecksums(archive, manifest)
    archive.checkPaths()
    checkPathCollisions(manifest.entries.map(entry => entry.path))
    this.verifyEntries(archive, manifest)
    checkEntrySizes(manifest.entries.map(entry => ({ path: entry.path, uncompressedSize: entry.size })))
    checkEntrySizes(archive.entries.map(record => ({
      path: record.name,
      uncompressedSize: record.uncompressedSize,
      compressedSize: record.compressedSize,
    }) satisfies DeclaredEntrySize))
    const customisation = parseCustomisation(contents.get(CUSTOMISATION_PATH)!)
    const signature = archive.names().includes(SIGNATURE_PATH) ? parseSignature(archive.read(SIGNATURE_PATH)) : undefined
    const check = checkArchiveSignature({
      manifestBytes: contents.get(MANIFEST_PATH)!,
      origin: manifest.origin,
      signature,
      trustedPublicKeys: this.config.trustedPublicKeys,
      confirmedHomeKeyId: this.config.confirmedHomeKeyId,
    })
    const source = options.source ?? manifest.origin.homeKeyId
    const workspaces = await this.publish(manifest, contents)
    return {
      state: check.state,
      reason: check.reason,
      label: signatureLabel(check.state, check.reason, source),
      source,
      workspaces,
      customisation: customisationDiff(customisation),
    }
  }

  /**
   * The first validation step that reads bytes: every entry the archive lists
   * is read, its size is compared with the manifest's size, and its SHA-256 is
   * compared with the manifest's digest.
   * @param archive - the open archive.
   * @param manifest - the validated manifest.
   * @returns every document's bytes, by path.
   * @throws ArchiveError `ARCHIVE_TRUNCATED` when a read entry is not the size the manifest declares, and `ARCHIVE_CHECKSUM_MISMATCH` when its bytes are not the digest the manifest declares.
   */
  private verifyChecksums(archive: ZipArchive, manifest: ArchiveManifest): Map<string, Uint8Array> {
    const names = new Set(archive.names())
    const contents = new Map<string, Uint8Array>()
    for (const entry of manifest.entries) {
      // An entry the archive does not hold is the entries step's refusal, so it is left for that step.
      if (!names.has(entry.path)) continue
      const data = archive.read(entry.path)
      if (data.length !== entry.size) {
        throw new ArchiveError(
          'ARCHIVE_TRUNCATED',
          `the entry ${JSON.stringify(entry.path)} holds ${String(data.length)} bytes where the manifest declares ${String(entry.size)}`,
        )
      }
      const digest = createHash('sha256').update(data).digest('hex')
      if (digest !== entry.sha256) {
        throw new ArchiveError('ARCHIVE_CHECKSUM_MISMATCH', `the entry ${JSON.stringify(entry.path)} is not the content its manifest digest names`)
      }
      contents.set(entry.path, data)
    }
    return contents
  }

  /**
   * The entries step: every entry is a plain file, the archive holds exactly
   * the entries the manifest lists plus the two documents the format names,
   * and the customisation document is one of them.
   * @param archive - the open archive.
   * @param manifest - the validated manifest.
   * @throws ArchiveError `ARCHIVE_LINK_REJECTED` and `ARCHIVE_PATH_REJECTED` from {@link ZipArchive.checkEntryTypes}, and `ARCHIVE_SCHEMA_INVALID` when the archive and the manifest disagree about which entries it holds or one of the format's documents is missing.
   */
  private verifyEntries(archive: ZipArchive, manifest: ArchiveManifest): void {
    archive.checkEntryTypes()
    const listed = new Set(manifest.entries.map(entry => entry.path))
    for (const name of archive.names()) {
      if (name === MANIFEST_PATH || name === SIGNATURE_PATH) continue
      if (!listed.has(name)) {
        throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the archive holds the entry ${JSON.stringify(name)}, which the manifest does not list`)
      }
    }
    for (const path of listed) {
      if (!archive.names().includes(path)) {
        throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the manifest lists the entry ${JSON.stringify(path)}, which the archive does not hold`)
      }
    }
    if (!listed.has(CUSTOMISATION_PATH)) {
      throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the manifest lists no ${CUSTOMISATION_PATH} entry, and every archive carries one`)
    }
    for (const name of archive.names()) {
      if (name !== MANIFEST_PATH && name !== SIGNATURE_PATH && name !== CUSTOMISATION_PATH && !name.startsWith(`${OBJECTS_DIRECTORY}/`)) {
        throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the archive holds ${JSON.stringify(name)} at its root, and the format allows no other entry there`)
      }
    }
  }

  /**
   * Stage every workspace and publish each one with one rename. The staging
   * root is removed whatever the publication did.
   * @param manifest - the validated manifest.
   * @param contents - every validated document and object, by path.
   * @returns the published workspaces, in the archive's order.
   * @throws ArchiveError `ARCHIVE_STAGING_FAILED` when the staging root or a publication fails.
   */
  private async publish(manifest: ArchiveManifest, contents: ReadonlyMap<string, Uint8Array>): Promise<ImportedWorkspace[]> {
    const root = join(this.config.stagingParent, randomUUID())
    const staged: StagedEntry[] = []
    for (const entry of manifest.entries) {
      if (entry.kind === 'customisation') continue
      staged.push({ path: entry.path, bytes: contents.get(entry.path)! })
    }
    staged.push({ path: CUSTOMISATION_PATH, bytes: contents.get(CUSTOMISATION_PATH)! })
    for (const workspace of manifest.workspaces) {
      const document: StagedWorkspaceDocument = {
        archiveId: workspace.id,
        name: workspace.name,
        chats: workspace.chats,
        attachments: workspace.attachments,
        objects: workspace.objects,
      }
      staged.push({
        path: `workspaces/${workspace.id}/${STAGED_WORKSPACE_DOCUMENT}`,
        bytes: new TextEncoder().encode(JSON.stringify(document, null, 2)),
      })
      const digests = new Set([...workspace.chats, ...workspace.attachments, ...workspace.objects].map(path => path.slice(OBJECTS_DIRECTORY.length + 1)))
      for (const digest of digests) {
        staged.push({
          path: `workspaces/${workspace.id}/${OBJECTS_DIRECTORY}/${digest}`,
          bytes: contents.get(`${OBJECTS_DIRECTORY}/${digest}`)!,
        })
      }
    }
    await writeStaging(root, staged)
    const published: ImportedWorkspace[] = []
    try {
      for (const workspace of manifest.workspaces) {
        const id = await this.allocate(workspace.id)
        try {
          await this.config.store.publish(id, join(root, 'workspaces', workspace.id))
        } catch (error: unknown) {
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unexpected error'
          throw new ArchiveError('ARCHIVE_STAGING_FAILED', `the workspace ${JSON.stringify(workspace.id)} could not be published (${code})`)
        }
        published.push({ archiveId: workspace.id, id, name: workspace.name })
      }
    } finally {
      await removeStaging(root)
    }
    return published
  }

  /**
   * The identifier a workspace is published under: the archive's own when the
   * store does not hold it, and a fresh one otherwise. An import never
   * overwrites a workspace.
   * @param archiveId - the identifier the archive gives the workspace.
   * @returns the identifier to publish under.
   * @throws ArchiveError `ARCHIVE_STAGING_FAILED` when the store already holds the fresh identifier too.
   */
  private async allocate(archiveId: string): Promise<string> {
    if (!(await this.config.store.exists(archiveId))) return archiveId
    const id = (this.config.newId ?? randomUUID)()
    if (await this.config.store.exists(id)) {
      throw new ArchiveError('ARCHIVE_STAGING_FAILED', `the workspace store holds the fresh identifier ${JSON.stringify(id)} already`)
    }
    return id
  }
}
