/**
 * The plugins this bundle has plugin management protect: every consent and guard row it mounts with its C16 switch on,
 * and the plugins of upstream's sandbox rows. The refusals themselves are proven against this file by the plugin
 * manager's `delo-protected-plugins.spec.ts`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { LOCAL_ROWS } from '../src/profile.ts'
import { PACKAGE_DIR, REPO } from './profiles.ts'

type Patch = Record<string, unknown>

/** This bundle's patch file, parsed with its `!!js` values kept. */
const patches = yaml.load(readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as Patch[]

/** The rows this bundle inserts. */
const inserted = patches.flatMap(patch => Array.isArray(patch['insert']) ? patch['insert'] as Patch[] : [])

/** The `protectedPlugins` this bundle gives the plugin-manager row. */
function protectedPlugins(): unknown {
  const row = patches.find(patch => patch['id'] === 'plugin-manager')
  return (row?.['config'] as Patch | undefined)?.['protectedPlugins']
}

/** The module upstream's base bundle mounts as one row id. */
function baseRowName(id: string): unknown {
  const base = yaml.load(readFileSync(join(REPO, 'packages/bundle/base/cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as Patch[]
  return base.flatMap(patch => Array.isArray(patch['insert']) ? patch['insert'] as Patch[] : []).find(row => row['id'] === id)?.['name']
}

describe('the plugin-manager row of @delo/bundle-local', () => {
  it('protects every row this bundle mounts with a C16 switch on, and nothing it does not mount', () => {
    const guards = inserted.filter(row => (row['config'] as Patch | undefined)?.['enabled'] === true && row['disabled'] === undefined).map(row => row['name'])
    expect(guards).toEqual([
      '@delo/plugin-instruction-consent', '@delo/plugin-mcp-consent', '@delo/plugin-permission-defaults',
      '@delo/plugin-schedule-consent', '@delo/plugin-fetch-guard', '@delo/plugin-delegation-consent', '@delo/plugin-changes', '@delo/bundle-local/update-gate', '@delo/bundle-local/update-check',
      '@delo/bundle-local/trust', '@delo/plugin-install-check', '@delo/reach',
    ])
    // home-auth has no switch; it is protected so no chat points the home's device records elsewhere.
    expect(protectedPlugins()).toEqual([...guards, '@delo/home-auth', baseRowName('sandbox'), baseRowName('sandbox-policy')])
  })

  it('protects the plugins of upstream\'s sandbox and sandbox-policy rows, the sandbox row\'s protected home included', () => {
    expect(protectedPlugins()).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-policy']))
    expect([baseRowName('sandbox'), baseRowName('sandbox-policy')]).toEqual(['@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-policy'])
  })

  it('is listed as a changed row whose parity form is upstream\'s', () => {
    expect(LOCAL_ROWS.find(row => row.id === 'plugin-manager')).toMatchObject({ kind: 'changed', parity: { kind: 'upstream' } })
  })
})
