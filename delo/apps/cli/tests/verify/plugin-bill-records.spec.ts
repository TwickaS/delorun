/**
 * The trust bill's plugin install check over recorded installs: a record fills integrity, commit and warnings, a file
 * changed after the record is a `mismatch`, a plugin without a record is `unrecorded`, and only critical findings
 * that name an advisory are listed as advisories.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordInstalled, type InstallFinding } from '@delo/plugin-install-check/check'
import { INTEGRITY, writeProfileFiles } from '@delo/plugin-install-check/tests/fixture'
import { profileDirectory } from '../../src/profile.ts'
import { installedPluginsCheck } from '../../src/verify/plugin-bill.ts'

vi.mock('../../src/plugin-install-check.ts', () => ({
  profileCheckSettings: () => ({ settings: { maxFiles: 1000 }, knownNames: new Set<string>() }),
}))

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * A profile with the given plugins installed and recorded.
 * @param names - plugins to install; each is listed in the lockfile and installed at version 1.0.0.
 * @param findings - the findings recorded for `recorded`.
 * @param recorded - the plugins to record; the others stay unrecorded.
 * @returns the home.
 */
async function profileWith(names: readonly string[], findings: readonly InstallFinding[], recorded: readonly string[]): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'delo-plugin-bill-'))
  homes.push(home)
  const directory = profileDirectory(home, 'default')
  mkdirSync(directory, { recursive: true })
  writeProfileFiles(directory, names.map(name => ({ name, version: '1.0.0', direct: true })))
  for (const name of recorded) {
    const done = await recordInstalled(directory, { name, version: '1.0.0', source: { kind: 'registry', reference: '1.0.0', integrity: INTEGRITY, commit: 'abc123' }, findings, allowedAdvisories: [], lockfileEntries: [`${name}@1.0.0`] }, { now: Date.now, maxFiles: 1000 })
    expect(done).toBe(true)
  }
  return home
}

const finding = (overrides: Partial<InstallFinding>): InstallFinding => ({ rule: 'advisory', title: 'a finding', package: 'p', path: 'pnpm-lock.yaml', line: 0, severity: 'warning', ...overrides })

describe('the bill\'s plugin install check over install records', () => {
  it('reads integrity, commit and a match from the record of unchanged files', async () => {
    const home = await profileWith(['good-plugin'], [], ['good-plugin'])
    const plugins = await installedPluginsCheck(join(home, 'package.json')).check(home, 'default')
    expect(plugins.status).toBe('known')
    expect(plugins.entries).toEqual([{ name: 'good-plugin', source: 'registry', version: '1.0.0', integrity: INTEGRITY, commit: 'abc123', match: 'match', warnings: [], criticalAdvisories: [] }])
  })

  it('reports a mismatch when an installed file differs from its record, and unrecorded for a plugin without one', async () => {
    const home = await profileWith(['good-plugin', 'other-plugin'], [], ['good-plugin'])
    appendFileSync(join(profileDirectory(home, 'default'), 'node_modules', 'good-plugin', 'index.js'), 'globalThis.planted = true\n')
    const plugins = await installedPluginsCheck(join(home, 'package.json')).check(home, 'default')
    expect(plugins.entries.map(entry => [entry.name, entry.match, entry.integrity])).toEqual([['good-plugin', 'mismatch', INTEGRITY], ['other-plugin', 'unrecorded', null]])
  })

  it('maps warnings to titles and lists only critical findings that carry an advisory', async () => {
    const findings = [
      finding({ severity: 'warning', title: 'no integrity', advisory: 'GHSA-aaaa-bbbb-cccc' }),
      finding({ severity: 'critical', title: 'known advisory', advisory: 'GHSA-xxxx-yyyy-zzzz' }),
      finding({ rule: 'missing-integrity', severity: 'critical', title: 'critical without an advisory' }),
    ]
    const home = await profileWith(['good-plugin'], findings, ['good-plugin'])
    const [entry] = (await installedPluginsCheck(join(home, 'package.json')).check(home, 'default')).entries
    expect(entry?.warnings).toEqual(['no integrity'])
    expect(entry?.criticalAdvisories).toEqual(['GHSA-xxxx-yyyy-zzzz'])
  })
})
