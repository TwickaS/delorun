/**
 * A complete fixture release for the install path's specs: throwaway Ed25519 keys for every role, the signed root,
 * timestamp, release manifest and runtime file list, a runtime archive built by the release tooling's deterministic
 * writer, a release-log bundle over the manifest with a witnessed checkpoint, and a stand-in log and file server so
 * nothing reaches the network. Every key is generated in the spec and removed with its temporary directory.
 *
 * @module @delorun/install/tests/support
 */
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brandString } from '@deepseek-ai/dsh-brand'
import { TIMESTAMP_LIFETIME_SECONDS, RELEASE_SCHEMAS, RUNTIME_PLATFORMS, type DesktopFileRef, type FileRef, type NpmIntegrity, type OciDigest, type ReleaseManifest, type RootMetadata, type RuntimeFileList, type RuntimePlatform, type Sha256Hex, type Sha512Base64, type SemanticVersion, type TimestampMetadata, type UtcTimestamp } from '@delorun/contract-release-manifest'
import { gzip } from '@delorun/release-formats/archive/bytes'
import type { ArchiveEntry } from '@delorun/release-formats/archive/entry'
import { tarStream } from '@delorun/release-formats/archive/tar'
import { entryBody, entryRequest } from '@delorun/release-formats/log/entry'
import type { LogEntrySigner } from '@delorun/release-formats/log/entry-keys'
import { inclusionProof, leafHash, treeRoot } from '@delorun/release-formats/log/merkle'
import { checkpointBody, NOTE_COSIGNATURE, NOTE_ED25519, signatureLine, verifierKey } from '@delorun/release-formats/log/note'
import { publicKeyEntry, signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import type { ReleaseLogBundle } from '@delorun/contract-release-log'
import { LogUnreachableError, type ReleaseLogTransport } from '@delorun/release-verify/online'

/** The fixture release's version. */
export const VERSION = '0.1.0'

/** The fixture's clock: 2027-01-15T08:00:00Z, in Unix seconds. */
export const NOW = 1_800_000_000

/** The archive's entry mtime, as contract C2's deterministic archives set it. */
const EPOCH = 1_795_000_000

/** The fixture root's issue time. */
const ROOT_ISSUED = '2027-01-01T00:00:00Z'

/** The fixture root's expiry. */
const ROOT_EXPIRES = '2027-12-01T00:00:00Z'

const utc = (text: string): UtcTimestamp => brandString<UtcTimestamp>(text)
const version = (text: string): SemanticVersion => brandString<SemanticVersion>(text)
const digest = (text: string): Sha256Hex => brandString<Sha256Hex>(text)

/** Throwaway keys for every role and for the log and its witness. */
export interface FixtureKeys {
  readonly root: KeyObject
  readonly targets: KeyObject
  readonly timestamp: KeyObject
  readonly catalogue: KeyObject
  readonly log: KeyObject
  readonly witness: KeyObject
}

/**
 * New throwaway Ed25519 keys.
 * @returns one private key per role.
 */
export function fixtureKeys(): FixtureKeys {
  const key = (): KeyObject => generateKeyPairSync('ed25519').privateKey
  return { root: key(), targets: key(), timestamp: key(), catalogue: key(), log: key(), witness: key() }
}

/** The log's origin line and key name. */
export const LOG_ORIGIN = 'log.example.test'

/** The witness's key name. */
export const WITNESS_NAME = 'witness.example.test'

/**
 * The SHA-256 of a byte string, as a file reference holds it.
 * @param bytes - the bytes.
 * @returns the digest.
 */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * A file reference for some bytes.
 * @param name - the file's name.
 * @param bytes - its bytes.
 * @returns the reference.
 */
export function fileRef(name: string, bytes: Uint8Array): FileRef {
  return { name, length: bytes.byteLength, sha256: digest(sha256(bytes)) }
}

/**
 * Sign a content object into a release envelope.
 * @param signed - the content.
 * @param keys - the signing keys.
 * @returns the envelope's file bytes.
 */
export function envelope(signed: object, keys: readonly KeyObject[]): Buffer {
  const signedJson = toJsonValue(signed)
  return Buffer.from(`${JSON.stringify(signEnvelope({ signed: signedJson, signatures: [] }, keys), undefined, 2)}\n`)
}

/** The parts a fixture release is built from, so a spec can tamper with one of them. */
export interface Fixture {
  readonly keys: FixtureKeys
  readonly platform: RuntimePlatform
  readonly entries: readonly ArchiveEntry[]
  readonly archive: Buffer
  readonly files: RuntimeFileList
  readonly filesBytes: Buffer
  readonly manifest: ReleaseManifest
  /** The release notes the manifest names, when it names any. */
  readonly notesBytes?: Buffer
  readonly manifestBytes: Buffer
  readonly rootMetadata: RootMetadata
  readonly roots: readonly Uint8Array[]
  readonly timestamp: TimestampMetadata
  readonly timestampBytes: Buffer
  readonly bundle: ReleaseLogBundle
  readonly bundleBytes: Buffer
  /** The latest checkpoint the log serves at this tree size, with its witness cosignature. */
  readonly checkpoint: string
  /** The leaves the log holds: this release's entry. */
  readonly leaves: readonly Buffer[]
}

/** What a fixture may change. */
export interface FixtureOptions {
  /** The platform the archive and the file list describe; `linux-x64` by default. */
  readonly platform?: RuntimePlatform
  /** The keys that sign the manifest; the targets key by default. */
  readonly manifestSigners?: readonly KeyObject[]
  /** The targets keys the root lists, with their status; one active targets key by default. */
  readonly targets?: (keys: FixtureKeys) => RootMetadata['roles']['targets']
  /** The timestamp's version; 1 by default. */
  readonly timestampVersion?: number
  /** The timestamp's issue time; an hour before {@link NOW}. */
  readonly timestampIssued?: number
  /** The keys that cosign the checkpoint; the listed witness by default. */
  readonly cosigners?: (keys: FixtureKeys) => readonly { readonly name: string, readonly key: KeyObject }[]
  /** A release manifest to bundle instead of this one, for the entry for another manifest. */
  readonly bundleOver?: { readonly manifest: Uint8Array }
  /** Whether the inclusion proof is corrupted; false by default. */
  readonly tamperInclusion?: boolean
  /** The version the release carries; {@link VERSION} by default. */
  readonly version?: string
  /** The platforms the manifest publishes a runtime for; every platform by default. */
  readonly released?: readonly RuntimePlatform[]
  /** The upstream version the manifest names; `0.2.2` by default. */
  readonly dsh?: string
  /** The security mark and summary the manifest carries; neither by default, as in a manifest signed before they existed. */
  readonly notice?: { readonly security: boolean, readonly summary: string }
  /** The release notes the manifest names and the fixture serves; none by default. */
  readonly notes?: Buffer
  /** The keys to sign with, such as an earlier fixture's, so a home that trusts that fixture's root trusts this release; fresh keys by default. */
  readonly keys?: FixtureKeys
  /** The builder the manifest's rebuild names; the targets-key holder by default. */
  readonly builder?: string
  /** The key that signs the log entry, with its entry key type; an Ed25519ph entry by the targets key by default. */
  readonly entrySigner?: (keys: FixtureKeys) => LogEntrySigner
  /** The log-entry keys and logs the root lists, in place of the targets key as its one Ed25519ph key and its log. */
  readonly rootExtra?: (keys: FixtureKeys) => Pick<RootMetadata, 'logEntryKeys' | 'logs'>
  /** Leave `logEntryKeys` and `logs` out of the root, as `1.root.json` does, so no release verifies under it. */
  readonly bareRoot?: boolean
}

/**
 * Build one fixture release.
 * @param options - what the release changes from the default.
 * @returns every part of the release, signed.
 */
export async function fixtureRelease(options: FixtureOptions = {}): Promise<Fixture> {
  const keys = options.keys ?? fixtureKeys()
  const platform = options.platform ?? 'linux-x64'
  const releaseVersion = options.version ?? VERSION
  const entries: ArchiveEntry[] = [
    { path: 'app/node_modules/@delorun/cli/src/bin.js', mode: '0644', data: Buffer.from('// the runtime entry\n') },
    { path: 'app/package.json', mode: '0644', data: Buffer.from('{"name":"@delorun/runtime-closure"}\n') },
    { path: 'node/bin/node', mode: '0755', data: Buffer.from('#!/bin/sh\nexit 0\n') },
  ]
  const archive = await tarGz(entries)
  const files: RuntimeFileList = {
    schema: RELEASE_SCHEMAS.files,
    version: version(releaseVersion),
    platform,
    files: entries.map(entry => ({ path: entry.path, length: entry.data.byteLength, sha256: digest(sha256(entry.data)), mode: entry.mode })),
  }
  const filesBytes = envelope(files, [keys.targets])
  const archiveRef = fileRef(`delorun-${releaseVersion}-${platform}.tar.gz`, archive)
  const filesRef = fileRef(`delorun-${releaseVersion}-${platform}.files.json`, filesBytes)
  const zeros = digest('0'.repeat(64))
  const dummy = (name: string): FileRef => ({ name, length: 1, sha256: zeros })
  const desktopFile = (name: string): DesktopFileRef => ({ name, length: 1, sha256: zeros, sha512: brandString<Sha512Base64>(`${'A'.repeat(86)}==`) })
  const artifacts = (entry: RuntimePlatform): { readonly archive: FileRef, readonly files: FileRef } => entry === platform
    ? { archive: archiveRef, files: filesRef }
    : { archive: dummy(`delorun-${releaseVersion}-${entry}.tar.gz`), files: dummy(`delorun-${releaseVersion}-${entry}.files.json`) }
  const manifest: ReleaseManifest = {
    schema: RELEASE_SCHEMAS.manifest,
    version: version(releaseVersion),
    dsh: version(options.dsh ?? '0.2.2'),
    channel: 'stable',
    source: { repository: 'https://github.com/twickas/delorun', tag: `v${releaseVersion}`, commit: 'a'.repeat(40) },
    published: utc('2027-01-01T00:00:00Z'),
    runtime: Object.fromEntries((options.released ?? RUNTIME_PLATFORMS).map(entry => [entry, artifacts(entry)])),
    desktop: {
      'mac-arm64': { installer: desktopFile('Delorun-0.1.0-mac-arm64.dmg'), update: desktopFile('Delorun-0.1.0-mac-arm64.zip'), blockmap: dummy('Delorun-0.1.0-mac-arm64.dmg.blockmap') },
      'mac-x64': { installer: desktopFile('Delorun-0.1.0-mac-x64.dmg'), update: desktopFile('Delorun-0.1.0-mac-x64.zip'), blockmap: dummy('Delorun-0.1.0-mac-x64.dmg.blockmap') },
      'win-x64': { installer: desktopFile('Delorun-0.1.0-win-x64.exe'), update: desktopFile('Delorun-0.1.0-win-x64.exe'), blockmap: dummy('Delorun-0.1.0-win-x64.exe.blockmap') },
    },
    images: { s2: image(), s3: image() },
    sbom: { ...dummy(`delorun-${releaseVersion}.spdx.json`), format: 'SPDX-2.3+json' },
    npm: [{ name: 'delorun', version: version(releaseVersion), integrity: brandString<NpmIntegrity>(`sha512-${'A'.repeat(86)}==`) }],
    install: { sh: dummy('install.sh'), ps1: dummy('install.ps1') },
    rebuild: { record: dummy(`delorun-${releaseVersion}.rebuild.json`), builders: [{ name: options.builder ?? 'the targets-key holder', ci: false }] },
    advisories: { report: dummy(`delorun-${releaseVersion}.advisories.json`), accepted: [] },
    ...options.notice,
    ...options.notes === undefined ? {} : { notes: fileRef(`delorun-${releaseVersion}.notes.txt`, options.notes) },
  }
  const manifestBytes = envelope(manifest, options.manifestSigners ?? [keys.targets])
  const bundledManifest = options.bundleOver?.manifest ?? manifestBytes
  const signer = options.entrySigner?.(keys) ?? { keyDetails: 'PKIX_ED25519_PH', key: keys.targets }
  const body = entryBody(entryRequest(bundledManifest, signer.key, signer.keyDetails))
  const leaves = [leafHash(body)]
  const rootMetadata = rootMetadataFor(keys, options)
  const cosigners = options.cosigners?.(keys) ?? [{ name: WITNESS_NAME, key: keys.witness }]
  const cpBody = checkpointBody(LOG_ORIGIN, leaves.length, treeRoot(leaves))
  let checkpoint = `${cpBody}\n${signatureLine(LOG_ORIGIN, keys.log, cpBody)}`
  for (const cosigner of cosigners) checkpoint += signatureLine(cosigner.name, cosigner.key, cpBody, NOW - 60)
  const bundle: ReleaseLogBundle = {
    schema: 'delorun.release-log-bundle/1',
    manifest: { name: `delorun-${releaseVersion}.manifest.json`, sha256: brandString<Sha256Hex>(sha256(bundledManifest)) },
    entry: { logIndex: 0, integratedTime: 0, body: body.toString('base64') },
    inclusion: {
      logIndex: 0,
      treeSize: leaves.length,
      rootHash: options.tamperInclusion === true ? 'b'.repeat(64) : treeRoot(leaves).toString('hex'),
      hashes: inclusionProof(0, leaves).map(hash => hash.toString('hex')),
    },
    checkpoint,
  }
  const issued = options.timestampIssued ?? NOW - 3600
  const timestamp: TimestampMetadata = {
    schema: RELEASE_SCHEMAS.timestamp,
    version: options.timestampVersion ?? 1,
    issued: utc(new Date(issued * 1000).toISOString().replace('.000Z', 'Z')),
    expires: utc(new Date((issued + TIMESTAMP_LIFETIME_SECONDS) * 1000).toISOString().replace('.000Z', 'Z')),
    root: { version: rootMetadata.version, sha256: digest(sha256(envelope(rootMetadata, [keys.root]))) },
    channels: {
      stable: { release: version(releaseVersion), manifest: fileRef(`delorun-${releaseVersion}.manifest.json`, manifestBytes) },
      beta: { release: version(releaseVersion), manifest: fileRef(`delorun-${releaseVersion}.manifest.json`, manifestBytes) },
    },
  }
  return {
    keys,
    platform,
    entries,
    archive,
    files,
    filesBytes,
    manifest,
    manifestBytes,
    ...options.notes === undefined ? {} : { notesBytes: options.notes },
    rootMetadata,
    roots: [envelope(rootMetadata, [keys.root])],
    timestamp,
    timestampBytes: envelope(timestamp, [keys.timestamp]),
    bundle,
    bundleBytes: Buffer.from(`${JSON.stringify(bundle, undefined, 2)}\n`),
    checkpoint,
    leaves,
  }
}

/** An image reference the fixture manifest carries. */
function image(): NonNullable<ReleaseManifest['images']>['s2'] {
  return {
    repository: 'ghcr.io/twickas/s2',
    index: brandString<OciDigest>(`sha256:${'c'.repeat(64)}`),
    platforms: { 'linux/amd64': brandString<OciDigest>(`sha256:${'d'.repeat(64)}`), 'linux/arm64': brandString<OciDigest>(`sha256:${'e'.repeat(64)}`) },
  }
}

/**
 * Root metadata over the fixture's keys.
 * @param keys - the role keys.
 * @param options - what the root changes, such as its targets keys.
 * @returns the root metadata.
 */
export function rootMetadataFor(keys: FixtureKeys, options: FixtureOptions = {}): RootMetadata {
  const entries = [keys.root, keys.targets, keys.timestamp, keys.catalogue].map(publicKeyEntry)
  const [root, targets, timestamp, catalogue] = entries.map(entry => entry.keyid)
  const log = { origin: LOG_ORIGIN, vkey: verifierKey(LOG_ORIGIN, NOTE_ED25519, keys.log) }
  const trust = options.bareRoot === true ? {} : { logs: [log], logEntryKeys: [{ keyDetails: 'PKIX_ED25519_PH', public: createPublicKey(keys.targets).export({ format: 'der', type: 'spki' }).toString('base64'), status: 'active' as const }] }
  return {
    schema: RELEASE_SCHEMAS.root,
    version: 1,
    issued: utc(ROOT_ISSUED),
    expires: utc(ROOT_EXPIRES),
    keys: Object.fromEntries(entries.map(entry => [entry.keyid, entry.entry])),
    roles: {
      root: { keyids: [root!], threshold: 1 },
      targets: options.targets?.(keys) ?? { keys: [{ keyid: targets!, status: 'active' }], threshold: 1 },
      timestamp: { keyids: [timestamp!], threshold: 1 },
      catalogue: { keyids: [catalogue!], threshold: 1 },
    },
    log,
    ...trust,
    ...options.rootExtra?.(keys),
    witnesses: { keys: [{ name: WITNESS_NAME, vkey: verifierKey(WITNESS_NAME, NOTE_COSIGNATURE, keys.witness) }], threshold: 1 },
  }
}

/**
 * A later root version, signed by the keys the contract requires.
 * @param previous - the root the client trusts now, whose log and witnesses the next version keeps.
 * @param keys - the next version's role keys; the same keys unless a rotation replaces them.
 * @param signers - the keys that sign it.
 * @param change - replaces fields of the next version, such as its log-entry keys; none by default.
 * @returns its file bytes.
 */
export function nextRoot(previous: RootMetadata, keys: FixtureKeys, signers: readonly KeyObject[], change: (next: RootMetadata) => RootMetadata = next => next): Buffer {
  const rotated = rootMetadataFor(keys)
  return envelope(change({ ...previous, version: previous.version + 1, keys: rotated.keys, roles: rotated.roles }), signers)
}

/**
 * The archive of a set of entries, in the release tooling's deterministic form.
 * @param entries - the entries.
 * @returns the `.tar.gz` bytes.
 */
export async function tarGz(entries: readonly ArchiveEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of gzip(tarStream([...entries], EPOCH))) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/**
 * The signed file list of a set of entries, exactly as the release tooling writes it.
 * @param entries - the archive's entries.
 * @returns the list.
 */
export function entryFileList(entries: readonly ArchiveEntry[]): RuntimeFileList {
  return {
    schema: RELEASE_SCHEMAS.files,
    version: brandString<SemanticVersion>(VERSION),
    platform: 'linux-x64',
    files: entries.map(entry => ({
      path: entry.path,
      length: entry.data.byteLength,
      sha256: brandString<Sha256Hex>(sha256(entry.data)),
      mode: entry.mode,
    })),
  }
}

/**
 * A bundle with one field replaced, for a spec that tampers with it.
 * @param fixture - the fixture release.
 * @param change - the fields to replace.
 * @returns the bundle's file bytes.
 */
export function bundleWith(fixture: Fixture, change: Partial<ReleaseLogBundle>): Buffer {
  return Buffer.from(`${JSON.stringify({ ...fixture.bundle, ...change }, undefined, 2)}\n`)
}

/**
 * A stand-in log that answers with the fixture's checkpoint and an empty consistency proof, which the same size
 * accepts.
 * @param checkpoint - the checkpoint note to serve.
 * @param proof - the consistency proof to serve; empty by default.
 * @returns the transport.
 */
export function logService(checkpoint: string, proof: readonly Uint8Array[] = []): ReleaseLogTransport {
  return {
    latestCheckpoint: () => Promise.resolve(checkpoint),
    consistencyProof: () => Promise.resolve(proof.map(hash => Buffer.from(hash).toString('hex'))),
  }
}

/**
 * A log that answers nothing, as an unreachable log does.
 * @returns the transport.
 */
export function unreachableLog(): ReleaseLogTransport {
  return {
    latestCheckpoint: () => Promise.reject(new LogUnreachableError('the log refused the connection')),
    consistencyProof: () => Promise.reject(new LogUnreachableError('the log refused the connection')),
  }
}

/** A stand-in file server and the paths a launcher's channel fetches. */
export interface StandIn {
  /** Its origin, `http://127.0.0.1:<port>`. */
  readonly origin: string
  /** What it serves, by path. */
  readonly files: Map<string, Buffer>
  /** The paths it was asked for, in order. */
  readonly requests: string[]
  /** Stop it. */
  close(): Promise<void>
}

/**
 * Serve a map of paths, adding to it after the server starts.
 * @param files - the paths and their bodies.
 * @returns the stand-in.
 */
export async function standIn(files: Map<string, Buffer> = new Map()): Promise<StandIn> {
  const requests: string[] = []
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/'
    requests.push(path)
    const body = files.get(path)
    if (body === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-length': String(body.byteLength), 'content-type': 'application/octet-stream' }).end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    files,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  }
}

/**
 * The paths a stand-in serves for a fixture release.
 * @param fixture - the release.
 * @returns the paths and their bodies.
 */
export function releasePaths(fixture: Fixture): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const name = String(fixture.manifest.version)
  files.set('/timestamp.json', fixture.timestampBytes)
  files.set('/root/1.root.json', Buffer.from(fixture.roots[0]!))
  files.set(`/releases/${name}/delorun-${name}.manifest.json`, fixture.manifestBytes)
  files.set(`/releases/${name}/delorun-${name}.manifest.log.json`, fixture.bundleBytes)
  files.set(`/releases/${name}/delorun-${name}-${fixture.platform}.tar.gz`, fixture.archive)
  files.set(`/releases/${name}/delorun-${name}-${fixture.platform}.files.json`, fixture.filesBytes)
  if (fixture.notesBytes !== undefined) files.set(`/releases/${name}/delorun-${name}.notes.txt`, fixture.notesBytes)
  return files
}
