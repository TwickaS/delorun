/**
 * A production channel and a release built on the maintainer's PC: installed only while it is a 0.x release under the
 * preview root (A369, A506); a 1.0 release, a later root, another root identity and a bad signature or digest all
 * refuse. The channel's one refusal site serves resolve, newest and the update-from-a-folder path, which
 * `productionRoot` selects.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASE_METADATA_ORIGIN, type SemanticVersion } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { publicKeyEntry } from '@delorun/release-formats/sign/envelope'
import { LOCAL_RELEASE_BUILDER } from '@delorun/release-formats/sign/schemas'
import { Downloader } from '../src/download.ts'
import { isInstallError, type InstallError } from '../src/errors.ts'
import { LauncherChannel, type ReleaseSource } from '../src/channel.ts'
import { PREVIEW_ROOT_SHA256 } from '../src/local-builder.ts'
import { writeStoredRootChain, writeTrustedRoot } from '../src/state.ts'
import { envelope, fixtureKeys, fixtureRelease, logService, nextRoot, NOW, releasePaths, sha256, type Fixture, type FixtureOptions } from './support.ts'

let homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.map(home => rm(home, { recursive: true, force: true })))
  homes = []
})

/**
 * A channel over contract C2's production publication, answered from a map of paths, so it fetches as a production
 * launcher does without a network.
 * @param fixture - the release the publication serves.
 * @param change - the extra files served and the options the channel gets.
 * @returns the channel.
 */
async function production(fixture: Fixture, change: { readonly extra?: ReadonlyMap<string, Buffer>, readonly previewRoots?: readonly string[], readonly roots?: readonly Uint8Array[], readonly productionRoot?: boolean, readonly source?: ReleaseSource, readonly home?: string } = {}): Promise<LauncherChannel> {
  const files = releasePaths(fixture)
  for (const [path, bytes] of change.extra ?? []) files.set(path, bytes)
  const served: typeof globalThis.fetch = async (input) => {
    const bytes = files.get(new URL(input instanceof Request ? input.url : String(input)).pathname)
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(bytes), { status: 200 })
  }
  const home = change.home ?? await mkdtemp(join(tmpdir(), 'delorun-install-local-builder-'))
  homes.push(home)
  const source = change.source ?? { metadata: RELEASE_METADATA_ORIGIN, files: (version: string, name: string) => `${RELEASE_METADATA_ORIGIN}/releases/${version}/${name}` }
  const origin = new URL(source.metadata)
  return new LauncherChannel({
    home,
    platform: fixture.platform,
    roots: change.roots ?? fixture.roots,
    channel: 'stable',
    log: logService(fixture.checkpoint),
    source,
    ...change.productionRoot === undefined ? {} : { productionRoot: change.productionRoot },
    ...change.previewRoots === undefined ? {} : { previewRoots: change.previewRoots },
    downloader: new Downloader({ fetch: served, hosts: { scheme: origin.protocol, hosts: [origin.hostname], maxRedirects: 0 } }),
    now: () => NOW * 1000,
  })
}

/**
 * A local release.
 * @param options - what the release changes.
 * @returns the fixture.
 */
function local(options: FixtureOptions = {}): Promise<Fixture> {
  return fixtureRelease({ builder: LOCAL_RELEASE_BUILDER, ...options })
}

/**
 * The failure of a step.
 * @param step - the pending step.
 * @returns its `INSTALL_VERIFY_FAILED` refusal.
 */
async function refused(step: Promise<unknown>): Promise<InstallError> {
  const error: unknown = await step.then(() => undefined, (failure: unknown) => failure)
  expect(isInstallError(error, 'INSTALL_VERIFY_FAILED'), error instanceof Error ? error.message : String(error)).toBe(true)
  return error as InstallError
}

/**
 * The preview root for a fixture: its own root 1, standing in for the published digest.
 * @param fixture - the release.
 * @returns the digests the channel accepts as the preview root.
 */
function previewOf(fixture: Fixture): readonly string[] {
  return [sha256(fixture.roots[0]!)]
}

describe('a production channel and a release the maintainer\'s PC built', () => {
  it('installs a 0.x release under the preview root, through resolve and newest', async () => {
    const fixture = await local({ version: '0.1.0-preview.2.7' })
    const channel = await production(fixture, { previewRoots: previewOf(fixture) })
    expect(String((await channel.resolve()).version)).toBe('0.1.0-preview.2.7')
    expect(String((await (await production(fixture, { previewRoots: previewOf(fixture) })).newest()).manifest.version)).toBe('0.1.0-preview.2.7')
  })

  it('installs the same release from a folder whose roots are production roots', async () => {
    const fixture = await local()
    const channel = await production(fixture, { previewRoots: previewOf(fixture), productionRoot: true, source: { metadata: 'http://folder.test', files: (version, name) => `http://folder.test/releases/${version}/${name}` } })
    expect(String((await channel.resolve()).version)).toBe('0.1.0')
  })

  it('refuses a 0.x release under a root whose digest is not the published preview root', async () => {
    const error = await refused((await production(await local())).resolve())
    expect(error.detail).toContain(`names the builder "${LOCAL_RELEASE_BUILDER}"`)
    expect(error.detail).toContain('only while it is a 0.x release under a root chain that holds the pinned preview root')
  })

  it.each(['1.0.0', '1.0.0-rc.1', '2.3.4'])('refuses release %s under the preview root, through resolve and newest', async (version) => {
    const fixture = await local({ version })
    const error = await refused((await production(fixture, { previewRoots: previewOf(fixture) })).resolve())
    expect(error.detail).toContain(`names the builder "${LOCAL_RELEASE_BUILDER}"`)
    await refused((await production(fixture, { previewRoots: previewOf(fixture) })).newest())
  })

  it('allows a 0.x release under a later root that descends from the pinned root and keeps its targets key, also once the home stored that root', async () => {
    const fixture = await local()
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root])
    const timestamp = envelope({ ...fixture.timestamp, root: { version: 2, sha256: sha256(second) } }, [fixture.keys.timestamp])
    const extra = new Map([['/timestamp.json', timestamp], ['/root/2.root.json', second]])
    expect(String((await (await production(fixture, { extra, previewRoots: previewOf(fixture) })).resolve()).version)).toBe(fixture.manifest.version)
    // A home that adopted root 2 walks from the launcher's shipped root 1 through its stored chain, so the pin is still in the walk.
    const home = await mkdtemp(join(tmpdir(), 'delorun-install-local-builder-'))
    await writeTrustedRoot(home, second)
    await writeStoredRootChain(home, [fixture.roots[0]!, second])
    expect(String((await (await production(fixture, { extra, previewRoots: previewOf(fixture), home })).resolve()).version)).toBe(fixture.manifest.version)
  })

  it('refuses a 0.x release under a later root that names another active targets key', async () => {
    const fixture = await local()
    const ceremony = fixtureKeys()
    const added = publicKeyEntry(ceremony.targets)
    // The old targets key is retired past this release, so the manifest still verifies and only the allowance can refuse it.
    const second = nextRoot(fixture.rootMetadata, fixture.keys, [fixture.keys.root], next => ({
      ...next,
      keys: { ...next.keys, [added.keyid]: added.entry },
      roles: { ...next.roles, targets: { keys: [{ keyid: publicKeyEntry(fixture.keys.targets).keyid, status: 'retired', lastRelease: brandString<SemanticVersion>('0.9.9') }, { keyid: added.keyid, status: 'active' }], threshold: 1 } },
    }))
    const timestamp = envelope({ ...fixture.timestamp, root: { version: 2, sha256: sha256(second) } }, [fixture.keys.timestamp])
    const extra = new Map([['/timestamp.json', timestamp], ['/root/2.root.json', second]])
    const error = await refused((await production(fixture, { extra, previewRoots: previewOf(fixture) })).resolve())
    expect(error.detail).toContain(`names the builder "${LOCAL_RELEASE_BUILDER}"`)
  })

  it('refuses a 0.x release when the pinned digest is the real preview root, which a throwaway root is not', async () => {
    const fixture = await local()
    expect(previewOf(fixture)).not.toContain(PREVIEW_ROOT_SHA256)
    await refused((await production(fixture, { previewRoots: [PREVIEW_ROOT_SHA256] })).resolve())
  })

  it('still refuses a local release a stranger signed, before the builder is read', async () => {
    const fixture = await local({ manifestSigners: [fixtureKeys().targets] })
    const error = await refused((await production(fixture, { previewRoots: previewOf(fixture) })).resolve())
    expect(error.detail).not.toContain('names the builder')
  })

  it('still refuses a local release whose manifest bytes are not the timestamp\'s digest', async () => {
    const fixture = await local()
    const tampered = Buffer.from(fixture.manifestBytes)
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x20 ? 0x21 : 0x20
    const extra = new Map([[`/releases/${fixture.manifest.version}/delorun-${fixture.manifest.version}.manifest.json`, tampered]])
    const error = await refused((await production(fixture, { extra, previewRoots: previewOf(fixture) })).resolve())
    expect(error.detail).not.toContain('names the builder')
  })
})
