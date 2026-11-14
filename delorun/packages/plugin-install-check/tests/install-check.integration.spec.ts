/**
 * The install check over real profile directories (`src/check.ts`): the findings it shows for each package an
 * installation brings, the refusal of a known critical advisory until the person allows it, the trusted sources, the
 * linked folders it leaves alone, the install record it writes, and the change check that compares installed files
 * with that record. A loopback stand-in answers for the advisory feed and the registry.
 */
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPackage, checkProfileTrust, reconcileProfile, readPluginTrust, recordInstalled, type InstallCheckSettings, type PackageCheck } from '../src/check.ts'
import { readInstallRecord, recordPath, trustPath } from '../src/record.ts'
import { advisory, INTEGRITY, OLD, removeProfile, settingsFor, startStandIn, writeProfile, writeProfileFiles, type FixturePackage, type StandIn } from './fixture.ts'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')
const PLUGIN: FixturePackage = { name: 'good-plugin', version: '1.0.0', direct: true, dependencies: { 'left-pad': '1.3.0' } }
const DEPENDENCY: FixturePackage = { name: 'left-pad', version: '1.3.0' }

let standIn: StandIn
let profiles: string[]
let settings: InstallCheckSettings

beforeEach(async () => {
  standIn = await startStandIn({ advisories: {}, times: { 'good-plugin': { '1.0.0': OLD }, 'left-pad': { '1.3.0': OLD } } })
  settings = settingsFor(standIn)
  profiles = []
})

afterEach(async () => {
  await standIn.close()
  for (const dir of profiles) removeProfile(dir)
})

/**
 * A fixture profile, removed after the test.
 * @param packages - its packages.
 * @returns its directory.
 */
function profile(packages: readonly FixturePackage[]): string {
  const dir = writeProfile(packages)
  profiles.push(dir)
  return dir
}

/**
 * Check a plugin.
 * @param dir - the profile.
 * @param name - the plugin.
 * @param extra - request fields to change.
 * @returns the check.
 */
async function check(dir: string, name = 'good-plugin', extra: { allowedAdvisories?: string[], knownNames?: Set<string>, settings?: InstallCheckSettings, registries?: string[], confirmIntegrity?: boolean } = {}): Promise<PackageCheck> {
  const result = await checkPackage({ profileDir: dir, name, allowedAdvisories: extra.allowedAdvisories ?? [], knownNames: extra.knownNames ?? new Set(), registries: extra.registries ?? [], now: () => NOW, confirmIntegrity: extra.confirmIntegrity === true }, extra.settings ?? settings)
  // The fixture's packages are already installed, as after pnpm's installation and its builds.
  if (result.kind === 'checked' && result.pending !== undefined) await recordInstalled(dir, result.pending, { now: () => NOW, maxFiles: 1000 })
  return result
}

/**
 * The findings of a check that ran.
 * @param result - the check.
 * @returns its findings' rules and titles.
 */
function findings(result: PackageCheck): { rule: string, title: string, severity: string }[] {
  expect(result.kind).toBe('checked')
  return result.kind === 'checked' ? result.findings.map(({ rule, title, severity }) => ({ rule, title, severity })) : []
}

describe('the install check', () => {
  it('checks the plugin and every package it brings, records each file, and shows nothing for a clean installation', async () => {
    const dir = profile([PLUGIN, DEPENDENCY])
    const result = await check(dir)
    expect(findings(result)).toEqual([])
    expect(standIn.advisoryRequests).toEqual([{ 'good-plugin': ['1.0.0'], 'left-pad': ['1.3.0'] }])
    expect(standIn.documents.sort()).toEqual(['good-plugin', 'left-pad'])
    const record = await readInstallRecord(dir, 'good-plugin')
    expect(record?.source).toEqual({ kind: 'registry', reference: '1.0.0', integrity: expect.stringMatching(/^sha512-/u) as string })
    expect(record?.lockfileEntries).toEqual(['good-plugin@1.0.0', 'left-pad@1.3.0'])
    expect(record?.packages.map(pkg => [pkg.dir, Object.keys(pkg.files)])).toEqual([['node_modules/good-plugin', ['index.js', 'package.json']], ['node_modules/left-pad', ['index.js', 'package.json']]])
    expect(record?.packages[0]?.files['index.js']).toMatch(/^[0-9a-f]{64}$/u)
    expect(statSync(recordPath(dir, 'good-plugin')).mode & 0o777).toBe(0o600)
  })

  it('warns about an advisory, naming it and its severity, and does not refuse it', async () => {
    standIn.answers.advisories = { 'left-pad': [advisory('GHSA-2222-3333-4444', 'high', '<2.0.0')] }
    const result = await check(profile([PLUGIN, DEPENDENCY]))
    expect(findings(result)).toEqual([{ rule: 'advisory', severity: 'warning', title: 'GHSA-2222-3333-4444 (high) affects left-pad@1.3.0: A flaw in the package (GHSA-2222-3333-4444)' }])
    expect(result.kind === 'checked' && result.blocking).toEqual([])
    expect(result.kind === 'checked' && result.pending !== undefined).toBe(true)
  })

  it('refuses a known critical advisory and records nothing until the person allows that advisory', async () => {
    standIn.answers.advisories = { 'left-pad': [advisory('GHSA-2222-3333-4444', 'critical', '<2.0.0')] }
    const dir = profile([PLUGIN, DEPENDENCY])
    const refused = await check(dir)
    expect(refused.kind === 'checked' && refused.blocking.map(finding => finding.advisory)).toEqual(['GHSA-2222-3333-4444'])
    expect(refused.kind === 'checked' && refused.pending).toBeUndefined()
    expect(existsSync(recordPath(dir, 'good-plugin'))).toBe(false)
    const otherAllowed = await check(dir, 'good-plugin', { allowedAdvisories: ['GHSA-6666-7777-8888'] })
    expect(otherAllowed.kind === 'checked' && otherAllowed.blocking).toHaveLength(1)
    const allowed = await check(dir, 'good-plugin', { allowedAdvisories: ['GHSA-2222-3333-4444'] })
    expect(allowed.kind === 'checked' && allowed.blocking).toEqual([])
    expect(findings(allowed).map(finding => finding.severity)).toEqual(['critical'])
    expect((await readInstallRecord(dir, 'good-plugin'))?.allowedAdvisories).toEqual(['GHSA-2222-3333-4444'])
  })

  it('warns that the advisory check could not run when the feed fails, and does not refuse', async () => {
    standIn.answers.advisories = 503
    const result = await check(profile([PLUGIN, DEPENDENCY]))
    expect(findings(result)).toEqual([{ rule: 'advisory-unchecked', severity: 'warning', title: `The advisory check could not run, so known vulnerabilities were not looked up: the advisory feed ${standIn.feed} answered HTTP 503` }])
    expect(result.kind === 'checked' && result.blocking).toEqual([])
  })

  it('warns about a version published within the configured age, and about publish times it could not read', async () => {
    standIn.answers.times = { 'good-plugin': { '1.0.0': new Date(NOW - 3 * 3_600_000).toISOString() } }
    expect(findings(await check(profile([PLUGIN, DEPENDENCY])))).toEqual([
      { rule: 'recent-publish', severity: 'warning', title: 'good-plugin@1.0.0 was published 3 hours ago; a hijacked release is often caught in its first day' },
      { rule: 'publish-time-unchecked', severity: 'warning', title: `The publish time of 1 package could not be checked: left-pad@1.3.0: ${standIn.registry}left-pad answered HTTP 404` },
    ])
    expect(findings(await check(profile([PLUGIN, DEPENDENCY]), 'good-plugin', { settings: { ...settings, minimumAgeHours: 2 } }))).toHaveLength(1)
  })

  it('warns about a package without integrity and about git without a full commit', async () => {
    const dir = profile([
      { ...PLUGIN, dependencies: { 'left-pad': '1.3.0', 'from-git': 'git+https://example.test/o/r.git#main' } },
      { ...DEPENDENCY, resolution: '{tarball: https://example.test/left-pad.tgz}', source: '1.3.0' },
      { name: 'from-git', version: '0.1.0', source: 'git+https://example.test/o/r.git#main', resolution: '{type: git, repo: https://example.test/o/r.git, commit: main}' },
    ])
    expect(findings(await check(dir)).map(finding => finding.title)).toEqual([
      'left-pad has no integrity hash in the lockfile, so a later install is not held to the same bytes',
      'from-git comes from git without a full 40-character commit, so the same name can fetch other code later',
    ])
  })

  it('warns about a name close to one the profile or Delorun already has', async () => {
    const dir = profile([{ name: '@delorun/bundle-locai', version: '1.0.0', direct: true }])
    standIn.answers.times['@delorun/bundle-locai'] = { '1.0.0': OLD }
    expect(findings(await check(dir, '@delorun/bundle-locai', { knownNames: new Set(['@delorun/bundle-local']) }))).toEqual([
      { rule: 'similar-name', severity: 'warning', title: '@delorun/bundle-locai is named like @delorun/bundle-local, which this profile or Delorun already has; check that it is the package you meant' },
    ])
  })

  it('shows only critical advisories for a trusted npm scope, which still refuse', async () => {
    const registryPlugin: FixturePackage = { name: '@mine/plugin', version: '1.0.0', direct: true }
    const trusted = { ...settings, trustedSources: ['@mine'] }
    expect(findings(await check(profile([registryPlugin]), '@mine/plugin')).map(finding => finding.rule)).toEqual(['publish-time-unchecked'])
    expect(findings(await check(profile([registryPlugin]), '@mine/plugin', { settings: trusted }))).toEqual([])
    standIn.answers.advisories = { '@mine/plugin': [advisory('GHSA-2222-3333-4444', 'critical', '*')] }
    const result = await check(profile([registryPlugin]), '@mine/plugin', { settings: trusted })
    expect(result.kind === 'checked' && result.trusted).toBe(true)
    expect(result.kind === 'checked' && result.blocking).toHaveLength(1)
  })

  it('trusts a git owner for a plugin fetched from that owner\'s repository', async () => {
    const plugin: FixturePackage = { name: 'mine', version: '1.0.0', direct: true, source: 'https://codeload.github.com/me/mine/tar.gz/0123456789abcdef0123456789abcdef01234567', resolution: '{tarball: https://codeload.github.com/me/mine/tar.gz/0123456789abcdef0123456789abcdef01234567}' }
    const dir = profile([plugin])
    expect(findings(await check(dir, 'mine', { settings: { ...settings, trustedSources: ['github.com/me'] } }))).toEqual([])
    expect(findings(await check(profile([plugin]), 'mine', { settings: { ...settings, trustedSources: ['github.com/someone-else'] } })).map(finding => finding.rule)).toEqual(['missing-integrity'])
  })

  it('leaves a linked folder unchecked and unrecorded', async () => {
    const dir = profile([{ name: 'my-dev-plugin', version: '0.0.0', direct: true, source: 'link:../elsewhere' }])
    expect(await check(dir, 'my-dev-plugin')).toEqual({ kind: 'skipped', reason: 'local-folder' })
    expect(standIn.advisoryRequests).toEqual([])
    const status = await checkProfileTrust(dir, { full: true, now: () => NOW, maxFiles: 1000 })
    expect(status.plugins).toEqual([])
  })

  it('shows the recorded findings again for the same installation without asking the network', async () => {
    standIn.answers.advisories = { 'left-pad': [advisory('GHSA-2222-3333-4444', 'moderate', '*')] }
    const dir = profile([PLUGIN, DEPENDENCY])
    const first = findings(await check(dir))
    const requests = standIn.advisoryRequests.length
    expect(findings(await check(dir))).toEqual(first)
    expect(standIn.advisoryRequests).toHaveLength(requests)
  })

  it('checks only the packages an installation adds to the lockfile when another record already holds the rest', async () => {
    const dir = profile([PLUGIN, DEPENDENCY, { name: 'second-plugin', version: '2.0.0', direct: true, dependencies: { 'left-pad': '1.3.0' } }])
    standIn.answers.times['second-plugin'] = { '2.0.0': OLD }
    await check(dir)
    standIn.advisoryRequests.length = 0
    await check(dir, 'second-plugin')
    expect(standIn.advisoryRequests).toEqual([{ 'second-plugin': ['2.0.0'] }])
  })
})

describe('an installation a mirror resolved', () => {
  it('passes when the primary registry lists the lockfile\'s integrity for every package', async () => {
    standIn.answers.integrities = { 'good-plugin': { '1.0.0': INTEGRITY }, 'left-pad': { '1.3.0': INTEGRITY } }
    const result = await check(profile([PLUGIN, DEPENDENCY]), 'good-plugin', { confirmIntegrity: true })
    expect(findings(result)).toEqual([])
    expect(result.kind === 'checked' && result.pending !== undefined).toBe(true)
  })

  it('refuses a package whose lockfile integrity the primary registry contradicts, whatever is allowed', async () => {
    standIn.answers.integrities = { 'good-plugin': { '1.0.0': INTEGRITY }, 'left-pad': { '1.3.0': 'sha512-other' } }
    const dir = profile([PLUGIN, DEPENDENCY])
    const result = await check(dir, 'good-plugin', { confirmIntegrity: true })
    expect(result).toMatchObject({ kind: 'checked', refused: [{ rule: 'integrity-mismatch', package: 'left-pad', severity: 'critical' }], blocking: [] })
    expect(result.kind === 'checked' && result.pending).toBeUndefined()
    expect(existsSync(recordPath(dir, 'good-plugin'))).toBe(false)
  })

  it('needs acceptance when the primary registry cannot be reached or lists no integrity, never passing silently', async () => {
    standIn.answers.integrities = { 'good-plugin': { '1.0.0': INTEGRITY } }
    standIn.answers.times = { 'good-plugin': { '1.0.0': OLD } }
    const result = await check(profile([PLUGIN, DEPENDENCY]), 'good-plugin', { confirmIntegrity: true })
    expect(result.kind === 'checked' && result.refused).toEqual([])
    expect(result.kind === 'checked' && result.blocking.map(finding => [finding.rule, finding.package, finding.severity])).toEqual([['integrity-unconfirmed', 'left-pad', 'critical']])
    expect(findings(result).find(finding => finding.rule === 'integrity-unconfirmed')?.title).toMatch(/^The integrity of left-pad@1\.3\.0, which came through a mirror, is not confirmed against the primary registry: .*answered HTTP 404$/u)
    standIn.answers.times['left-pad'] = { '1.3.0': OLD }
    const unlisted = await check(profile([PLUGIN, DEPENDENCY]), 'good-plugin', { confirmIntegrity: true })
    expect(unlisted.kind === 'checked' && unlisted.blocking.map(finding => finding.rule)).toEqual(['integrity-unconfirmed'])
  })

  it('compares nothing for an installation the primary registry resolved', async () => {
    standIn.answers.integrities = { 'good-plugin': { '1.0.0': 'sha512-other' } }
    expect(findings(await check(profile([PLUGIN, DEPENDENCY])))).toEqual([])
  })
})

describe('the change check', () => {
  it('reports a plugin unchanged, then changed when an installed file is edited, added or removed, and records it', async () => {
    const dir = profile([PLUGIN, DEPENDENCY])
    await check(dir)
    const before = await checkProfileTrust(dir, { full: false, now: Date.now, maxFiles: 1000 })
    expect(before.plugins).toEqual([{ name: 'good-plugin', version: '1.0.0', state: 'unchanged', changedCount: 0, changedFiles: [], installFindings: 0, installedAt: NOW }])
    appendFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'globalThis.stolen = true\n')
    writeFileSync(join(dir, 'node_modules', 'good-plugin', 'added.js'), 'export {}\n')
    const quick = await checkProfileTrust(dir, { full: false, now: Date.now, maxFiles: 1000 })
    expect(quick.plugins[0]).toMatchObject({ state: 'changed', changedCount: 2, changedFiles: ['node_modules/good-plugin/added.js', 'node_modules/left-pad/index.js'] })
    expect(await readPluginTrust(dir)).toEqual(quick)
    expect(statSync(trustPath(dir)).mode & 0o777).toBe(0o600)
    const full = await checkProfileTrust(dir, { full: true, now: Date.now, maxFiles: 1000 })
    expect(full).toMatchObject({ mode: 'full', plugins: [{ state: 'changed', changedCount: 2 }] })
  })

  it('shows a changed plugin as a finding when it is enabled again, and never records the change as its new state', async () => {
    const dir = profile([PLUGIN, DEPENDENCY])
    await check(dir)
    const recorded = readFileSync(recordPath(dir, 'good-plugin'), 'utf8')
    writeFileSync(join(dir, 'node_modules', 'good-plugin', 'index.js'), 'export default "replaced"\n')
    expect(findings(await check(dir))).toEqual([{ rule: 'changed-files', severity: 'warning', title: '1 file of good-plugin changed since it was installed, such as node_modules/good-plugin/index.js; reinstall it if you did not change it' }])
    expect(readFileSync(recordPath(dir, 'good-plugin'), 'utf8')).toBe(recorded)
  })

  it('lists a plugin without a record as unrecorded, never as unchanged', async () => {
    const dir = profile([PLUGIN, DEPENDENCY])
    expect((await checkProfileTrust(dir, { full: false, now: () => NOW, maxFiles: 1000 })).plugins).toEqual([{ name: 'good-plugin', version: null, state: 'unrecorded', changedCount: 0, changedFiles: [], installFindings: 0, installedAt: null }])
  })

  it('reports a profile whose lockfile does not read', async () => {
    const dir = profile([PLUGIN])
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 5\n')
    const status = await checkProfileTrust(dir, { full: false, now: () => NOW, maxFiles: 1000 })
    expect(status.plugins).toEqual([])
    expect(status.problem).toMatch(/not a pnpm lockfile of version 9/u)
  })
})

describe('bringing records in step with a profile', () => {
  it('checks new and changed installations only, and removes the records of removed plugins', async () => {
    const dir = profile([PLUGIN, DEPENDENCY])
    const first = await reconcileProfile({ profileDir: dir, allowedAdvisories: [], knownNames: new Set(), registries: [], now: () => NOW }, settings)
    expect(first.checked.map(each => each.name)).toEqual(['good-plugin'])
    for (const { check: each } of first.checked) if (each.kind === 'checked' && each.pending !== undefined) await recordInstalled(dir, each.pending, { now: () => NOW, maxFiles: 1000 })
    expect((await reconcileProfile({ profileDir: dir, allowedAdvisories: [], knownNames: new Set(), registries: [], now: () => NOW }, settings)).checked).toEqual([])
    writeProfileFiles(dir, [{ ...DEPENDENCY, direct: true }])
    const result = await reconcileProfile({ profileDir: dir, allowedAdvisories: [], knownNames: new Set(), registries: [], now: () => NOW }, settings)
    expect(result.removed).toEqual(['good-plugin'])
    expect(existsSync(recordPath(dir, 'good-plugin'))).toBe(false)
  })
})

describe('the check before installation', () => {
  it('reads the lockfile alone, so it answers before any file is installed, and records nothing until asked', async () => {
    const dir = profile([PLUGIN, DEPENDENCY])
    rmSync(join(dir, 'node_modules'), { recursive: true })
    standIn.answers.advisories = { 'left-pad': [advisory('GHSA-2222-3333-4444', 'moderate', '*')] }
    const result = await checkPackage({ profileDir: dir, name: 'good-plugin', allowedAdvisories: [], knownNames: new Set(), registries: [], now: () => NOW }, settings)
    expect(result).toMatchObject({ kind: 'checked', version: '1.0.0', findings: [{ rule: 'advisory', package: 'left-pad' }] })
    expect(existsSync(recordPath(dir, 'good-plugin'))).toBe(false)
    writeProfileFiles(dir, [PLUGIN, DEPENDENCY])
    expect(result.kind === 'checked' && result.pending !== undefined && await recordInstalled(dir, result.pending, { now: () => NOW, maxFiles: 1000 })).toBe(true)
    expect((await readInstallRecord(dir, 'good-plugin'))?.findings.map(finding => finding.rule)).toEqual(['advisory'])
  })

  it('records nothing when the lockfile names another reference than the check read', async () => {
    const dir = profile([PLUGIN, DEPENDENCY])
    const result = await checkPackage({ profileDir: dir, name: 'good-plugin', allowedAdvisories: [], knownNames: new Set(), registries: [], now: () => NOW }, settings)
    writeProfileFiles(dir, [{ ...PLUGIN, version: '2.0.0' }, DEPENDENCY])
    expect(result.kind === 'checked' && result.pending !== undefined && await recordInstalled(dir, result.pending, { now: () => NOW, maxFiles: 1000 })).toBe(false)
  })

  it('warns about a plain http registry and a plain http download, and installs them', async () => {
    const dir = profile([{ ...PLUGIN, dependencies: { 'left-pad': '1.3.0' } }, { ...DEPENDENCY, resolution: `{integrity: sha512-x, tarball: 'http://downloads.example.test/left-pad.tgz'}` }])
    const result = await check(dir, 'good-plugin', { registries: ['http://registry.example.test/', 'https://registry.npmjs.org/'] })
    expect(findings(result).filter(finding => finding.rule === 'insecure-source')).toEqual([
      { rule: 'insecure-source', severity: 'warning', title: 'The registry http://registry.example.test/ is plain http, so a package and its integrity hash could be altered in transit; a lockfile hash only holds later installs to the bytes this one received' },
      { rule: 'insecure-source', severity: 'warning', title: 'left-pad is downloaded over plain http (http://downloads.example.test/left-pad.tgz), so it could be altered in transit; its lockfile integrity hash only holds later installs to the bytes this one received' },
    ])
    expect(result.kind === 'checked' && result.blocking).toEqual([])
  })
})
