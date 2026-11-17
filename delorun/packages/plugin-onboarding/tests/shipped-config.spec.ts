import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { Config, ONBOARDING_ROW_ID } from '../src/config.ts'

/** `!!js` expressions are read as the text they hold; the checked config never uses one. */
const SCHEMA = DEFAULT_SCHEMA.extend(['scalar', 'sequence', 'mapping'].map(kind => new Type('tag:yaml.org,2002:js', { kind: kind as 'scalar', construct: (data: unknown) => data })))

const PACKAGES = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** One row of a bundle's patch. */
interface PatchRow { readonly id?: string; readonly config?: Record<string, unknown>; readonly insert?: readonly PatchRow[] }

/**
 * Every bundle's `cordis.patch.yml` rows that configure the guide.
 * @returns the bundle directory and its onboarding config, for each bundle that sets one.
 */
function shippedOnboardingConfigs(): readonly (readonly [string, Record<string, unknown>])[] {
  const found: (readonly [string, Record<string, unknown>])[] = []
  for (const dir of readdirSync(PACKAGES).filter(name => name.startsWith('bundle-'))) {
    let text: string
    try { text = readFileSync(join(PACKAGES, dir, 'cordis.patch.yml'), 'utf8') } catch { continue }
    const rows = load(text, { schema: SCHEMA }) as readonly PatchRow[] | null
    // A patch is a list of operations; `insert` holds the rows it adds.
    for (const operation of rows ?? []) {
      for (const row of [operation, ...operation.insert ?? []]) if (row.id === ONBOARDING_ROW_ID && row.config !== undefined) found.push([dir, row.config])
    }
  }
  return found
}

describe('the guide configuration the bundles ship', () => {
  it('finds the studio bundle\'s row, so this check does not pass by reading nothing', () => {
    expect(shippedOnboardingConfigs().map(([dir]) => dir)).toContain('bundle-studio')
  })

  it.each(shippedOnboardingConfigs())('%s: its delorun-onboarding config validates against the plugin\'s schema', (_, config) => {
    expect(() => Config(config)).not.toThrow()
  })
})
