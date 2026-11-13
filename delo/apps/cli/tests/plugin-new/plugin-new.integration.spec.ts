/**
 * `delorun plugin new`'s scaffolds work on the release that runs. Each kind with a build type-checks and builds with
 * its own `tsdown.config.ts`, its `node_modules` linked to this workspace's packages as `pnpm install` would install
 * them; each kind composes into a profile that lists it, through upstream's profile loader; the tool plugin boots
 * through upstream's `boot` and its tool answers; and the ui plugin's `lib/client.js` registers through the studio's
 * client module system and adds its Settings page.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  boot, composeEntries, createRuntimeResolution, DELO_VERSION_ENV, initProfile, loadProfileDirectory, PluginPackages,
} from '@deepseek-ai/dsh-app-boot'
import { runPluginNew } from '../../src/plugin-new/index.ts'
import { scaffoldNames, type PluginKind } from '../../src/plugin-new/scaffold.ts'
import { PAGE_MODULES } from '../../src/plugin-new/templates.ts'
import { versions } from '../../src/version.ts'
// Relative: the CLI does not depend on the studio's client module system; the spec loads lib/client.js through it.
import { createClientModuleSystem, type ClientBundleRegistration, type ClientModuleLoaderTarget } from '../../../../../packages/client/modules/src/client/index.ts'
import { parseDshClient } from '../../../../../packages/client/modules/src/client/manifest.ts'

/** The repository root. */
const REPO = realpathSync(join(import.meta.dirname, '../../../../..'))
/** Upstream's CLI package manifest, the installation anchor of a source checkout. */
const INSTALL_ANCHOR = join(REPO, 'apps/cli/package.json')
/** The directories this workspace's packages live in, by package name. */
const PACKAGE_TREES = ['packages', 'vendor', 'delo/packages']
/** Packages that resolve to third-party modules installed for these workspace packages. */
const THIRD_PARTY_ANCHORS = [join(REPO, 'package.json'), join(REPO, 'delo/packages/plugin-sidebar/package.json')]
/** The package each kind is scaffolded as. */
const NAMES: Readonly<Record<PluginKind, string>> = { tool: '@you/greet', preset: '@you/read-only', ui: '@you/hello-page', bundle: '@you/careful-edits' }

/** `FiberState.ACTIVE`: Cordis declares the states as a const enum, which a transpiled spec cannot read at run time. */
const ACTIVE = 2

let root: string
const folders = {} as Record<PluginKind, string>

/** The source directory of every workspace package, by package name. */
function workspacePackages(): ReadonlyMap<string, string> {
  const dirs = new Map<string, string>()
  const visit = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'lib') continue
      const child = join(dir, entry.name)
      if (existsSync(join(child, 'package.json'))) dirs.set((JSON.parse(readFileSync(join(child, 'package.json'), 'utf8')) as { name: string }).name, child)
      else if (depth < 1) visit(child, depth + 1)
    }
  }
  for (const tree of PACKAGE_TREES) visit(join(REPO, tree), 0)
  return dirs
}

/**
 * Link every dependency a scaffold declares into its `node_modules`, as `pnpm install` would install it: a workspace
 * package from its source directory, a third-party one from where this workspace installed it.
 * @param folder - the scaffold.
 */
function linkDependencies(folder: string): void {
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string>, peerDependencies?: Record<string, string> }
  const workspace = workspacePackages()
  for (const name of Object.keys({ ...manifest.peerDependencies, ...manifest.devDependencies })) {
    const target = workspace.get(name) ?? THIRD_PARTY_ANCHORS.map((anchor) => {
      const found = createRequire(anchor).resolve.paths(name)?.map(path => join(path, name)).find(path => existsSync(join(path, 'package.json')))
      return found === undefined ? undefined : realpathSync(found)
    }).find(path => path !== undefined)
    if (target === undefined) throw new Error(`${name} is installed nowhere in this workspace`)
    const link = join(folder, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, 'junction')
  }
}

/**
 * Run one of the scaffold's own tools with Node, from the scaffold's folder.
 * @param folder - the scaffold.
 * @param tool - the tool's script under the scaffold's `node_modules`.
 * @param args - its arguments.
 * @returns the tool's combined output.
 * @throws {Error} when the tool exits unsuccessfully.
 */
function run(folder: string, tool: string, args: readonly string[]): string {
  const result = spawnSync(process.execPath, [join(folder, 'node_modules', tool), ...args], { cwd: folder, encoding: 'utf8', timeout: 50_000 })
  const output = `${result.stdout}${result.stderr}`
  if (result.status !== 0) throw new Error(`${tool} ${args.join(' ')} exited ${String(result.status)} (signal ${String(result.signal)}): ${output}`)
  return output
}

/**
 * A profile under a temporary Harness home whose bundles are the given ones, with the scaffold installed as
 * `delorun plugin add <folder>` installs a folder: linked under its `node_modules` and recorded as a dependency.
 * @param kind - the scaffold's kind.
 * @param bundles - the bundles before the scaffold, which is last.
 * @returns the home and the profile's directory.
 */
function profileWith(kind: PluginKind, bundles: readonly string[]): { readonly home: string, readonly dir: string } {
  const home = join(root, `home-${kind}-${String(bundles.length)}`)
  const dir = join(home, 'profiles', 'default')
  initProfile(dir, [...bundles, NAMES[kind]])
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies: { [NAMES[kind]]: `link:${folders[kind]}` } }, null, 2)}\n`)
  const link = join(dir, 'node_modules', NAMES[kind])
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(folders[kind], link, 'junction')
  return { home, dir }
}

/**
 * The rows a profile composes to, as boot and `--dump-config` compose them.
 * @param dir - the profile's directory.
 * @returns the rows at the top level, and the bundles the profile skipped.
 */
function composed(dir: string): { readonly rows: ReturnType<typeof composeEntries>, readonly skipped: readonly string[] } {
  const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
  return { rows: composeEntries(profile.layers.map(layer => layer.patches)), skipped: profile.skippedBundles.map(bundle => bundle.packageName) }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-plugin-new-')))
  const running = versions()
  // A Delo start exports its version, which the profile loader checks each bundle's engines.delo against.
  vi.stubEnv(DELO_VERSION_ENV, running.delo)
  for (const kind of ['tool', 'preset', 'ui', 'bundle'] as const) {
    folders[kind] = join(root, kind)
    await runPluginNew([NAMES[kind], '--kind', kind, '--dir', folders[kind]], { env: {}, stdout: () => {}, stderr: () => {} }, running)
  }
  for (const kind of ['tool', 'ui'] as const) linkDependencies(folders[kind])
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('delorun plugin new scaffolds', () => {
  it.each(['tool', 'ui'] as const)('type-checks and builds the %s plugin with its own configuration', (kind) => {
    run(folders[kind], 'typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.json'])
    run(folders[kind], 'tsdown/dist/run.mjs', [])
    expect(readdirSync(join(folders[kind], 'lib')).filter(name => name.endsWith('.js')).sort()).toEqual(kind === 'ui' ? ['client.js', 'index.js'] : ['index.js'])
  })

  it.each(['tool', 'preset', 'ui', 'bundle'] as const)('composes the %s plugin into a profile after the base bundle', (kind) => {
    const { dir } = profileWith(kind, ['@deepseek-ai/dsh-base'])
    const { rows, skipped } = composed(dir)
    expect(skipped).toEqual([])
    const names = scaffoldNames(NAMES[kind])
    switch (kind) {
      case 'tool':
      case 'ui':
        expect(rows).toContainEqual({ id: names.rowId, name: NAMES[kind] })
        break
      case 'preset':
        expect(rows).toContainEqual(expect.objectContaining({ id: `preset-${names.rowId}`, name: '@deepseek-ai/dsh-agent-preset', config: expect.objectContaining({ id: names.rowId }) }))
        break
      case 'bundle':
        expect(rows).toContainEqual(expect.objectContaining({ id: 'fs-observation-policy', name: '@deepseek-ai/dsh-fs-observation-policy', disabled: false }))
        break
    }
  })

  it('boots the tool plugin from a profile, and the agent\'s tool answers', async () => {
    const { home, dir } = profileWith('tool', [])
    const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
    const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile, home })
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    // The tool registry and the system prompt it injects, which a profile's base bundle provides.
    const registry = { insert: [{ id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: '' } }, { id: 'tools', name: '@deepseek-ai/dsh-tools' }] }
    const ctx = await boot('plugin-new-spec', join(dir, 'cordis.yml'), [registry, ...profile.layers.flatMap(layer => layer.patches)], async (root) => {
      await root.plugin(PluginPackages, { resolution })
    })
    try {
      const names = scaffoldNames(NAMES.tool)
      const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === names.rowId)
      expect(entry?.fiber?.state).toBe(ACTIVE)
      const tools = ctx.get('tools') as { get(name: string): { execute(args: object, run: object): Promise<unknown> } | undefined } | undefined
      const tool = tools?.get(names.toolName)
      expect(await tool?.execute({ name: 'Ada' }, {})).toBe('Hello, Ada!')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('boots the ui plugin\'s host half from a profile', async () => {
    const { home, dir } = profileWith('ui', [])
    const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
    const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile, home })
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const ctx = await boot('plugin-new-spec', join(dir, 'cordis.yml'), profile.layers.flatMap(layer => layer.patches), async (root) => {
      await root.plugin(PluginPackages, { resolution })
    })
    try {
      const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === scaffoldNames(NAMES.ui).rowId)
      expect(entry?.fiber?.state).toBe(ACTIVE)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers the ui plugin\'s lib/client.js through the studio\'s module system, and its apply adds the Settings page', async () => {
    const manifest = JSON.parse(readFileSync(join(folders.ui, 'package.json'), 'utf8')) as { name: string, dsh: { client: unknown } }
    expect(parseDshClient(manifest.name, manifest.dsh.client)).toEqual({ platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] })
    // The page's module table: the modules the studio provides, from the copies this workspace installs.
    const pageRequire = createRequire(join(REPO, 'packages/client/web/package.json'))
    const staticModules = Object.fromEntries(PAGE_MODULES.filter(name => name === 'react' || name === 'react/jsx-runtime' || name === '@deepseek-ai/cordis').map(name => [name, pageRequire(name) as object]))
    const pending: ClientBundleRegistration[] = []
    const target: ClientModuleLoaderTarget = {
      mode: 'queue',
      pendingQueue: pending,
      load: (registration) => { pending.push(registration) },
      create: options => createClientModuleSystem(target, { id: '@deepseek-ai/dsh-client-modules', exports: {} }, options),
    }
    const url = `plugins/??${manifest.name}/client.js&rev=1`
    const loaded: string[] = []
    const system = target.create({
      boot: {
        rev: 'graph',
        entries: [{ id: manifest.name, url, rev: '1', inject: ['@deepseek-ai/dsh-client-ui-settings'] }],
        batches: [{ phase: 'application', url, rev: '1', entries: [manifest.name] }],
      },
      staticModules,
      // The page runs the script as a classic script whose global object is the window.
      loadBundle: (requested) => {
        loaded.push(requested)
        runInNewContext(readFileSync(join(folders.ui, 'lib/client.js'), 'utf8'), { window: { __ModuleLoader__: target } })
        return Promise.resolve()
      },
    })
    const plugin = await system.import(manifest.name) as { inject: unknown, apply(ctx: Context): void }
    expect(loaded).toEqual([url])
    expect(plugin.inject).toEqual(['slots'])

    const registrations: { readonly options: Record<string, unknown>, readonly component: () => unknown }[] = []
    const ctx = new Context()
    ctx.provide('slots', {
      inject(slot: string, register: () => () => void) { expect(slot).toBe('settings.section'); return register() },
      register(options: Record<string, unknown>, component: () => unknown) { registrations.push({ options, component }); return () => {} },
    })
    plugin.apply(ctx)
    const names = scaffoldNames(NAMES.ui)
    expect(registrations.map(registration => registration.options)).toEqual([{ name: 'settings.section', id: names.rowId, order: 100, label: names.title }])
    const { renderToStaticMarkup } = pageRequire('react-dom/server') as { renderToStaticMarkup(element: unknown): string }
    const react = staticModules['react'] as { createElement(type: () => unknown): unknown }
    expect(renderToStaticMarkup(react.createElement(registrations[0]!.component))).toBe(`<section><h2>${names.title}</h2><p>This page comes from the ${NAMES.ui} plugin.</p></section>`)
  })
})
