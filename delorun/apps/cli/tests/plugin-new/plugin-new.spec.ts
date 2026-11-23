/**
 * `delorun plugin new` (`delorun/apps/cli/src/plugin-new/`): each kind's scaffold, the manifest `delorun plugin check`
 * admits, the names and folders it refuses, and that it writes only inside the new folder. The installation is a
 * temporary directory standing for one, so which names it ships is fixed by the test.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SemanticVersion } from '@delorun/contract-release-manifest'
import { CliError, EXIT } from '../../src/exit.ts'
import { runPluginCheck } from '../../src/plugin-check.ts'
import { runPluginNew } from '../../src/plugin-new/index.ts'
import { PAGE_MODULES, PLUGIN_KINDS, TOOLCHAIN, type Installation, type PluginKind } from '@delorun/plugin-scaffold'
// Relative: the CLI does not depend on the web shell; the scaffold's build must name the page's module table exactly.
import { PLATFORM_MODULES } from '../../../../../packages/client/web/src/platform.ts'

const RUNNING = { delorun: brandString<SemanticVersion>('0.1.3'), dsh: brandString<SemanticVersion>('0.2.2') }
const CORDIS = '4.1.0'

/** The repository root, whose own toolchain versions the scaffold's must match. */
const REPO = join(import.meta.dirname, '../../../../..')

let root: string
let installation: Installation

/**
 * Write a JSON file, creating its directory.
 * @param path - the file.
 * @param value - its value.
 */
function writeJson(path: string, value: object): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value)}\n`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delorun-plugin-new-'))
  const install = join(root, 'install')
  // The installation ships shipped-plugin directly and deep-dependency only through cordis, where Node's lookup from
  // the anchor does not reach it but the installation's runtime resolution does.
  writeJson(join(install, 'package.json'), { name: '@deepseek-ai/dsh', version: RUNNING.dsh, dependencies: { '@deepseek-ai/cordis': CORDIS, 'shipped-plugin': '1.0.0' } })
  writeJson(join(install, 'node_modules/@deepseek-ai/cordis/package.json'), { name: '@deepseek-ai/cordis', version: CORDIS, dependencies: { 'deep-dependency': '1.0.0' } })
  writeJson(join(install, 'node_modules/@deepseek-ai/cordis/node_modules/deep-dependency/package.json'), { name: 'deep-dependency', version: '1.0.0' })
  writeJson(join(install, 'node_modules/shipped-plugin/package.json'), { name: 'shipped-plugin', version: '1.0.0' })
  installation = { anchor: join(install, 'package.json') }
  mkdirSync(join(root, 'work'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * Run the command and collect what it prints.
 * @param args - the arguments after `new`.
 * @returns the exit code and the output.
 */
async function scaffold(args: readonly string[]): Promise<{ readonly exit: number | undefined, readonly out: string }> {
  let out = ''
  const exit = await runPluginNew(args, { env: {}, stdout: (text) => { out += text }, stderr: () => {} }, RUNNING, installation)
  return { exit, out }
}

/**
 * Every file under a folder.
 * @param folder - the folder.
 * @returns the paths relative to it, `/`-separated and sorted.
 */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(folder.length + 1).split('\\').join('/'))
    .sort()
}

/**
 * A folder's `package.json`.
 * @param folder - the folder.
 * @returns the parsed manifest.
 */
function manifestOf(folder: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as Record<string, Record<string, unknown>>
}

/**
 * The error a promise rejects with.
 * @param promise - the promise.
 * @returns the CliError it rejected with.
 */
async function refusal(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(CliError)
  return error as CliError
}

/** The files each kind writes. */
const LAYOUT: Readonly<Record<PluginKind, readonly string[]>> = {
  tool: ['.gitignore', 'README.md', 'cordis.patch.yml', 'locale/en.json', 'package.json', 'src/index.ts', 'tsconfig.json', 'tsdown.config.ts'],
  preset: ['.gitignore', 'README.md', 'cordis.patch.yml', 'locale/en.json', 'package.json'],
  ui: ['.gitignore', 'README.md', 'cordis.patch.yml', 'locale/en.json', 'package.json', 'src/client/index.tsx', 'src/index.ts', 'tsconfig.json', 'tsdown.config.ts'],
  bundle: ['.gitignore', 'README.md', 'cordis.patch.yml', 'locale/en.json', 'package.json'],
}

describe('delorun plugin new', () => {
  it.each(PLUGIN_KINDS)('scaffolds a %s plugin whose files each end in one newline', async (kind) => {
    const folder = join(root, 'work', kind)
    const { exit, out } = await scaffold([`@you/my-${kind}`, '--kind', kind, '--dir', folder])
    expect(exit).toBe(EXIT.ok)
    expect(filesUnder(folder)).toEqual([...LAYOUT[kind]].sort())
    for (const path of filesUnder(folder)) expect(readFileSync(join(folder, path), 'utf8')).toMatch(/[^\n]\n$/u)
    expect(out).toContain(`Created @you/my-${kind}, a ${kind} plugin, in ${folder}:`)
    expect(out).toContain(`delorun plugin add ${folder}`)
    expect(out).toContain('delorun plugin check .')
    expect(out).toContain('delorun plugin dev .')
    expect(out.includes('pnpm run build')).toBe(kind === 'tool' || kind === 'ui')
  })

  it.each(PLUGIN_KINDS)('writes a %s manifest that delorun plugin check admits on the running release', async (kind) => {
    const folder = join(root, 'work', kind)
    await scaffold([`@you/my-${kind}`, '--kind', kind, '--dir', folder])
    let out = ''
    expect(await runPluginCheck([folder], { env: {}, stdout: (text) => { out += text }, stderr: () => {} }, RUNNING)).toBe(EXIT.ok)
    expect(out).toContain('DSH axis: not checked on Delorun, because engines.delorun decides alone')
    expect(out).toContain('Delorun axis: engines.delorun admits Delorun 0.1.3, and decides alone')
    expect(manifestOf(folder)['engines']).toMatchObject({ dsh: '^0.2.2' })
  })

  it.each(['0.1.0-preview.1.18', '0.1.0'])('writes a manifest that delorun plugin check admits on Delorun %s', async (delorun) => {
    const running = { ...RUNNING, delorun: brandString<SemanticVersion>(delorun) }
    const folder = join(root, 'work', 'preview')
    await runPluginNew(['@you/preview', '--dir', folder], { env: {}, stdout: () => {}, stderr: () => {} }, running, installation)
    let out = ''
    expect(await runPluginCheck([folder], { env: {}, stdout: (text) => { out += text }, stderr: () => {} }, running)).toBe(EXIT.ok)
    expect(out).toContain(`Delorun axis: engines.delorun admits Delorun ${delorun}, and decides alone`)
    expect(manifestOf(folder)['engines']).toMatchObject({ delorun: '^0.1.0-0' })
  })

  it('declares the bundle patch, both engines, and the DSH packages a tool shares with the host as peers', async () => {
    const folder = join(root, 'work', 'greet')
    await scaffold(['greet', '--dir', folder])
    const manifest = manifestOf(folder)
    expect(manifest).toMatchObject({
      name: 'greet',
      version: '0.1.0',
      type: 'module',
      main: './lib/index.js',
      exports: { '.': './lib/index.js' },
      scripts: { build: 'tsdown', prepare: 'tsdown' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      engines: { dsh: '^0.2.2', delorun: '^0.1.0-0' },
      peerDependencies: { '@deepseek-ai/cordis': `~${CORDIS}`, '@deepseek-ai/dsh-tools': '^0.2.2' },
    })
    expect(manifest['devDependencies']).toEqual({
      '@deepseek-ai/cordis': `~${CORDIS}`, '@deepseek-ai/dsh-tools': '^0.2.2', tsdown: TOOLCHAIN.tsdown, typescript: TOOLCHAIN.typescript,
    })
    expect(readFileSync(join(folder, 'cordis.patch.yml'), 'utf8')).toContain("- insert:\n    - id: 'greet'\n      name: 'greet'\n")
    expect(readFileSync(join(folder, 'src/index.ts'), 'utf8')).toContain("export const inject = ['tools']")
    expect(JSON.parse(readFileSync(join(folder, 'locale/en.json'), 'utf8'))).toEqual({ meta: { title: 'Greet', description: manifest['description'] } })
  })

  it('declares a ui plugin\'s studio half under dsh.client and exports lib/client.js', async () => {
    const folder = join(root, 'work', 'page')
    await scaffold(['@you/my-page', '--kind', 'ui', '--dir', folder])
    const manifest = manifestOf(folder)
    expect(manifest['dsh']).toEqual({ bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] } })
    expect(manifest['exports']).toMatchObject({ '.': './lib/index.js', './client': './lib/client.js' })
    expect(manifest['files']).toEqual(['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'locale/*.json'])
    expect(readFileSync(join(folder, 'tsdown.config.ts'), 'utf8')).toContain('window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {')
  })

  it('gives a preset and a bundle no code, build or dependencies', async () => {
    for (const kind of ['preset', 'bundle'] as const) {
      const folder = join(root, 'work', kind)
      await scaffold([`my-${kind}`, '--kind', kind, '--dir', folder])
      const manifest = manifestOf(folder)
      for (const field of ['main', 'scripts', 'peerDependencies', 'devDependencies']) expect(manifest[field]).toBeUndefined()
      expect(manifest['exports']).toEqual({ './cordis.patch.yml': './cordis.patch.yml', './locale/*.json': './locale/*.json', './package.json': './package.json' })
    }
    expect(readFileSync(join(root, 'work', 'preset', 'cordis.patch.yml'), 'utf8')).toContain("      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: 'my-preset'\n")
    expect(readFileSync(join(root, 'work', 'bundle', 'cordis.patch.yml'), 'utf8')).toContain('- id: fs-observation-policy\n  disabled: false\n')
  })

  it.each(['tool', 'preset'] as const)('writes the %s patch\'s ids as strings when the name is all digits', async (kind) => {
    const folder = join(root, 'work', kind)
    await scaffold(['2024', '--kind', kind, '--dir', folder])
    const [patch] = parse(readFileSync(join(folder, 'cordis.patch.yml'), 'utf8')) as [{ insert: [{ id: unknown, config?: { id: unknown, name: unknown } }] }]
    const [row] = patch.insert
    expect(row.id).toBe(kind === 'tool' ? '2024' : 'preset-2024')
    if (kind === 'preset') expect(row.config).toMatchObject({ id: '2024', name: '2024' })
  })

  it('names the folder after the name without its scope, under the working directory', async () => {
    const before = process.cwd()
    process.chdir(join(root, 'work'))
    try {
      await scaffold(['@you/greeter'])
    } finally {
      process.chdir(before)
    }
    expect(readdirSync(join(root, 'work'))).toEqual(['greeter'])
    expect(manifestOf(join(root, 'work', 'greeter'))['name']).toBe('@you/greeter')
  })

  it('writes into an empty folder that exists, and nothing beside it', async () => {
    const folder = join(root, 'work', 'empty')
    mkdirSync(folder)
    expect((await scaffold(['greet', '--dir', folder])).exit).toBe(EXIT.ok)
    expect(readdirSync(join(root, 'work'))).toEqual(['empty'])
    expect(readdirSync(root).sort()).toEqual(['install', 'work'])
  })

  it.each([
    ['Upper'], ['_leading'], ['.leading'], ['has space'], ['http'], ['node_modules'], [`a${'b'.repeat(214)}`], ['@scope'], ['@you/'],
  ])('refuses %j, which npm would not publish', async (name) => {
    const error = await refusal(scaffold([name, '--dir', join(root, 'work', 'x')]))
    expect(error.exit).toBe(EXIT.usage)
    expect(error.message).toContain('is not a package name npm publishes')
    expect(readdirSync(join(root, 'work'))).toEqual([])
  })

  it.each([['@deepseek-ai/greet', '@deepseek-ai'], ['@delorun/greet', '@delorun']])('refuses %s, under a reserved scope', async (name, scope) => {
    const error = await refusal(scaffold([name, '--dir', join(root, 'work', 'x')]))
    expect(error.exit).toBe(EXIT.usage)
    expect(error.message).toBe(`delorun plugin new: "${name}" is under the ${scope} scope, which only its own packages use; name the plugin under your own scope, such as @you/greet`)
  })

  it.each([['shipped-plugin'], ['deep-dependency']])('refuses %s, a package the installation ships', async (name) => {
    const error = await refusal(scaffold([name, '--dir', join(root, 'work', 'x')]))
    expect(error.exit).toBe(EXIT.usage)
    expect(error.message).toBe(`delorun plugin new: "${name}" is a package this Delorun installation ships, and a profile loads the shipped package instead of a plugin of the same name; choose another name, such as @you/${name}`)
    expect(readdirSync(join(root, 'work'))).toEqual([])
  })

  it('refuses a folder that is not empty and leaves it as it was', async () => {
    const folder = join(root, 'work', 'taken')
    mkdirSync(folder)
    writeFileSync(join(folder, 'notes.txt'), 'mine\n')
    const error = await refusal(scaffold(['greet', '--dir', folder]))
    expect(error.exit).toBe(EXIT.failed)
    expect(error.message).toBe(`delorun plugin new: ${folder} is not empty; choose a new or empty folder with --dir`)
    expect(readdirSync(folder)).toEqual(['notes.txt'])
  })

  it('refuses a folder that is a file, and one under a file', async () => {
    writeFileSync(join(root, 'work', 'file'), '')
    expect((await refusal(scaffold(['greet', '--dir', join(root, 'work', 'file')]))).message).toContain('exists and is not a folder')
    const error = await refusal(scaffold(['greet', '--dir', join(root, 'work', 'file', 'greet')]))
    expect(error.exit).toBe(EXIT.failed)
    expect(error.message).toContain(`${join(root, 'work', 'file', 'greet')} cannot be read`)
    expect(readdirSync(join(root, 'work'))).toEqual(['file'])
  })

  it('creates the missing parent folders of the folder', async () => {
    const folder = join(root, 'work', 'plugins', 'home', 'greet')
    expect((await scaffold(['greet', '--dir', folder])).exit).toBe(EXIT.ok)
    expect(manifestOf(folder)['name']).toBe('greet')
    expect(readdirSync(join(root, 'work', 'plugins'))).toEqual(['home'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('removes what it wrote when a write fails', async () => {
    const folder = join(root, 'work', 'locked')
    mkdirSync(folder)
    chmodSync(folder, 0o555)
    try {
      const error = await refusal(scaffold(['greet', '--dir', folder]))
      expect(error.exit).toBe(EXIT.failed)
      expect(error.message).toContain('could not be written, and what this command wrote there is removed')
      expect(readdirSync(folder)).toEqual([])
    } finally {
      chmodSync(folder, 0o755)
    }
  })

  it.each([
    [[]], [['a', 'b']], [['a', '--kind', 'widget']], [['a', '--colour', 'red']], [['a', '--dir']], [['a', '--dir', '']],
  ])('refuses the command line %j with the usage code', async (args) => {
    expect((await refusal(scaffold(args))).exit).toBe(EXIT.usage)
  })

  it('builds with the toolchain versions and page modules the repository itself uses', () => {
    const rootManifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    expect(TOOLCHAIN.typescript).toBe(rootManifest.devDependencies['typescript'])
    expect(TOOLCHAIN.tsdown).toBe(rootManifest.devDependencies['tsdown'])
    expect(TOOLCHAIN['@types/react']).toBe(rootManifest.devDependencies['@types/react'])
    expect(PAGE_MODULES).toEqual(PLATFORM_MODULES)
  })
})
