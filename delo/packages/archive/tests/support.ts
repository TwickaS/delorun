/**
 * Shared fixtures of the archive specs: a scratch directory shaped like a
 * home's staging parent and workspace root, a workspace store that records
 * what an import published and the modes it published with, and the builder of
 * the archives the refusals are read from — a valid manifest and customisation
 * document, plus whatever hostile entry the spec under test adds beside them.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  ARCHIVE_CUSTOMISATION_SCHEMA_VERSION,
  ARCHIVE_FORMAT_VERSION,
  type ArchiveEntry,
  type ArchiveWorkspace,
} from '@delo/contract-archive-and-trash'
import {
  CUSTOMISATION_PATH,
  MANIFEST_PATH,
  OBJECTS_DIRECTORY,
  ZipWriter,
  type ArchiveWorkspaceStore,
  type ZipEntryInput,
} from '../src/index.ts'

/** The home key identifier every fixture manifest declares. */
export const HOME_KEY_ID = 'fixture-home-key'

/** The public key every fixture manifest declares: 32 bytes of one value, which no real key is. */
export const HOME_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64url')

/** The UTF-8 encoder the fixtures write their documents with. */
const ENCODER = new TextEncoder()

/**
 * The SHA-256 of one byte sequence, in the lowercase hexadecimal the format uses.
 * @param bytes - the bytes to digest.
 * @returns the digest.
 */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The UTF-8 bytes of one text.
 * @param text - the text to encode.
 * @returns the bytes.
 */
export function utf8(text: string): Uint8Array {
  return ENCODER.encode(text)
}

/** One object a fixture archive carries, under the digest its path names. */
export interface FixtureObject {
  /** The entry kind the manifest declares for the object. */
  readonly kind: ArchiveEntry['kind']
  /** The object's bytes. */
  readonly bytes: Uint8Array
}

/** The facts one fixture archive is built from. */
export interface FixtureArchive {
  /** The objects the manifest lists, each under its own digest. */
  readonly objects?: readonly FixtureObject[]
  /** The workspaces the manifest declares. */
  readonly workspaces?: readonly ArchiveWorkspace[]
  /** The customisation document; by default one that carries no rows. */
  readonly customisation?: string
  /** Entries written beside the format's documents, which is how a spec builds a hostile archive. */
  readonly extra?: readonly ZipEntryInput[]
  /** The uncompressed size the writer declares for the customisation entry, when it should not be the real one. */
  readonly customisationDeclaredSize?: number
}

/**
 * Build one archive: the customisation document, every object under its
 * digest, the manifest that lists them, and the spec's extra entries.
 * @param fixture - the objects, the workspaces, the customisation document and the extra entries.
 * @returns the archive's bytes.
 */
export function buildArchive(fixture: FixtureArchive = {}): Uint8Array {
  const customisation = utf8(fixture.customisation ?? JSON.stringify({ schemaVersion: ARCHIVE_CUSTOMISATION_SCHEMA_VERSION, rows: [] }))
  const objects = fixture.objects ?? []
  const entries: ArchiveEntry[] = [
    { path: CUSTOMISATION_PATH, sha256: sha256(customisation), size: customisation.length, kind: 'customisation' },
    ...objects.map(object => ({ path: `${OBJECTS_DIRECTORY}/${sha256(object.bytes)}`, sha256: sha256(object.bytes), size: object.bytes.length, kind: object.kind })),
  ]
  const manifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdBy: 'delo-archive-fixture',
    exportedAt: '2026-01-01T00:00:00Z',
    origin: { homeKeyId: HOME_KEY_ID, publicKey: HOME_PUBLIC_KEY },
    workspaces: fixture.workspaces ?? [],
    entries,
  }
  const manifestBytes = utf8(JSON.stringify(manifest, null, 2))
  const writer = new ZipWriter()
  writer.add({
    name: CUSTOMISATION_PATH,
    bytes: customisation,
    ...fixture.customisationDeclaredSize === undefined ? {} : { declaredUncompressedSize: fixture.customisationDeclaredSize },
  })
  for (const object of objects) writer.add({ name: `${OBJECTS_DIRECTORY}/${sha256(object.bytes)}`, bytes: object.bytes })
  writer.add({ name: MANIFEST_PATH, bytes: manifestBytes })
  for (const entry of fixture.extra ?? []) writer.add(entry)
  return writer.finish()
}

/** One workspace a fixture import published, with the modes it was published with. */
export interface PublishedWorkspace {
  /** The identifier the import published it under. */
  readonly id: string
  /** The permission bits of the published workspace directory. */
  readonly directoryMode: number
  /** The permission bits of every file in it, by path relative to the directory. */
  readonly files: readonly { readonly path: string; readonly mode: number }[]
}

/**
 * A workspace store that records what an import published, and the modes it
 * published with, instead of moving the staged directory anywhere.
 */
export class RecordingStore implements ArchiveWorkspaceStore {
  /** Every workspace the imports published, in order. */
  readonly published: PublishedWorkspace[] = []
  private readonly taken: Set<string>

  /**
   * @param taken - the identifiers the store already holds.
   */
  constructor(taken: readonly string[] = []) {
    this.taken = new Set(taken)
  }

  /**
   * Whether the store already holds a workspace under an identifier.
   * @param id - the identifier to look for.
   * @returns true when the store holds it.
   */
  async exists(id: string): Promise<boolean> {
    return this.taken.has(id)
  }

  /**
   * Record one staged directory as published under an identifier.
   * @param id - the identifier to publish under.
   * @param stagedDirectory - the absolute path of the staged directory.
   */
  async publish(id: string, stagedDirectory: string): Promise<void> {
    this.published.push({
      id,
      directoryMode: statSync(stagedDirectory).mode & 0o777,
      files: walk(stagedDirectory),
    })
    this.taken.add(id)
  }
}

/**
 * The permission bits of every file under one directory.
 * @param root - the directory to walk.
 * @returns the files, by path relative to the root, in path order.
 */
function walk(root: string): { path: string; mode: number }[] {
  const files: { path: string; mode: number }[] = []
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const absolute = join(entry.parentPath, entry.name)
    files.push({ path: relative(root, absolute), mode: statSync(absolute).mode & 0o777 })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

/** One private scratch directory a spec writes its staging roots and stores under. */
export interface Scratch {
  /** The root of the scratch tree. */
  readonly root: string
  /** The directory an import creates its staging root under. */
  readonly stagingParent: string
  /** The directory a store would publish workspaces under. */
  readonly workspacesRoot: string
  /** Remove the scratch tree and everything in it. */
  remove(): void
}

/**
 * Make one private scratch directory, with the staging parent and the
 * workspace root inside it.
 * @returns the scratch tree.
 */
export function makeScratch(): Scratch {
  const root = mkdtempSync(join(tmpdir(), 'delo-archive-'))
  const stagingParent = join(root, 'staging')
  const workspacesRoot = join(root, 'workspaces')
  mkdirSync(stagingParent)
  mkdirSync(workspacesRoot)
  return {
    root,
    stagingParent,
    workspacesRoot,
    remove: () => { rmSync(root, { recursive: true, force: true }) },
  }
}
