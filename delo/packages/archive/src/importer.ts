/**
 * The import path of contract C8. An import validates the whole archive before
 * it writes anything, in the order the contract names: the manifest, the
 * checksums, the paths, the entries, the limits, the customisation and the
 * signature. The sizes the central directory declares are checked first of
 * all, before the first read, because a read allocates what its record
 * declares: an archive that breaks a limit on its declarations is refused
 * rather than inflated into memory and refused afterwards. Only a fully
 * validated archive is staged, and each workspace is published from the
 * staging directory by one rename that never replaces an existing workspace.
 * An identifier that already exists is given a new one.
 *
 * An import publishes only an archive whose signer the person has accepted: a
 * signature that does not verify is refused, a key the home does not vouch for
 * is refused until the person confirms it, and an unsigned archive is refused
 * until the person accepts it unverified. {@link ArchiveImporter.inspect} runs
 * every validation step and writes nothing, so a caller can show who signed an
 * archive and what it holds before it asks. A publication that fails partway
 * withdraws every workspace the import already published, so a failed import
 * leaves no partial workspace or chat.
 *
 * @module @delo/archive/importer
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArchiveCustomisation, ArchiveManifest } from '@delo/contract-archive-and-trash'
import { ArchiveError } from './errors.ts'
import { customisationDiff, parseCustomisation, type CustomisationDiffRow } from './customisation.ts'
import { checkContainerDeclarations, checkManifestDeclarations } from './limits.ts'
import { CUSTOMISATION_PATH, MANIFEST_PATH, OBJECTS_DIRECTORY, parseManifest, SIGNATURE_PATH } from './manifest.ts'
import { checkPathCollisions } from './paths.ts'
import { checkArchiveSignature, keyFingerprint, parseSignature, type SignatureCheck, type SignatureReason, type SignatureState } from './signature.ts'
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

  /**
   * Remove one workspace this import published, when a later publication of
   * the same import fails, so a failed import leaves no partial workspace.
   * @param id - the identifier the import published the workspace under.
   */
  withdraw(id: string): Promise<void>
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
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await rename(stagedDirectory, join(this.root, id))
  }

  /**
   * Remove one workspace directory the same import published.
   * @param id - the identifier the workspace was published under.
   */
  async withdraw(id: string): Promise<void> {
    await rm(join(this.root, id), { recursive: true, force: true })
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

/** One workspace an archive holds, as a person sees it before the import. */
export interface PreviewWorkspace {
  /** The identifier the archive gives the workspace. */
  readonly id: string
  /** The workspace's name. */
  readonly name: string
  /** How many chats the workspace holds. */
  readonly chats: number
  /** How many attachments the workspace holds. */
  readonly attachments: number
}

/** The key an archive names as its signer, as a person confirms it. */
export interface ArchiveSigner {
  /** The key identifier the manifest declares, which the archive itself asserts. */
  readonly declaredKeyId: string
  /** The base64url public key the manifest declares. */
  readonly publicKey: string
  /** The SHA-256 of the raw public key, base64url: what a person compares and confirms, because the archive cannot choose it. */
  readonly fingerprint: string
}

/** What a validated archive holds and who signed it, which an import shows before it asks. */
export interface ArchivePreview {
  /** Whether the archive was signed by a key this home vouches for. */
  readonly state: SignatureState
  /** Why the archive is unverified; absent when it is verified. */
  readonly reason?: SignatureReason | undefined
  /** One sentence naming the source and the state. */
  readonly label: string
  /** The archive's source: its file name, or the origin's key identifier. */
  readonly source: string
  /** Whether the archive carries a signature. */
  readonly signed: boolean
  /** The key the archive names as its signer. */
  readonly signer: ArchiveSigner
  /** The Delo version that wrote the archive, as the archive states it. */
  readonly createdBy: string
  /** The time the export finished, as the archive states it. */
  readonly exportedAt: string
  /** The workspaces the archive holds, in its order. */
  readonly workspaces: readonly PreviewWorkspace[]
  /** The customisation diff: each row's kind and target. */
  readonly customisation: readonly CustomisationDiffRow[]
  /** The uncompressed bytes the manifest's entries add up to. */
  readonly totalBytes: number
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
  /** The home key identifier the person confirmed by its fingerprint at import, which narrows the confirmation to that identifier. */
  readonly confirmedHomeKeyId?: string | undefined
  /** The base64url key the person confirmed by its fingerprint at import: the confirmation binds this key, and the identifier alone vouches for nothing. */
  readonly confirmedPublicKey?: string | undefined
  /** Set once the person has seen that the archive carries no signature and chosen to import it unverified. */
  readonly acceptUnsigned?: boolean | undefined
  /** The identifier generator for a workspace whose archive identifier is taken; a UUID by default. */
  readonly newId?: (() => string) | undefined
}

/** One archive that passed every validation step, held in memory. */
interface ValidatedArchive {
  readonly manifest: ArchiveManifest
  readonly contents: ReadonlyMap<string, Uint8Array>
  readonly customisation: ArchiveCustomisation
  readonly signed: boolean
  readonly check: SignatureCheck
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
   * Validate one archive and describe it, writing nothing: the signer, the
   * signature state, the workspaces and the customisation a person sees before
   * an import asks.
   * @param bytes - the whole archive.
   * @param options - `source` names the archive by its file name; the origin's key identifier is used when it is absent.
   * @returns the preview.
   * @throws ArchiveError with the code of the first refusal the archive earns, `ARCHIVE_SIGNATURE_INVALID` included.
   */
  async inspect(bytes: Uint8Array, options: { readonly source?: string } = {}): Promise<ArchivePreview> {
    const validated = this.validate(bytes)
    const { manifest, check } = validated
    const source = options.source ?? manifest.origin.homeKeyId
    return {
      state: check.state,
      reason: check.reason,
      label: signatureLabel(check.state, check.reason, source),
      source,
      signed: validated.signed,
      signer: {
        declaredKeyId: manifest.origin.homeKeyId,
        publicKey: manifest.origin.publicKey,
        fingerprint: keyFingerprint(manifest.origin.publicKey),
      },
      createdBy: manifest.createdBy,
      exportedAt: manifest.exportedAt,
      workspaces: manifest.workspaces.map(workspace => ({
        id: workspace.id,
        name: workspace.name,
        chats: workspace.chats.length,
        attachments: workspace.attachments.length,
      })),
      customisation: customisationDiff(validated.customisation),
      totalBytes: manifest.entries.reduce((total, entry) => total + entry.size, 0),
    }
  }

  /**
   * Validate one archive and publish its workspaces.
   * @param bytes - the whole archive.
   * @param options - `source` names the archive in the report, by its file name; the origin's key identifier is used when it is absent.
   * @returns the import report.
   * @throws ArchiveError with the code of the first refusal the archive earns, after which nothing is written; `ARCHIVE_SIGNER_UNTRUSTED` when the signing key is neither vouched for nor confirmed, or the archive is unsigned and the person did not accept it unverified.
   */
  async import(bytes: Uint8Array, options: { readonly source?: string } = {}): Promise<ArchiveImportReport> {
    const validated = this.validate(bytes)
    const { manifest, check } = validated
    this.requireAcceptedSigner(check)
    const source = options.source ?? manifest.origin.homeKeyId
    const workspaces = await this.publish(manifest, validated.contents)
    return {
      state: check.state,
      reason: check.reason,
      label: signatureLabel(check.state, check.reason, source),
      source,
      workspaces,
      customisation: customisationDiff(validated.customisation),
    }
  }

  /**
   * Every validation step, in the contract's order, with nothing written.
   * @param bytes - the whole archive.
   * @returns the validated archive.
   * @throws ArchiveError with the code of the first refusal, and `ARCHIVE_SIGNATURE_INVALID` when a signature is present and does not verify.
   */
  private validate(bytes: Uint8Array): ValidatedArchive {
    const archive = ZipArchive.open(bytes)
    // The declarations come before the first read: every read allocates what its central-directory record declares, so a bomb is refused on its sizes rather than inflated into memory and refused afterwards.
    checkContainerDeclarations(archive)
    const manifestBytes = archive.read(MANIFEST_PATH)
    const manifest = parseManifest(manifestBytes)
    checkManifestDeclarations(manifest)
    const contents = this.verifyChecksums(archive, manifest)
    archive.checkPaths()
    checkPathCollisions(manifest.entries.map(entry => entry.path))
    this.verifyEntries(archive, manifest)
    const customisation = parseCustomisation(contents.get(CUSTOMISATION_PATH)!)
    const signature = archive.names().includes(SIGNATURE_PATH) ? parseSignature(archive.read(SIGNATURE_PATH)) : undefined
    const check = checkArchiveSignature({
      manifestBytes,
      origin: manifest.origin,
      signature,
      trustedPublicKeys: this.config.trustedPublicKeys,
      confirmedHomeKeyId: this.config.confirmedHomeKeyId,
      confirmedPublicKey: this.config.confirmedPublicKey,
    })
    if (check.reason === 'signature-invalid') {
      throw new ArchiveError('ARCHIVE_SIGNATURE_INVALID', 'the archive carries a signature that does not verify over its manifest')
    }
    return { manifest, contents, customisation, signed: signature !== undefined, check }
  }

  /**
   * Refuse an archive whose signer the person has not accepted.
   * @param check - the signature check of the validated archive.
   * @throws ArchiveError `ARCHIVE_SIGNER_UNTRUSTED` for a key neither vouched for nor confirmed, and for an unsigned archive not accepted unverified.
   */
  private requireAcceptedSigner(check: SignatureCheck): void {
    if (check.reason === 'key-not-trusted') {
      throw new ArchiveError('ARCHIVE_SIGNER_UNTRUSTED', 'the archive is signed by a key this home does not trust, and the person has not confirmed it')
    }
    if (check.reason === 'absent' && this.config.acceptUnsigned !== true) {
      throw new ArchiveError('ARCHIVE_SIGNER_UNTRUSTED', 'the archive carries no signature, and the person has not accepted it unverified')
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
    // Defence in depth: parseManifest already admits only these paths, so with every entry listed this never fires.
    /* v8 ignore next 5 -- unreachable while parseManifest restricts listed paths; kept so a looser manifest reader cannot admit a root entry */
    for (const name of archive.names()) {
      if (name !== MANIFEST_PATH && name !== SIGNATURE_PATH && name !== CUSTOMISATION_PATH && !name.startsWith(`${OBJECTS_DIRECTORY}/`)) {
        throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the archive holds ${JSON.stringify(name)} at its root, and the format allows no other entry there`)
      }
    }
  }

  /**
   * Stage every workspace and publish each one with one rename. The staging
   * root is filled and published inside one try, and it is removed whatever
   * the staging write or a publication did, so a refusal that lands after the
   * first staged file leaves no chat content on disk. A publication that fails
   * withdraws every workspace this import already published.
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
    const published: ImportedWorkspace[] = []
    try {
      await writeStaging(root, staged)
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
    } catch (error: unknown) {
      for (const workspace of published.reverse()) await this.config.store.withdraw(workspace.id)
      throw error
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
