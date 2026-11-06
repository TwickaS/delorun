/**
 * A complete fixture release for the signing and verification specs: a git repository with the release's tag and
 * the recipe committed under `delo/apps/release`, the release workflow's output with its manifest draft, the
 * targets-key holder's rebuild of the same closures and its rebuild record path outside the release, a throwaway
 * targets key file, and root metadata over throwaway keys. Every key is generated in the test and removed with its
 * temporary directory.
 */
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'vitest'
import { DESKTOP_PLATFORMS, RELEASE_REPOSITORY_URL, RELEASE_SCHEMAS, RUNTIME_PLATFORMS, type FileRef, type ReleaseManifest, type RootMetadata, type UtcTimestamp } from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { sha256Hex } from '../../src/brands.ts'
import { RECIPE_DIR, RECIPE_FILES } from '../../src/closure/config.ts'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { publicKeyEntry, signEnvelope } from '../../src/sign/envelope.ts'
import { toJsonValue } from '../../src/sign/json.ts'
import { ManifestSchema } from '../../src/sign/schemas.ts'
import { runEntry, scratch, writeTree, type RunResult } from '../support.ts'

/** The fixture release's version. */
export const VERSION = '0.1.0'

const EPOCH = 1_793_981_656

/** Throwaway keys of every role. */
export interface Keys {
  readonly root: KeyObject
  readonly targets: KeyObject
  readonly timestamp: KeyObject
  readonly catalogue: KeyObject
}

/**
 * New throwaway Ed25519 keys for every role.
 * @returns the private keys.
 */
export function throwawayKeys(): Keys {
  const key = (): KeyObject => generateKeyPairSync('ed25519').privateKey
  return { root: key(), targets: key(), timestamp: key(), catalogue: key() }
}

/**
 * Signed root metadata over the given keys.
 * @param keys - the role keys.
 * @param overrides - fields to replace, such as the version or the targets keys.
 * @param signers - the keys that sign it; the root key by default.
 * @returns the root file's bytes and its content.
 */
export function rootFile(keys: Keys, overrides: Partial<RootMetadata> = {}, signers: readonly KeyObject[] = [keys.root]): { bytes: Buffer, metadata: RootMetadata } {
  const entries = [keys.root, keys.targets, keys.timestamp, keys.catalogue].map(publicKeyEntry)
  const [root, targets, timestamp, catalogue] = entries.map(entry => entry.keyid)
  const metadata: RootMetadata = {
    schema: RELEASE_SCHEMAS.root,
    version: 1,
    issued: brandString<UtcTimestamp>('2026-11-01T00:00:00Z'),
    expires: brandString<UtcTimestamp>('2027-10-01T00:00:00Z'),
    keys: Object.fromEntries(entries.map(entry => [entry.keyid, entry.entry])),
    roles: {
      root: { keyids: [root!], threshold: 1 },
      targets: { keys: [{ keyid: targets!, status: 'active' }], threshold: 1 },
      timestamp: { keyids: [timestamp!], threshold: 1 },
      catalogue: { keyids: [catalogue!], threshold: 1 },
    },
    log: { origin: 'log.example.test/fixture', vkey: 'log.example.test/fixture+00000000+AQ==' },
    witnesses: { keys: [{ name: 'witness.example.test', vkey: 'witness.example.test+00000000+BA==' }], threshold: 1 },
    ...overrides,
  }
  const envelope = signEnvelope({ signed: toJsonValue(metadata), signatures: [] }, signers)
  return { bytes: Buffer.from(`${JSON.stringify(envelope, undefined, 2)}\n`), metadata }
}

function ref(directory: string, name: string): FileRef {
  const bytes = readFileSync(join(directory, name))
  return { name, length: bytes.byteLength, sha256: sha256Hex(createHash('sha256').update(bytes).digest('hex')) }
}

async function closures(directory: string, marker: string): Promise<void> {
  mkdirSync(directory, { recursive: true })
  for (const platform of RUNTIME_PLATFORMS) {
    const stage = join(directory, '..', `stage-${marker}-${platform}`)
    writeTree(stage, { 'app/package.json': '{"name":"dsh-python-runtime-closure"}\n', 'app/lib/bin.js': `// ${platform}\n`, 'node/LICENSE': 'licence\n' })
    await archiveClosure({ stage, outDir: directory, version: VERSION, platform, epoch: EPOCH, pins: undefined })
  }
}

/** The native compiler the fixture repository's committed toolchain names, which the checkout's does not. */
export const COMMITTED_COMPILER = 'fixture compiler, committed at the release tag only'

/** A fixture release on disk. */
export interface ReleaseFixture {
  readonly repo: string
  readonly release: string
  readonly rebuild: string
  /** The holder's rebuild record, outside the release directory. */
  readonly recordPath: string
  readonly keyPath: string
  readonly keys: Keys
  readonly commit: string
  /** Run a release entry point in the fixture repository. */
  readonly run: (entry: string, args: readonly string[], env?: NodeJS.ProcessEnv) => RunResult
  /** Record the rebuild with `record-rebuild.ts`. */
  readonly record: () => RunResult
  /** Sign with `sign-release.ts`, optionally from another rebuild output or record. */
  readonly sign: (env?: NodeJS.ProcessEnv, args?: { readonly rebuild?: string, readonly record?: string }) => RunResult
}

/**
 * Build a fixture release.
 * @param test - the running test.
 * @returns the fixture.
 */
export async function releaseFixture(test: TestContext): Promise<ReleaseFixture> {
  const directory = scratch(test, 'delo-signing-')
  const repo = join(directory, 'repo')
  mkdirSync(repo)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
  const git = (args: readonly string[]): string => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  mkdirSync(join(repo, 'delo/apps/release'), { recursive: true })
  for (const file of RECIPE_FILES) {
    let text = readFileSync(join(RECIPE_DIR, file), 'utf8')
    if (file === 'toolchain.json') {
      const toolchain = JSON.parse(text) as { native: Record<string, string> }
      text = `${JSON.stringify({ ...toolchain, native: { ...toolchain.native, compiler: COMMITTED_COMPILER } }, undefined, 2)}\n`
    }
    writeFileSync(join(repo, 'delo/apps/release', file), text)
  }
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'fixture'])
  git(['tag', `v${VERSION}`])
  const commit = git(['rev-parse', 'HEAD'])
  const release = join(directory, 'release')
  const rebuild = join(directory, 'rebuild')
  const recordPath = join(directory, `delorun-${VERSION}.rebuild.json`)
  await closures(release, 'workflow')
  await closures(rebuild, 'holder')
  const extra = ['delorun-0.1.0.spdx.json', 'delorun-0.1.0.advisories.json', 'install.sh', 'install.ps1']
  for (const name of extra) writeFileSync(join(release, name), `${name}\n`)
  const desktop: Record<string, unknown> = {}
  for (const platform of DESKTOP_PLATFORMS) {
    const names = { installer: `Delo-${VERSION}-${platform}.installer`, update: `Delo-${VERSION}-${platform}.update`, blockmap: `Delo-${VERSION}-${platform}.blockmap` }
    for (const name of Object.values(names)) writeFileSync(join(release, name), `${name}\n`)
    const sha512 = (name: string): string => createHash('sha512').update(readFileSync(join(release, name))).digest('base64')
    desktop[platform] = { installer: { ...ref(release, names.installer), sha512: sha512(names.installer) }, update: { ...ref(release, names.update), sha512: sha512(names.update) }, blockmap: ref(release, names.blockmap) }
  }
  const digest = `sha256:${'a'.repeat(64)}`
  const image = { repository: 'ghcr.io/delo-run/fixture', index: digest, platforms: { 'linux/amd64': digest, 'linux/arm64': digest } }
  const draft = {
    schema: RELEASE_SCHEMAS.manifest,
    version: VERSION,
    dsh: '0.2.2-rc.1',
    channel: 'stable',
    source: { repository: RELEASE_REPOSITORY_URL, tag: `v${VERSION}`, commit },
    runtime: Object.fromEntries(RUNTIME_PLATFORMS.map((platform) => {
      const archive = `delorun-${VERSION}-${platform}.${platform === 'win32-x64' ? 'zip' : 'tar.gz'}`
      return [platform, { archive: ref(release, archive), files: ref(release, `delorun-${VERSION}-${platform}.files.json`) }]
    })),
    desktop,
    images: { s2: image, s3: image },
    sbom: { ...ref(release, 'delorun-0.1.0.spdx.json'), format: 'SPDX-2.3+json' },
    npm: [{ name: 'delorun', version: VERSION, integrity: `sha512-${'A'.repeat(86)}==` }],
    install: { sh: ref(release, 'install.sh'), ps1: ref(release, 'install.ps1') },
    advisories: { report: ref(release, 'delorun-0.1.0.advisories.json'), accepted: [] },
  }
  writeFileSync(join(release, 'manifest-draft.json'), `${JSON.stringify(draft, undefined, 2)}\n`)
  const keys = throwawayKeys()
  const keyPath = join(directory, 'targets.pem')
  writeFileSync(keyPath, keys.targets.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const run = (entry: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): RunResult => runEntry(entry, args, { CI: '', GITHUB_ACTIONS: '', ...extraEnv }, repo)
  return {
    repo,
    release,
    rebuild,
    recordPath,
    keyPath,
    keys,
    commit,
    run,
    record: () => run('record-rebuild.ts', ['--version', VERSION, '--release', release, '--rebuild', rebuild, '--record', recordPath, '--builder', 'fixture-holder', '--compared-with', 'https://github.com/Delo-Run/delo/actions/runs/1']),
    sign: (signEnv = {}, args = {}) => run('sign-release.ts', ['--release', release, '--rebuild', args.rebuild ?? rebuild, '--record', args.record ?? recordPath, '--key', keyPath], signEnv),
  }
}

/**
 * A complete manifest content for verification specs.
 * @param version - the release.
 * @param archive - the linux-x64 archive's bytes, which every platform entry names.
 * @returns the manifest.
 */
function contentRef(name: string, bytes: Uint8Array): FileRef {
  return { name, length: bytes.byteLength, sha256: sha256Hex(createHash('sha256').update(bytes).digest('hex')) }
}

export function manifestContent(version: string, archive: Uint8Array): ReleaseManifest {
  const digest = `sha256:${'b'.repeat(64)}`
  const image = { repository: 'ghcr.io/delo-run/fixture', index: digest, platforms: { 'linux/amd64': digest, 'linux/arm64': digest } }
  const ref = contentRef('file', Buffer.from('x'))
  const desktop = { installer: { ...ref, sha512: 'A'.repeat(86) + '==' }, update: { ...ref, sha512: 'A'.repeat(86) + '==' }, blockmap: ref }
  const runtime = { archive: contentRef(`delorun-${version}-linux-x64.tar.gz`, archive), files: ref }
  return ManifestSchema.parse({
    schema: RELEASE_SCHEMAS.manifest,
    version,
    dsh: '0.2.2-rc.1',
    channel: 'stable',
    source: { repository: 'https://github.com/Delo-Run/delo', tag: `v${version}`, commit: 'c'.repeat(40) },
    published: '2026-11-06T12:00:00Z',
    runtime: { 'linux-x64': runtime, 'linux-arm64': runtime, 'darwin-x64': runtime, 'darwin-arm64': runtime, 'win32-x64': runtime },
    desktop: { 'mac-arm64': desktop, 'mac-x64': desktop, 'win-x64': desktop },
    images: { s2: image, s3: image },
    sbom: { ...ref, format: 'SPDX-2.3+json' },
    npm: [],
    install: { sh: ref, ps1: ref },
    rebuild: { record: ref, builders: [{ name: 'holder', ci: false }] },
    advisories: { report: ref, accepted: [] },
  })
}
