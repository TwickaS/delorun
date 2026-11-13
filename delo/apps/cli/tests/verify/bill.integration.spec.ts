/**
 * The trust bill `delorun verify` prints and the studio's Host row serves: the start stage reports the launcher's start
 * check without hashing, the verify stage hashes every file; each reader turns a planted fault into an `unknown` section
 * with its reason and never into a pass; the plugin source kinds, the `!!js` count, the skill roots and MCP servers come
 * from the profile's files; the summary never reads as a plain pass while a row is unknown; `--json` carries the bill;
 * and the printed block escapes control characters in names and paths. Every log answer comes from the fixture's `fetch`.
 */
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRUST_BILL_SCHEMA, trustBadge, trustRows, type TrustBill } from '@delo/bundle-local/trust-bill'
import { DELO_HOME_ENTRIES, TRUST_FILES } from '@delo/contract-home-layout'
import { checkStatePath } from '@delo/release-verify'
import { START_CHECK_SCHEMA, startCheckHandoffText } from '@delo/runtime-store'
import { EXIT } from '../../src/exit.ts'
import { NO_CHANGES, runVerifyStage, startBill, type BillContext, type ChangesReader, type PluginInstallCheck } from '../../src/verify/bill.ts'
import { countExpressions, NO_INSTALL_CHECK, pluginSourceOf } from '../../src/verify/bill-profile.ts'
import { billLines, billSuffix, ownChangesLine } from '../../src/verify/bill-text.ts'
import { createVerifyCommand, reportLines, stderrLogger, summaryLine } from '../../src/verify/index.ts'
import { installedHome, makeWritable, NOW, PLATFORM, RELEASE, type InstalledHome } from './fixtures.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    makeWritable(dirname(home))
    rmSync(dirname(home), { recursive: true, force: true })
  }
})

/**
 * A fixture home, removed after the spec.
 * @returns the home.
 */
async function home(): Promise<InstalledHome> {
  const fixture = await installedHome()
  homes.push(fixture.home)
  return fixture
}

/** When the fixture launcher's start check ran, in milliseconds. */
const STARTED_AT = (NOW - 120) * 1000

/**
 * The launcher's handoff for a release.
 * @param release - the release it names.
 * @returns the variable's text.
 */
function handoff(release: string = RELEASE): string {
  return startCheckHandoffText({ schema: START_CHECK_SCHEMA, release, at: STARTED_AT, full: false, hashed: 3, files: 5, fullCheckAt: STARTED_AT - 86_400_000, launcher: { version: '1.4.0', path: '/opt/delorun-launcher' } })
}

/**
 * The context of a bill over a fixture home.
 * @param fixture - the home.
 * @param env - variables beside the launcher's roots.
 * @param extra - readers of the other components.
 * @returns the context.
 */
function context(fixture: InstalledHome, env: Record<string, string | undefined> = {}, extra: Pick<BillContext, 'plugins' | 'changes'> = {}): BillContext {
  const agents = join(dirname(fixture.home), 'agents')
  return { home: fixture.home, profile: 'default', platform: PLATFORM, running: RELEASE, env: { DELO_LAUNCHER_ROOTS: fixture.launcherRoots, DSH_AGENTS_HOME: agents, ...env }, now: NOW, ...extra }
}

/** A logger that drops everything. */
const QUIET = stderrLogger({ stdout: () => undefined, stderr: () => undefined })

/**
 * Write a file of the profile, creating its directory.
 * @param fixture - the home.
 * @param name - the path below the profile's directory.
 * @param text - the content.
 * @returns the file's path.
 */
function profileFile(fixture: InstalledHome, name: string, text: string): string {
  const path = join(fixture.home, 'profiles', 'default', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/**
 * Change a runtime file in place, as a program with the person's access can.
 * @param fixture - the home.
 */
function changeLicence(fixture: InstalledHome): void {
  const path = join(fixture.home, 'runtimes', RELEASE, 'node', 'LICENSE')
  makeWritable(dirname(path))
  chmodSync(path, 0o644)
  writeFileSync(path, 'changed\n')
}

describe('the start stage', { timeout: 30_000 }, () => {
  it('reports the launcher\'s start check as a pass without hashing, while the verify stage hashes and fails the files', async () => {
    const fixture = await home()
    changeLicence(fixture)
    const bill = await startBill(context(fixture, { DELO_START_CHECK: handoff() }))
    expect(bill).toMatchObject({ schema: TRUST_BILL_SCHEMA, stage: 'start', generatedAt: new Date(NOW * 1000).toISOString().replace('.000Z', 'Z') })
    expect(bill.release).toMatchObject({
      version: RELEASE,
      signature: 'pass',
      files: 'pass',
      launcher: { version: '1.4.0', path: '/opt/delorun-launcher' },
      lastFullHashAt: new Date(STARTED_AT - 86_400_000).toISOString().replace('.000Z', 'Z'),
      startCheck: { at: new Date(STARTED_AT).toISOString().replace('.000Z', 'Z'), full: false, hashed: 3, files: 5 },
      root: { version: 1, anchored: 'shipped' },
    })
    expect(bill.release.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(bill.release.manifestSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(bill.release.fileListSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(bill.release.detail).toBeUndefined()
    const { bill: verified, outcome } = await runVerifyStage(context(fixture, { DELO_START_CHECK: handoff() }), { fetch: fixture.tiles.fetch, logger: QUIET })
    expect(verified.stage).toBe('verify')
    expect(verified.release).toMatchObject({ signature: 'pass', files: 'fail', lastFullHashAt: new Date(NOW * 1000).toISOString().replace('.000Z', 'Z') })
    expect(verified.release.detail).toContain('RUNTIME_CHANGED')
    expect(outcome.results.find(result => result.id === 'runtime-files')?.result).toBe('fail')
    expect(verified.releaseLog.state).toBe('verified')
  })

  it('leaves the signature and files unknown without a handoff, and ignores a handoff for another release', async () => {
    const fixture = await home()
    for (const env of [{}, { DELO_START_CHECK: handoff('0.2.0') }, { DELO_START_CHECK: '{"schema":"delo.start-check/1"}' }]) {
      const bill = await startBill(context(fixture, env))
      expect(bill.release).toMatchObject({ signature: 'unknown', files: 'unknown', startCheck: null, lastFullHashAt: null, launcher: { version: null, path: dirname(fixture.launcherRoots) } })
      expect(bill.release.detail).toContain('no start check of this release was handed over by the launcher')
      expect(trustRows(bill)[0]!.state).toBe('unknown')
    }
  })

  it('turns an unreadable trusted root into a failed signature with no root, and keeps every other section', async () => {
    const fixture = await home()
    writeFileSync(join(fixture.home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root), 'not a root', { mode: 0o600 })
    const bill = await startBill(context(fixture, { DELO_START_CHECK: handoff() }))
    expect(bill.release).toMatchObject({ signature: 'fail', root: null, commit: null, manifestSha256: null, fileListSha256: null })
    expect(bill.release.detail).toContain('does not read')
    expect(bill.releaseLog.state).toBe('unknown')
    expect(bill.skills.roots.map(root => root.source)).toEqual(['user-dsh', 'user-agents'])
  })
})

describe('the release log', { timeout: 30_000 }, () => {
  it('is unknown with a reason when no record exists, and when the record is laxer than 0600', async () => {
    const fixture = await home()
    expect((await startBill(context(fixture))).releaseLog).toEqual({ state: 'unknown', lastAttempt: null, uncheckedSince: null, detail: `no release-log check is recorded for release ${RELEASE}` })
    await runVerifyStage(context(fixture), { fetch: undefined, logger: QUIET })
    const recorded = (await startBill(context(fixture))).releaseLog
    expect(recorded).toMatchObject({ state: 'unchecked', lastAttempt: new Date(NOW * 1000).toISOString().replace('.000Z', 'Z'), uncheckedSince: new Date(NOW * 1000).toISOString().replace('.000Z', 'Z') })
    chmodSync(checkStatePath(fixture.home), 0o644)
    const lax = (await startBill(context(fixture))).releaseLog
    expect(lax.state).toBe('unknown')
    expect(lax.detail).toContain('the release-log record does not read')
  })
})

describe('plugins', { timeout: 30_000 }, () => {
  it('classifies every source kind from its spec', () => {
    expect(Object.fromEntries(['^1.2.0', '1.0.0', 'latest', 'npm:other@1', 'git+https://example.com/a.git', 'github:owner/repo', 'owner/repo#main', 'link:../plugin', 'file:../plugin', 'file:plugin-1.0.0.tgz', './plugin.tar.gz', 'https://example.com/plugin.tgz', 'workspace:*'].map(spec => [spec, pluginSourceOf(spec)]))).toEqual({
      '^1.2.0': 'registry',
      '1.0.0': 'registry',
      'latest': 'registry',
      'npm:other@1': 'registry',
      'git+https://example.com/a.git': 'git',
      'github:owner/repo': 'git',
      'owner/repo#main': 'git',
      'link:../plugin': 'link',
      'file:../plugin': 'file',
      'file:plugin-1.0.0.tgz': 'tarball',
      './plugin.tar.gz': 'tarball',
      'https://example.com/plugin.tgz': 'tarball',
      'workspace:*': 'unknown',
    })
  })

  it('lists the profile\'s dependencies with installed versions, every match unknown, without an install check', async () => {
    const fixture = await home()
    profileFile(fixture, 'package.json', JSON.stringify({ dependencies: { 'delo-plugin-a': '^1.0.0', '@scope/b': 'github:owner/b', 'linked': 'link:../linked', '../escape': '1.0.0' } }))
    profileFile(fixture, 'node_modules/delo-plugin-a/package.json', JSON.stringify({ name: 'delo-plugin-a', version: '1.2.3' }))
    profileFile(fixture, 'node_modules/@scope/b/real.json', JSON.stringify({ version: '9.9.9' }))
    symlinkSync('real.json', join(fixture.home, 'profiles', 'default', 'node_modules', '@scope', 'b', 'package.json'))
    const { plugins } = await startBill(context(fixture))
    expect(plugins.status).toBe('unknown')
    expect(plugins.reason).toBe(NO_INSTALL_CHECK)
    expect(plugins.entries).toEqual([
      { name: '../escape', source: 'registry', version: null, integrity: null, commit: null, match: 'unknown', warnings: [], criticalAdvisories: [] },
      { name: '@scope/b', source: 'git', version: null, integrity: null, commit: null, match: 'unknown', warnings: [], criticalAdvisories: [] },
      { name: 'delo-plugin-a', source: 'registry', version: '1.2.3', integrity: null, commit: null, match: 'unknown', warnings: [], criticalAdvisories: [] },
      { name: 'linked', source: 'link', version: null, integrity: null, commit: null, match: 'unknown', warnings: [], criticalAdvisories: [] },
    ])
  })

  it('is unknown with the reason when the profile\'s package.json does not read, or the install check fails', async () => {
    const fixture = await home()
    profileFile(fixture, 'package.json', '{ not json')
    const unread = (await startBill(context(fixture))).plugins
    expect(unread.status).toBe('unknown')
    expect(unread.reason).toContain('the profile\'s package.json does not read')
    const failing: PluginInstallCheck = { check: () => Promise.reject(new Error('install records are unreadable')) }
    const failed = (await startBill(context(fixture, {}, { plugins: failing }))).plugins
    expect(failed.status).toBe('unknown')
    expect(failed.reason).toContain('the plugin install check failed: install records are unreadable')
    const passing: PluginInstallCheck = { check: () => Promise.resolve({ status: 'known', entries: [{ name: 'a', source: 'registry', version: '1.0.0', integrity: 'sha512-x', commit: null, match: 'match', warnings: [], criticalAdvisories: [] }] }) }
    expect((await startBill(context(fixture, {}, { plugins: passing }))).plugins.status).toBe('known')
  })
})

describe('changes', { timeout: 30_000 }, () => {
  it('is unknown without Changes, and maps a Changes reading', async () => {
    const fixture = await home()
    expect((await startBill(context(fixture))).changes).toEqual({ status: 'unknown', reason: NO_CHANGES, harnessEdits: [], approvedPlugins: [], notReviewed: 0 })
    const reader: ChangesReader = { read: (_home, _profile, release) => Promise.resolve({ harnessEdits: [{ file: `runtimes/${release}/app/x.js` }], approvedPlugins: [{ plugin: 'a', version: null, source: '/src/a' }], notReviewed: 2 }) }
    const bill = await startBill(context(fixture, {}, { changes: reader }))
    expect(bill.changes).toEqual({ status: 'known', harnessEdits: [{ file: `runtimes/${RELEASE}/app/x.js` }], approvedPlugins: [{ plugin: 'a', version: null, source: '/src/a' }], notReviewed: 2 })
    expect(trustRows(bill)[3]).toEqual({ id: 'changes', state: 'waiting', tone: 'neutral', ownChanges: 4 })
    const failing: ChangesReader = { read: () => Promise.reject(new Error('the change log is torn')) }
    expect((await startBill(context(fixture, {}, { changes: failing }))).changes).toMatchObject({ status: 'unknown', reason: 'Changes does not read: the change log is torn' })
  })
})

describe('patches, skills and MCP servers', { timeout: 30_000 }, () => {
  const PROFILE_PATCH = [
    '- insert:',
    '    - id: my-tool',
    '      name: my-plugin',
    '      config:',
    '        enabled: !!js "process.env.X === \'1\'"',
    '    - group: true',
    '      config:',
    '        - id: inner',
    '          name: inner-plugin',
    '    - id: docs-mcp',
    `      name: '@deepseek-ai/dsh-mcp-client'`,
    '      config:',
    '        serverName: docs',
    '        transport: stdio',
    '        command: docs-server',
    '- id: skill-filesystem',
    '  config:',
    '    customSkillDirs: [/srv/team-skills]',
    '    watch: !!js "true"',
    '',
  ].join('\n')

  it('lists inserted rows, counts !!js values, and reads skill roots and MCP servers from the person\'s layers', async () => {
    const fixture = await home()
    const profilePatch = profileFile(fixture, 'cordis.patch.yml', PROFILE_PATCH)
    const homePatch = join(fixture.home, 'cordis.patch.yml')
    writeFileSync(homePatch, '- insert:\n    - id: home-row\n      name: home-plugin\n      disabled: !!js "false"\n')
    const bill = await startBill(context(fixture, { DSH_BUNDLED_SKILL_DIR: '/opt/bundled-skills' }))
    expect(bill.patches).toEqual({
      status: 'known',
      rows: [
        { layer: profilePatch, id: 'my-tool', name: 'my-plugin' },
        { layer: profilePatch, id: 'inner', name: 'inner-plugin' },
        { layer: profilePatch, id: 'docs-mcp', name: '@deepseek-ai/dsh-mcp-client' },
        { layer: homePatch, id: 'home-row', name: 'home-plugin' },
      ],
      jsValues: 3,
    })
    expect(bill.skills.roots).toEqual([
      { path: '/srv/team-skills', source: 'custom' },
      { path: join(fixture.home, 'skills'), source: 'user-dsh' },
      { path: join(dirname(fixture.home), 'agents', 'skills'), source: 'user-agents' },
      { path: '/opt/bundled-skills', source: 'bundled' },
    ])
    expect(bill.mcp).toEqual({ status: 'known', servers: [{ name: 'docs', transport: 'stdio' }] })
  })

  it('counts nested !!js values', () => {
    expect(countExpressions([{ a: { __jsExpr: '1' }, b: [{ __jsExpr: '2' }, { c: { __jsExpr: '3' } }], d: '__jsExpr' }])).toBe(3)
  })

  it('turns an unparsable layer into unknown patches and MCP with the reason, and still reads the other layer', async () => {
    const fixture = await home()
    profileFile(fixture, 'cordis.patch.yml', '- insert: [unclosed\n')
    writeFileSync(join(fixture.home, 'cordis.patch.yml'), '- insert:\n    - id: home-row\n      name: home-plugin\n')
    const bill = await startBill(context(fixture))
    expect(bill.patches.status).toBe('unknown')
    expect(bill.patches.reason).toContain('failed to parse')
    expect(bill.patches.rows).toEqual([{ layer: join(fixture.home, 'cordis.patch.yml'), id: 'home-row', name: 'home-plugin' }])
    expect(bill.mcp.status).toBe('unknown')
    expect(trustRows(bill)[3]!.state).toBe('unknown')
  })
})

/**
 * A bill whose every row is verified, for the text specs.
 * @returns the bill.
 */
function verifiedBill(): TrustBill {
  return {
    schema: TRUST_BILL_SCHEMA,
    stage: 'verify',
    generatedAt: '2026-11-11T00:00:00Z',
    release: { version: RELEASE, commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), fileListSha256: 'c'.repeat(64), root: { version: 1, keyIds: ['d'.repeat(64)], anchored: 'shipped' }, launcher: { version: '1.4.0', path: '/opt/launcher' }, lastFullHashAt: '2026-11-11T00:00:00Z', startCheck: null, signature: 'pass', files: 'pass' },
    releaseLog: { state: 'verified', lastAttempt: '2026-11-11T00:00:00Z', uncheckedSince: null },
    plugins: { status: 'known', entries: [] },
    changes: { status: 'known', harnessEdits: [], approvedPlugins: [], notReviewed: 0 },
    patches: { status: 'known', rows: [], jsValues: 0 },
    skills: { roots: [] },
    mcp: { status: 'known', servers: [] },
  }
}

describe('the printed bill', () => {
  it('reads verified only when every row is, counts the person\'s changes neutrally, and names every unknown row', () => {
    const verified = verifiedBill()
    expect(trustBadge(trustRows(verified)).state).toBe('verified')
    expect(ownChangesLine(verified)).toBe('Your changes: 0 (0 approved harness files, 0 approved plugin versions, 0 waiting for your review, 0 patch rows).\n')
    expect(billSuffix(verified)).toBe('; this Delorun reads verified')
    const own: TrustBill = { ...verified, changes: { status: 'known', harnessEdits: [{ file: 'a.js' }], approvedPlugins: [], notReviewed: 1 }, patches: { status: 'known', rows: [{ layer: '/p.yml', id: 'r', name: 'n' }], jsValues: 0 } }
    expect(ownChangesLine(own)).toBe('Your changes: 3 (1 approved harness files, 0 approved plugin versions, 1 waiting for your review, 1 patch rows); waiting for your review: changes.\n')
    expect(billSuffix(own)).toBe('; this Delorun reads waiting for your review, with 3 of your changes')
    const unknown: TrustBill = { ...verified, changes: { status: 'unknown', reason: NO_CHANGES, harnessEdits: [], approvedPlugins: [], notReviewed: 0 }, releaseLog: { state: 'unchecked', lastAttempt: null, uncheckedSince: '2026-11-10T00:00:00Z' } }
    expect(ownChangesLine(unknown)).toBe('Your changes: 0 (0 approved harness files, 0 approved plugin versions, 0 waiting for your review, 0 patch rows); unchecked: release log; unknown: changes.\n')
    const summary = summaryLine([{ id: 'release-signature', result: 'pass', detail: 'ok' }], unknown)
    expect(summary).toBe('1 checks passed, 0 failed, 0 not run; this Delorun reads unchecked; this is not a full verification of this Delorun.\n')
    expect(summaryLine([{ id: 'release-signature', result: 'pass', detail: 'ok' }], { ...verified, plugins: { status: 'unknown', reason: NO_INSTALL_CHECK, entries: [] } })).toContain('; this Delorun reads unknown;')
  })

  it('escapes control characters in plugin names, paths and reasons', () => {
    const bill: TrustBill = {
      ...verifiedBill(),
      plugins: { status: 'unknown', reason: 'reason\u001b[2J', entries: [{ name: 'evil\u001b[31m‮plugin', source: 'registry', version: '1.0.0\r', integrity: null, commit: null, match: 'unknown', warnings: ['warn\u0007'], criticalAdvisories: ['GHSA\u001b[0m'] }] },
      patches: { status: 'known', rows: [{ layer: '/home/p\u001b]0;x\u0007/cordis.patch.yml', id: 'row\n', name: null }], jsValues: 1 },
      skills: { roots: [{ path: '/skills\u001b[1A', source: 'custom' }] },
      mcp: { status: 'known', servers: [{ name: 'srv\u009b', transport: 'stdio' }] },
    }
    const text = billLines(bill)
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‮]/u)
    for (const escaped of ['evil\\u001b[31m\\u202eplugin', '1.0.0\\u000d', 'warn\\u0007', 'reason\\u001b[2J', '/home/p\\u001b]0;x\\u0007/cordis.patch.yml', 'row\\u000a', '/skills\\u001b[1A', 'srv\\u009b', 'GHSA\\u001b[0m']) expect(text).toContain(escaped)
  })

  it('prints the block, the access statement and the summary after the check lines', () => {
    const text = reportLines(RELEASE, { results: [{ id: 'release-signature', result: 'pass', detail: 'ok' }], root: undefined, origins: undefined, launcher: undefined }, verifiedBill())
    const lines = text.split('\n')
    expect(lines.indexOf('Bill of materials (verify stage, 2026-11-11T00:00:00Z):')).toBeGreaterThan(lines.findIndex(line => line.includes('release-signature')))
    expect(lines.slice(-4)).toEqual(['Your changes: 0 (0 approved harness files, 0 approved plugin versions, 0 waiting for your review, 0 patch rows).', 'These checks run with your access, and a program running with your access can change them.', '1 checks passed, 0 failed, 0 not run; this Delorun reads verified; this is not a full verification of this Delorun.', ''])
  })
})

describe('delorun verify', { timeout: 30_000 }, () => {
  it('prints the bill after the check lines and carries it under `bill` with --json', async () => {
    const fixture = await home()
    const command = createVerifyCommand({ fetch: fixture.tiles.fetch, now: () => NOW, platform: PLATFORM, running: () => RELEASE, fromStore: () => true })
    let stdout = ''
    const env = { DELO_HOME: fixture.home, DELO_LAUNCHER_ROOTS: fixture.launcherRoots, DSH_AGENTS_HOME: join(dirname(fixture.home), 'agents') }
    expect(await command.run([], { env, stdout: (text) => { stdout += text }, stderr: () => undefined })).toBe(EXIT.ok)
    expect(stdout).toContain('Bill of materials (verify stage, ')
    expect(stdout).toContain(`  Plugins: 0, unknown (${NO_INSTALL_CHECK}; the profile's package.json does not read`)
    expect(stdout).toContain(`  Changes: unknown (${NO_CHANGES})`)
    expect(stdout).toContain('Your changes: 0 (0 approved harness files, 0 approved plugin versions, 0 waiting for your review, 0 patch rows); unknown: plugins, changes.\n')
    stdout = ''
    expect(await command.run(['--json'], { env, stdout: (text) => { stdout += text }, stderr: () => undefined })).toBe(EXIT.ok)
    const report = JSON.parse(stdout) as { schemaVersion: number, bill: TrustBill }
    expect(report.schemaVersion).toBe(1)
    expect(report.bill).toMatchObject({ schema: TRUST_BILL_SCHEMA, stage: 'verify', release: { version: RELEASE, signature: 'pass', files: 'pass' }, releaseLog: { state: 'verified' } })
  })
})
