/**
 * A built pack loads from the review copy Changes makes of it: the cut builds a pack whose deployment emptied the
 * package's `peerDependencies`, the runtime store installs it with its peer links into the runtime, Changes stores and
 * materializes the installed pack, and every plugin entry of the pack imports from the copy in a separate Node process.
 * The review copy check the cut runs (`reviewCopyProblems`) agrees with what the copy loads.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { materialize, scanFolder, storeFolder } from '@delorun/changes'
import { installPack, parseRuntimeVersion, StorePaths } from '@delorun/runtime-store'
import { buildPack, type PackSources } from '../../src/closure/packs.ts'
import { pluginModules, reviewCopyProblems } from '../../src/closure/review-copy.ts'

/** This computer's platform: only its variant's plugin modules are imported from the copy. */
const PLATFORM: RuntimePlatform = RUNTIME_PLATFORMS.find(each => each === `${process.platform}-${process.arch}`) ?? 'linux-x64'
const RELEASE = parseRuntimeVersion('0.1.0')!

const roots: string[] = []
/** The installed pack is sealed read-only, so its directories are made writable again before removal. */
function writable(path: string): void {
  if (lstatSync(path).isSymbolicLink()) return
  chmodSync(path, 0o700)
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) writable(join(path, name))
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    writable(root)
    rmSync(root, { recursive: true, force: true })
  }
})
const temp = (prefix: string): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}
const put = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
}
const json = (value: object): string => JSON.stringify(value)
/** A one-module ESM package that exports its own name. */
const esm = (directory: string, name: string, version = '1.0.0'): Record<string, string> => ({
  [`${directory}/package.json`]: json({ name, version, type: 'module', exports: './index.js' }),
  [`${directory}/index.js`]: `export const name = ${JSON.stringify(name)}\n`,
})

/** The packages the runtime release carries, which the pack links as peers. */
const RUNTIME = ['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-timeout', '@deepseek-ai/dsh-subagent', '@deepseek-ai/cosmokit', 'react']

/**
 * A Claude Code-like plugin as `pnpm deploy` leaves it: `peerDependencies` emptied, a dependency the runtime carries at
 * the same version, and a bundled package of its own that imports a runtime package it does not declare.
 */
const DEPLOYED: Record<string, string> = {
  'package.json': json({
    name: '@deepseek-ai/dsh-subagent-demo', version: '0.2.2', type: 'module',
    exports: { '.': './lib/index.js', './client': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: {}, dependencies: { '@deepseek-ai/dsh-brand': '1.0.0', '@deepseek-ai/dsh-demo-ui': '0.2.2' },
  }),
  'cordis.patch.yml': [
    '- insert:',
    '    - id: demo',
    '      name: \'@deepseek-ai/dsh-subagent-demo\'',
    '      config:',
    '        home: !!js "process.env.HOME"',
    '    - name: cordis:group',
    '      config:',
    '        - id: client',
    '          name: \'@deepseek-ai/dsh-subagent-demo/client\'',
    '          disabled: true',
    '',
  ].join('\n'),
  'lib/index.js': [
    'import { name as brand } from "@deepseek-ai/dsh-brand"',
    'import { name as timeout } from "@deepseek-ai/dsh-timeout"',
    'import { name as subagent } from "@deepseek-ai/dsh-subagent"',
    'import { name as cosmokit } from "@deepseek-ai/cosmokit"',
    'export const names = [brand, timeout, subagent, cosmokit]',
    '',
  ].join('\n'),
  'lib/client.js': 'export { names } from "@deepseek-ai/dsh-demo-ui"\n',
  ...esm('node_modules/@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-brand'),
  'node_modules/@deepseek-ai/dsh-demo-ui/package.json': json({ name: '@deepseek-ai/dsh-demo-ui', version: '0.2.2', type: 'module', exports: './index.js' }),
  'node_modules/@deepseek-ai/dsh-demo-ui/index.js': 'import { name } from "react"\nexport const names = [name]\n',
}

/**
 * A home running {@link RELEASE} with {@link RUNTIME} installed in its runtime.
 * @returns the home and its store paths.
 */
function runtimeHome(): { readonly home: string, readonly paths: StorePaths } {
  const home = temp('delorun-pack-review-home-')
  const paths = new StorePaths(home, PLATFORM)
  put(paths.runtimeNodeModules(RELEASE), Object.assign({}, ...RUNTIME.map(name => esm(name, name))) as Record<string, string>)
  put(home, { 'runtimes/current': `${RELEASE}\n` })
  return { home, paths }
}

/**
 * @param copy - the materialized review copy.
 * @param entry - a file of the copy.
 * @returns the `names` the entry exports, imported in a separate Node process.
 */
function namesFrom(copy: string, entry: string): string[] {
  const url = pathToFileURL(join(copy, ...entry.split('/'))).href
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `const { names } = await import(${JSON.stringify(url)}); process.stdout.write(JSON.stringify(names))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })) as string[]
}

describe('a built pack\'s review copy', () => {
  it('keeps every peer link of a pack whose deployment emptied its peers, and each plugin entry imports from the copy', async () => {
    const { home, paths } = runtimeHome()
    const sources: PackSources = {
      deploy: (_name, _platform, directory) => Promise.resolve(put(directory, DEPLOYED)),
      closureNodeModules: () => paths.runtimeNodeModules(RELEASE),
      locked: () => undefined,
      download: () => Promise.reject(new Error('no download in this test')),
      declaredPeers: () => Promise.resolve({ peerDependencies: { '@deepseek-ai/dsh-subagent': 'workspace:*', '@deepseek-ai/dsh-timeout': 'workspace:*' } }),
    }
    const built = await buildPack('@deepseek-ai/dsh-subagent-demo', '0.2.2', false, RELEASE, [PLATFORM], 1_800_000_000, [], sources, temp('delorun-pack-review-build-'))
    const variant = built.entry.variants.any!
    expect(variant.peers).toEqual([...RUNTIME].sort())
    const installed = await installPack({ paths, release: RELEASE, entry: built.entry, platform: PLATFORM, archive: built.archives.get(variant.archive.name)!, fetchExternal: () => Promise.reject(new Error('no externals in this pack')) })

    const scanned = await scanFolder(installed, { home })
    expect(scanned.entries.flatMap(entry => (entry.type === 'link' && entry.runtime === true ? [entry.target] : [])).sort()).toEqual([...RUNTIME].sort())

    expect(await reviewCopyProblems(installed, home)).toEqual([])
    // The cut imported these from a copy already; a group's child and a disabled row count.
    expect(await pluginModules(installed)).toEqual(['@deepseek-ai/dsh-subagent-demo', '@deepseek-ai/dsh-subagent-demo/client'])
    const { version } = await storeFolder(home, installed)
    const copy = join(temp('delorun-pack-review-active-'), 'plugin')
    await materialize(home, version, copy)
    expect(namesFrom(copy, 'lib/index.js')).toEqual(['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-timeout', '@deepseek-ai/dsh-subagent', '@deepseek-ai/cosmokit'])
    expect(namesFrom(copy, 'lib/client.js')).toEqual(['react'])
  })

  it('refuses the cut when a plugin module the patch names does not import from the copy, which resolving package names cannot see', async () => {
    const { paths } = runtimeHome()
    // The client entry is exported for require only, so an import of it finds no export, although every package resolves.
    const requireOnly = { ...DEPLOYED, 'package.json': DEPLOYED['package.json']!.replace('"./client":"./lib/client.js"', '"./client":{"require":"./lib/client.cjs"}'), 'lib/client.cjs': 'module.exports = {}\n' }
    const sources: PackSources = {
      deploy: (_name, _platform, directory) => Promise.resolve(put(directory, requireOnly)),
      closureNodeModules: () => paths.runtimeNodeModules(RELEASE),
      locked: () => undefined,
      download: () => Promise.reject(new Error('no download in this test')),
      declaredPeers: () => Promise.resolve({}),
    }
    await expect(buildPack('@deepseek-ai/dsh-subagent-demo', '0.2.2', false, RELEASE, [PLATFORM], 1_800_000_000, [], sources, temp('delorun-pack-review-build-')))
      .rejects.toThrow(/would not load from the review copy Changes makes of it: @deepseek-ai\/dsh-subagent-demo\/client: .*, imported from the review copy/u)
  })

  /**
   * The demo pack with one plugin module, `./env`, that fails to import unless its environment holds no variable of the
   * building process and points every home directory into the check's temporary home.
   */
  function envProbe(): Record<string, string> {
    return {
      ...DEPLOYED,
      'package.json': DEPLOYED['package.json']!.replace('"./client":"./lib/client.js"', '"./client":"./lib/client.js","./env":"./lib/env.js"'),
      'cordis.patch.yml': '- insert:\n    - id: env\n      name: \'@deepseek-ai/dsh-subagent-demo/env\'\n',
      'lib/env.js': [
        'const env = process.env',
        'if (env.PK4_BUILD_SECRET !== undefined || env.NODE_PATH !== undefined || env.NODE_OPTIONS !== undefined) throw new Error("the building process\'s environment reached the import")',
        'for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR"]) {',
        '  if (env[name] === undefined || !env[name].startsWith(env.DELORUN_HOME + "/")) throw new Error(`${name} is outside the temporary home`)',
        '}',
        'if (!process.cwd().startsWith(env.DELORUN_HOME + "/")) throw new Error("the import runs outside the temporary home")',
        '',
      ].join('\n'),
    }
  }

  function demoSources(deployed: Record<string, string>, runtime: string): PackSources {
    return {
      deploy: (_name, _platform, directory) => Promise.resolve(put(directory, deployed)),
      closureNodeModules: () => runtime,
      locked: () => undefined,
      download: () => Promise.reject(new Error('no download in this test')),
      declaredPeers: () => Promise.resolve({}),
    }
  }

  it('imports the plugin modules with none of the building process\'s environment and every home directory in the temporary home', async () => {
    const { paths } = runtimeHome()
    process.env['PK4_BUILD_SECRET'] = 'a credential of the person running the cut'
    process.env['NODE_PATH'] = paths.runtimeNodeModules(RELEASE)
    try {
      await expect(buildPack('@deepseek-ai/dsh-subagent-demo', '0.2.2', false, RELEASE, [PLATFORM], 1_800_000_000, [], demoSources(envProbe(), paths.runtimeNodeModules(RELEASE)), temp('delorun-pack-review-build-'))).resolves.toBeDefined()
    } finally {
      delete process.env['PK4_BUILD_SECRET']
      delete process.env['NODE_PATH']
    }
  })

  it('refuses to import from a review copy with a node_modules folder above it, which could meet an import the copy does not', async () => {
    const { paths } = runtimeHome()
    const outer = temp('delorun-pack-review-outer-')
    mkdirSync(join(outer, 'node_modules'))
    const scratch = join(outer, 'scratch')
    mkdirSync(scratch)
    await expect(buildPack('@deepseek-ai/dsh-subagent-demo', '0.2.2', false, RELEASE, [PLATFORM], 1_800_000_000, [], demoSources(envProbe(), paths.runtimeNodeModules(RELEASE)), scratch))
      .rejects.toThrow(new RegExp(`would not load from the review copy Changes makes of it: the plugin modules cannot be imported from the review copy at .*, because ${join(outer, 'node_modules').replaceAll('/', '\\/')} above it could meet an import the copy does not`, 'u'))
  })

  it('leaves out a peer link no package.json declares, so the copy fails to load where the installed pack loads, as the review copy check reports', async () => {
    const { home, paths } = runtimeHome()
    // An installed pack as 0.1.0-preview.1.5 shipped it: a bundled package beside the link, and the import of
    // dsh-timeout linked but declared nowhere.
    const installed = join(home, 'packs', RELEASE, '@deepseek-ai__dsh-subagent-demo', 'package')
    put(installed, {
      'package.json': json({ name: '@deepseek-ai/dsh-subagent-demo', version: '0.2.2', type: 'module', exports: './lib/index.js', peerDependencies: {}, dependencies: { bundled: '1.0.0' } }),
      'lib/index.js': 'import "bundled"\nimport { name } from "@deepseek-ai/dsh-timeout"\nexport const names = [name]\n',
      ...esm('node_modules/bundled', 'bundled'),
    })
    mkdirSync(join(installed, 'node_modules', '@deepseek-ai'), { recursive: true })
    symlinkSync(join(paths.runtimeNodeModules(RELEASE), '@deepseek-ai', 'dsh-timeout'), join(installed, 'node_modules', '@deepseek-ai', 'dsh-timeout'))
    expect(namesFrom(installed, 'lib/index.js')).toEqual(['@deepseek-ai/dsh-timeout'])
    expect(await reviewCopyProblems(installed, home)).toEqual(['@deepseek-ai/dsh-subagent-demo imports @deepseek-ai/dsh-timeout in lib/index.js without declaring it in its package.json, which the review copy does not hold'])
    const { version } = await storeFolder(home, installed)
    const copy = join(temp('delorun-pack-review-active-'), 'plugin')
    await materialize(home, version, copy)
    expect(() => namesFrom(copy, 'lib/index.js')).toThrow(/Cannot find package '@deepseek-ai\/dsh-timeout'/u)
  })
})
