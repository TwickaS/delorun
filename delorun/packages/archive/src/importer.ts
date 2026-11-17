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
 * @module @delorun/archive/importer
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ARCHIVE_LIMITS, type ArchiveContentKind, type ArchiveCustomisation, type ArchiveManifest } from '@delorun/contract-archive-and-trash'
import { ArchiveError, failureCode } from './errors.ts'
import { customisationDiff, parseCustomisation, type CustomisationDiffRow } from './customisation.ts'
import { checkContainerDeclarations, checkManifestDeclarations } from './limits.ts'
import { CUSTOMISATION_PATH, MANIFEST_PATH, OBJECTS_DIRECTORY, parseManifest, SIGNATURE_PATH } from './manifest.ts'
import { checkPathCollisions } from './paths.ts'
import { keyFingerprint } from './fingerprint.ts'
import { parseSetupDocument, type SetupDocument } from './setup.ts'
import { checkArchiveSignature, parseSignature, type SignatureReason, type SignatureState } from './signature.ts'
import { refuseLinkedDirectory, removeStaging, writeStaging, type StagedEntry } from './staging.ts'
import type { ArchiveSizeLimits } from './limits.ts'
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

/** Why an archive an import accepts is unverified: a failing signature is refused, never accepted. */
export type AcceptedReason = Exclude<SignatureReason, 'signature-invalid'>

/** The suffix of the journal an import keeps beside its staging root while it publishes. */
export const PUBLISHING_JOURNAL_SUFFIX = '.publishing.json'

/** What {@link ArchiveImporter.recover} cleaned up. */
export interface RecoveryReport {
  /** Workspaces an interrupted import had published, which were withdrawn. */
  readonly withdrawn: readonly string[]
  /** Staging entries an interrupted import left, which were removed. */
  readonly removed: number
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
   * rename replaces an empty directory that stands at its target, so a target
   * that exists is refused first; the root and the directory that holds it
   * must not be symbolic links.
   * @param id - the identifier to publish under.
   * @param stagedDirectory - the absolute path of the staged directory.
   * @throws ArchiveError `ARCHIVE_STAGING_FAILED` for a linked root; Error with code `EEXIST` for a taken identifier.
   */
  async publish(id: string, stagedDirectory: string): Promise<void> {
    await refuseLinkedDirectory(this.root)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (await this.exists(id)) throw Object.assign(new Error(`the workspace store holds ${id} already`), { code: 'EEXIST' })
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
  readonly reason?: AcceptedReason | undefined
  /** One sentence naming the source and the state. */
  readonly label: string
  /** The archive's source: its file name, or the origin's key identifier. */
  readonly source: string
  /** Whether the archive carries a signature. */
  readonly signed: boolean
  /** The key the archive names as its signer. */
  readonly signer: ArchiveSigner
  /** The Delorun version that wrote the archive, as the archive states it. */
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
  readonly reason?: AcceptedReason | undefined
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
  /** The size limits to apply, by default contract C8's; a caller that holds the archive in memory sets lower ones. */
  readonly limits?: ArchiveSizeLimits | undefined
}

/** A setup archive that passed every validation step. */
export interface OpenedSetup {
  /** The setup document. */
  readonly document: SetupDocument
  /** Whether a key this home vouches for signed the archive. */
  readonly state: SignatureState
  /** Why the archive is unverified; absent when it is verified. */
  readonly reason?: AcceptedReason | undefined
  /** The archive's source: its file name, or the origin's key identifier. */
  readonly source: string
  /** Whether the archive carries a signature. */
  readonly signed: boolean
  /** The key the archive names as its signer. */
  readonly signer: ArchiveSigner
  /** The Delorun version that wrote the archive, as the archive states it. */
  readonly createdBy: string
  /** The time the export finished, as the archive states it. */
  readonly exportedAt: string
  /**
   * Read one plugin file.
   * @param sha256 - the digest the document names; the bytes are the entry's, whose digest the validation checked.
   * @returns the file's bytes.
   */
  readonly readFile: (sha256: string) => Uint8Array
}

/**
 * Refuse an archive of the other content kind.
 * @param validated - the validated archive.
 * @param wanted - the content kind the caller reads.
 * @throws ArchiveError `ARCHIVE_WRONG_KIND` naming the command that reads the archive.
 */
function requireContent(validated: ValidatedArchive, wanted: ArchiveContentKind): void {
  const has = validated.manifest.content ?? 'chats'
  if (has === wanted) return
  throw new ArchiveError('ARCHIVE_WRONG_KIND', has === 'setup'
    ? 'this is a setup archive: import it with delorun setup import'
    : 'this is an archive of chats: import it with delorun import')
}

/** One archive that passed every validation step. Entries are read again when staged, so no content is held. */
interface ValidatedArchive {
  readonly archive: ZipArchive
  readonly manifest: ArchiveManifest
  readonly customisation: ArchiveCustomisation
  readonly signed: boolean
  readonly state: SignatureState
  readonly reason?: AcceptedReason | undefined
}

/**
 * The one sentence that states an archive's signature state to a person.
 * @param state - the state the signature check found.
 * @param reason - why the archive is unverified.
 * @param source - the archive's source.
 * @returns the sentence.
 */
export function signatureLabel(state: SignatureState, reason: AcceptedReason | undefined, source: string): string {
  if (state === 'verified') return `Import from ${source}: the signature is verified.`
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
    requireContent(validated, 'chats')
    const { manifest } = validated
    const source = options.source ?? manifest.origin.homeKeyId
    return {
      state: validated.state,
      reason: validated.reason,
      label: signatureLabel(validated.state, validated.reason, source),
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
    requireContent(validated, 'chats')
    this.requireAcceptedSigner(validated.reason)
    const source = options.source ?? validated.manifest.origin.homeKeyId
    const workspaces = await this.publish(validated.archive, validated.manifest)
    return {
      state: validated.state,
      reason: validated.reason,
      label: signatureLabel(validated.state, validated.reason, source),
      source,
      workspaces,
      customisation: customisationDiff(validated.customisation),
    }
  }

  /**
   * Validate one setup archive and describe it, writing nothing. Every check of {@link inspect} runs. The signer is
   * not a gate: an unsigned archive and a signature by a key this home does not know are returned as unverified with
   * the key's fingerprint, because a setup is reviewed by the person and applied only through the paths that review
   * plugin code, and a signature that does not verify is still refused.
   * @param bytes - the whole archive.
   * @param options - `source` names the archive by its file name; the origin's key identifier is used when it is absent.
   * @returns the setup document, the signer and a reader for the plugin files.
   * @throws ArchiveError with the code of the first refusal the archive earns; `ARCHIVE_WRONG_KIND` for a chats archive; `ARCHIVE_SCHEMA_INVALID` when the customisation lists a row, when a plugin file the document names is not a `plugin-file` entry of the same size, or when a `plugin-file` entry is named by no plugin.
   */
  openSetup(bytes: Uint8Array, options: { readonly source?: string } = {}): OpenedSetup {
    const validated = this.validate(bytes)
    requireContent(validated, 'setup')
    const { manifest, archive } = validated
    if (validated.customisation.rows.length > 0) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', 'a setup archive lists customisation rows, which only a chats archive carries')
    const entries = new Map(manifest.entries.map(entry => [entry.sha256, entry]))
    const documentEntry = manifest.entries.find(entry => entry.kind === 'setup-document')!
    const document = parseSetupDocument(archive.read(documentEntry.path))
    const named = new Set<string>()
    for (const plugin of document.plugins) {
      if (plugin.source !== 'local') continue
      for (const file of plugin.files) {
        const entry = entries.get(file.sha256)
        if (entry?.kind !== 'plugin-file' || entry.size !== file.size) {
          throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the file ${JSON.stringify(file.path)} of ${plugin.name} is not a plugin-file entry of the size the setup names`)
        }
        named.add(file.sha256)
      }
    }
    const stray = manifest.entries.find(entry => entry.kind === 'plugin-file' && !named.has(entry.sha256))
    if (stray !== undefined) throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', `the plugin-file entry ${JSON.stringify(stray.path)} is named by no plugin of the setup`)
    const source = options.source ?? manifest.origin.homeKeyId
    return {
      document,
      state: validated.state,
      reason: validated.reason,
      source,
      signed: validated.signed,
      signer: { declaredKeyId: manifest.origin.homeKeyId, publicKey: manifest.origin.publicKey, fingerprint: keyFingerprint(manifest.origin.publicKey) },
      createdBy: manifest.createdBy,
      exportedAt: manifest.exportedAt,
      readFile: (sha256: string) => archive.read(`${OBJECTS_DIRECTORY}/${sha256}`),
    }
  }

  /**
   * Finish what an interrupted import left: withdraw every workspace its
   * journal names and remove its staging root, which holds decoded chat
   * content. The caller holds the exclusion that keeps any other import from
   * running, because every entry under the staging parent is then stale.
   * @returns what was withdrawn and removed.
   * @throws ArchiveError `ARCHIVE_STAGING_FAILED` for a linked staging parent, and `ARCHIVE_SCHEMA_INVALID` for a journal that names something other than a workspace identifier.
   */
  async recover(): Promise<RecoveryReport> {
    const parent = this.config.stagingParent
    await refuseLinkedDirectory(parent)
    let names: string[]
    try {
      names = await readdir(parent)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { withdrawn: [], removed: 0 }
      throw error
    }
    const withdrawn: string[] = []
    for (const name of names.filter(entry => entry.endsWith(PUBLISHING_JOURNAL_SUFFIX))) {
      for (const id of await readJournal(join(parent, name))) {
        await this.config.store.withdraw(id)
        withdrawn.push(id)
      }
    }
    for (const name of names) await rm(join(parent, name), { recursive: true, force: true })
    return { withdrawn, removed: names.length }
  }

  /**
   * Every validation step, in the contract's order, with nothing written and
   * no entry's content kept.
   * @param bytes - the whole archive.
   * @returns the validated archive.
   * @throws ArchiveError with the code of the first refusal, and `ARCHIVE_SIGNATURE_INVALID` when a signature is present and does not verify.
   */
  private validate(bytes: Uint8Array): ValidatedArchive {
    const limits = this.config.limits ?? ARCHIVE_LIMITS
    const archive = ZipArchive.open(bytes, limits)
    // The declarations come before the first read: every read allocates what its central-directory record declares, so a bomb is refused on its sizes rather than inflated into memory and refused afterwards.
    checkContainerDeclarations(archive, limits)
    const manifestBytes = archive.read(MANIFEST_PATH)
    const manifest = parseManifest(manifestBytes)
    checkManifestDeclarations(manifest, limits)
    const customisationBytes = this.verifyChecksums(archive, manifest)
    archive.checkPaths()
    checkPathCollisions(manifest.entries.map(entry => entry.path))
    this.verifyEntries(archive, manifest)
    const customisation = parseCustomisation(customisationBytes!)
    const signature = archive.has(SIGNATURE_PATH) ? parseSignature(archive.read(SIGNATURE_PATH)) : undefined
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
    return { archive, manifest, customisation, signed: signature !== undefined, state: check.state, reason: check.reason }
  }

  /**
   * Refuse an archive whose signer the person has not accepted.
   * @param reason - why the validated archive is unverified, if it is.
   * @throws ArchiveError `ARCHIVE_SIGNER_UNTRUSTED` for a key neither vouched for nor confirmed, and for an unsigned archive not accepted unverified.
   */
  private requireAcceptedSigner(reason: AcceptedReason | undefined): void {
    if (reason === 'key-not-trusted') {
      throw new ArchiveError('ARCHIVE_SIGNER_UNTRUSTED', 'the archive is signed by a key this home does not trust, and the person has not confirmed it')
    }
    if (reason === 'absent' && this.config.acceptUnsigned !== true) {
      throw new ArchiveError('ARCHIVE_SIGNER_UNTRUSTED', 'the archive carries no signature, and the person has not accepted it unverified')
    }
  }

  /**
   * The first validation step that reads bytes: every entry the archive lists
   * is read, its size is compared with the manifest's size, and its SHA-256 is
   * compared with the manifest's digest. Only the customisation document is
   * kept; every other entry is read again when it is staged.
   * @param archive - the open archive.
   * @param manifest - the validated manifest.
   * @returns the customisation document's bytes, when the archive holds it.
   * @throws ArchiveError `ARCHIVE_TRUNCATED` when a read entry is not the size the manifest declares, and `ARCHIVE_CHECKSUM_MISMATCH` when its bytes are not the digest the manifest declares.
   */
  private verifyChecksums(archive: ZipArchive, manifest: ArchiveManifest): Uint8Array | undefined {
    let customisation: Uint8Array | undefined
    for (const entry of manifest.entries) {
      // An entry the archive does not hold is the entries step's refusal, so it is left for that step.
      if (!archive.has(entry.path)) continue
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
      if (entry.path === CUSTOMISATION_PATH) customisation = data
    }
    return customisation
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
      if (!archive.has(path)) {
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
   * Stage every workspace and publish each one with one rename. Each object
   * is read from the archive as it is written, so the import holds one entry
   * at a time. A journal beside the staging root names each workspace before
   * it is published, so {@link recover} can withdraw what a crash left. The
   * staging root is removed whatever happened, and a publication that fails
   * withdraws every workspace this import already published.
   * @param archive - the validated archive.
   * @param manifest - its manifest.
   * @returns the published workspaces, in the archive's order.
   * @throws ArchiveError `ARCHIVE_STAGING_FAILED` when the staging root, the journal or a publication fails.
   */
  private async publish(archive: ZipArchive, manifest: ArchiveManifest): Promise<ImportedWorkspace[]> {
    await refuseLinkedDirectory(this.config.stagingParent)
    const root = join(this.config.stagingParent, randomUUID())
    const journal = `${root}${PUBLISHING_JOURNAL_SUFFIX}`
    const staged: StagedEntry[] = []
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
        staged.push({ path: `workspaces/${workspace.id}/${OBJECTS_DIRECTORY}/${digest}`, bytes: () => archive.read(`${OBJECTS_DIRECTORY}/${digest}`) })
      }
    }
    const published: ImportedWorkspace[] = []
    let settled = false
    try {
      await writeStaging(root, staged)
      const journaled: string[] = []
      for (const workspace of manifest.workspaces) {
        const id = await this.allocate(workspace.id)
        journaled.push(id)
        await writeJournal(journal, journaled)
        try {
          await this.config.store.publish(id, join(root, 'workspaces', workspace.id))
        } catch (error: unknown) {
          throw new ArchiveError('ARCHIVE_STAGING_FAILED', `the workspace ${JSON.stringify(workspace.id)} could not be published (${failureCode(error)})`)
        }
        published.push({ archiveId: workspace.id, id, name: workspace.name })
      }
      settled = true
    } catch (error: unknown) {
      for (const workspace of published.reverse()) await this.config.store.withdraw(workspace.id)
      settled = true
      throw error
    } finally {
      await removeStaging(root)
      // A journal stays only when a withdrawal itself failed, so the next recovery finishes it.
      if (settled) await removeStaging(journal)
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

/**
 * Write the journal of the workspaces an import is about to publish.
 * @param path - the journal's path.
 * @param ids - every identifier the import may have published.
 * @throws ArchiveError `ARCHIVE_STAGING_FAILED` when the journal cannot be written.
 */
async function writeJournal(path: string, ids: readonly string[]): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify({ workspaces: ids })}\n`, { mode: 0o600 })
  } catch (error: unknown) {
    throw new ArchiveError('ARCHIVE_STAGING_FAILED', `the import's journal could not be written (${failureCode(error)})`)
  }
}

/**
 * Read one journal an interrupted import left.
 * @param path - the journal's path.
 * @returns the workspace identifiers it names.
 * @throws ArchiveError `ARCHIVE_SCHEMA_INVALID` when it names anything other than workspace identifiers.
 */
async function readJournal(path: string): Promise<string[]> {
  let ids: unknown
  try {
    ids = (JSON.parse(await readFile(path, 'utf8')) as { workspaces?: unknown }).workspaces
  } catch (error: unknown) {
    // A journal cut short by the crash it records names nothing the recovery can trust.
    void error
    return []
  }
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && /^[A-Za-z0-9._~-]+$/u.test(id) && id !== '.' && id !== '..')) {
    throw new ArchiveError('ARCHIVE_SCHEMA_INVALID', 'an import journal names something other than workspace identifiers')
  }
  return ids
}
