/**
 * File identities and the identity record of an installation (contract C2's start check, design
 * `delorun/docs/design/start-check.md`). A file's identity is `<inode>:<mode>:<size>:<mtime ns>:<ctime ns>`, with its
 * device required to equal the installation root's current device, because WSL2 and device-mapper renumber devices at
 * a reboot. An unprivileged process cannot set a change time on the file systems this module trusts, so a file whose
 * identity equals the one recorded after its bytes were hashed or written has not been written, truncated, replaced
 * or re-moded since. An identity whose change time lies within {@link RACY_WINDOW_NS} of the record's capture time
 * vouches for nothing, as in git's racy-clean rule, because a later write in the same clock step can keep it.
 *
 * The record lives at `trust/runtime-files/delorun-<version>-<platform>.json`, outside every read exemption, at mode
 * 0600. It holds no key: every process that can write it can also read any key under the same home, change the runtime
 * and replace the launcher.
 *
 * @module @delorun/runtime-store/identity
 */
import { constants, type BigIntStats } from 'node:fs'
import { open, statfs } from 'node:fs/promises'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { RuntimePlatform } from '@delorun/contract-release-manifest'

/** The record's schema name and major version. */
export const IDENTITY_SCHEMA = 'delorun.runtime-identity/1'

/** The largest record read: twice the file list's own limit, because an entry is never longer than its list entry. */
const RECORD_MAX_BYTES = 64 * 1024 * 1024

/**
 * How much older than the record's capture time a change time must be to vouch: a write that lands in the same step
 * of the clock the kernel stamps change times from, or in the same second on a file system that stores whole seconds,
 * can keep the change time, so a newer identity is hashed until a later capture leaves it this far behind.
 */
export const RACY_WINDOW_NS = 2_000_000_000n

const NS_PER_MS = 1_000_000n

/**
 * The Linux file systems (`statfs` magic numbers) whose change times only the local kernel sets: ext2, ext3 and ext4
 * (one number), XFS, Btrfs, F2FS and tmpfs. Every other file system, macOS's and Windows' included, gets the full hash
 * at every start: NFS, SMB, FUSE, 9p and WSL's drvfs, and virtiofs report times another party chooses, NTFS lets a
 * file's owner set its change time, and overlayfs reports its own type whatever its lower layers are, so an NFS or
 * FUSE lower layer would pass for a local one.
 */
const TRUSTED_FILE_SYSTEMS: ReadonlySet<number> = new Set([0xEF53, 0x58465342, 0x9123683E, 0xF2F52010, 0x01021994])

const IDENTITY = /^\d+:\d+:\d+:\d+:\d+$/u
const SHA256 = /^[0-9a-f]{64}$/u
const DIGITS = /^\d+$/u

/** What the record of one installation holds. */
export interface IdentityRecord {
  /** The version it describes. */
  readonly version: string
  /** The platform it describes. */
  readonly platform: string
  /** The SHA-256 of the signed file list it describes, as the verified manifest gives it. */
  readonly fileList: string
  /** The SHA-256 of the stored manifest's bytes. */
  readonly manifest: string
  /** The installation root's inode, in decimal. */
  readonly rootInode: string
  /** The `statfs` type of the installation root's file system. */
  readonly fileSystem: number
  /** When the identities were captured: a time no later than every observation they come from, in milliseconds. */
  readonly capturedAt: number
  /** When the last pass that hashed every file started, in milliseconds since the epoch. */
  readonly fullCheckAt: number
  /** One identity per entry of the file list, in its order; `null` where the store could not vouch. */
  readonly files: readonly (string | null)[]
}

/** What a record must be bound to before a start may use it. */
export type RecordBinding = Pick<IdentityRecord, 'fileList' | 'manifest' | 'rootInode' | 'fileSystem'> & {
  /** The installed version. */
  readonly version: RuntimeVersion
  /** This machine's platform. */
  readonly platform: RuntimePlatform
  /** The number of files the list names. */
  readonly length: number
}

/**
 * Now, in nanoseconds since the epoch, at millisecond precision; never later than the true time.
 * @returns the time.
 */
export function nowNs(): bigint {
  return BigInt(Date.now()) * NS_PER_MS
}

/**
 * A file's identity: `<inode>:<mode>:<size>:<mtime ns>:<ctime ns>`, where the mode includes the file type. The
 * device is compared with the installation root's separately.
 * @param stats - the file's status with `bigint` times.
 * @returns the identity.
 */
export function identityOf(stats: BigIntStats): string {
  return `${String(stats.ino)}:${String(stats.mode)}:${String(stats.size)}:${String(stats.mtimeNs)}:${String(stats.ctimeNs)}`
}

/**
 * The change time an identity names.
 * @param identity - the identity.
 * @returns its change time in nanoseconds.
 */
export function changeTimeOf(identity: string): bigint {
  return BigInt(identity.slice(identity.lastIndexOf(':') + 1))
}

/**
 * The file system of a directory when its change times can vouch for files under it: Linux, on a file system of
 * {@link TRUSTED_FILE_SYSTEMS}.
 * @param directory - the directory.
 * @returns the `statfs` type, or `undefined` on any other platform or file system, or when it cannot be read.
 */
export async function trustedFileSystem(directory: string): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const type = (await statfs(directory)).type >>> 0
    return TRUSTED_FILE_SYSTEMS.has(type) ? type : undefined
  } catch {
    // The file system cannot be named, so its change times vouch for nothing; the caller hashes every file.
    return undefined
  }
}

/**
 * Read an installation's record, refusing anything the store did not write: a link, a file that is not regular, larger
 * than its limit, owned by another user or readable by anyone else, text that is not JSON, and JSON that is not
 * exactly a record.
 * @param path - the record's path.
 * @returns the record, or `undefined` when it is missing or refused; the caller then hashes every file.
 */
export async function readIdentityRecord(path: string): Promise<IdentityRecord | undefined> {
  let text: string
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > RECORD_MAX_BYTES || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) return undefined
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    // Missing, a link (ELOOP) or unreadable: the record vouches for nothing.
    return undefined
  }
  try {
    return parseRecord(JSON.parse(text))
  } catch {
    // Not JSON: the record vouches for nothing.
    return undefined
  }
}

/**
 * A parsed record, when the value is exactly one.
 * @param value - the parsed JSON.
 * @returns the record, or `undefined`.
 */
function parseRecord(value: unknown): IdentityRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'capturedAt,fileList,fileSystem,files,fullCheckAt,manifest,platform,rootInode,schema,version') return undefined
  const { schema, version, platform, fileList, manifest, rootInode, fileSystem, capturedAt, fullCheckAt, files } = record
  if (schema !== IDENTITY_SCHEMA || typeof version !== 'string' || typeof platform !== 'string') return undefined
  if (!isDigest(fileList) || !isDigest(manifest) || typeof rootInode !== 'string' || !DIGITS.test(rootInode)) return undefined
  if (!isWhole(fileSystem) || !isWhole(capturedAt) || !isWhole(fullCheckAt) || !Array.isArray(files)) return undefined
  if (!files.every((entry: unknown) => entry === null || (typeof entry === 'string' && IDENTITY.test(entry)))) return undefined
  return { version, platform, fileList, manifest, rootInode, fileSystem, capturedAt, fullCheckAt, files: files as (string | null)[] }
}

/**
 * Whether a value is a lowercase hex SHA-256.
 * @param value - the value.
 * @returns true when it is.
 */
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

/**
 * Whether a value is a non-negative safe integer.
 * @param value - the value.
 * @returns true when it is.
 */
function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Whether a record describes exactly this installation of this release.
 * @param record - the record.
 * @param binding - the version, platform, digests, root inode, file system and list length it must name.
 * @returns true when every one matches.
 */
export function recordBound(record: IdentityRecord, binding: RecordBinding): boolean {
  return record.version === String(binding.version)
    && record.platform === binding.platform
    && record.fileList === binding.fileList
    && record.manifest === binding.manifest
    && record.rootInode === binding.rootInode
    && record.fileSystem === binding.fileSystem
    && record.files.length === binding.length
}

/**
 * Whether the pass that hashes every file is due: the interval has passed since the last one, or the clock reads
 * earlier than the last full pass or the record's capture time, either of which a clock set back leaves ahead of it.
 * @param record - the record.
 * @param now - the clock, in milliseconds since the epoch.
 * @param days - the interval in whole days; 0 makes it due at every start.
 * @returns true when the start hashes every file.
 */
export function fullCheckDue(record: IdentityRecord, now: number, days: number): boolean {
  return now < Math.max(record.fullCheckAt, record.capturedAt) || now - record.fullCheckAt >= days * 86_400_000
}

/**
 * The record's file contents.
 * @param record - the record.
 * @returns its JSON text with one newline.
 */
export function recordText(record: IdentityRecord): string {
  const { version, platform, fileList, manifest, rootInode, fileSystem, capturedAt, fullCheckAt, files } = record
  return `${JSON.stringify({ schema: IDENTITY_SCHEMA, version, platform, fileList, manifest, rootInode, fileSystem, capturedAt, fullCheckAt, files })}\n`
}
