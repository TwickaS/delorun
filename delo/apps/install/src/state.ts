/**
 * What the launcher remembers between installs, under contract C1's `trust/`: the newest root that verified, the
 * newest timestamp that verified, and the newest release-log checkpoint that verified. Contract C2 refuses a lower
 * timestamp version than the stored one and contract C18 refuses a checkpoint smaller than the stored one, so these
 * three files are the rollback protection a client keeps. Every one of them is a protected file: written at mode 0600
 * through a temporary file, and refused by `@delo/home` when it is a link, another user's or laxer than 0600.
 *
 * @module @delo/install/state
 */
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES, PRIVATE_DIR_MODE, ROOT_FILE_NAME_PATTERN, TRUST_FILES, TRUST_ROOTS_DIRECTORY } from '@delo/contract-home-layout'
import type { ReleaseLogCheck } from '@delo/contract-release-log'
import { readProtectedFile, writeProtectedFile } from '@delo/home'
import { readRoot } from '@delo/release/sign/verify'
import { checkStatePath } from '@delo/release-verify/paths'
import { readCheckState, recorded, serializeCheckState } from '@delo/release-verify/state'
import { InstallError, messageOf } from './errors.ts'

/** The newest timestamp a client verified: its version and its bytes, which an equal version must repeat. */
export interface StoredTimestamp {
  /** The highest timestamp version verified. */
  readonly version: number
  /** That timestamp file's bytes. */
  readonly bytes: Uint8Array
}

/** The newest release-log checkpoint a client verified (contract C18). */
export interface StoredCheckpoint {
  /** The tree size the checkpoint names. */
  readonly treeSize: number
  /** The checkpoint's root hash, lowercase hex. */
  readonly rootHash: string
}

/** The two fields a stored checkpoint holds, in the sorted order `Object.keys(record).sort()` gives them. */
const CHECKPOINT_FIELDS = ['rootHash', 'treeSize'] as const

/** The shape a stored checkpoint's root hash has. */
const HEX = /^[0-9a-f]{64}$/u

/**
 * The path of one of `trust/`'s files.
 * @param home - the resolved Delo home.
 * @param name - the file's name in `trust/`.
 * @returns the absolute path.
 */
export function trustFile(home: string, name: (typeof TRUST_FILES)[keyof typeof TRUST_FILES]): string {
  return join(home, DELO_HOME_ENTRIES.trust, name)
}

/**
 * Read a file under `trust/`, `undefined` when it is absent.
 * @param path - the absolute path.
 * @returns its bytes, or `undefined`.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the file is a link, belongs to another user or is laxer than 0600.
 */
async function readTrustFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readProtectedFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new InstallError('TRUST_STATE_INVALID', path, `the stored trust file cannot be read: ${messageOf(error)}`, { cause: error })
  }
}

/**
 * Write a file under `trust/`, creating the directory at mode 0700 when absent.
 * @param home - the resolved Delo home.
 * @param name - the file's name in `trust/`.
 * @param bytes - what to write.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the write fails.
 */
async function writeTrustFile(home: string, name: (typeof TRUST_FILES)[keyof typeof TRUST_FILES], bytes: Uint8Array): Promise<void> {
  const path = trustFile(home, name)
  try {
    await mkdir(join(home, DELO_HOME_ENTRIES.trust), { recursive: true, mode: PRIVATE_DIR_MODE })
    await writeProtectedFile(path, bytes)
  } catch (error) {
    throw new InstallError('TRUST_STATE_INVALID', path, `the trust file cannot be written: ${messageOf(error)}`, { cause: error })
  }
}

/**
 * Read the newest verified timestamp.
 * @param home - the resolved Delo home.
 * @returns its version and bytes, or `undefined` when no timestamp was stored.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the file does not read as a signed envelope with a positive
 *   integer version.
 */
export async function readStoredTimestamp(home: string): Promise<StoredTimestamp | undefined> {
  const path = trustFile(home, TRUST_FILES.timestamp)
  const bytes = await readTrustFile(path)
  if (bytes === undefined) return undefined
  let version: unknown
  try {
    const envelope: unknown = JSON.parse(bytes.toString('utf8'))
    version = typeof envelope === 'object' && envelope !== null ? (envelope as { readonly signed?: { readonly version?: unknown } }).signed?.version : undefined
  } catch (error) {
    throw new InstallError('TRUST_STATE_INVALID', path, `the stored timestamp is not JSON: ${messageOf(error)}`, { cause: error })
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new InstallError('TRUST_STATE_INVALID', path, 'the stored timestamp has no signed version, so a replay cannot be refused')
  }
  return { version, bytes }
}

/**
 * Store the newest verified timestamp. A caller writes it as soon as the timestamp verifies, so a later step's
 * refusal still leaves the freshness it proved recorded.
 * @param home - the resolved Delo home.
 * @param bytes - the verified timestamp file's bytes.
 */
export async function writeStoredTimestamp(home: string, bytes: Uint8Array): Promise<void> {
  await writeTrustFile(home, TRUST_FILES.timestamp, bytes)
}

/**
 * Read the newest trusted root's file, `trust/root.json`, which a start check anchors on.
 * @param home - the resolved Delo home.
 * @returns its bytes, or `undefined` when no root was stored.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the file is a link, belongs to another user or is laxer than 0600.
 */
export async function readStoredRootBytes(home: string): Promise<Uint8Array | undefined> {
  return readTrustFile(trustFile(home, TRUST_FILES.root))
}

/**
 * Store the newest trusted root, `trust/root.json`, which the runtime store's start check reads (contract C1).
 * @param home - the resolved Delo home.
 * @param bytes - the newest root file's bytes, as verified.
 */
export async function writeTrustedRoot(home: string, bytes: Uint8Array): Promise<void> {
  await writeTrustFile(home, TRUST_FILES.root, bytes)
}

/** The directory under `trust/` that holds the chain an install walked, `trust/roots/<n>.root.json`. */
const TRUST_ROOTS = (home: string): string => join(home, DELO_HOME_ENTRIES.trust, TRUST_ROOTS_DIRECTORY)

/** One filed root's name: `<n>.root.json`, where `n` is its version. */
const ROOT_FILE_NAME = new RegExp(ROOT_FILE_NAME_PATTERN, 'u')

/**
 * The path of one root of the chain an install walked.
 * @param home - the resolved Delo home.
 * @param version - the root's version.
 * @returns the absolute path.
 */
function trustRootFile(home: string, version: number): string {
  return join(TRUST_ROOTS(home), `${String(version)}.root.json`)
}

/**
 * Read the chain of roots an install walked, `trust/roots/<n>.root.json`, oldest first. It is what a stored root newer
 * than every root a launcher ships is held to: the start path walks it from a shipped root, so a file a restore or a
 * sync placed under `trust/` is not a root this launcher trusts on its own.
 * @param home - the resolved Delo home.
 * @returns the root files, oldest first; empty when no install walked a chain.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the directory or one of its roots is a link, belongs to another
 *   user or is laxer than 0600.
 */
export async function readStoredRootChain(home: string): Promise<readonly Uint8Array[]> {
  const directory = TRUST_ROOTS(home)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new InstallError('TRUST_STATE_INVALID', directory, `the walked root chain cannot be read: ${messageOf(error)}`, { cause: error })
  }
  const roots = names
    .map(name => ROOT_FILE_NAME.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ version: Number(match[1]), name: match[0] }))
    .sort((left, right) => left.version - right.version)
  const chain: Uint8Array[] = []
  for (const root of roots) {
    const path = join(directory, root.name)
    try {
      chain.push(await readProtectedFile(path))
    } catch (error) {
      throw new InstallError('TRUST_STATE_INVALID', path, `the walked root chain cannot be read: ${messageOf(error)}`, { cause: error })
    }
  }
  return chain
}

/**
 * Store the chain of roots an install walked, so a later start can prove that a stored root newer than every root its
 * launcher ships descends from one the launcher ships. Each file is named for its version and written at mode 0600.
 * @param home - the resolved Delo home.
 * @param roots - the root files the install verified, oldest first.
 * @throws {InstallError} `TRUST_STATE_INVALID` when a root does not read, or a file cannot be written.
 */
export async function writeStoredRootChain(home: string, roots: readonly Uint8Array[]): Promise<void> {
  if (roots.length === 0) return
  const directory = TRUST_ROOTS(home)
  try {
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
  } catch (error) {
    throw new InstallError('TRUST_STATE_INVALID', directory, `the walked root chain cannot be written: ${messageOf(error)}`, { cause: error })
  }
  for (const bytes of roots) {
    let version: number
    try {
      version = readRoot(bytes).metadata.version
    } catch (error) {
      throw new InstallError('TRUST_STATE_INVALID', directory, `a root of the walked chain does not read, so the chain cannot be stored: ${messageOf(error)}`, { cause: error })
    }
    const path = trustRootFile(home, version)
    try {
      await writeProtectedFile(path, bytes)
    } catch (error) {
      throw new InstallError('TRUST_STATE_INVALID', path, `the walked root chain cannot be written: ${messageOf(error)}`, { cause: error })
    }
  }
}

/**
 * Read the newest verified release-log checkpoint.
 * @param home - the resolved Delo home.
 * @returns the checkpoint, or `undefined` when none was stored.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the file is not a checkpoint record.
 */
export async function readStoredCheckpoint(home: string): Promise<StoredCheckpoint | undefined> {
  const path = trustFile(home, TRUST_FILES.checkpoint)
  const bytes = await readTrustFile(path)
  if (bytes === undefined) return undefined
  let record: unknown
  try {
    record = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new InstallError('TRUST_STATE_INVALID', path, `the stored checkpoint is not JSON: ${messageOf(error)}`, { cause: error })
  }
  const fields = typeof record === 'object' && record !== null ? Object.keys(record).sort() : []
  const value = record as { readonly treeSize?: unknown, readonly rootHash?: unknown }
  if (fields.join(',') !== CHECKPOINT_FIELDS.join(',')
    || typeof value.treeSize !== 'number' || !Number.isSafeInteger(value.treeSize) || value.treeSize < 1
    || typeof value.rootHash !== 'string' || !HEX.test(value.rootHash)) {
    throw new InstallError('TRUST_STATE_INVALID', path, 'the stored checkpoint is not a {treeSize, rootHash} record, so the log cannot be checked from it')
  }
  return { treeSize: value.treeSize, rootHash: value.rootHash }
}

/**
 * Store the newest verified release-log checkpoint, so the next check proves consistency from it.
 * @param home - the resolved Delo home.
 * @param checkpoint - the checkpoint a verified online check named.
 */
export async function writeStoredCheckpoint(home: string, checkpoint: StoredCheckpoint): Promise<void> {
  await writeTrustFile(home, TRUST_FILES.checkpoint, Buffer.from(`${JSON.stringify(checkpoint)}\n`))
}

/**
 * Record what the release-log check found for a release in `trust/release-log.json`, the per-release check state that
 * `@delo/release-verify` keeps (contract C18, "Check states"): `verified` when the online check passed, and `unchecked`
 * with the reason when it could not run. The record of any other release in the file is kept as it is.
 * @param home - the resolved Delo home.
 * @param check - the check's record for the release being installed.
 * @param detail - why the check did not run, when it did not.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the file exists and does not read as a check state record, or
 *   cannot be written.
 */
export async function writeReleaseLogCheck(home: string, check: ReleaseLogCheck, detail?: string): Promise<void> {
  const path = checkStatePath(home)
  const existing = await readTrustFile(path)
  let state: ReturnType<typeof readCheckState>
  try {
    state = existing === undefined ? new Map() : readCheckState(existing)
  } catch (error) {
    throw new InstallError('TRUST_STATE_INVALID', path, `the stored release-log check state does not read: ${messageOf(error)}`, { cause: error })
  }
  state.set(check.release, recorded(check.release, check.state, check.lastAttempt, undefined, detail))
  try {
    await mkdir(join(home, DELO_HOME_ENTRIES.trust), { recursive: true, mode: PRIVATE_DIR_MODE })
    await writeProtectedFile(path, Buffer.from(serializeCheckState(state)))
  } catch (error) {
    throw new InstallError('TRUST_STATE_INVALID', path, `the release-log check state cannot be written: ${messageOf(error)}`, { cause: error })
  }
}
