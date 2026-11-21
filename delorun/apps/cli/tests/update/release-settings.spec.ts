/**
 * What two installed releases' signed bundles change in protected rows (`delorun/apps/cli/src/update/release-settings.ts`):
 * each release is checked first, its bundles resolve only from its own `app/` directory, every file the reader parses
 * hashes to its signed digest, and a bundle whose metadata cannot be read stops the derivation.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { StorePaths } from '@delorun/runtime-store'
import { rowSettingsFact, type LayerFact } from '@delorun/update'
import type { BundleLayerFacts, BundleLayerOptions } from '../../src/update/bundle-layers.ts'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { signedSettingChanges, type SignedSettingsOptions } from '../../src/update/release-settings.ts'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'drs-')))
const OLD = brandString<RuntimeVersion>('0.1.0-preview.2.3')
const NEW = brandString<RuntimeVersion>('0.1.0-preview.2.5')
const SEATS = '@delorun/plugin-agent-seats'
const BUNDLE = '@delorun/bundle-local'
const paths = new StorePaths(home, runtimePlatformOf(process.platform, process.arch))
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * A layer that protects the seats plugin and gives its row settings.
 * @param config - the row's keys.
 * @returns the layer.
 */
function layer(config: Record<string, boolean>): LayerFact {
  return { layer: BUNDLE, rows: [], settings: [rowSettingsFact('plugin-manager', undefined, { protectedPlugins: [SEATS] }), rowSettingsFact('delorun-agent-seats', SEATS, config)] }
}

/**
 * Options whose check and bundle reader are fakes that record what they were asked.
 * @param read - the layers each release's directory gives, by version.
 * @param failing - a release whose check fails.
 * @returns the options and what was asked.
 */
function fakes(read: Readonly<Record<string, BundleLayerFacts>>, failing?: RuntimeVersion): { readonly options: SignedSettingsOptions, readonly checked: string[], readonly reads: BundleLayerOptions[] } {
  const checked: string[] = []
  const reads: BundleLayerOptions[] = []
  return {
    checked, reads,
    options: {
      home, bundles: [BUNDLE], running: NEW, platform: 'linux',
      check: async (version) => {
        checked.push(version)
        if (version === failing) throw new Error(`files of ${version} differ`)
        return Promise.resolve({ manifest: { version: brandString<SemanticVersion>(version), dsh: brandString<SemanticVersion>('0.2.2-rc.3') }, files: { files: [] } })
      },
      layers: async (_bundles, options) => {
        reads.push(options)
        const version = [OLD, NEW].find(candidate => options.anchors[0]?.startsWith(paths.version(candidate)))
        return Promise.resolve(read[version ?? ''] ?? { layers: [], skipped: [] })
      },
    },
  }
}

describe('signedSettingChanges over a reader that is not stubbed', () => {
  const manifest = JSON.stringify({ name: BUNDLE, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  const patch = (enabled: boolean | undefined): string => [
    '- id: plugin-manager',
    '  config:',
    `    protectedPlugins: ['${SEATS}']`,
    '- insert:',
    '    - id: delorun-agent-seats',
    `      name: '${SEATS}'`,
    '      config:',
    ...enabled === undefined ? ['        seats: []'] : [`        enabled: ${String(enabled)}`],
    '',
  ].join('\n')

  /**
   * Install a release's bundle files and list them as the signed file list does.
   * @param version - the release.
   * @param text - the patch file's text.
   * @returns the signed file list, whose digests are those of the files as written.
   */
  function install(version: RuntimeVersion, text: string): { readonly path: string, readonly sha256: string }[] {
    const directory = join(paths.version(version), 'app', 'node_modules', '@delorun', 'bundle-local')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), manifest)
    writeFileSync(join(directory, 'cordis.patch.yml'), text)
    return [
      { path: 'app/node_modules/@delorun/bundle-local/package.json', sha256: sha256(manifest) },
      { path: 'app/node_modules/@delorun/bundle-local/cordis.patch.yml', sha256: sha256(text) },
    ]
  }

  /**
   * Options over the installed releases, whose start check answers with the given signed lists.
   * @param signed - each release's signed file list.
   * @returns the options.
   */
  const over = (signed: Readonly<Record<string, readonly { readonly path: string, readonly sha256: string }[]>>): SignedSettingsOptions => ({
    home, bundles: [BUNDLE], running: NEW, platform: 'linux',
    check: async version => Promise.resolve({ manifest: { version: brandString<SemanticVersion>(version), dsh: brandString<SemanticVersion>('0.2.2-rc.3') }, files: { files: signed[version] ?? [] } }),
  })

  it('names the change when every file hashes to its signed digest', async () => {
    const options = over({ [OLD]: install(OLD, patch(undefined)), [NEW]: install(NEW, patch(true)) })
    expect(await signedSettingChanges(options, OLD)).toEqual([{ id: 'delorun-agent-seats', plugin: SEATS, layer: BUNDLE, change: 'changed', keys: [{ key: 'enabled', after: true }, { key: 'seats', before: [] }] }])
  })

  it('derives nothing when a patch file was changed after the signed list was made, whatever the start check recorded', async () => {
    const signed = { [OLD]: install(OLD, patch(undefined)), [NEW]: install(NEW, patch(true)) }
    // A writer swaps the new release's patch for one that turns more on; the check's list still holds the real digest.
    writeFileSync(join(paths.version(NEW), 'app', 'node_modules', '@delorun', 'bundle-local', 'cordis.patch.yml'), patch(true).replace('enabled: true', 'enabled: true\n        extra: 1'))
    await expect(signedSettingChanges(over(signed), OLD)).rejects.toThrow('could not be read: Delorun could not read its patch ./cordis.patch.yml: Error: app/node_modules/@delorun/bundle-local/cordis.patch.yml differs from its signed digest')
  })

  it('derives nothing when the manifest was changed, a file is not in the signed list or a file is a link', async () => {
    const signed = { [OLD]: install(OLD, patch(undefined)), [NEW]: install(NEW, patch(true)) }
    const directory = join(paths.version(NEW), 'app', 'node_modules', '@delorun', 'bundle-local')
    const unlisted = { ...signed, [NEW]: (signed[NEW] ?? []).filter(file => !file.path.endsWith('cordis.patch.yml')) }
    await expect(signedSettingChanges(over(unlisted), OLD)).rejects.toThrow('is not in the release\'s signed file list')
    writeFileSync(join(directory, 'package.json'), manifest.replace('1.0.0', '1.0.1'))
    await expect(signedSettingChanges(over(signed), OLD)).rejects.toThrow('package.json differs from its signed digest')
    install(NEW, patch(true))
    rmSync(join(directory, 'cordis.patch.yml'))
    mkdirSync(dirname(join(directory, 'real.yml')), { recursive: true })
    writeFileSync(join(directory, 'real.yml'), patch(true))
    symlinkSync(join(directory, 'real.yml'), join(directory, 'cordis.patch.yml'))
    await expect(signedSettingChanges(over(signed), OLD)).rejects.toThrow('is not a regular file')
  })
})

describe('signedSettingChanges', () => {
  it('names the protected-row settings the two releases\' bundles give differently, after checking both', async () => {
    const { options, checked, reads } = fakes({ [OLD]: { layers: [layer({})], skipped: [] }, [NEW]: { layers: [layer({ enabled: true })], skipped: [] } })

    expect(await signedSettingChanges(options, OLD)).toEqual([{ id: 'delorun-agent-seats', plugin: SEATS, layer: BUNDLE, change: 'changed', keys: [{ key: 'enabled', after: true }] }])
    expect(checked).toEqual([OLD, NEW])
    expect(reads.map(read => ({ anchors: read.anchors, within: read.within, exemptions: read.exemptions, versions: read.versions }))).toEqual([OLD, NEW].map(version => ({
      anchors: [join(paths.version(version), 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')], within: join(paths.version(version), 'app'), exemptions: {}, versions: { dsh: '0.2.2-rc.3', delorun: version },
    })))
  })

  it('names nothing when a bundle only one profile installs is skipped as not installed', async () => {
    const { options } = fakes({ [OLD]: { layers: [layer({})], skipped: [{ package: 'plugin-pack', reason: 'neither the target release nor the profile installs it', verification: 'verified' }] }, [NEW]: { layers: [layer({})], skipped: [] } })
    expect(await signedSettingChanges(options, OLD)).toEqual([])
  })

  it('throws when either release does not verify, and reads no bundle of the one after it', async () => {
    const old = fakes({}, OLD)
    await expect(signedSettingChanges(old.options, OLD)).rejects.toThrow(`files of ${OLD} differ`)
    expect(old.checked).toEqual([OLD])
    expect(old.reads).toEqual([])
    const target = fakes({ [OLD]: { layers: [layer({})], skipped: [] } }, NEW)
    await expect(signedSettingChanges(target.options, OLD)).rejects.toThrow(`files of ${NEW} differ`)
  })

  it('throws when a bundle\'s metadata cannot be read, so no change is derived', async () => {
    const { options } = fakes({ [NEW]: { layers: [], skipped: [{ package: BUNDLE, reason: 'its patch ./cordis.patch.yml is not a list of patch entries', verification: 'unverified' }] } })
    await expect(signedSettingChanges(options, OLD)).rejects.toThrow('the bundle @delorun/bundle-local of release 0.1.0-preview.2.5 could not be read: its patch ./cordis.patch.yml is not a list of patch entries')
  })
})
