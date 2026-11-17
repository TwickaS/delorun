/**
 * The optional-plugin bundles (owner decisions A399, A405): each is off in a fresh Delorun CLI profile, composes its
 * rows with a valid default config when a person turns it on, takes them away again when turned off, and never
 * mounts a row that would fail to load for want of setup.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertBundlePlatform, composeEntries, initProfile, loadProfileDirectory, UnsupportedBundlePlatformError } from '@deepseek-ai/dsh-app-boot'
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
] as const

const manifest = (dir: string): { name: string; dsh: { bundle: { patch: string; platforms?: string[] } }; delorun: { state: string; pack?: boolean }; dependencies: Record<string, string> } =>
  JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8'))
const patchRows = (dir: string): Row[] => (yaml.load(readFileSync(join(PACKAGES, dir, 'cordis.patch.yml'), 'utf8'), { schema: patchSchema }) as { insert: Row[] }[])[0]!.insert
/** A row's `disabled` as the Loader evaluates it for a given platform and environment. */
const isDisabled = (row: Row, platform = process.platform): boolean => Boolean(interpolate({ process }, row.disabled) ?? false) && platform !== ''

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

  it('declares a dependency on every package it mounts, and mounts rows with ids and names only', () => {
    const top = patchRows(dir)
    expect(top.map(row => row.id)).toEqual([...rows])
    const names = top.flatMap(row => row.group ? ((row.config as Row[]) ?? []).map(child => child.name) : [row.name])
    for (const name of names) if (name !== undefined && name !== 'cordis:group') expect(Object.keys(info.dependencies), name).toContain(name)
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

  it('mounts the language server only when typescript-language-server is on PATH', () => {
    expect(ids('bundle-code-intelligence', binDir())).toEqual(['lsp'])
    expect(ids('bundle-code-intelligence', binDir('typescript-language-server'))).toEqual(['lsp', 'lsp-stdio', 'tool-lsp'])
  })

  it('mounts the GitHub endpoint only when the webhook secret is set', () => {
    expect(ids('bundle-webhooks', binDir())).toEqual(['webhook-runtime'])
    expect(ids('bundle-webhooks', binDir(), 'a-long-random-secret')).toEqual(['webhook-runtime', 'github-webhook-ingress'])
  })
})

describe('default configuration', () => {
  const CHECKED = [
    ['bundle-browser', 'browser-use-playwright-mcp', 'experimental/browser-use-playwright-mcp'],
    ['bundle-agent-hooks', 'hooks-claude-code', 'experimental/hooks-claude-code'],
    ['bundle-agent-hooks', 'hooks-codex', 'experimental/hooks-codex'],
    ['bundle-code-intelligence', 'lsp-stdio', 'lsp/lsp-stdio'],
    ['bundle-webhooks', 'github-webhook-adapter', 'experimental/webhook-github'],
  ] as const

  it.each(CHECKED)('%s: row %s passes its plugin schema', async (dir, id, plugin) => {
    const flat = (rows: Row[]): Row[] => rows.flatMap(row => row.group ? [row, ...flat((row.config as Row[]) ?? [])] : [row])
    const row = flat(patchRows(dir)).find(each => each.id === id)!
    const { Config } = await import(/* @vite-ignore */ join(UPSTREAM, plugin, 'src/index.ts')) as { Config: (value: unknown) => unknown }
    const config = interpolate({ process }, row.config)
    expect(() => Config(config)).not.toThrow()
  })
})
