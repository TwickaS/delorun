/**
 * The readers behind contract C3's report for the CLI home (`delo/apps/cli/src/update/sources.ts`), over a temporary
 * home: fake signed releases (keys generated here) installed into a real `RuntimeStore`, and a profile written file by
 * file. Covers the running and target releases, the profile's plugins, layers and exemption files, both installations'
 * status records, the data facts, and the target's bundle tables read by the target's own Node.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { INSTALLATION_OWNED_PROFILE_TUPLES, PROFILE_TEMPLATES, RETIRED_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { DELO_HOME_ENTRIES, STATUS_FILES, TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import { EXEMPTION_FILES } from '@delo/contract-plugin-versions'
import { ensureHomeTree } from '@delo/home'
import { type DeloLogger } from '@delo/logs'
import { recordResult } from '@delo/release-verify'
import { RuntimeStore } from '@delo/runtime-store'
import type { SkippedBundleFact } from '@delo/update'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { bundleFactsOf, readBundleTables, storeReportSources, type BundleTables } from '../../src/update/sources.ts'
import { fakeClosure, signedRelease, throwawayRoot, writeClosure, type FakeBehaviour } from './support.ts'

const PROFILE = 'default'
const TIMEOUT = { timeout: 120_000 }
const platform = runtimePlatformOf(process.platform, process.arch)
const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
const SAME = 'a'.repeat(64)
const NEWER = 'b'.repeat(64)
const BUNDLES = '@deepseek-ai/dsh-official-bundles'
const SILENT: DeloLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

/**
 * The skip of a bundle neither the target nor the profile installs.
 * @param name - the bundle.
 * @returns the skipped bundle.
 */
const ABSENT = (name: string): SkippedBundleFact => ({ package: name, reason: 'neither the target release nor the profile installs it', verification: 'verified' })

/** The tables of release 1.1.0, whose own module `readBundleTables` imports. */
const TABLES: BundleTables = {
  retired: ['@old/bundle', '@other/retired'],
  tuples: { cli: ['@a/one', '@a/two'] },
  templates: { cli: ['@a/new'] },
}

/**
 * A bundles module that exports upstream's three tables in upstream's form: a set, a record of lists, and a record of
 * `ProfileTemplate` objects.
 * @param tables - the tables.
 * @returns the module's source.
 */
function tablesModule(tables: BundleTables): string {
  const templates = Object.fromEntries(Object.entries(tables.templates).map(([name, bundles]) => [name, { bundles }]))
  return `export const RETIRED_BUNDLES = new Set(${JSON.stringify(tables.retired)})\nexport const INSTALLATION_OWNED_PROFILE_TUPLES = ${JSON.stringify(tables.tuples)}\nexport const PROFILE_TEMPLATES = ${JSON.stringify(templates)}\n`
}

/**
 * Upstream's own bundles module, its three tables serialized from the workspace package.
 * @returns the module's source.
 */
function upstreamTablesModule(): string {
  return `export const RETIRED_BUNDLES = new Set(${JSON.stringify([...RETIRED_BUNDLES])})\nexport const INSTALLATION_OWNED_PROFILE_TUPLES = ${JSON.stringify(INSTALLATION_OWNED_PROFILE_TUPLES)}\nexport const PROFILE_TEMPLATES = ${JSON.stringify(PROFILE_TEMPLATES)}\n`
}

let rootOf: ReturnType<typeof throwawayRoot>
let base: string
let home: string
let profileDir: string
let store: RuntimeStore

/**
 * Install a fake release.
 * @param version - its version.
 * @param behaviour - its data formats.
 * @param change - edits to its closure; a `undefined` file is removed.
 */
async function installRelease(version: string, behaviour: FakeBehaviour, change: Record<string, string | undefined> = {}): Promise<void> {
  const root = rootOf
  const closure = fakeClosure(version, behaviour)
  for (const [path, content] of Object.entries(change)) {
    if (content === undefined) delete closure[path]
    else closure[path] = { content }
  }
  await store.install({ version: v(version), root: root.metadata, fill: async (directory) => {
    writeClosure(directory, closure)
    return Promise.resolve(signedRelease(root.keys.targets, platform, version, closure))
  } })
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dsr-')))
  home = join(base, 'h')
  await ensureHomeTree(home, PROFILE)
  rootOf = throwawayRoot()
  writeFileSync(join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root), rootOf.bytes, { mode: 0o600 })
  profileDir = join(home, 'profiles', PROFILE)
  store = new RuntimeStore({ home, platform, logger: SILENT })
  await installRelease('1.0.0', { healthy: true, persistence: SAME })
  await installRelease('1.1.0', { healthy: true, persistence: NEWER }, { [`app/node_modules/${BUNDLES}/index.js`]: tablesModule(TABLES) })
  await installRelease('1.2.0', { healthy: true, persistence: SAME }, { [`app/node_modules/${BUNDLES}/index.js`]: 'export const RETIRED_BUNDLES = [1]\nexport const INSTALLATION_OWNED_PROFILE_TUPLES = {}\nexport const PROFILE_TEMPLATES = {}\n' })
  await installRelease('1.3.0', { healthy: true, persistence: SAME }, { [`app/node_modules/${BUNDLES}/package.json`]: undefined, [`app/node_modules/${BUNDLES}/index.js`]: undefined })
  await installRelease('1.4.0', { healthy: true, persistence: SAME }, { 'data-formats.json': 'not json' })
  await installRelease('1.7.0', { healthy: true, persistence: SAME }, { [`app/node_modules/${BUNDLES}/index.js`]: 'export const RETIRED_BUNDLES = new Set()\nexport const INSTALLATION_OWNED_PROFILE_TUPLES = {}\nexport const PROFILE_TEMPLATES = { cli: [\'@a/new\'] }\n' })
  await installRelease('1.6.0', { healthy: true, persistence: SAME }, { [`app/node_modules/${BUNDLES}/index.js`]: upstreamTablesModule() })
  await installRelease('1.5.0', { healthy: true, persistence: SAME }, {
    'app/node_modules/@t/bundle/package.json': JSON.stringify({ name: '@t/bundle', version: '1.5.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'app/node_modules/@t/bundle/cordis.patch.yml': '- insert:\n    - id: target-row\n      name: plugin-target\n',
  })
}, 120_000)

afterAll(() => {
  // Installed runtimes are read-only; make them removable first.
  execFileSync('chmod', ['-R', 'u+rwX', base], { timeout: 30_000 })
  rmSync(base, { recursive: true, force: true })
})

/**
 * Write files under a directory, creating their parents.
 * @param directory - the directory.
 * @param files - the contents by relative path.
 */
function writeFiles(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

/** The profile's manifest. */
const manifest = (change: Record<string, unknown> = {}): string => JSON.stringify({ name: 'profile', private: true, dependencies: {}, dsh: { profile: { bundles: [] } }, ...change })

beforeEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
  rmSync(join(home, 'cordis.patch.yml'), { force: true })
  rmSync(join(home, DELO_HOME_ENTRIES.status), { recursive: true, force: true })
  mkdirSync(join(home, DELO_HOME_ENTRIES.status), { mode: 0o700 })
  mkdirSync(profileDir, { recursive: true })
  writeFiles(profileDir, { 'package.json': manifest() })
})

/** @returns the sources over the shared home, running 1.0.0. */
const sources = (bundleTables?: (runtime: string, node: string) => Promise<BundleTables>): ReturnType<typeof storeReportSources> =>
  storeReportSources({ home, profile: PROFILE, store, running: v('1.0.0'), root: async () => Promise.resolve(rootOf.metadata), fullCheckDays: 7, ...bundleTables === undefined ? {} : { bundleTables } })

describe('bundleFactsOf', () => {
  it('reports the retired bundles the profile lists, and no template when its list is no installation-owned list', () => {
    expect(bundleFactsOf(['@old/bundle', '@mine/bundle'], TABLES)).toEqual({ retired: ['@old/bundle'] })
  })

  it('names the template that replaces a list equal to an installation-owned list', () => {
    expect(bundleFactsOf(['@a/one', '@a/two'], TABLES)).toEqual({ retired: [], template: ['@a/new'] })
  })

  it('does not match a list that differs in order, in length or in one name', () => {
    expect(bundleFactsOf(['@a/two', '@a/one'], TABLES)).not.toHaveProperty('template')
    expect(bundleFactsOf(['@a/one'], TABLES)).not.toHaveProperty('template')
    expect(bundleFactsOf(['@a/one', '@a/two', '@a/three'], TABLES)).not.toHaveProperty('template')
    expect(bundleFactsOf(['@a/one', '@a/other'], TABLES)).not.toHaveProperty('template')
  })

  it('gives no template when the owned list has none in the target\'s templates', () => {
    expect(bundleFactsOf(['@a/one', '@a/two'], { ...TABLES, templates: {} })).toEqual({ retired: [] })
  })
})

describe('readBundleTables', () => {
  const tablesOf = async (version: string): Promise<BundleTables> =>
    readBundleTables(store.paths.version(v(version)), store.launchCommand(v(version), PROFILE, []).command)

  it('reads the tables a runtime\'s own bundles module exports, with the runtime\'s own Node', TIMEOUT, async () => {
    expect(await tablesOf('1.1.0')).toEqual(TABLES)
    expect(await tablesOf('1.0.0')).toEqual({ retired: [], tuples: {}, templates: {} })
  })

  it('reads upstream\'s own tables, whose templates are objects that carry the list', TIMEOUT, async () => {
    const tables = await tablesOf('1.6.0')
    expect(tables.retired).toEqual([...RETIRED_BUNDLES])
    expect(tables.tuples).toEqual(INSTALLATION_OWNED_PROFILE_TUPLES)
    expect(tables.templates).toEqual(Object.fromEntries(Object.entries(PROFILE_TEMPLATES).map(([name, template]) => [name, [...template.bundles]])))
    expect(tables.templates.headless).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  })

  it('refuses a module whose templates are bare lists, not upstream\'s objects', TIMEOUT, async () => {
    await expect(tablesOf('1.7.0')).rejects.toThrow()
  })

  it('refuses a module whose tables are not lists of names', TIMEOUT, async () => {
    await expect(tablesOf('1.2.0')).rejects.toThrow()
  })

  it('fails when the runtime ships no bundles module', TIMEOUT, async () => {
    await expect(tablesOf('1.3.0')).rejects.toThrow()
  })
})

describe('storeReportSources', () => {
  describe('running and target', () => {
    it('reads the running release\'s versions from the store\'s verified manifest', TIMEOUT, async () => {
      expect(await sources().running()).toEqual({ delo: '1.0.0', dsh: '0.2.2', channel: 'stable' })
    })

    it('reads the target\'s versions, the digest of its manifest and the checks the install made', TIMEOUT, async () => {
      await recordResult(home, '1.1.0', 1_800_000_000, { state: 'verified', stop: false })
      const target = await sources(async () => Promise.resolve(TABLES)).target('1.1.0')

      expect(target.versions).toEqual({ delo: '1.1.0', dsh: '0.2.2', channel: 'stable' })
      expect(target.release).toEqual({ manifest: expect.stringMatching(/^[0-9a-f]{64}$/u) as string, signature: 'passed', freshness: 'passed', log: 'passed' })
      expect(target.revocations).toEqual([])
    })

    it('reports the release-log state the install recorded, and unchecked when it recorded none', TIMEOUT, async () => {
      const read = sources(async () => Promise.resolve(TABLES))
      expect((await read.target('1.6.0')).release.log).toBe('unchecked')
      await recordResult(home, '1.6.0', 1_800_000_000, { state: 'unchecked', detail: 'the log did not answer', stop: false })
      expect((await read.target('1.6.0')).release.log).toBe('unchecked')
      await recordResult(home, '1.6.0', 1_800_000_060, { state: 'failed', refusal: 'consistency-proof-invalid', detail: 'the proof does not verify', stop: true })
      expect((await read.target('1.6.0')).release.log).toBe('failed')
      await recordResult(home, '1.6.0', 1_800_000_120, { state: 'verified', stop: false })
      expect((await read.target('1.6.0')).release.log).toBe('passed')
    })

    it('reads the target\'s bundle tables with its own Node by default and answers for the profile\'s bundle list', TIMEOUT, async () => {
      writeFiles(profileDir, { 'package.json': manifest({ dsh: { profile: { bundles: ['@a/one', '@a/two'] } } }) })

      expect((await sources().target('1.1.0')).bundles).toEqual({ retired: [], template: ['@a/new'], skipped: [ABSENT('@a/new')], layers: [] })
    })

    it('hands the injected reader the target\'s directory and its Node, and uses what it returns', TIMEOUT, async () => {
      writeFiles(profileDir, { 'package.json': manifest({ dsh: { profile: { bundles: ['@old/bundle', '@mine/bundle'] } } }) })
      const asked: string[][] = []

      const target = await sources(async (runtime, node) => {
        asked.push([runtime, node])
        return Promise.resolve(TABLES)
      }).target('1.1.0')

      expect(asked).toEqual([[store.paths.version(v('1.1.0')), store.launchCommand(v('1.1.0'), PROFILE, []).command]])
      expect(target.bundles).toEqual({ retired: ['@old/bundle'], skipped: [ABSENT('@mine/bundle')], layers: [] })
    })
  })

  describe('the bundles the target loads', () => {
    it('reads the target\'s bundles from its files, then the profile\'s, and names only the revocation list as not checked', TIMEOUT, async () => {
      writeFiles(profileDir, {
        'package.json': manifest({ dsh: { profile: { bundles: ['@t/bundle', '@p/bundle', '@p/old'] } } }),
        'node_modules/@p/bundle/package.json': JSON.stringify({ name: '@p/bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
        'node_modules/@p/bundle/cordis.patch.yml': '- insert:\n    - name: plugin-profile\n',
        'node_modules/@p/old/package.json': JSON.stringify({ name: '@p/old', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, engines: { dsh: '^0.1.0' } }),
        'node_modules/@p/old/cordis.patch.yml': '- insert:\n    - name: plugin-old\n',
      })

      const target = await sources().target('1.5.0')

      expect(target.bundles).toEqual({
        retired: [],
        skipped: [{ package: '@p/old', reason: 'it requires DSH ^0.1.0 and the target runs DSH 0.2.2', verification: 'verified' }],
        layers: [
          { layer: '@t/bundle', rows: [{ id: 'target-row', name: 'plugin-target', plugins: ['plugin-target'] }] },
          { layer: '@p/bundle', rows: [{ name: 'plugin-profile', plugins: ['plugin-profile'] }] },
        ],
      })
      expect(target.notChecked).toEqual(['revocations'])
    })

    it('hands the reader the list the target loads, both anchors, the target\'s versions, the DSH exemptions and the platform', TIMEOUT, async () => {
      writeFiles(profileDir, {
        'package.json': manifest({ dsh: { profile: { bundles: ['@old/bundle', '@mine/bundle'] } } }),
        [EXEMPTION_FILES.dsh]: JSON.stringify({ '@mine/bundle@1.0.0': ['0.2.2'] }),
      })
      const asked: unknown[] = []
      const layers = [{ layer: '@mine/bundle', rows: [] }]

      const target = await storeReportSources({
        home, profile: PROFILE, store, running: v('1.0.0'), root: async () => Promise.resolve(rootOf.metadata), fullCheckDays: 7,
        bundleTables: async () => Promise.resolve(TABLES),
        bundleLayers: async (bundles, options) => {
          asked.push([bundles, options])
          return Promise.resolve({ layers, skipped: [] })
        },
      }).target('1.1.0')

      expect(asked).toEqual([[['@mine/bundle'], {
        anchors: [join(store.paths.version(v('1.1.0')), 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), join(profileDir, 'package.json')],
        versions: { dsh: '0.2.2', delo: '1.1.0' },
        exemptions: { '@mine/bundle@1.0.0': ['0.2.2'] },
        platform: process.platform,
      }]])
      expect(target.bundles).toEqual({ retired: ['@old/bundle'], skipped: [], layers })
    })
  })

  describe('data', () => {
    it('reads both releases\' data formats and the size of the chat data a copy would take', TIMEOUT, async () => {
      mkdirSync(join(home, 'sessions', 'chat-a'), { recursive: true })
      writeFileSync(join(home, 'sessions', 'chat-a', 'log.jsonl'), 'before\n')

      const data = await sources().data('1.1.0')

      expect(data.from).toMatchObject({ dsh: '0.2.2', formats: { persistence: SAME } })
      expect(data.to).toMatchObject({ dsh: '0.2.2', formats: { persistence: NEWER } })
      expect(data.copy).toMatchObject({ files: 1, bytes: 7 })
      expect(data.copy.free).toBeGreaterThan(0)
    })

    it('leaves a release\'s formats out when its data-formats.json cannot be read', TIMEOUT, async () => {
      const data = await sources().data('1.4.0')

      expect(data.to.formats).toBeUndefined()
      expect(data.from.formats).toBeDefined()
    })
  })

  it('stamps the report with the current time', () => {
    const before = Date.now()
    const stamped = Date.parse(sources().now())

    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(Date.now())
  })

  describe('status records', () => {
    const record = (change: Record<string, unknown>): string => JSON.stringify({ id: 'cli-home', state: 'current', ...change })
    const statusDirectory = (): string => join(home, DELO_HOME_ENTRIES.status)

    it('leaves out both installations when neither has written a record', async () => {
      expect(await sources().statuses()).toEqual({})
    })

    it('reads each installation\'s versions, state and target from its own record', async () => {
      writeFiles(statusDirectory(), {
        [STATUS_FILES.cliHome]: record({ delo: '1.0.0', dsh: '0.2.2', state: 'applying', target: '1.1.0' }),
        [STATUS_FILES.desktopHost]: record({ id: 'desktop-host', delo: '0.9.0', dsh: '0.2.1' }),
      })

      expect(await sources().statuses()).toEqual({
        'cli-home': { id: 'cli-home', delo: '1.0.0', dsh: '0.2.2', state: 'applying', target: '1.1.0' },
        'desktop-host': { id: 'desktop-host', delo: '0.9.0', dsh: '0.2.1', state: 'current' },
      })
    })

    it('reads a record that states only its state', async () => {
      writeFiles(statusDirectory(), { [STATUS_FILES.cliHome]: record({}) })

      expect(await sources().statuses()).toEqual({ 'cli-home': { id: 'cli-home', state: 'current' } })
    })

    it('leaves out a record that names the other installation, is malformed, is not JSON or has an unknown state', async () => {
      writeFiles(statusDirectory(), {
        [STATUS_FILES.cliHome]: record({ id: 'desktop-host' }),
        [STATUS_FILES.desktopHost]: 'not json',
      })
      expect(await sources().statuses()).toEqual({})

      writeFiles(statusDirectory(), {
        [STATUS_FILES.cliHome]: record({ state: 'sleeping' }),
        [STATUS_FILES.desktopHost]: record({ id: 'desktop-host', extra: true }),
      })
      expect(await sources().statuses()).toEqual({})
    })
  })

  describe('profile', () => {
    const plugin = (name: string, body: string): Record<string, string> => ({ [`node_modules/${name}/package.json`]: body })

    it('reads the profile\'s bundle list', async () => {
      writeFiles(profileDir, { 'package.json': manifest({ dsh: { profile: { bundles: ['@a/one', '@a/two'] } } }) })

      expect((await sources().profile()).bundles).toEqual(['@a/one', '@a/two'])
    })

    it('reads each plugin\'s version and engines from its own package.json', async () => {
      writeFiles(profileDir, {
        'package.json': manifest({ dependencies: { 'plugin-ok': '^1.0.0', '@scope/plugin': '2.0.0' } }),
        ...plugin('plugin-ok', JSON.stringify({ name: 'plugin-ok', version: '1.4.2', engines: { dsh: '^0.2.0', delo: '>=1' } })),
        ...plugin('@scope/plugin', JSON.stringify({ name: '@scope/plugin', version: '2.0.1' })),
      })

      expect((await sources().profile()).plugins).toEqual([
        { name: 'plugin-ok', version: '1.4.2', manifest: { name: 'plugin-ok', version: '1.4.2', engines: { dsh: '^0.2.0', delo: '>=1' } } },
        { name: '@scope/plugin', version: '2.0.1', manifest: { name: '@scope/plugin', version: '2.0.1' } },
      ])
    })

    it('falls back to the dependency spec for the version, and states no manifest, when the plugin\'s package.json is missing', async () => {
      writeFiles(profileDir, { 'package.json': manifest({ dependencies: { 'exact-spec': '2.3.4', 'ranged-spec': '^3.0.0' } }) })

      expect((await sources().profile()).plugins).toEqual([
        { name: 'exact-spec', version: '2.3.4' },
        { name: 'ranged-spec', version: '0.0.0' },
      ])
    })

    it('states no manifest when the plugin\'s package.json is not JSON, and takes the version from the spec', async () => {
      writeFiles(profileDir, {
        'package.json': manifest({ dependencies: { broken: '1.2.3' } }),
        ...plugin('broken', '{"name": '),
      })

      expect((await sources().profile()).plugins).toEqual([{ name: 'broken', version: '1.2.3' }])
    })

    it('takes the version from the spec when the plugin\'s own version is absent or not a version', async () => {
      writeFiles(profileDir, {
        'package.json': manifest({ dependencies: { 'no-version': '4.0.0', 'bad-version': '^5.0.0' } }),
        ...plugin('no-version', JSON.stringify({ name: 'no-version' })),
        ...plugin('bad-version', JSON.stringify({ name: 'bad-version', version: 'latest' })),
      })

      expect((await sources().profile()).plugins.map(entry => [entry.name, entry.version])).toEqual([['no-version', '4.0.0'], ['bad-version', '0.0.0']])
    })

    it('reads both exemption files, each as the grants it lists', async () => {
      writeFiles(profileDir, {
        [EXEMPTION_FILES.dsh]: JSON.stringify({ 'plugin-a@1.0.0': ['0.2.2', '0.3.0'] }),
        [EXEMPTION_FILES.delo]: JSON.stringify({ 'plugin-b@2.0.0': ['1.1.0'] }),
      })

      expect((await sources().profile()).exemptions).toEqual({ dsh: { 'plugin-a@1.0.0': ['0.2.2', '0.3.0'] }, delo: { 'plugin-b@2.0.0': ['1.1.0'] } })
    })

    it('grants nothing from an exemption file that is missing, not JSON or not a map of version lists', async () => {
      writeFiles(profileDir, {
        [EXEMPTION_FILES.dsh]: '{"plugin-a@1.0.0": ',
        [EXEMPTION_FILES.delo]: JSON.stringify({ 'plugin-b@2.0.0': '1.1.0' }),
      })
      expect((await sources().profile()).exemptions).toEqual({ dsh: {}, delo: {} })

      rmSync(join(profileDir, EXEMPTION_FILES.delo))
      expect((await sources().profile()).exemptions.delo).toEqual({})
    })

    it('has no layer rows when the patches are missing or empty', async () => {
      writeFiles(profileDir, { 'cordis.patch.yml': '' })

      expect((await sources().profile()).layers).toEqual([
        { layer: 'profile patch', rows: [] },
        { layer: 'home patch', rows: [] },
      ])
    })

    it('lists the rows of the profile patch and the home patch that are not disabled, by id and plugin', async () => {
      writeFiles(profileDir, {
        'cordis.patch.yml': '- insert:\n    - id: row-a\n      name: plugin-a\n    - name: plugin-nameless\n    - id: row-off\n      name: plugin-off\n      disabled: true\n',
      })
      writeFiles(home, { 'cordis.patch.yml': '- insert:\n    - name: plugin-home\n' })

      expect((await sources().profile()).layers).toEqual([
        { layer: 'profile patch', rows: [{ id: 'row-a', name: 'plugin-a', plugins: ['plugin-a'] }, { name: 'plugin-nameless', plugins: ['plugin-nameless'] }] },
        { layer: 'home patch', rows: [{ name: 'plugin-home', plugins: ['plugin-home'] }] },
      ])
    })
  })
})
