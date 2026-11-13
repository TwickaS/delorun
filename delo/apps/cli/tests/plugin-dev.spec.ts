/**
 * `delorun plugin dev` (`delo/apps/cli/src/plugin-dev.ts`): the profile patch gains one marked patch of upstream's HMR
 * row that watches the folder while the command runs, keeps the person's other patches and comments, and loses it when
 * the command ends; a patch that sets the HMR row itself is refused. The folder is linked through `delorun plugin add`
 * unless the profile links it already; a package of the same name from elsewhere, one without a bundle and one in a
 * shipped scope are refused. A package with a build script is built at the start and after each change under `src/`.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import type { CommandContext, CommandResult } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { addDevRoot, HMR_ROW, isSourceChange, linkState, removeDevRoot, runPluginDev, type DevDependencies } from '../src/plugin-dev.ts'

/** How long a spec waits for the command's next step: it reads the installation's runtime resolution first. */
const WAIT = { timeout: 10_000 }

/** The profile patch upstream's profile initialisation writes, comments included. */
const TEMPLATE = '# Profile patch layer: a top-level YAML array of loader patch entries.\n[]\n'

let osHome: string
let deloHome: string
let profileDir: string
let folder: string
let context: CommandContext
let out: string[]

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-plugin-dev-')))
  deloHome = join(osHome, '.delo')
  profileDir = join(deloHome, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), TEMPLATE)
  folder = join(osHome, 'my-plugin')
  mkdirSync(join(folder, 'src'), { recursive: true })
  writePackage({ name: 'my-plugin', version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, scripts: { build: 'tsdown' } })
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('DELO_HOME', undefined)
  vi.stubEnv('DELO_PROFILE', undefined)
  out = []
  context = { env: { HOME: osHome }, stdout: (text) => { out.push(text) }, stderr: (text) => { out.push(text) } }
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * Write the plugin folder's manifest.
 * @param manifest - the manifest.
 */
function writePackage(manifest: object): void {
  writeFileSync(join(folder, 'package.json'), `${JSON.stringify(manifest)}\n`)
}

/**
 * Record a dependency in the profile, as pnpm does.
 * @param name - the package's name.
 * @param spec - the recorded spec.
 * @param bundle - whether its bundle is on.
 */
function depend(name: string, spec: string, bundle = true): void {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>, dsh: { profile: { bundles: string[] } } }
  manifest.dependencies[name] = spec
  if (bundle) manifest.dsh.profile.bundles.push(name)
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest)}\n`)
}

/**
 * The profile patch's parsed entries.
 * @returns the entries.
 */
function profilePatch(): unknown {
  return parse(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'))
}

/** A run's stand-ins and what they saw. */
interface Fakes {
  readonly dependencies: DevDependencies
  readonly plugin: (readonly string[])[]
  readonly builds: string[]
  readonly change: (name: string) => void
  readonly stop: () => void
}

/**
 * Stand-ins for the plugin command, the build, the watch and the stop.
 * @param link - whether `plugin add` records the link, as upstream's would.
 * @returns the stand-ins.
 */
function fakes(link = true): Fakes {
  const plugin: (readonly string[])[] = []
  const builds: string[] = []
  let onChange: (name: string | null) => void = () => undefined
  let stop: () => void = () => undefined
  const stopped = new Promise<void>((done) => { stop = done })
  return {
    plugin,
    builds,
    change: (name) => { onChange(name) },
    stop: () => { stop() },
    dependencies: {
      plugin: (args): Promise<CommandResult> => {
        plugin.push(args)
        if (!link) return Promise.resolve(EXIT.failed)
        depend('my-plugin', `link:${relative(profileDir, folder)}`)
        return Promise.resolve(EXIT.ok)
      },
      build: (built) => { builds.push(built); return Promise.resolve(true) },
      watch: (_folder, listener) => { onChange = listener; return { close: () => { onChange = () => undefined } } },
      stopped: () => stopped,
      running: () => Promise.resolve(undefined),
      debounceMs: 5,
    },
  }
}

describe('the HMR patch in the profile patch', () => {
  it('is added with the folder as a root, keeps the file\'s comments, and is removed with its last root', () => {
    const path = join(profileDir, 'cordis.patch.yml')
    const one = addDevRoot(TEMPLATE, '/work/a', path)
    expect(one).toContain('# Profile patch layer')
    expect(parse(one)).toEqual([{ id: HMR_ROW, config: { root: ['/work/a'] } }])
    const two = addDevRoot(one, '/work/b', path)
    expect(parse(two)).toEqual([{ id: HMR_ROW, config: { root: ['/work/a', '/work/b'] } }])
    expect(addDevRoot(two, '/work/b', path)).toBe(two)
    expect(parse(removeDevRoot(two, '/work/a', path))).toEqual([{ id: HMR_ROW, config: { root: ['/work/b'] } }])
    expect(parse(removeDevRoot(removeDevRoot(two, '/work/a', path), '/work/b', path))).toEqual([])
    expect(removeDevRoot(TEMPLATE, '/work/a', path)).toBe(TEMPLATE)
    expect(parse(addDevRoot('# only a comment', '/work/a', path))).toEqual([{ id: HMR_ROW, config: { root: ['/work/a'] } }])
    expect(addDevRoot('# only a comment', '/work/a', path)).toContain('# only a comment')
  })

  it('keeps the person\'s other patches and refuses a patch of the HMR row that is not its own', () => {
    const path = join(profileDir, 'cordis.patch.yml')
    const mine = '- id: delo-trash\n  config: {}\n'
    expect(parse(addDevRoot(mine, '/work/a', path))).toEqual([{ id: 'delo-trash', config: {} }, { id: HMR_ROW, config: { root: ['/work/a'] } }])
    expect(() => addDevRoot('- id: hmr\n  config:\n    root: ["."]\n', '/work/a', path)).toThrow('already sets the hmr row')
    expect(() => addDevRoot('id: hmr\n', '/work/a', path)).toThrow('is not a YAML list of patches')
    expect(() => addDevRoot('- [\n', '/work/a', path)).toThrow('is not YAML')
  })
})

describe('the link and the source changes', () => {
  it('tells a link to the folder from a package of the same name installed from elsewhere', () => {
    expect(linkState(profileDir, 'my-plugin', folder)).toEqual({ kind: 'absent' })
    depend('my-plugin', `link:${relative(profileDir, folder)}`)
    expect(linkState(profileDir, 'my-plugin', folder)).toEqual({ kind: 'linked' })
    depend('my-plugin', 'github:someone/my-plugin')
    expect(linkState(profileDir, 'my-plugin', folder)).toEqual({ kind: 'other', spec: 'github:someone/my-plugin' })
  })

  it('counts a change under src/ only', () => {
    expect(isSourceChange(join('src', 'index.ts'))).toBe(true)
    expect(isSourceChange(join('lib', 'index.js'))).toBe(false)
    expect(isSourceChange('srcs')).toBe(false)
    expect(isSourceChange(null)).toBe(false)
  })
})

describe('delorun plugin dev', () => {
  it('builds, links the folder, watches it through the HMR patch while it runs, rebuilds on a source change, and removes the patch when stopped', async () => {
    const run = fakes()
    const result = runPluginDev([folder], context, run.dependencies)
    await vi.waitFor(() => { expect(profilePatch()).toEqual([{ id: HMR_ROW, config: { root: [folder] } }]) }, WAIT)
    expect(run.plugin).toEqual([['--profile', 'default', 'add', `link:${folder}`]])
    expect(run.builds).toEqual([folder])
    run.change(join('src', 'index.ts'))
    run.change(join('lib', 'index.js'))
    await vi.waitFor(() => { expect(run.builds).toEqual([folder, folder]) }, WAIT)
    run.stop()
    expect(await result).toBe(EXIT.ok)
    expect(profilePatch()).toEqual([])
    expect(out.join('')).toContain('Delo is not running for this profile')
  })

  it('reuses a link to the folder that is there, and builds nothing for a package without a build script', async () => {
    writePackage({ name: 'my-plugin', version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    depend('my-plugin', `link:${relative(profileDir, folder)}`)
    const run = fakes()
    const result = runPluginDev([folder], context, run.dependencies)
    await vi.waitFor(() => { expect(profilePatch()).toEqual([{ id: HMR_ROW, config: { root: [folder] } }]) }, WAIT)
    run.stop()
    expect(await result).toBe(EXIT.ok)
    expect(run.plugin).toEqual([])
    expect(run.builds).toEqual([])
  })

  it('names a linked package whose bundle is off', async () => {
    depend('my-plugin', `link:${relative(profileDir, folder)}`, false)
    const run = fakes()
    const result = runPluginDev([folder], context, run.dependencies)
    await vi.waitFor(() => { expect(out.join('')).toContain('its bundle is off') }, WAIT)
    run.stop()
    expect(await result).toBe(EXIT.ok)
  })

  it('follows a folder given through a link to its real path', async () => {
    const alias = join(osHome, 'alias')
    symlinkSync(folder, alias)
    const run = fakes()
    const result = runPluginDev([alias], context, run.dependencies)
    await vi.waitFor(() => { expect(profilePatch()).toEqual([{ id: HMR_ROW, config: { root: [folder] } }]) }, WAIT)
    run.stop()
    expect(await result).toBe(EXIT.ok)
  })

  it('fails without changing the profile patch when linking fails', async () => {
    const run = fakes(false)
    expect(await runPluginDev([folder], context, run.dependencies)).toBe(EXIT.failed)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(TEMPLATE)
  })

  it.each([
    ['a package of the same name from elsewhere', () => { depend('my-plugin', 'github:someone/my-plugin') }, 'installs my-plugin from github:someone/my-plugin'],
    ['a package without a bundle', () => { writePackage({ name: 'my-plugin', version: '0.1.0' }) }, 'declares no "dsh": { "bundle"'],
    ['a package in a shipped scope', () => { writePackage({ name: '@delo/plugin-trash', dsh: { bundle: { patch: './cordis.patch.yml' } } }) }, 'give your fork its own package name'],
    ['a package without a name', () => { writePackage({ dsh: { bundle: {} } }) }, 'names no package'],
    ['a profile patch that sets the HMR row itself', () => { writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: hmr\n  config:\n    root: ["."]\n') }, 'already sets the hmr row'],
  ])('refuses %s', async (_case, plant, message) => {
    plant()
    const run = fakes()
    const error: unknown = await runPluginDev([folder], context, run.dependencies).then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toContain(message)
  })

  it('refuses a wrong command line, a missing folder and a profile that is not set up', async () => {
    const run = fakes()
    await expect(runPluginDev([], context, run.dependencies)).rejects.toThrow('usage: delorun plugin dev <folder>')
    await expect(runPluginDev([folder, '--watch'], context, run.dependencies)).rejects.toThrow('delorun plugin dev')
    await expect(runPluginDev([join(osHome, 'missing')], context, run.dependencies)).rejects.toThrow('does not exist')
    await expect(runPluginDev([folder, '--profile', 'other'], context, run.dependencies)).rejects.toThrow('the profile other is not set up')
  })
})
