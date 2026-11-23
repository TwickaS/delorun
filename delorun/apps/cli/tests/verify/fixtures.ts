/**
 * Fixtures of the `delorun verify` specs: a Delorun home with a release installed through the runtime store, its trusted
 * root, a fresh timestamp and the release-log bundle of its manifest, over throwaway keys generated in the test; a
 * fixture release log whose entry, inclusion proof and witnessed checkpoint are computed locally; and a `fetch` that
 * answers as that log's tlog-tiles API. No spec reaches the network, and no key here is a real one.
 */
import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DELORUN_HOME_ENTRIES, TRUST_FILES, type RuntimeVersion } from '@delorun/contract-home-layout'
import { RELEASE_CHANNELS, RELEASE_SCHEMAS, TIMESTAMP_LIFETIME_SECONDS, type RootMetadata, type SemanticVersion, type Sha256Hex, type TimestampMetadata, type UtcTimestamp } from '@delorun/contract-release-manifest'
import { publicKeyEntry, signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { logEndpoints } from '@delorun/release-verify'
import { RuntimeStore } from '@delorun/runtime-store'
import { COSIGNED_AT, entryBody, FixtureLog, FixtureTiles, FixtureWitness } from '../../../../packages/release-verify/tests/fixtures.ts'
import { closureFiles, makeWritable, PLATFORM, RecordingLogger, releaseFiles, throwawayKeys, writeClosure, type Keys } from '../../../../packages/runtime-store/tests/support.ts'

export { COSIGNED_AT, makeWritable, PLATFORM }

/** The release every fixture installs. */
export const RELEASE = '0.1.0'

/** The clock of a run: a minute after the fixture checkpoint's cosignature, inside the timestamp's lifetime. */
export const NOW = COSIGNED_AT + 60

/**
 * The time text C2's metadata carries.
 * @param seconds - Unix seconds.
 * @returns RFC 3339 UTC, to the second.
 */
function utc(seconds: number): UtcTimestamp {
  return brandString<UtcTimestamp>(new Date(seconds * 1000).toISOString().replace('.000Z', 'Z'))
}

/**
 * A file's SHA-256.
 * @param bytes - the file.
 * @returns lowercase hex.
 */
export function sha256(bytes: Uint8Array): Sha256Hex {
  return brandString<Sha256Hex>(createHash('sha256').update(bytes).digest('hex'))
}

/**
 * A signed C2 file.
 * @param signed - the content.
 * @param key - the signing key.
 * @returns the file's bytes.
 */
export function signed(signed: object, key: KeyObject): Buffer {
  return Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [key]), undefined, 2)}\n`)
}

/** A home with one installed release and everything its checks read. */
export interface InstalledHome {
  /** The home's path. */
  readonly home: string
  /** The role keys. */
  readonly keys: Keys
  /** The release log the root names. */
  readonly log: FixtureLog
  /** The witness the root lists. */
  readonly witness: FixtureWitness
  /** The trusted root's content. */
  readonly root: RootMetadata
  /** The trusted root's file. */
  readonly rootBytes: Buffer
  /** The installed manifest's bytes. */
  readonly manifest: Buffer
  /** The log entry's index. */
  readonly index: number
  /** The log's tlog-tiles API, serving the log's latest cosigned checkpoint. */
  readonly tiles: FixtureTiles
  /** The store's paths. */
  readonly store: RuntimeStore
  /** The launcher's `roots/` directory, holding the root the home stored. */
  readonly launcherRoots: string
}

/**
 * The trusted root over the role keys, naming the fixture log and witness, with the targets key as its one Ed25519ph
 * log-entry key.
 * @param keys - the role keys.
 * @param log - the log.
 * @param witness - the witness.
 * @returns the root's content.
 */
function rootMetadata(keys: Keys, log: FixtureLog, witness: FixtureWitness): RootMetadata {
  const all = [keys.root, keys.targets, keys.timestamp, keys.catalogue].map(publicKeyEntry)
  const [root, targets, timestamp, catalogue] = all.map(entry => entry.keyid)
  return {
    schema: RELEASE_SCHEMAS.root,
    version: 1,
    issued: brandString<UtcTimestamp>('2026-11-01T00:00:00Z'),
    expires: brandString<UtcTimestamp>('2027-10-01T00:00:00Z'),
    keys: Object.fromEntries(all.map(entry => [entry.keyid, entry.entry])),
    roles: {
      root: { keyids: [root!], threshold: 1 },
      targets: { keys: [{ keyid: targets!, status: 'active' }], threshold: 1 },
      timestamp: { keyids: [timestamp!], threshold: 1 },
      catalogue: { keyids: [catalogue!], threshold: 1 },
    },
    log: { origin: log.origin, vkey: log.vkey },
    logs: [{ origin: log.origin, vkey: log.vkey }],
    witnesses: { keys: [{ name: witness.name, vkey: witness.vkey }], threshold: 1 },
    logEntryKeys: [{ keyDetails: 'PKIX_ED25519_PH', public: createPublicKey(keys.targets).export({ format: 'der', type: 'spki' }).toString('base64'), status: 'active' }],
  }
}

/**
 * The timestamp a home stores after it verified one: issued an hour before {@link NOW}, naming the root and the
 * release's manifest on every channel.
 * @param fixture - the home's keys, root and manifest.
 * @param issued - when it was issued, in Unix seconds.
 * @returns the timestamp file.
 */
export function timestampFile(fixture: Pick<InstalledHome, 'keys' | 'rootBytes' | 'manifest'>, issued: number = NOW - 3600): Buffer {
  const pointer = { release: brandString<SemanticVersion>(RELEASE), manifest: { name: `delorun-${RELEASE}.manifest.json`, length: fixture.manifest.byteLength, sha256: sha256(fixture.manifest) } }
  const timestamp: TimestampMetadata = {
    schema: RELEASE_SCHEMAS.timestamp,
    version: 1,
    issued: utc(issued),
    expires: utc(issued + TIMESTAMP_LIFETIME_SECONDS),
    root: { version: 1, sha256: sha256(fixture.rootBytes) },
    channels: Object.fromEntries(RELEASE_CHANNELS.map(channel => [channel, pointer])) as TimestampMetadata['channels'],
  }
  return signed(timestamp, fixture.keys.timestamp)
}

/**
 * Write a file under the home's `trust/` at mode 0600.
 * @param home - the home.
 * @param name - the file's name.
 * @param bytes - its bytes.
 */
export function writeTrustFile(home: string, name: string, bytes: Uint8Array): void {
  const path = join(home, DELORUN_HOME_ENTRIES.trust, name)
  writeFileSync(path, bytes, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/**
 * A new home with release {@link RELEASE} installed through the runtime store: the trusted root and a fresh timestamp
 * under `trust/`, and the manifest, file list and release-log bundle beside the installation.
 * @returns the home and what built it.
 */
export async function installedHome(): Promise<InstalledHome> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-verify-')))
  const home = join(base, '.delorun')
  const launcherRoots = join(base, 'launcher', 'roots')
  mkdirSync(join(home, DELORUN_HOME_ENTRIES.trust), { recursive: true, mode: 0o700 })
  const keys = throwawayKeys()
  const log = new FixtureLog()
  const witness = new FixtureWitness()
  const root = rootMetadata(keys, log, witness)
  const rootBytes = signed(root, keys.root)
  const files = closureFiles(RELEASE)
  const release = releaseFiles(keys.targets, RELEASE, files)
  const manifest = Buffer.from(release.manifest)
  log.append(Buffer.from('an earlier entry'))
  const index = log.append(entryBody({ manifest, signer: keys.targets }))
  log.append(Buffer.from('a later entry'))
  const bundle = log.bundle(index, `delorun-${RELEASE}.manifest.json`, sha256(manifest), witness.cosign(log.checkpoint(), COSIGNED_AT))
  writeTrustFile(home, TRUST_FILES.root, rootBytes)
  mkdirSync(launcherRoots, { recursive: true })
  writeFileSync(join(launcherRoots, '1.root.json'), rootBytes)
  writeTrustFile(home, TRUST_FILES.timestamp, timestampFile({ keys, rootBytes, manifest }))
  const store = new RuntimeStore({ home, platform: PLATFORM, logger: new RecordingLogger() })
  await store.install({
    version: brandString<RuntimeVersion>(RELEASE),
    root,
    fill: async (directory) => {
      writeClosure(directory, files)
      return { ...release, bundle: Buffer.from(JSON.stringify(bundle)) }
    },
  })
  const tiles = new FixtureTiles(logEndpoints(root).tiles, log.leafHashes)
  tiles.note = witness.cosign(log.checkpoint(), COSIGNED_AT)
  return { home, keys, log, witness, root, rootBytes, manifest, index, tiles, store, launcherRoots }
}
