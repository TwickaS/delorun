/**
 * The trust bill's plugin install check: with the check off for a profile, the plugins are listed and `unknown` with the
 * reason, never `match`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { profileDirectory } from '../../src/profile.ts'
import { installedPluginsCheck } from '../../src/verify/plugin-bill.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('the bill\'s plugin install check', () => {
  it('lists a profile\'s plugins as unknown, naming the reason, when the profile has no install check row', async () => {
    const home = mkdtempSync(join(tmpdir(), 'delo-plugin-bill-'))
    homes.push(home)
    const directory = profileDirectory(home, 'default')
    mkdirSync(join(directory, 'node_modules', 'good-plugin'), { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ dependencies: { 'good-plugin': '^1.0.0' } }))
    writeFileSync(join(directory, 'node_modules', 'good-plugin', 'package.json'), JSON.stringify({ name: 'good-plugin', version: '1.2.3' }))
    const plugins = await installedPluginsCheck(join(home, 'no-such-anchor', 'package.json')).check(home, 'default')
    expect(plugins.status).toBe('unknown')
    expect(plugins.reason).toBe('the plugin install check is switched off for this profile')
    expect(plugins.entries).toEqual([{ name: 'good-plugin', source: 'registry', version: '1.2.3', integrity: null, commit: null, match: 'unknown', warnings: [], criticalAdvisories: [] }])
  })
})
