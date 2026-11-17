/**
 * The plugins this bundle has plugin management protect: every consent and guard row it mounts with its C16 switch on,
 * and the plugins of upstream's sandbox rows. The refusals themselves are proven against this file by the plugin
 * manager's `delorun-protected-plugins.spec.ts`.
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

describe('the plugin-manager row of @delorun/bundle-local', () => {
  it('protects every row this bundle mounts with a C16 switch on, and nothing it does not mount', () => {
    // The rename tool only adds one tool that asks, so turning it off removes a convenience and no guard. The start gate of
    // live agents holds its switch in `limitRefusal`, and protecting it keeps a model from raising its cap (review D7).
    const switchOn = (config: Patch | undefined): boolean => config?.['enabled'] === true || config?.['limitRefusal'] === true
    const guards = inserted.filter(row => switchOn(row['config'] as Patch | undefined) && row['disabled'] === undefined && row['name'] !== '@delorun/bundle-local/workspace-rename').map(row => row['name'])
    expect(guards).toEqual([
      '@delorun/plugin-instruction-consent', '@delorun/plugin-mcp-consent', '@delorun/plugin-permission-defaults',
      '@delorun/plugin-schedule-consent', '@delorun/plugin-fetch-guard', '@delorun/plugin-tool-failure-guard', '@delorun/plugin-delegation-consent', '@delorun/external-agents', '@delorun/plugin-changes', '@delorun/bundle-local/update-gate', '@delorun/bundle-local/update-check',
      '@delorun/bundle-local/trust', '@delorun/plugin-install-check', '@delorun/reach',
    ])
    // home-auth has no switch; it is protected so no chat points the home's device records elsewhere.
    expect(protectedPlugins()).toEqual([...guards, '@delorun/home-auth', baseRowName('sandbox'), baseRowName('sandbox-policy')])
  })

  it('protects the plugins of upstream\'s sandbox and sandbox-policy rows, the sandbox row\'s protected home included', () => {
    expect(protectedPlugins()).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-policy']))
    expect([baseRowName('sandbox'), baseRowName('sandbox-policy')]).toEqual(['@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-policy'])
  })

  it('is listed as a changed row whose parity form is upstream\'s', () => {
    expect(LOCAL_ROWS.find(row => row.id === 'plugin-manager')).toMatchObject({ kind: 'changed', parity: { kind: 'upstream' } })
  })
})
