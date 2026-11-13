/**
 * The `delo-plugin-changes` row names the bundles safe mode from the studio's recovery screen keeps: Delo's profile
 * bundle list, which `delorun recover safe-mode` passes. The plugin cannot import that list, because this package
 * depends on the plugin, so the row restates it and this spec holds the two equal.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { Config } from '@delo/plugin-changes'
import { DELO_PROFILE_BUNDLES } from '../src/profile.ts'
import { PACKAGE_DIR } from './profiles.ts'

type Patch = Record<string, unknown>

it('names Delo\'s profile bundle list as the bundles safe mode keeps', () => {
  const patches = yaml.load(readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as Patch[]
  const row = patches.flatMap(patch => Array.isArray(patch['insert']) ? patch['insert'] as Patch[] : []).find(candidate => candidate['id'] === 'delo-plugin-changes')
  const config = Config(row?.['config'] as never)
  expect(config.installationBundles).toEqual([...DELO_PROFILE_BUNDLES])
  expect(config.enabled).toBe(true)
})
