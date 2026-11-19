/**
 * The optional-plugin bundles (owner decisions A399, A405): each is off in a fresh Delorun CLI profile, composes its
 * rows with a valid default config when a person turns it on, takes them away again when turned off, and never
 * mounts a row that would fail to load for want of setup.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assertBundlePlatform, composeEntries, initProfile, loadProfileDirectory, UnsupportedBundlePlatformError } from '@deepseek-ai/dsh-app-boot'
import { chromeChannelCandidates } from '@deepseek-ai/dsh-native-command/chrome-channel'
import { checkRequirements, hostEnvironment } from '../src/requirements.ts'
import { DELORUN_PROFILE_BUNDLES, LOCAL_BUNDLE, STUDIO_BUNDLE } from '../src/profile.ts'
import { createTestHome, INSTALL_ANCHOR, PACKAGE_DIR, STUDIO_PACKAGE_DIR, type TestHome } from './profiles.ts'

/** The Loader's `!!js` tag: a scalar that {@link interpolate} evaluates against `process`. */
const JS_TAG = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source: string) => ({ __jsExpr: source }) })
const patchSchema = yaml.DEFAULT_SCHEMA.extend([JS_TAG])
/** Evaluate `!!js` nodes the way the Loader does, with `process` in scope. */
function interpolate(scope: { process: NodeJS.Process }, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '__jsExpr' in value) return new Function('process', `return eval(${JSON.stringify((value as { __jsExpr: string }).__jsExpr)})`)(scope.process)
  if (Array.isArray(value)) return value.map(item => interpolate(scope, item))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(scope, item)]))
  return value
}

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url))
const UPSTREAM = fileURLToPath(new URL('../../../../packages/', import.meta.url))

interface Row { readonly id?: string; readonly name?: string; readonly disabled?: unknown; readonly config?: unknown; readonly group?: boolean }

/** Each bundle, the row ids its patch inserts at the top level, and the rows that mount unconditionally. */
const BUNDLES = [
  { dir: 'bundle-browser', rows: ['browser-use', 'browser-use-playwright-mcp', 'browser-use-chrome-devtools-mcp', 'browser-use-stagehand-native'], on: ['browser-use', 'browser-use-playwright-mcp'] },
  { dir: 'bundle-code-intelligence', rows: ['lsp', 'lsp-stdio', 'tool-lsp'], on: ['lsp'] },
  { dir: 'bundle-agent-hooks', rows: ['hooks-claude-code', 'hooks-codex', 'claude-code-mods', 'client-ui-claude-code-mods'], on: ['hooks-claude-code', 'hooks-codex', 'claude-code-mods', 'client-ui-claude-code-mods'] },
  { dir: 'bundle-webhooks', rows: ['webhook-runtime', 'github-webhook-ingress'], on: ['webhook-runtime'] },
  { dir: 'bundle-external-agents', rows: ['experimental-subagent-oar-codex', 'experimental-subagent-oar-claude', 'tool-subagent-oar', 'ptc-runtime-python'], on: [] },
  { dir: 'bundle-computer-use-driver', rows: ['computer-use-registry', 'computer-use-cua-driver-native'], on: ['computer-use-registry', 'computer-use-cua-driver-native'] },
  { dir: 'bundle-real-browser', rows: ['browser-use-browse', 'skill-real-browser'], on: ['skill-real-browser'] },
] as const

const manifest = (dir: string): { name: string; dsh: { bundle: { patch: string; platforms?: string[] } }; delorun: { state: string; pack?: boolean }; dependencies: Record<string, string>; exports: Record<string, string> } =>
  JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8'))
const patchRows = (dir: string): Row[] => (yaml.load(readFileSync(join(PACKAGES, dir, 'cordis.patch.yml'), 'utf8'), { schema: patchSchema }) as { insert: Row[] }[])[0]!.insert
/** A row's `disabled` as the Loader evaluates it for a given platform and environment. */
const isDisabled = (row: Row, platform: string = process.platform): boolean => Boolean(interpolate({ process }, row.disabled) ?? false) && platform !== ''

let home: TestHome
let scratch: string
beforeAll(() => { home = createTestHome(); scratch = mkdtempSync(join(tmpdir(), 'delorun-optional-')) })
afterAll(() => { home.remove(); rmSync(scratch, { recursive: true, force: true }) })

/** A CLI profile with Delorun's bundle list plus `extra`, linking every bundle package it lists. */
function profileWith(extra: readonly string[]): string[] {
  const dir = mkdtempSync(join(scratch, 'profile-'))
  initProfile(dir, [...DELORUN_PROFILE_BUNDLES, ...extra])
  const links: [string, string][] = [[LOCAL_BUNDLE, PACKAGE_DIR], [STUDIO_BUNDLE, STUDIO_PACKAGE_DIR], ...extra.map((name): [string, string] => [name, join(PACKAGES, name.replace('@delorun/', ''))])]
  for (const [name, target] of links) {
    const link = join(dir, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, 'junction')
  }
  return composeEntries(loadProfileDirectory('dsh', dir, INSTALL_ANCHOR).layers.map(layer => layer.patches)).map(row => String((row as Row).id))
}

describe.each(BUNDLES)('$dir', ({ dir, rows, on }) => {
  const info = manifest(dir)

  it('is a pack-eligible bundle that no default profile lists', () => {
    expect(info.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(info.delorun.pack).toBe(true)
    expect(DELORUN_PROFILE_BUNDLES).not.toContain(info.name)
    const ids = home.rows('default').map(row => String((row as Row).id))
    for (const id of rows) expect(ids, id).not.toContain(id)
  })

  it('adds its rows when turned on and removes them when turned off', () => {
    expect(profileWith([info.name])).toEqual(expect.arrayContaining([...rows]))
    const off = profileWith([])
    for (const id of rows) expect(off, id).not.toContain(id)
  })

  it('declares a dependency on every package it mounts, or exports the module itself, and mounts rows with ids and names only', () => {
    const top = patchRows(dir)
    expect(top.map(row => row.id)).toEqual([...rows])
    const names = top.flatMap(row => row.group ? ((row.config as Row[]) ?? []).map(child => child.name) : [row.name])
    for (const name of names) {
      if (name === undefined || name === 'cordis:group') continue
      if (name.startsWith(`${info.name}/`)) expect(Object.keys(info.exports), name).toContain(`.${name.slice(info.name.length)}`)
      else expect(Object.keys(info.dependencies), name).toContain(name)
    }
  })

  it('mounts exactly the rows meant to be on with nothing set up', () => {
    const emptyPath = mkdtempSync(join(scratch, 'empty-'))
    const saved = { PATH: process.env.PATH, secret: process.env.DELORUN_GITHUB_WEBHOOK_SECRET }
    process.env.PATH = emptyPath
    delete process.env.DELORUN_GITHUB_WEBHOOK_SECRET
    try {
      const mounted = patchRows(dir).filter(row => !isDisabled(row)).map(row => row.id)
      expect(mounted).toEqual([...on])
    } finally {
      process.env.PATH = saved.PATH
      if (saved.secret !== undefined) process.env.DELORUN_GITHUB_WEBHOOK_SECRET = saved.secret
    }
  })

  it('has titles and descriptions in English and Chinese', () => {
    for (const language of ['en', 'zh']) {
      const meta = JSON.parse(readFileSync(join(PACKAGES, dir, 'locale', `${language}.json`), 'utf8')).meta as { title: string; description: string }
      expect(meta.title.length).toBeGreaterThan(0)
      expect(meta.description.length).toBeGreaterThan(0)
    }
  })
})

describe('what needs setup', () => {
  function withEnv<T>(path: string, secret: string | undefined, run: () => T): T {
    const saved = { PATH: process.env.PATH, secret: process.env.DELORUN_GITHUB_WEBHOOK_SECRET }
    process.env.PATH = path
    if (secret === undefined) delete process.env.DELORUN_GITHUB_WEBHOOK_SECRET
    else process.env.DELORUN_GITHUB_WEBHOOK_SECRET = secret
    try { return run() } finally {
      process.env.PATH = saved.PATH
      if (saved.secret === undefined) delete process.env.DELORUN_GITHUB_WEBHOOK_SECRET
      else process.env.DELORUN_GITHUB_WEBHOOK_SECRET = saved.secret
    }
  }
  /** A directory on PATH holding the named executables. */
  function binDir(...names: string[]): string {
    const dir = mkdtempSync(join(scratch, 'bin-'))
    for (const name of names) { writeFileSync(join(dir, name), '#!/bin/sh\n'); chmodSync(join(dir, name), 0o755) }
    return dir
  }
  const ids = (dir: string, path: string, secret?: string) => withEnv(path, secret, () => patchRows(dir).filter(row => !isDisabled(row)).map(row => row.id))
  const flat = (rows: Row[]): Row[] => rows.flatMap(row => row.group ? [row, ...flat((row.config as Row[]) ?? [])] : [row])
  /** The rows of a bundle that declare needs, and the state the check reports for each on a computer with the given PATH and secret. */
  const states = (dir: string, path: string, secret?: string) => withEnv(path, secret, () => {
    const answer = checkRequirements([{ name: dir, dir: join(PACKAGES, dir), rowIds: flat(patchRows(dir)).map(row => String(row.id)) }], 'en')
    expect(answer.problems).toEqual([])
    return Object.fromEntries(answer.rows.map(row => [row.rowId, row.state]))
  })

  it('ships the language-server rows off, and says Needs setup until typescript-language-server is on PATH', () => {
    expect(ids('bundle-code-intelligence', binDir('typescript-language-server'))).toEqual(['lsp'])
    expect(states('bundle-code-intelligence', binDir())).toEqual({ 'lsp-stdio': 'needs-setup', 'tool-lsp': 'needs-setup' })
    expect(states('bundle-code-intelligence', binDir('typescript-language-server'))).toEqual({ 'lsp-stdio': 'ready', 'tool-lsp': 'ready' })
  })

  it('ships the GitHub endpoint off, and says Needs setup until the webhook secret is set', () => {
    expect(ids('bundle-webhooks', binDir(), 'a-long-random-secret')).toEqual(['webhook-runtime'])
    expect(states('bundle-webhooks', binDir())).toEqual({ 'github-webhook-ingress': 'needs-setup' })
    expect(states('bundle-webhooks', binDir(), 'a-long-random-secret')).toEqual({ 'github-webhook-ingress': 'ready' })
  })

  it('says Browser is ready with Chrome installed, and otherwise needs the exact Chromium build its Playwright expects', () => {
    const cache = mkdtempSync(join(scratch, 'ms-playwright-'))
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', cache)
    try {
      const rows = flat(patchRows('bundle-browser'))
      const rowIds = rows.map(row => String(row.id))
      const rowConfigs = Object.fromEntries(rows.map(row => [String(row.id), (row as { config?: unknown }).config]))
      // The bundle sets no `browser`, so the row launches Chrome when this computer has it: the spec decides whether it does.
      const real = hostEnvironment()
      const chrome = chromeChannelCandidates(real)
      const answer = (installed: boolean) => checkRequirements(
        [{ name: '@delorun/bundle-browser', dir: join(PACKAGES, 'bundle-browser'), rowIds, rowConfigs }], 'en',
        { ...real, exists: path => chrome.includes(path) ? installed : real.exists(path) },
      )
      expect(chrome.length > 0 || !['linux', 'darwin', 'win32'].includes(process.platform)).toBe(true)
      if (chrome.length > 0) expect(answer(true)).toEqual({ problems: [], rows: [{ packageName: '@delorun/bundle-browser', rowId: 'browser-use-playwright-mcp', state: 'ready' }] })
      const without = answer(false)
      expect(without).toMatchObject({ problems: [], rows: [{ rowId: 'browser-use-playwright-mcp', state: 'needs-setup', reason: 'Chromium download' }] })
      const row = without.rows[0]
      const command = row?.state === 'needs-setup' && row.fix.kind === 'command' ? row.fix.command : ''
      expect(command).toMatch(/^npx -y @playwright\/mcp@\d+\.\d+\.\d+ install-browser chromium$/u)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('says Your own browser needs Chrome connected until browse has seen a paired browser, reading only browsers.json', () => {
    const data = mkdtempSync(join(scratch, 'xdg-data-'))
    vi.stubEnv('XDG_DATA_HOME', data)
    try {
      const check = () => checkRequirements([{ name: '@delorun/bundle-real-browser', dir: join(PACKAGES, 'bundle-real-browser'), rowIds: flat(patchRows('bundle-real-browser')).map(row => String(row.id)) }], 'en')
      const unpaired = check()
      expect(unpaired).toMatchObject({ problems: [], rows: [{ rowId: 'browser-use-browse', state: 'needs-setup', reason: 'Connect Chrome', fix: { kind: 'browse-pair', extension: expect.stringMatching(/^https:\/\/chromewebstore\.google\.com\//u) } }] })
      mkdirSync(join(data, 'browse'))
      writeFileSync(join(data, 'browse', 'browsers.json'), JSON.stringify({ profile: { id: 'profile', name: 'Chrome' } }))
      expect(check()).toEqual({ problems: [], rows: [{ packageName: '@delorun/bundle-real-browser', rowId: 'browser-use-browse', state: 'ready' }] })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([['bundle-code-intelligence', ['lsp-stdio', 'tool-lsp']], ['bundle-webhooks', ['github-webhook-ingress']]] as const)(
    '%s: turning each guarded row on with its needs unmet composes and evaluates without throwing, so start is not stopped',
    (dir, guarded) => {
      withEnv(binDir(), undefined, () => {
        const rows = flat(patchRows(dir))
        for (const id of guarded) {
          const row = rows.find(each => each.id === id)!
          expect(() => interpolate({ process }, { ...row, disabled: false })).not.toThrow()
        }
        expect(profileWith([manifest(dir).name])).toEqual(expect.arrayContaining([...guarded]))
      })
    },
  )

  it('ships every external-agent row off, and says Needs setup until its program is on PATH', () => {
    const dir = 'bundle-external-agents'
    expect(ids(dir, binDir('codex', 'claude', 'python3'))).toEqual([])
    const none = { 'experimental-subagent-oar-codex': 'needs-setup', 'experimental-subagent-oar-claude': 'needs-setup', 'tool-subagent-oar': 'needs-setup', 'ptc-runtime-python': 'needs-setup' }
    expect(states(dir, binDir())).toEqual(none)
    expect(states(dir, binDir('claude'))).toEqual({ ...none, 'experimental-subagent-oar-claude': 'ready', 'tool-subagent-oar': 'ready' })
    expect(states(dir, binDir('codex', 'claude', 'python3'))).toEqual({ ...none, 'experimental-subagent-oar-codex': 'ready', 'experimental-subagent-oar-claude': 'ready', 'tool-subagent-oar': 'ready', 'ptc-runtime-python': 'ready' })
  })

  it('lists only the installed programs in the delegation tool once its row is turned on', () => {
    const row = withEnv(binDir('claude'), undefined, () => patchRows('bundle-external-agents').find(each => each.id === 'tool-subagent-oar'))
    expect(withEnv(binDir('claude'), undefined, () => interpolate({ process }, (row!.config as { providers: unknown }).providers))).toEqual({ claude: 'oar-claude' })
  })

  it('is unavailable on a platform the bundle does not support, with the reason', () => {
    const platforms = manifest('bundle-computer-use-driver').dsh.bundle.platforms
    expect(platforms).toEqual(['linux', 'win32'])
    expect(() => assertBundlePlatform(platforms, 'darwin')).toThrow(UnsupportedBundlePlatformError)
    expect(() => assertBundlePlatform(platforms, 'darwin')).toThrow(/linux, win32.*darwin/)
    expect(() => assertBundlePlatform(platforms, 'linux')).not.toThrow()
    expect(() => assertBundlePlatform(platforms, 'win32')).not.toThrow()
  })
})

describe('default configuration', () => {
  const CHECKED = [
    ['bundle-browser', 'browser-use-playwright-mcp', 'experimental/browser-use-playwright-mcp'],
    ['bundle-agent-hooks', 'hooks-claude-code', 'experimental/hooks-claude-code'],
    ['bundle-agent-hooks', 'hooks-codex', 'experimental/hooks-codex'],
    ['bundle-code-intelligence', 'lsp-stdio', 'lsp/lsp-stdio'],
    ['bundle-webhooks', 'github-webhook-adapter', 'experimental/webhook-github'],
    ['bundle-external-agents', 'experimental-subagent-oar-codex', 'experimental/subagent-oar'],
    ['bundle-external-agents', 'experimental-subagent-oar-claude', 'experimental/subagent-oar'],
  ] as const

  it('bundle-webhooks: row github-webhook-server mounts upstream\'s web server through the bundle\'s own module, and passes its schema', async () => {
    const flat = (rows: Row[]): Row[] => rows.flatMap(row => row.group ? [row, ...flat((row.config as Row[]) ?? [])] : [row])
    const row = flat(patchRows('bundle-webhooks')).find(each => each.id === 'github-webhook-server')!
    expect(row.name).toBe('@delorun/bundle-webhooks/server')
    const server = await import(/* @vite-ignore */ join(PACKAGES, 'bundle-webhooks', 'src/server.ts')) as { default: { Config: (value: unknown) => unknown } }
    const upstream = await import('@deepseek-ai/dsh-host-webserver')
    expect(server.default).toBe(upstream.default)
    expect(server.default.Config(interpolate({ process }, row.config))).toMatchObject({ host: '127.0.0.1', port: 3081 })
  })

  it('bundle-browser: row browser-use-playwright-mcp turns on C16 switch browser_additions, the parity value being off', async () => {
    const flat = (rows: Row[]): Row[] => rows.flatMap(row => row.group ? [row, ...flat((row.config as Row[]) ?? [])] : [row])
    const row = flat(patchRows('bundle-browser')).find(each => each.id === 'browser-use-playwright-mcp')!
    const { Config } = await import(/* @vite-ignore */ join(UPSTREAM, 'experimental/browser-use-playwright-mcp', 'src/index.ts')) as { Config: (value: unknown) => { browserAdditions: boolean } }
    expect(Config(interpolate({ process }, row.config)).browserAdditions).toBe(true)
    expect(Config({ mode: 'launch' }).browserAdditions).toBe(false)
  })

  it.each(CHECKED)('%s: row %s passes its plugin schema', async (dir, id, plugin) => {
    const flat = (rows: Row[]): Row[] => rows.flatMap(row => row.group ? [row, ...flat((row.config as Row[]) ?? [])] : [row])
    const row = flat(patchRows(dir)).find(each => each.id === id)!
    const { Config } = await import(/* @vite-ignore */ join(UPSTREAM, plugin, 'src/index.ts')) as { Config: (value: unknown) => unknown }
    const config = interpolate({ process }, row.config)
    expect(() => Config(config)).not.toThrow()
  })
})
