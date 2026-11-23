/**
 * Fixtures of `delorun update`'s end-to-end specs: fake releases signed with Ed25519 keys generated in the test, whose
 * runtime is a few files — a Node launcher that runs this machine's Node, a successor entry that answers the handover
 * as its release says, upstream's bundle tables and a `data-formats.json` — and a release channel that serves them.
 * Every file lives in a temporary directory the spec removes.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
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
import { publicKeyEntry, signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { recordResult } from '@delorun/release-verify'
import type { ChannelRelease, OpenUpdateChannel, ReleaseFileBytes, UpdateInstallEvent, UpdateReleaseChannel } from '@delorun/runtime-store'

/** How one fake release's successor behaves. */
export interface FakeBehaviour {
  /** Whether it answers `ready`. */
  readonly healthy: boolean
  /** The digest its `data-formats.json` names; releases with different digests do not read each other's data. */
  readonly persistence: string
}

/** One file of a fake closure. */
interface FakeFile {
  readonly content: string
  readonly executable?: boolean
}

/** The successor entry: answer the handover, write a chat as the release that opened the data, take the commit. */
const ENTRY = `import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { join } from 'node:path'
const behaviour = JSON.parse(readFileSync(new URL('../../../../../behaviour.json', import.meta.url), 'utf8'))
const pipe = new Socket({ fd: 3, readable: true, writable: true })
let buffered = ''
let handover
pipe.setEncoding('utf8')
pipe.on('data', (chunk) => {
  buffered += chunk
  let newline
  while ((newline = buffered.indexOf('\\n')) !== -1) {
    const line = JSON.parse(buffered.slice(0, newline))
    buffered = buffered.slice(newline + 1)
    if (handover === undefined) {
      handover = line
      const chat = join(handover.home, 'sessions', 'opened-by-' + handover.to)
      mkdirSync(chat, { recursive: true })
      writeFileSync(join(chat, 'log.jsonl'), handover.to + '\\n')
      pipe.write(JSON.stringify(behaviour.healthy ? { type: 'ready' } : { type: 'failed', reason: 'HEALTH_CHECK_FAILED' }) + '\\n')
    } else if (line.type === 'commit') {
      const path = join(handover.home, 'run', handover.profile, 'update.json')
      const record = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path + '.fake', JSON.stringify({ ...record, phase: 'committed' }) + '\\n', { mode: 0o600 })
      renameSync(path + '.fake', path)
      // A home process keeps running after its commit; this one ends a moment later, still holding the lock until then,
      // so a spec that takes the lock next waits for it to exit.
      setTimeout(() => process.exit(0), 300)
    }
  }
})
pipe.on('error', () => process.exit(1))
`

/**
 * The files of a fake closure.
 * @param version - the release.
 * @param behaviour - how its successor behaves and what its data formats are.
 * @returns the files by relative path.
 */
export function fakeClosure(version: string, behaviour: FakeBehaviour): Record<string, FakeFile> {
  return {
    'node/bin/node': { content: `#!/bin/sh\n# fake runtime ${version}\nexec ${JSON.stringify(process.execPath)} "$@"\n`, executable: true },
    'behaviour.json': { content: `${JSON.stringify(behaviour)}\n` },
    'data-formats.json': { content: `${JSON.stringify({ schema: 'delorun.data-formats/1', persistence: behaviour.persistence, delorunRecords: { 'update-record': 1 } })}\n` },
    'app/package.json': { content: `{"name":"@delorun/runtime-closure","version":"${version}","type":"module"}\n` },
    'app/node_modules/@delorun/cli/package.json': { content: '{"name":"@delorun/cli","type":"module"}\n' },
    'app/node_modules/@delorun/cli/src/bin.js': { content: ENTRY },
    'app/node_modules/@deepseek-ai/dsh-official-bundles/package.json': { content: '{"name":"@deepseek-ai/dsh-official-bundles","type":"module","exports":"./index.js"}\n' },
    'app/node_modules/@deepseek-ai/dsh-official-bundles/index.js': { content: 'export const RETIRED_BUNDLES = new Set()\nexport const INSTALLATION_OWNED_PROFILE_TUPLES = {}\nexport const PROFILE_TEMPLATES = {}\n' },
  }
}

/** Throwaway keys of every role. */
export interface Keys {
  readonly root: KeyObject
  readonly targets: KeyObject
  readonly timestamp: KeyObject
  readonly catalogue: KeyObject
}

/**
 * New throwaway Ed25519 keys and the root metadata over them.
 * @returns the keys, the root file's bytes and its metadata.
 */
export function throwawayRoot(): { readonly keys: Keys, readonly bytes: Buffer, readonly metadata: RootMetadata } {
  const key = (): KeyObject => generateKeyPairSync('ed25519').privateKey
  const keys: Keys = { root: key(), targets: key(), timestamp: key(), catalogue: key() }
  const all = [keys.root, keys.targets, keys.timestamp, keys.catalogue].map(publicKeyEntry)
  const [root, targets, timestamp, catalogue] = all.map(entry => entry.keyid)
  const metadata: RootMetadata = {
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
    log: { origin: 'log.example.test/fixture', vkey: 'log.example.test/fixture+00000000+AQ==' },
    witnesses: { keys: [{ name: 'witness.example.test', vkey: 'witness.example.test+00000000+BA==' }], threshold: 1 },
  }
  const envelope = signEnvelope({ signed: toJsonValue(metadata), signatures: [] }, [keys.root])
  return { keys, bytes: Buffer.from(`${JSON.stringify(envelope, undefined, 2)}\n`), metadata }
}

/**
 * The next root version over the same keys, signed by the root key, which both the trusted root's root role and its own
 * require.
 * @param previous - the root it follows.
 * @param previous.keys - that root's keys.
 * @param previous.metadata - that root's metadata.
 * @returns the next root's bytes and metadata.
 */
export function nextThrowawayRoot(previous: { readonly keys: Keys, readonly metadata: RootMetadata }): { readonly bytes: Buffer, readonly metadata: RootMetadata } {
  const metadata: RootMetadata = { ...previous.metadata, version: previous.metadata.version + 1, issued: brandString<UtcTimestamp>('2026-11-02T00:00:00Z') }
  const envelope = signEnvelope({ signed: toJsonValue(metadata), signatures: [] }, [previous.keys.root])
  return { bytes: Buffer.from(`${JSON.stringify(envelope, undefined, 2)}\n`), metadata }
}

function sha256(bytes: Uint8Array): Sha256Hex {
  return brandString<Sha256Hex>(createHash('sha256').update(bytes).digest('hex'))
}

function ref(name: string, bytes: Uint8Array): FileRef {
  return { name, length: bytes.byteLength, sha256: sha256(bytes) }
}

function sign<T extends object>(signed: T, key: KeyObject): Buffer {
  return Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [key]), undefined, 2)}\n`)
}

/**
 * The signed release files of a fake closure.
 * @param key - the targets key.
 * @param platform - the platform the file list is for.
 * @param release - the version.
 * @param files - the closure's files.
 * @returns the manifest, file list and a placeholder log bundle.
 */
export function signedRelease(key: KeyObject, platform: RuntimePlatform, release: string, files: Record<string, FakeFile>): ReleaseFileBytes {
  const semantic = brandString<SemanticVersion>(release)
  const list: RuntimeFileList = {
    schema: RELEASE_SCHEMAS.files,
    version: semantic,
    platform,
    files: Object.entries(files).sort(([left], [right]) => (left < right ? -1 : 1)).map(([path, file]) => {
      const bytes = Buffer.from(file.content)
      return { path, length: bytes.byteLength, sha256: sha256(bytes), mode: file.executable === true ? '0755' : '0644' }
    }),
  }
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
    runtime: Object.fromEntries(RUNTIME_PLATFORMS.map(each => [each, {
      archive: placeholder,
      files: each === platform ? ref(`delorun-${release}-${each}.files.json`, listBytes) : placeholder,
    }])) as ReleaseManifest['runtime'],
    desktop: Object.fromEntries(DESKTOP_PLATFORMS.map(each => [each, { installer: desktopRef, update: desktopRef, blockmap: placeholder }])) as NonNullable<ReleaseManifest['desktop']>,
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
 * Write a fake closure into a directory.
 * @param directory - the directory.
 * @param files - the files.
 */
export function writeClosure(directory: string, files: Record<string, FakeFile>): void {
  for (const [path, file] of Object.entries(files)) {
    const target = join(directory, ...path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, { mode: file.executable === true ? 0o755 : 0o644 })
  }
}

/**
 * A release channel over fake releases: it names the release the spec points it at, reports the install step for
 * it, fills the staging directory with its signed files, as `@delorun/install`'s channel does after its checks, and
 * records each release the store installed.
 */
export class FakeChannel implements UpdateReleaseChannel {
  /** The release `resolve` names when no target is asked for. */
  next: RuntimeVersion
  /** The releases the store installed, in order. */
  readonly recorded: RuntimeVersion[] = []
  private report: (event: UpdateInstallEvent) => void = () => {}

  private readonly root: RootMetadata
  private readonly key: KeyObject
  private readonly platform: RuntimePlatform
  private readonly releases: ReadonlyMap<string, FakeBehaviour>
  private readonly home: string

  /**
   * @param home - the Delorun home whose `trust/release-log.json` records each installed release as verified.
   * @param root - the root the releases verify under.
   * @param key - the targets key.
   * @param platform - this machine's platform.
   * @param releases - each release's behaviour.
   * @param first - the first release to name.
   */
  constructor(home: string, root: RootMetadata, key: KeyObject, platform: RuntimePlatform, releases: ReadonlyMap<string, FakeBehaviour>, first: RuntimeVersion) {
    this.home = home
    this.root = root
    this.key = key
    this.platform = platform
    this.releases = releases
    this.next = first
  }

  /** Opens this channel for one prepare, reporting its steps where the prepare asks. */
  readonly open: OpenUpdateChannel = async (report) => {
    this.report = report
    return this
  }

  async resolve(target: RuntimeVersion | undefined): Promise<ChannelRelease> {
    const version = target ?? this.next
    this.report({ step: 'resolved', channel: 'stable', version: brandString<SemanticVersion>(version) })
    // As the launcher's channel stores the timestamp it verified, which names the release it confirmed as current.
    writeFileSync(join(this.home, DELORUN_HOME_ENTRIES.trust, TRUST_FILES.timestamp), JSON.stringify({ signed: { version: 1, channels: { stable: { release: version } } } }), { mode: 0o600 })
    return Promise.resolve({ version, root: this.root })
  }

  async fill(release: ChannelRelease, directory: string): Promise<ReleaseFileBytes> {
    const behaviour = this.releases.get(release.version)
    if (behaviour === undefined) throw new Error(`no fake release ${release.version}`)
    const files = fakeClosure(release.version, behaviour)
    writeClosure(directory, files)
    return Promise.resolve(signedRelease(this.key, this.platform, release.version, files))
  }

  async recordInstalled(release: ChannelRelease): Promise<void> {
    this.recorded.push(release.version)
    // As the launcher's channel records a release whose online log check passed.
    await recordResult(this.home, release.version, Math.floor(Date.now() / 1000), { state: 'verified', stop: false })
  }
}
