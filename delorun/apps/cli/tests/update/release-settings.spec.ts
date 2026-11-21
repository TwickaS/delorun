/**
 * What two installed releases' signed bundles change in protected rows (`delorun/apps/cli/src/update/release-settings.ts`):
 * each release is checked first, its bundles resolve only from its own `app/` directory, and a bundle whose metadata
 * cannot be read stops the derivation.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { StorePaths } from '@delorun/runtime-store'
import { rowSettingsFact, type LayerFact } from '@delorun/update'
import type { BundleLayerFacts, BundleLayerOptions } from '../../src/update/bundle-layers.ts'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { signedSettingChanges } from '../../src/update/release-settings.ts'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'drs-')))
const OLD = brandString<RuntimeVersion>('0.1.0-preview.2.3')
const NEW = brandString<RuntimeVersion>('0.1.0-preview.2.5')
const SEATS = '@delorun/plugin-agent-seats'
const paths = new StorePaths(home, runtimePlatformOf(process.platform, process.arch))

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

mkdirSync(join(home, 'profiles', 'default'), { recursive: true })
writeFileSync(join(home, 'profiles', 'default', 'package.json'), JSON.stringify({ name: 'profile', dsh: { profile: { bundles: ['@delorun/bundle-local'] } } }))

/**
 * A layer that protects the seats plugin and gives its row settings.
 * @param config - the row's keys.
 * @returns the layer.
 */
function layer(config: Record<string, boolean>): LayerFact {
  return { layer: '@delorun/bundle-local', rows: [], settings: [rowSettingsFact('plugin-manager', undefined, { protectedPlugins: [SEATS] }), rowSettingsFact('delorun-agent-seats', SEATS, config)] }
}

/**
 * Options whose check and bundle reader are fakes that record what they were asked.
 * @param read - the layers each release's directory gives, by version.
 * @param failing - a release whose check fails.
 * @returns the options and what was asked.
 */
function fakes(read: Readonly<Record<string, BundleLayerFacts>>, failing?: RuntimeVersion): { readonly options: Parameters<typeof signedSettingChanges>[0], readonly checked: string[], readonly reads: BundleLayerOptions[] } {
  const checked: string[] = []
  const reads: BundleLayerOptions[] = []
  return {
    checked, reads,
    options: {
      home, profile: 'default', running: NEW, platform: 'linux',
      check: async (version) => {
        checked.push(version)
        if (version === failing) throw new Error(`files of ${version} differ`)
        return Promise.resolve({ manifest: { version: brandString<SemanticVersion>(version), dsh: brandString<SemanticVersion>('0.2.2-rc.3') } })
      },
      layers: async (_bundles, options) => {
        reads.push(options)
        const version = [OLD, NEW].find(candidate => options.anchors[0]?.startsWith(paths.version(candidate)))
        return Promise.resolve(read[version ?? ''] ?? { layers: [], skipped: [] })
      },
    },
  }
}

describe('signedSettingChanges', () => {
  it('names the protected-row settings the two releases\' bundles give differently, after checking both', async () => {
    const { options, checked, reads } = fakes({ [OLD]: { layers: [layer({})], skipped: [] }, [NEW]: { layers: [layer({ enabled: true })], skipped: [] } })

    expect(await signedSettingChanges(options, OLD)).toEqual([{ id: 'delorun-agent-seats', plugin: SEATS, layer: '@delorun/bundle-local', change: 'changed', keys: [{ key: 'enabled', after: true }] }])
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
    const { options } = fakes({ [NEW]: { layers: [], skipped: [{ package: '@delorun/bundle-local', reason: 'its patch ./cordis.patch.yml is not a list of patch entries', verification: 'unverified' }] } })
    await expect(signedSettingChanges(options, OLD)).rejects.toThrow('the bundle @delorun/bundle-local of release 0.1.0-preview.2.5 could not be read: its patch ./cordis.patch.yml is not a list of patch entries')
  })
})
