/**
 * Fixtures of the runtime-store specs: throwaway Ed25519 keys and root metadata, a fixture runtime closure for one
 * platform, its signed manifest and file list, a home with the store's directories, and an installed store. Every key
 * is generated in the test, and every file lives in a temporary directory the spec removes.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DELORUN_HOME_ENTRIES, TRUST_FILES, type RuntimeVersion } from '@delorun/contract-home-layout'
import {
  DESKTOP_PLATFORMS,
  RELEASE_REPOSITORY_URL,
  RELEASE_SCHEMAS,
  RUNTIME_PLATFORMS,
  type FileRef,
  type ReleaseManifest,
  type RootMetadata,
  type RuntimeFileList,
  type RuntimePlatform,
  type SemanticVersion,
  type Sha256Hex,
  type UtcTimestamp,
} from '@delorun/contract-release-manifest'
import type { DelorunLogDetails, DelorunLogger } from '@delorun/logs'
import { publicKeyEntry, signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { RuntimeStore, type ReleaseFileBytes } from '../src/index.ts'

/** The platform every fixture uses. */
export const PLATFORM: RuntimePlatform = 'linux-x64'

/** The repository root, the working directory of fixture child processes. */
export const REPOSITORY = join(import.meta.dirname, '../../../..')

/**
 * A runtime version.
 * @param text - the version text.
 * @returns the branded version.
 */
export function version(text: string): RuntimeVersion {
  return brandString<RuntimeVersion>(text)
}

/** Throwaway keys of every role, plus a second targets key for rotation specs. */
export interface Keys {
  readonly root: KeyObject
  readonly targets: KeyObject
  readonly timestamp: KeyObject
  readonly catalogue: KeyObject
}

/**
 * New throwaway Ed25519 keys.
 * @returns the private keys.
 */
export function throwawayKeys(): Keys {
  const key = (): KeyObject => generateKeyPairSync('ed25519').privateKey
  return { root: key(), targets: key(), timestamp: key(), catalogue: key() }
}

/**
 * Root metadata over the keys, signed by the root key.
 * @param keys - the role keys.
 * @param targetsStatus - the targets key's status.
 * @param replacement - a targets key that becomes the active one, so the fixture key can be retired or revoked.
 * @returns the root's file bytes and content.
 */
export function rootFile(keys: Keys, targetsStatus: 'active' | 'revoked' = 'active', replacement?: KeyObject): { readonly bytes: Buffer, readonly metadata: RootMetadata } {
  const all = [keys.root, keys.targets, keys.timestamp, keys.catalogue, ...(replacement === undefined ? [] : [replacement])].map(publicKeyEntry)
  const [root, targets, timestamp, catalogue, next] = all.map(entry => entry.keyid)
  const metadata: RootMetadata = {
    schema: RELEASE_SCHEMAS.root,
    version: 1,
    issued: brandString<UtcTimestamp>('2026-11-01T00:00:00Z'),
    expires: brandString<UtcTimestamp>('2027-10-01T00:00:00Z'),
    keys: Object.fromEntries(all.map(entry => [entry.keyid, entry.entry])),
    roles: {
      root: { keyids: [root!], threshold: 1 },
      targets: { keys: [{ keyid: targets!, status: targetsStatus }, ...(next === undefined ? [] : [{ keyid: next, status: 'active' as const }])], threshold: 1 },
      timestamp: { keyids: [timestamp!], threshold: 1 },
      catalogue: { keyids: [catalogue!], threshold: 1 },
    },
    log: { origin: 'log.example.test/fixture', vkey: 'log.example.test/fixture+00000000+AQ==' },
    witnesses: { keys: [{ name: 'witness.example.test', vkey: 'witness.example.test+00000000+BA==' }], threshold: 1 },
  }
  const envelope = signEnvelope({ signed: toJsonValue(metadata), signatures: [] }, [keys.root])
  return { bytes: Buffer.from(`${JSON.stringify(envelope, undefined, 2)}\n`), metadata }
}

/** One file of a fixture closure. */
export interface FixtureFile {
  readonly content: string
  readonly executable?: boolean
}

/**
 * The files of a fixture closure: launch protocol 1's Node executable and entry file, and a few others.
 * @param marker - text that makes this version's files differ from another's.
 * @returns the files by relative path.
 */
export function closureFiles(marker: string): Record<string, FixtureFile> {
  return {
    'node/bin/node': { content: `#!/bin/sh\n# fixture node ${marker}\n`, executable: true },
    'node/LICENSE': { content: 'licence\n' },
    'app/package.json': { content: `{"name":"@delorun/runtime-closure","version":"${marker}"}\n` },
    'app/node_modules/@delorun/cli/src/bin.js': { content: `console.log('delorun ${marker}')\n` },
    'app/node_modules/@delorun/cli/package.json': { content: '{"name":"@delorun/cli"}\n' },
  }
}

/**
 * The lowercase hex SHA-256 of bytes.
 * @param bytes - the bytes.
 * @returns the digest.
 */
export function sha256(bytes: Uint8Array): Sha256Hex {
  return brandString<Sha256Hex>(createHash('sha256').update(bytes).digest('hex'))
}

function ref(name: string, bytes: Uint8Array): FileRef {
  return { name, length: bytes.byteLength, sha256: sha256(bytes) }
}

function sign<T extends object>(signed: T, key: KeyObject): Buffer {
  return Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [key]), undefined, 2)}\n`)
}

/**
 * Signed release files for a fixture closure: the platform's file list and a manifest that names it.
 * @param key - the targets key that signs both.
 * @param release - the version.
 * @param files - the closure's files.
 * @returns the manifest, file list and a placeholder log bundle.
 */
export function releaseFiles(key: KeyObject, release: string, files: Record<string, FixtureFile>): ReleaseFileBytes {
  return signedRelease(key, release, Object.entries(files).sort(([left], [right]) => (left < right ? -1 : 1)).map(([path, file]) => {
    const bytes = Buffer.from(file.content)
    return { path, length: bytes.byteLength, sha256: sha256(bytes), mode: file.executable === true ? '0755' : '0644' }
  }))
}

/**
 * Signed release files for a closure whose file list entries are already computed.
 * @param key - the targets key that signs both.
 * @param release - the version.
 * @param entries - the file list's entries, in their order.
 * @returns the manifest, file list and a placeholder log bundle.
 */
export function signedRelease(key: KeyObject, release: string, entries: RuntimeFileList['files']): ReleaseFileBytes {
  const semantic = brandString<SemanticVersion>(release)
  const list: RuntimeFileList = { schema: RELEASE_SCHEMAS.files, version: semantic, platform: PLATFORM, files: entries }
  const listBytes = sign(list, key)
  const placeholder = ref('placeholder', Buffer.from('placeholder'))
  const desktopRef = { ...placeholder, sha512: brandString<NonNullable<ReleaseManifest['desktop']>['mac-arm64']['installer']['sha512']>(`${'A'.repeat(86)}==`) }
  const oci = brandString<NonNullable<ReleaseManifest['images']>['s2']['index']>(`sha256:${'0'.repeat(64)}`)
  const image = { repository: 'ghcr.io/example/fixture', index: oci, platforms: { 'linux/amd64': oci, 'linux/arm64': oci } }
  const manifest: ReleaseManifest = {
    schema: RELEASE_SCHEMAS.manifest,
    version: semantic,
    dsh: brandString<SemanticVersion>('0.2.2'),
    channel: 'stable',
    source: { repository: RELEASE_REPOSITORY_URL, tag: `v${release}`, commit: 'a'.repeat(40) },
    published: brandString<UtcTimestamp>('2026-11-02T00:00:00Z'),
    runtime: Object.fromEntries(RUNTIME_PLATFORMS.map(platform => [platform, {
      archive: placeholder,
      files: platform === PLATFORM ? ref(`delorun-${release}-${platform}.files.json`, listBytes) : placeholder,
    }])) as ReleaseManifest['runtime'],
    desktop: Object.fromEntries(DESKTOP_PLATFORMS.map(platform => [platform, { installer: desktopRef, update: desktopRef, blockmap: placeholder }])) as NonNullable<ReleaseManifest['desktop']>,
    images: { s2: image, s3: image },
    sbom: { ...placeholder, format: 'SPDX-2.3+json' },
    npm: [],
    install: { sh: placeholder, ps1: placeholder },
    rebuild: { record: placeholder, builders: [{ name: 'fixture', ci: false }] },
    advisories: { report: placeholder, accepted: [] },
  }
  return { manifest: sign(manifest, key), files: listBytes, bundle: Buffer.from('{"fixture":"log bundle"}\n') }
}

/**
 * Write a fixture closure into a directory.
 * @param directory - the directory.
 * @param files - the files.
 */
export function writeClosure(directory: string, files: Record<string, FixtureFile>): void {
  for (const [path, file] of Object.entries(files)) {
    const target = join(directory, ...path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, { mode: file.executable === true ? 0o755 : 0o644 })
  }
}

/** A logger that keeps its records. */
export class RecordingLogger implements DelorunLogger {
  readonly records: Array<{ readonly level: string, readonly msg: string, readonly details: DelorunLogDetails | undefined }> = []
  error(msg: string, details?: DelorunLogDetails): void {
    this.records.push({ level: 'error', msg, details })
  }

  warn(msg: string, details?: DelorunLogDetails): void {
    this.records.push({ level: 'warn', msg, details })
  }

  info(msg: string, details?: DelorunLogDetails): void {
    this.records.push({ level: 'info', msg, details })
  }

  debug(msg: string, details?: DelorunLogDetails): void {
    this.records.push({ level: 'debug', msg, details })
  }
}

/** A temporary home with the store's directories. */
export interface FixtureHome {
  /** The home. */
  readonly home: string
  /** The keys that sign its releases. */
  readonly keys: Keys
  /** The root over those keys. */
  readonly root: RootMetadata
  /** The store. */
  readonly store: RuntimeStore
  /** The store's logger. */
  readonly logger: RecordingLogger
  /** Install a fixture version through the store, as an installer would after downloading it. */
  readonly install: (release: string, files?: Record<string, FixtureFile>) => Promise<void>
  /** Remove the home. */
  readonly remove: () => void
}

/**
 * A new temporary home with `runtimes/` and `staging/`.
 * @returns the fixture.
 */
export function fixtureHome(): FixtureHome {
  const home = mkdtempSync(join(tmpdir(), 'delorun-store-'))
  chmodSync(home, 0o700)
  for (const entry of [DELORUN_HOME_ENTRIES.runtimes, DELORUN_HOME_ENTRIES.staging, DELORUN_HOME_ENTRIES.trust]) mkdirSync(join(home, entry), { mode: 0o700 })
  const keys = throwawayKeys()
  const root = rootFile(keys)
  writeFileSync(join(home, DELORUN_HOME_ENTRIES.trust, TRUST_FILES.root), root.bytes, { mode: 0o600 })
  const logger = new RecordingLogger()
  const store = new RuntimeStore({ home, platform: PLATFORM, logger })
  return {
    home,
    keys,
    root: root.metadata,
    store,
    logger,
    install: async (release, files = closureFiles(release)) => {
      await store.install({
        version: version(release),
        root: root.metadata,
        fill: async (directory) => {
          writeClosure(directory, files)
          return Promise.resolve(releaseFiles(keys.targets, release, files))
        },
      })
    },
    remove: () => {
      makeWritable(home)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/**
 * Give the owner write permission on every directory and file under a path, so a spec can change or remove an
 * installation whose installed modes take the owner's write permission away.
 * @param path - the tree.
 */
export function makeWritable(path: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false })
  if (stats === undefined || stats.isSymbolicLink()) return
  if (!stats.isDirectory()) {
    chmodSync(path, 0o600)
    return
  }
  chmodSync(path, 0o700)
  for (const name of readdirSync(path)) makeWritable(join(path, name))
}

/**
 * Every entry under a directory with its kind and bytes, for comparing a tree before and after an operation.
 * @param root - the directory.
 * @returns each relative path mapped to a description of its entry.
 */
export function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      const stats = lstatSync(path)
      if (stats.isDirectory()) {
        snapshot[relative] = `dir ${(stats.mode & 0o777).toString(8)}`
        walk(path, relative)
      } else if (stats.isSymbolicLink()) {
        snapshot[relative] = `link ${readlinkSync(path)}`
      } else {
        snapshot[relative] = `file ${(stats.mode & 0o777).toString(8)} ${String(stats.mtimeMs)} ${readFileSync(path).toString('base64')}`
      }
    }
  }
  walk(root, '')
  return snapshot
}
