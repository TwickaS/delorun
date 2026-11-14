/**
 * What the launcher remembers between installs, under contract C1's `trust/`: the newest root that verified, the chain
 * an install walked to it, and the newest timestamp that verified. Contract C2 refuses a lower timestamp version than
 * the stored one, so these files are the rollback protection of the release metadata. The release log's checkpoint and
 * check state are `@delorun/release-verify`'s records, in the one format that package reads and writes. Every file here is
 * a protected file: written at mode 0600 through a temporary file, and refused by `@delorun/home` when it is a link,
 * another user's or laxer than 0600.
 *
 * @module @delorun/install/state
 */
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DELORUN_HOME_ENTRIES, PRIVATE_DIR_MODE, ROOT_FILE_NAME_PATTERN, TRUST_FILES, TRUST_ROOTS_DIRECTORY } from '@delorun/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delorun/home'
import { readRoot } from '@delorun/release-formats/sign/verify'
import { z } from 'zod'
import { InstallError, messageOf } from './errors.ts'

/** The newest timestamp a client verified: its version and its bytes, which an equal version must repeat. */
export interface StoredTimestamp {
  /** The highest timestamp version verified. */
  readonly version: number
  /** That timestamp file's bytes. */
  readonly bytes: Uint8Array
}

/**
 * The path of one of `trust/`'s files.
 * @param home - the resolved Delorun home.
 * @param name - the file's name in `trust/`.
 * @returns the absolute path.
 */
export function trustFile(home: string, name: (typeof TRUST_FILES)[keyof typeof TRUST_FILES]): string {
  return join(home, DELORUN_HOME_ENTRIES.trust, name)
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
 * @param home - the resolved Delorun home.
 * @param name - the file's name in `trust/`.
 * @param bytes - what to write.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the write fails.
 */
async function writeTrustFile(home: string, name: (typeof TRUST_FILES)[keyof typeof TRUST_FILES], bytes: Uint8Array): Promise<void> {
  const path = trustFile(home, name)
  try {
    await mkdir(join(home, DELORUN_HOME_ENTRIES.trust), { recursive: true, mode: PRIVATE_DIR_MODE })
    await writeProtectedFile(path, bytes)
  } catch (error) {
    throw new InstallError('TRUST_STATE_INVALID', path, `the trust file cannot be written: ${messageOf(error)}`, { cause: error })
  }
}

/**
 * Read the newest verified timestamp.
 * @param home - the resolved Delorun home.
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
 * @param home - the resolved Delorun home.
 * @param bytes - the verified timestamp file's bytes.
 */
export async function writeStoredTimestamp(home: string, bytes: Uint8Array): Promise<void> {
  await writeTrustFile(home, TRUST_FILES.timestamp, bytes)
}

/**
 * Read the newest trusted root's file, `trust/root.json`, which a start check anchors on.
 * @param home - the resolved Delorun home.
 * @returns its bytes, or `undefined` when no root was stored.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the file is a link, belongs to another user or is laxer than 0600.
 */
export async function readStoredRootBytes(home: string): Promise<Uint8Array | undefined> {
  return readTrustFile(trustFile(home, TRUST_FILES.root))
}

/**
 * Store the newest trusted root, `trust/root.json`, which the runtime store's start check reads (contract C1).
 * @param home - the resolved Delorun home.
 * @param bytes - the newest root file's bytes, as verified.
 */
export async function writeTrustedRoot(home: string, bytes: Uint8Array): Promise<void> {
  await writeTrustFile(home, TRUST_FILES.root, bytes)
}

/** The directory under `trust/` that holds the chain an install walked, `trust/roots/<n>.root.json`. */
const TRUST_ROOTS = (home: string): string => join(home, DELORUN_HOME_ENTRIES.trust, TRUST_ROOTS_DIRECTORY)

/** One filed root's name: `<n>.root.json`, where `n` is its version. */
const ROOT_FILE_NAME = new RegExp(ROOT_FILE_NAME_PATTERN, 'u')

/**
 * The path of one root of the chain an install walked.
 * @param home - the resolved Delorun home.
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
 * @param home - the resolved Delorun home.
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
 * @param home - the resolved Delorun home.
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

/** The hosts an `http:` build origin may name: this machine only. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/**
 * Check a build origin: an origin with no path, query or fragment, over `https:`, or over `http:` for this machine's
 * loopback address so a local channel and log can serve a build.
 * @param origin - the origin a build passes.
 * @param what - what the origin is, for the refusal.
 * @returns the origin without a trailing slash.
 * @throws {Error} naming the origin and the rule it breaks.
 */
export function buildOrigin(origin: string, what: string): string {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    // The URL constructor's own message names no origin, so the refusal below is the one reported.
    throw new Error(`the ${what} ${JSON.stringify(origin)} is not a URL`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error(`the ${what} ${origin} must be an origin: a scheme, a host and a port, with no path, query, fragment or credentials`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))) {
    throw new Error(`the ${what} ${origin} must use https, or http on this machine's loopback address`)
  }
  return url.origin
}

/**
 * Where a home's releases come from: the origins the launcher that installed its runtime was built with. An absent
 * field is the production value, contract C2's publication and the log the trusted root names.
 */
export interface ChannelOrigins {
  /** The origin that serves `timestamp.json`, `root/<n>.root.json` and `releases/download/v<version>/<file>`. */
  readonly channelOrigin?: string
  /** The log's `tlog-tiles` origin. */
  readonly logOrigin?: string
}

const channelRecord = z.strictObject({
  v: z.literal(1),
  channelOrigin: z.string().min(1).optional(),
  logOrigin: z.string().min(1).optional(),
})

/**
 * Read the release channel this home updates from, `trust/channel.json`. Delorun writes it only from a launcher, when it
 * installs a runtime. The sandbox keeps confined commands from writing under `trust/`; an unconfined process of the same
 * user, a Host plugin included, can write it as it can any file of the home, so it decides only where releases are
 * fetched from, never which releases verify.
 * @param home - the resolved Delorun home.
 * @returns the recorded origins; `undefined` when no launcher recorded any, which means the production channel.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the file is a link, belongs to another user, is laxer than 0600, is
 *   not a channel record, or names an origin {@link buildOrigin} refuses.
 */
export async function readChannelRecord(home: string): Promise<ChannelOrigins | undefined> {
  const path = trustFile(home, TRUST_FILES.channel)
  const bytes = await readTrustFile(path)
  if (bytes === undefined) return undefined
  let parsed: z.output<typeof channelRecord>
  try {
    parsed = channelRecord.parse(JSON.parse(bytes.toString('utf8')))
    if (parsed.channelOrigin !== undefined) buildOrigin(parsed.channelOrigin, 'channel origin')
    if (parsed.logOrigin !== undefined) buildOrigin(parsed.logOrigin, 'log origin')
  } catch (error) {
    throw new InstallError('TRUST_STATE_INVALID', path, `the recorded release channel is not a channel record: ${messageOf(error)}`, { cause: error })
  }
  return { ...parsed.channelOrigin === undefined ? {} : { channelOrigin: parsed.channelOrigin }, ...parsed.logOrigin === undefined ? {} : { logOrigin: parsed.logOrigin } }
}

/**
 * Record the release channel a launcher installed this home's runtime from, `trust/channel.json`, at mode 0600.
 * @param home - the resolved Delorun home.
 * @param origins - the launcher's build origins; an empty object for the production channel.
 */
export async function writeChannelRecord(home: string, origins: ChannelOrigins): Promise<void> {
  await writeTrustFile(home, TRUST_FILES.channel, Buffer.from(`${JSON.stringify({ v: 1, ...origins })}\n`, 'utf8'))
}
