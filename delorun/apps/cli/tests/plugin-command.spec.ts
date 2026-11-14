/**
 * `delorun plugin`: after upstream's plugin operation, a plugin it linked from a folder is linked to its active
 * directory at once. With protection on, the directory holds nothing until the person applies the folder's content;
 * with protection off, the default, it holds the folder's content, logged as loaded without review. The command says
 * which.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeDirectory, attestTerminal, readChangeLog, setProtection } from '@delorun/changes'
import type { CommandContext } from '../src/command.ts'
import { startChanges } from '../src/changes/start.ts'
import { EXIT } from '../src/exit.ts'
import { plugin, type PluginDependencies } from '../src/upstream.ts'

/** What the mocked upstream command line does: the files `pnpm add` writes, then how it ends. */
const upstream = vi.hoisted(() => ({
  calls: [] as (readonly string[])[],
  run: (): void => {},
  end: 'exit-0' as 'exit-0' | 'exit-1' | 'exit-undefined' | 'return' | 'throw',
}))

/** Upstream's plugin command line replaced by the mocked one; the install check is off, so one call runs per command. */
const dependencies: PluginDependencies = {
  runUpstream: async (argv) => {
    upstream.calls.push(argv)
    upstream.run()
    if (upstream.end === 'throw') throw new Error('upstream failed')
    return upstream.end === 'exit-1' ? 1 : 0
  },
  checkSettings: async () => undefined,
  profileRegistry: async () => null,
  installAnchor: async () => join(tmpdir(), 'package.json'),
  onExit: () => {},
}

/**
 * Run `delorun plugin` against the mocked upstream command line.
 * @param args - the arguments after `plugin`.
 * @param commandContext - the environment and output.
 * @returns the command's exit code.
 */
function runPlugin(args: readonly string[], commandContext: CommandContext): Promise<number> {
  return plugin(args, commandContext, dependencies)
}

const PROFILE = 'default'

let base: string
let home: string
let profileDir: string
let context: CommandContext & { errors: string[] }

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-plugin-')))
  home = join(base, '.delorun')
  vi.stubEnv('HOME', base)
  vi.stubEnv('USERPROFILE', base)
  vi.stubEnv('DSH_HOME', join(base, '.dsh'))
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
  const errors: string[] = []
  context = { env: { HOME: base, DSH_HOME: join(base, '.dsh'), DELORUN_HOME: home }, stdout: () => {}, stderr: text => void errors.push(text), errors }
  profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: {} }, undefined, 2)}\n`)
  await setProtection(home, 'on', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
  upstream.calls = []
  upstream.run = () => {}
  upstream.end = 'exit-0'
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

/**
 * A plugin folder, and the files `pnpm add link:<folder>` writes for it, as the mocked upstream run.
 * @param name - the folder's and the package's name.
 * @returns the folder.
 */
function addingLink(name: string): string {
  const folder = join(base, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), `{"name":"${name}","version":"1.0.0"}\n`)
  writeFileSync(join(folder, 'index.js'), 'export default "not reviewed"\n')
  upstream.run = () => {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies[name] = `link:${folder}`
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    symlinkSync(relative(join(profileDir, 'node_modules'), folder), join(profileDir, 'node_modules', name))
  }
  return folder
}

/**
 * @param name - a package name.
 * @returns the profile's spec for it.
 */
function spec(name: string): string | undefined {
  return (JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies[name]
}

/** Run the profile's first start under Changes, as the home's first `delorun start` does. */
async function firstStart(): Promise<void> {
  await startChanges({ home, profile: PROFILE }, () => {})
}

describe('delorun plugin', () => {
  it('delorun plugin add link:<folder> links the plugin to its empty active directory and leaves the folder waiting for review', async () => {
    await firstStart()
    const folder = addingLink('plug')
    expect(await runPlugin(['--profile', PROFILE, 'add', `link:${folder}`], context)).toBe(EXIT.ok)
    expect(upstream.calls).toEqual([['plugin', '--profile', PROFILE, 'add', `link:${folder}`]])
    const active = activeDirectory(home, PROFILE, 'plug')
    expect(spec('plug')).toBe(`link:${active}`)
    expect(realpathSync(join(profileDir, 'node_modules', 'plug'))).toBe(active)
    expect((await readChangeLog(home, PROFILE)).entries.at(-1)).toMatchObject({ kind: 'plugin-install', state: 'pending', subject: { plugin: 'plug', source: folder } })
    expect(context.errors.join('')).toMatch(/^plug is not loaded until you review it: delorun changes show c[0-9a-f]{10}\n$/)
  })

  it('with protection off, delorun plugin add link:<folder> loads the folder at once, logged as loaded without review', async () => {
    rmSync(join(home, 'changes', 'protection.json'))
    await firstStart()
    const folder = addingLink('plug')
    expect(await runPlugin(['--profile', PROFILE, 'add', `link:${folder}`], context)).toBe(EXIT.ok)
    const active = activeDirectory(home, PROFILE, 'plug')
    expect(spec('plug')).toBe(`link:${active}`)
    expect(readFileSync(join(active, 'index.js'), 'utf8')).toBe('export default "not reviewed"\n')
    const entry = (await readChangeLog(home, PROFILE)).entries.at(-1)!
    expect(entry).toMatchObject({ kind: 'plugin-install', state: 'applied', decidedFrom: 'unreviewed', subject: { plugin: 'plug', source: folder } })
    expect(context.errors.join('')).toBe(`plug loaded without review, because protection is off: delorun changes show ${entry.id}\n`)
  })

  it('moves the link after a failed upstream operation too, and exits 1', async () => {
    await firstStart()
    const folder = addingLink('plug')
    upstream.end = 'exit-1'
    expect(await runPlugin([`--profile=${PROFILE}`, 'add', `link:${folder}`], context)).toBe(EXIT.failed)
    expect(spec('plug')).toBe(`link:${activeDirectory(home, PROFILE, 'plug')}`)
  })

  it('exits 1 and says why when the profile is not what Changes keeps', async () => {
    await firstStart()
    const folder = addingLink('plug')
    writeFileSync(join(profileDir, 'package.json.lock'), '1\n')
    expect(await runPlugin(['--profile', PROFILE, 'add', `link:${folder}`], context)).toBe(EXIT.failed)
    expect(context.errors.join('')).toContain(`delorun: Delorun did not load the profile ${PROFILE}`)
    expect(spec('plug')).toBe(`link:${folder}`)
  })

  it('exits 1 and says why when the profile cannot be checked', async () => {
    await firstStart()
    mkdirSync(join(profileDir, 'package.json.lock'))
    expect(await runPlugin(['--profile', PROFILE, 'list'], context)).toBe(EXIT.failed)
    expect(context.errors.join('')).toContain('delorun: Error: EISDIR')
  })

  it('leaves a profile whose first start under Changes has not run to that start', async () => {
    const folder = addingLink('plug')
    upstream.end = 'exit-undefined'
    expect(await runPlugin(['--profile', PROFILE, 'add', `link:${folder}`], context)).toBe(EXIT.ok)
    expect(spec('plug')).toBe(`link:${folder}`)
    expect(context.errors).toEqual([])
  })

  it('leaves alone a profile the home does not have, and arguments that name none', async () => {
    upstream.end = 'return'
    expect(await runPlugin(['--profile', 'other', 'list'], context)).toBe(EXIT.ok)
    expect(await runPlugin(['list'], context)).toBe(EXIT.ok)
    expect(context.errors).toEqual([])
  })

  it('passes on a failure of upstream\'s command line', async () => {
    upstream.end = 'throw'
    await expect(runPlugin(['--profile', PROFILE, 'list'], context)).rejects.toThrow('upstream failed')
  })
})

describe('the profile delorun plugin checks', () => {
  it('is the one DELORUN_PROFILE or the default selects when the arguments name none, as upstream\'s parser reads them', async () => {
    await firstStart()
    const folder = addingLink('plug')
    expect(await runPlugin(['add', `link:${folder}`], { ...context, env: { ...context.env, DELORUN_PROFILE: PROFILE } })).toBe(EXIT.ok)
    expect(spec('plug')).toBe(`link:${activeDirectory(home, PROFILE, 'plug')}`)
  })
})
