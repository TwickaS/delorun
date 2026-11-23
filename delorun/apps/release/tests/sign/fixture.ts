/**
 * A complete fixture release for the signing and verification specs: a git repository with the recipe committed under
 * `delorun/apps/release` on the branch `main` and the release's tag signed with a throwaway SSH key that the fixture's
 * allowed-signers file lists, the release workflow's output with its manifest draft, zero-length install-script
 * placeholders and the packed `delorun` npm package, the targets-key holder's rebuild of the same closures with its
 * attestation and rebuild record path outside the release, throwaway attestation and targets key files, and root
 * metadata over throwaway keys. Every key is generated in the test and removed with its temporary directory.
 */
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { devNull } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestContext } from 'vitest'
import { DESKTOP_PLATFORMS, RELEASE_REPOSITORY_URL, RELEASE_SCHEMAS, type FileRef, type ReleaseManifest, type RootMetadata, type UtcTimestamp } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { releaseAdvisoryCheck } from '../../src/advisory/release.ts'
import { semanticVersion, sha256Hex } from '@delorun/release-formats/brands'
import { readRecipe, RECIPE_DIR, RECIPE_FILES } from '../../src/closure/config.ts'
import { attestationText } from '../../src/rebuild/attestation.ts'
import { outputRefs, recipeAt } from '../../src/rebuild/record.ts'
import { imagesName, writeSeccompProfiles } from '../../src/images/build.ts'
import { writeReleaseSbom } from '../../src/sbom/release-sbom.ts'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { publicKeyEntry, readSigningKey, signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { signRelease, SigningRefusal } from '../../src/sign/release.ts'
import { DesktopSchema, ImagesSchema, InstallSchema, ManifestSchema } from '@delorun/release-formats/sign/schemas'
import { PERSISTENCE_SCHEMA_PATH } from '../../src/closure/data-formats.ts'
import { CHANGELOG_SCHEMA } from '../../src/changelog/data.ts'
import { DATA_PATH } from '../../src/changelog/paths.ts'
import { DELORUN_RECORDS_PATH, UPSTREAM_VERSION_PATH } from '../../src/sign/patch-rule.ts'
import { PLUGIN_INTERFACE_PATH, readPluginInterface } from '../../src/sign/plugin-interface.ts'
import { npmIntegrity } from '../../src/sign/npm-package.ts'
import { tarStream } from '@delorun/release-formats/archive/tar'
import { REPO, runEntry, scratch, writeTree, type RunResult } from '../support.ts'

/** The fixture release's version. */
export const VERSION = '0.1.0'

/** The release platforms `closure.json` lists, which the fixture release publishes. */
export const PLATFORMS = readRecipe().closure.platforms

const EPOCH = 1_793_981_656

/** The branch the fixture repository's release commit is on. */
export const RELEASE_BRANCH = 'main'

/** A throwaway SSH signing key and the allowed-signers line that lists it. */
export interface TagSigner {
  /** The private key file, which git's `user.signingkey` names. */
  readonly key: string
  /** The line of an allowed-signers file that lists the public key for the `git` namespace. */
  readonly allowed: string
}

/**
 * A new throwaway Ed25519 SSH key, made with `ssh-keygen`.
 * @param directory - where to write the key files.
 * @param name - the private key file's name; the public key is `<name>.pub`.
 * @returns the key file and its allowed-signers line.
 */
export function tagSigner(directory: string, name: string): TagSigner {
  const key = join(directory, name)
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', key], { timeout: 30_000 })
  const [type, base64] = readFileSync(`${key}.pub`, 'utf8').trim().split(' ')
  return { key, allowed: `${name}@example.test namespaces="git" ${type!} ${base64!}\n` }
}

/**
 * The bytes of a packed npm package as `npm pack` lays it out: one `package/package.json` naming the package.
 * @param name - the package name.
 * @param version - the package version.
 * @returns the gzipped tarball.
 */
export async function packedPackage(name: string, version: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of tarStream([{ path: 'package/package.json', mode: '0644', data: Buffer.from(`${JSON.stringify({ name, version, bin: { delorun: 'dist/bin.js' } }, undefined, 2)}\n`) }], EPOCH)) chunks.push(chunk)
  return gzipSync(Buffer.concat(chunks))
}

/** The closure lockfile every fixture archive holds: one registry package. */
export const LOCKFILE = `lockfileVersion: '9.0'\n\npackages:\n\n  example-parser@1.2.3:\n    resolution: {integrity: sha512-${'A'.repeat(86)}==}\n`

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

async function closures(directory: string, marker: string, version: string): Promise<void> {
  mkdirSync(directory, { recursive: true })
  for (const platform of PLATFORMS) {
    const stage = join(directory, '..', `stage-${marker}-${platform}`)
    writeTree(stage, { 'app/package.json': '{"name":"dsh-python-runtime-closure"}\n', 'app/pnpm-lock.yaml': LOCKFILE, 'app/lib/bin.js': `// ${platform}\n`, 'node/LICENSE': 'licence\n' })
    await archiveClosure({ stage, outDir: directory, version, platform, epoch: EPOCH, pins: undefined })
  }
}

/** The base image digest the fixture repository's committed `images.json` names, which the checkout's does not. */
export const COMMITTED_BASE_DIGEST = 'b'.repeat(64)

/** The native compiler the fixture repository's committed toolchain names, which the checkout's does not. */
export const COMMITTED_COMPILER = 'fixture compiler, committed at the release tag only'

/** The upstream DSH version the fixture release builds on, as its draft's `dsh` and its committed app-boot package state. */
export const FIXTURE_DSH = '0.2.2-rc.1'

/** An earlier release the fixture repository commits and tags before the release, for the patch rule. */
export interface EarlierFixtureRelease {
  /** Its version, tagged `v<version>`. */
  readonly version: string
  /** The upstream version its app-boot package names; {@link FIXTURE_DSH} by default. */
  readonly dsh?: string
  /** Changes its tree after the release facts are written, before the commit. */
  readonly change?: (repo: string) => void
}

/** How a fixture release differs from the default one. */
export interface FixtureOptions {
  /** The release's version; {@link VERSION} by default. */
  readonly version?: string
  /** Earlier releases, oldest first, committed and tagged before the release. */
  readonly earlier?: readonly EarlierFixtureRelease[]
  /** The versions the release commit's changelog lists; the earlier releases' and the release's by default. */
  readonly changelog?: readonly string[]
}

/**
 * Write `delorun/changelog/changelog.json` listing assembled versions, newest last as given, with no previews and no
 * bullets: the record the patch rule cross-checks the earlier releases' tags with.
 * @param repo - the fixture repository's work tree.
 * @param versions - the assembled versions.
 */
export function writeChangelog(repo: string, versions: readonly string[]): void {
  const data = { schema: CHANGELOG_SCHEMA, upstream: { ref: 'dsh-v0.2.2-rc.1', commit: '0'.repeat(40) }, compared: [], versions: versions.map(version => ({ version, date: '2026-11-06', preview: false, areas: [], fromUpstream: { ref: 'dsh-v0.2.2-rc.1', items: [] }, previews: [] })).reverse() }
  mkdirSync(dirname(join(repo, DATA_PATH)), { recursive: true })
  writeFileSync(join(repo, DATA_PATH), `${JSON.stringify(data, undefined, 2)}\n`)
}

/**
 * Write the files the patch rule reads at a commit: the app-boot package naming the upstream version, and the
 * persistence-schema inventory, Delorun's record versions, the plugin-facing interface inventory and the sources of its
 * covered entries as the checkout holds them.
 * @param repo - the fixture repository's work tree.
 * @param dsh - the upstream version the app-boot package names.
 */
export function writeReleaseFacts(repo: string, dsh: string): void {
  const write = (path: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  write(UPSTREAM_VERSION_PATH, `${JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: dsh }, undefined, 2)}\n`)
  const inventory = readFileSync(join(REPO, PLUGIN_INTERFACE_PATH))
  const sources = readPluginInterface(inventory).covered.map(entry => entry.source)
  for (const path of [PERSISTENCE_SCHEMA_PATH, DELORUN_RECORDS_PATH, PLUGIN_INTERFACE_PATH, ...sources]) write(path, readFileSync(join(REPO, path)))
}

/** A fixture release on disk. */
export interface ReleaseFixture {
  /** The release's version. */
  readonly version: string
  readonly repo: string
  readonly release: string
  readonly rebuild: string
  /** The holder's rebuild record, outside the release directory. */
  readonly recordPath: string
  /** The attestation of the holder's rebuild, outside the release and rebuild directories. */
  readonly attestationPath: string
  /** The holder's throwaway attestation key file. */
  readonly attestationKeyPath: string
  /** The attestation key's bytes. */
  readonly attestationKey: Buffer
  readonly keyPath: string
  readonly keys: Keys
  readonly commit: string
  /** The SSH key that signed the release tag, which the release branch's allowed-signers file lists. */
  readonly signer: TagSigner
  /**
   * Commit a release file on the release branch, as a maintainer's merge would: `delorun/release/allowed-signers` or
   * `delorun/release/production-keys.json`; `undefined` removes it. The checkout stays at the release commit.
   */
  readonly commitReleaseFile: (name: 'allowed-signers' | 'production-keys.json', text: string | undefined) => void
  /** The text of the release branch's allowed-signers file as the fixture commits it. */
  readonly allowedSigners: string
  /** Run git in the fixture repository, with no global or system configuration. */
  readonly git: (args: readonly string[]) => string
  /** Run a release entry point in the fixture repository. */
  readonly run: (entry: string, args: readonly string[], env?: NodeJS.ProcessEnv) => RunResult
  /** Record the rebuild with `record-rebuild.ts`. */
  readonly record: () => RunResult
  /**
   * Sign with the signing library against an advisory feed stand-in that answers with `advisories`, optionally from
   * another rebuild output, record or attestation, with `firstOfLine` when given, and with another release branch than
   * the fixture's.
   */
  readonly sign: (env?: NodeJS.ProcessEnv, args?: { readonly rebuild?: string, readonly record?: string, readonly attestation?: string, readonly advisories?: object, readonly firstOfLine?: boolean, readonly releaseBranch?: string }) => Promise<RunResult>
}

/**
 * Build a fixture release.
 * @param test - the running test.
 * @returns the fixture.
 */
export async function releaseFixture(test: TestContext, options: FixtureOptions = {}): Promise<ReleaseFixture> {
  const version = options.version ?? VERSION
  const directory = scratch(test, 'delorun-signing-')
  const repo = join(directory, 'repo')
  mkdirSync(repo)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
  const git = (args: readonly string[]): string => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }).trim()
  git(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  const assembled: string[] = []
  for (const earlier of options.earlier ?? []) {
    assembled.push(earlier.version)
    writeReleaseFacts(repo, earlier.dsh ?? FIXTURE_DSH)
    writeChangelog(repo, assembled)
    earlier.change?.(repo)
    git(['add', '-A'])
    git(['commit', '-q', '--allow-empty', '-m', `release ${earlier.version}`])
    git(['tag', `v${earlier.version}`])
  }
  const signer = tagSigner(directory, 'release-signer')
  const allowedSigners = `# The fixture's release signer.\n${signer.allowed}`
  const keys = throwawayKeys()
  writeReleaseFacts(repo, FIXTURE_DSH)
  writeChangelog(repo, options.changelog ?? [...assembled, version])
  mkdirSync(join(repo, 'delorun/apps/release'), { recursive: true })
  for (const file of RECIPE_FILES) {
    let text = readFileSync(join(RECIPE_DIR, file), 'utf8')
    if (file === 'toolchain.json') {
      const toolchain = JSON.parse(text) as { native: Record<string, string> }
      text = `${JSON.stringify({ ...toolchain, native: { ...toolchain.native, compiler: COMMITTED_COMPILER } }, undefined, 2)}\n`
    }
    if (file === 'images.json') text = text.replace(/@sha256:[0-9a-f]{64}/u, `@sha256:${COMMITTED_BASE_DIGEST}`)
    writeFileSync(join(repo, 'delorun/apps/release', file), text)
  }
  mkdirSync(join(repo, 'delorun', 'release'), { recursive: true })
  writeFileSync(join(repo, 'delorun', 'release', 'advisory-acceptances.yaml'), 'acceptances: []\n')
  writeFileSync(join(repo, 'delorun', 'release', 'allowed-signers'), allowedSigners)
  writeFileSync(join(repo, 'delorun', 'release', 'production-keys.json'), `${JSON.stringify({ schema: 'delorun.production-keys/1', roots: [], keyids: [publicKeyEntry(keys.targets).keyid] }, undefined, 2)}\n`)
  mkdirSync(join(repo, '.github'))
  writeFileSync(join(repo, '.github', 'CODEOWNERS'), '* @example-maintainer\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'fixture'])
  git(['-c', 'gpg.format=ssh', '-c', `user.signingkey=${signer.key}`, 'tag', '-s', '-m', `release ${version}`, `v${version}`])
  const commit = git(['rev-parse', 'HEAD'])
  const release = join(directory, 'release')
  const rebuild = join(directory, 'rebuild')
  const recordPath = join(directory, `delorun-${version}.rebuild.json`)
  await closures(release, 'workflow', version)
  await closures(rebuild, 'holder', version)
  const digest = `sha256:${'a'.repeat(64)}`
  const image = { repository: 'ghcr.io/twickas/fixture', index: digest, platforms: { 'linux/amd64': digest, 'linux/arm64': digest } }
  const recipe = recipeAt(repo, commit)
  let images: Record<'s2' | 's3', typeof image & { seccomp: FileRef }> | undefined
  for (const directory of [release, rebuild]) {
    const seccomp = await writeSeccompProfiles(recipe.images, directory, version)
    images = { s2: { ...image, seccomp: seccomp.s2 }, s3: { ...image, seccomp: seccomp.s3 } }
    writeFileSync(join(directory, imagesName(version)), `${JSON.stringify({ ...images, builder: recipe.toolchain.images, debian: { s2: { 'linux/amd64': [], 'linux/arm64': [] }, s3: { 'linux/amd64': [], 'linux/arm64': [] } } }, undefined, 2)}\n`)
    await writeReleaseSbom(directory, version, recipe.closure.platforms, recipe.toolchain, recipe.images.base)
  }
  const feed = await feedStandIn(test, {})
  const report = await releaseAdvisoryCheck(repo, commit, release, semanticVersion(version), feed.url)
  writeFileSync(join(release, `delorun-${version}.advisories.json`), `${JSON.stringify(report, undefined, 2)}\n`)
  for (const name of ['install.sh', 'install.ps1']) writeFileSync(join(release, name), '')
  const tarball = await packedPackage('delorun', version)
  writeFileSync(join(release, `delorun-${version}.tgz`), tarball)
  const desktop: Record<string, unknown> = {}
  for (const platform of DESKTOP_PLATFORMS) {
    const names = { installer: `Delorun-${version}-${platform}.installer`, update: `Delorun-${version}-${platform}.update`, blockmap: `Delorun-${version}-${platform}.blockmap` }
    for (const name of Object.values(names)) writeFileSync(join(release, name), `${name}\n`)
    const sha512 = (name: string): string => createHash('sha512').update(readFileSync(join(release, name))).digest('base64')
    desktop[platform] = { installer: { ...ref(release, names.installer), sha512: sha512(names.installer) }, update: { ...ref(release, names.update), sha512: sha512(names.update) }, blockmap: ref(release, names.blockmap) }
  }
  const draft = {
    schema: RELEASE_SCHEMAS.manifest,
    version,
    dsh: FIXTURE_DSH,
    channel: 'stable',
    source: { repository: RELEASE_REPOSITORY_URL, tag: `v${version}`, commit },
    runtime: Object.fromEntries(PLATFORMS.map((platform) => {
      const archive = `delorun-${version}-${platform}.${platform === 'win32-x64' ? 'zip' : 'tar.gz'}`
      return [platform, { archive: ref(release, archive), files: ref(release, `delorun-${version}-${platform}.files.json`) }]
    })),
    desktop,
    images,
    sbom: { ...ref(release, `delorun-${version}.spdx.json`), format: 'SPDX-2.3+json' },
    npm: [{ name: 'delorun', version, integrity: npmIntegrity(tarball) }],
    install: { sh: ref(release, 'install.sh'), ps1: ref(release, 'install.ps1') },
    advisories: { report: ref(release, `delorun-${version}.advisories.json`), accepted: [] },
    security: false,
    summary: 'The fixture release.',
  }
  writeFileSync(join(release, 'manifest-draft.json'), `${JSON.stringify(draft, undefined, 2)}\n`)
  const attestationKey = randomBytes(32)
  const attestationKeyPath = join(directory, 'attestation.key')
  writeFileSync(attestationKeyPath, attestationKey, { mode: 0o600 })
  const attestationPath = join(directory, 'rebuild.attestation.json')
  writeFileSync(attestationPath, attestationText(attestationKey, { version, commit, outputs: await outputRefs(rebuild) }))
  const keyPath = join(directory, 'targets.pem')
  writeFileSync(keyPath, keys.targets.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const run = (entry: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): RunResult => runEntry(entry, args, { CI: '', GITHUB_ACTIONS: '', ...extraEnv }, repo)
  return {
    version,
    repo,
    release,
    rebuild,
    recordPath,
    attestationPath,
    attestationKeyPath,
    attestationKey,
    keyPath,
    keys,
    commit,
    signer,
    allowedSigners,
    commitReleaseFile: (name, text) => {
      git(['checkout', '-q', RELEASE_BRANCH])
      const path = join(repo, 'delorun', 'release', name)
      if (text === undefined) rmSync(path)
      else writeFileSync(path, text)
      git(['add', '-A'])
      git(['commit', '-q', '-m', `change ${name}`])
      // The release branch moves on; the checkout stays at the release commit, which the rebuild records.
      git(['checkout', '-q', '--detach', commit])
    },
    git,
    run,
    record: () => run('record-rebuild.ts', ['--version', version, '--release', release, '--rebuild', rebuild, '--record', recordPath, '--builder', 'fixture-holder', '--compared-with', 'https://github.com/twickas/delorun/actions/runs/1']),
    sign: async (signEnv = {}, args = {}) => {
      feed.answer(args.advisories ?? {})
      try {
        const signed = await signRelease({
          repository: repo,
          release,
          rebuild: args.rebuild ?? rebuild,
          record: args.record ?? recordPath,
          attestation: args.attestation ?? attestationPath,
          attestationKey,
          key: readSigningKey(keyPath),
          env: { ...signEnv },
          now: new Date('2026-11-06T12:00:00Z'),
          feed: feed.url,
          firstOfLine: args.firstOfLine ?? false,
          releaseBranch: args.releaseBranch ?? RELEASE_BRANCH,
        })
        return { status: 0, stdout: signed.manifestName, stderr: '' }
      } catch (error) {
        if (!(error instanceof SigningRefusal)) throw error
        return { status: 1, stdout: '', stderr: error.message }
      }
    },
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

export function manifestContent(version: string, archive: Uint8Array): ReleaseManifest & Required<Pick<ReleaseManifest, 'desktop' | 'images' | 'install'>> {
  const digest = `sha256:${'b'.repeat(64)}`
  const image = { repository: 'ghcr.io/twickas/fixture', index: digest, platforms: { 'linux/amd64': digest, 'linux/arm64': digest } }
  const ref = contentRef('file', Buffer.from('x'))
  const desktop = { installer: { ...ref, sha512: 'A'.repeat(86) + '==' }, update: { ...ref, sha512: 'A'.repeat(86) + '==' }, blockmap: ref }
  const runtime = { archive: contentRef(`delorun-${version}-linux-x64.tar.gz`, archive), files: ref }
  return ManifestSchema.extend({ desktop: DesktopSchema, images: ImagesSchema, install: InstallSchema }).parse({
    schema: RELEASE_SCHEMAS.manifest,
    version,
    dsh: '0.2.2-rc.1',
    channel: 'stable',
    source: { repository: 'https://github.com/twickas/delorun', tag: `v${version}`, commit: 'c'.repeat(40) },
    published: '2026-11-06T12:00:00Z',
    runtime: { 'linux-x64': runtime, 'linux-arm64': runtime, 'darwin-x64': runtime, 'darwin-arm64': runtime, 'win32-x64': runtime },
    desktop: { 'mac-arm64': desktop, 'mac-x64': desktop, 'win-x64': desktop },
    images: { s2: image, s3: image },
    sbom: { ...ref, format: 'SPDX-2.3+json' },
    npm: [],
    install: { sh: ref, ps1: ref },
    rebuild: { record: ref, builders: [{ name: 'holder', ci: false }] },
    advisories: { report: ref, accepted: [] },
    security: false,
    summary: 'The fixture release.',
  })
}

/**
 * A local stand-in of npm's bulk advisory API, closed when the test ends.
 * @param test - the running test.
 * @param answer - the response body until the next {@link answer} call.
 * @returns the stand-in's URL, and the function that sets the body of later responses.
 */
export async function feedStandIn(test: TestContext, answer: object): Promise<{ readonly url: string, readonly answer: (next: object) => void }> {
  let current = answer
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(current))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  test.onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, answer: (next) => { current = next } }
}
