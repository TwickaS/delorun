import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SharedFixtures, SuiteContext } from '../src/harness/suite.ts'
import { PLUGINS_ITEMS, PLUGINS_SCENARIOS, pluginEvents, pluginsSuite, replaceFile, START_PLUGIN_COUNTS, waitFor, writePluginTarballs, writePnpmShim } from '../src/suites/plugins/index.ts'
import {
  allStarted, configOverride, disabledOverride, firstEvent, loadedPluginFiles, loadedPluginName, loadedPluginRowId, loadedPluginTarballName,
  packageTarball, pluginEventsIn, pnpmEntry, pnpmShim, withRows, type PluginEvent,
} from '../src/suites/plugins/packages.ts'

const made: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/**
 * A new temporary directory, removed after the test.
 * @returns its path.
 */
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'delo-plugins-spec-'))
  made.push(path)
  return path
}

/**
 * One report.
 * @param index - the plugin's index.
 * @param event - what happened.
 * @param generation - the generation.
 * @param at - when.
 * @returns the report.
 */
function report(index: number, event: PluginEvent['event'], generation: number, at: number): PluginEvent {
  return { index, event, generation, at }
}

describe('the synthetic plugin packages', () => {
  it('names each plugin, its row and its tarball by a two-digit index', () => {
    expect(loadedPluginName(3)).toBe('@delo-benchmark/loaded-plugin-03')
    expect(loadedPluginRowId(12)).toBe('delo-benchmark-plugin-12')
    expect(loadedPluginTarballName(7)).toBe('delo-benchmark-loaded-plugin-07-1.0.0.tgz')
  })

  it('declares a dependency-free bundle whose patch inserts one row running the package module', () => {
    const files = loadedPluginFiles(4)
    expect(Object.keys(files)).toEqual(['cordis.patch.yml', 'index.mjs', 'package.json'])
    const manifest = JSON.parse(files['package.json']!) as Record<string, unknown>
    expect(manifest).toMatchObject({ name: '@delo-benchmark/loaded-plugin-04', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    expect(manifest).not.toHaveProperty('dependencies')
    expect(files['cordis.patch.yml']).toBe('- insert:\n    - id: delo-benchmark-plugin-04\n      name: ./index.mjs\n')
  })

  it('has a row that reports its start and stop with its configuration\'s generation', async () => {
    const module = await import(`data:text/javascript,${encodeURIComponent(loadedPluginFiles(4)['index.mjs']!)}`) as { name: string, apply: (ctx: unknown, config?: unknown) => void }
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => { written.push(String(text)); return true })
    const disposers: (() => void)[] = []
    const ctx = { effect: (execute: () => () => void) => { disposers.push(execute()) } }
    module.apply(ctx, undefined)
    module.apply(ctx, { generation: 2 })
    for (const dispose of disposers) dispose()
    expect(module.name).toBe('delo-benchmark-plugin-04')
    expect(written).toEqual(['delo-benchmark-plugin 04 started 1\n', 'delo-benchmark-plugin 04 started 2\n', 'delo-benchmark-plugin 04 stopped 1\n', 'delo-benchmark-plugin 04 stopped 2\n'])
  })

  it('packs the files as a deterministic npm-style tarball that tar unpacks', () => {
    const files = loadedPluginFiles(1)
    const tarball = packageTarball(files)
    expect(packageTarball(files).equals(tarball)).toBe(true)
    const root = directory()
    writeFileSync(join(root, 'plugin.tgz'), tarball)
    const listing = execFileSync('tar', ['-tvzf', join(root, 'plugin.tgz')], { encoding: 'utf8' })
    expect(listing).toContain('1985-10-26')
    execFileSync('tar', ['-xzf', join(root, 'plugin.tgz'), '-C', root])
    expect(readdirSync(join(root, 'package')).sort()).toEqual(Object.keys(files))
    for (const [path, text] of Object.entries(files)) expect(readFileSync(join(root, 'package', path), 'utf8')).toBe(text)
  })

  it('pads an entry whose size is a whole number of blocks with nothing', () => {
    const root = directory()
    writeFileSync(join(root, 'block.tgz'), packageTarball({ 'block.txt': 'x'.repeat(512) }))
    execFileSync('tar', ['-xzf', join(root, 'block.tgz'), '-C', root])
    expect(readFileSync(join(root, 'package', 'block.txt'), 'utf8')).toHaveLength(512)
  })

  it('refuses an entry name a ustar header cannot hold', () => {
    expect(() => packageTarball({ ['a'.repeat(93)]: '' })).toThrow('longer than 100 bytes')
  })
})

describe('reading the rows\' reports', () => {
  it('reads every report in a message and none in other text', () => {
    expect(pluginEventsIn('delo-benchmark-plugin 02 started 1\ndelo-benchmark-plugin 02 stopped 1', 9)).toEqual([report(2, 'started', 1, 9), report(2, 'stopped', 1, 9)])
    expect(pluginEventsIn('studio at http://127.0.0.1:1/', 9)).toEqual([])
  })

  it('times all rows started by the latest of each row\'s first start with the generation', () => {
    const events = [report(0, 'started', 1, 30), report(0, 'started', 1, 10), report(1, 'stopped', 1, 5), report(1, 'started', 2, 6), report(1, 'started', 1, 20)]
    expect(allStarted(events, 2)).toBe(20)
    expect(allStarted(events, 2, 2)).toBeUndefined()
    expect(allStarted(events, 3)).toBeUndefined()
    expect(allStarted([], 0)).toBe(0)
  })

  it('finds a row\'s first report of an event and generation', () => {
    const events = [report(0, 'started', 2, 40), report(0, 'started', 2, 35), report(0, 'stopped', 2, 30), report(1, 'started', 2, 1)]
    expect(firstEvent(events, 0, 'started', 2)).toBe(35)
    expect(firstEvent(events, 0, 'started', 1)).toBeUndefined()
  })

  it('reads the reports from the home log since a time', () => {
    const deloHome = directory()
    const logs = join(deloHome, 'logs', 'home-default')
    mkdirSync(logs, { recursive: true, mode: 0o700 })
    const record = (ts: string, msg: string): string => JSON.stringify({ ts, level: 'info', surface: 'home-default', pid: 1, logger: 'stdout', source: 'captured', msg })
    writeFileSync(join(logs, 'home.log'), `${[
      record('2026-01-01T00:00:00.000Z', 'delo-benchmark-plugin 00 started 1'),
      record('2026-01-01T00:00:02.000Z', 'delo-benchmark-plugin 00 stopped 1'),
      'not a record',
      record('2026-01-01T00:00:03.000Z', 'delo-benchmark-plugin 00 started 1'),
    ].join('\n')}\n`, { mode: 0o600 })
    const since = Date.parse('2026-01-01T00:00:01.000Z')
    expect(pluginEvents(deloHome, since)).toEqual([report(0, 'stopped', 1, since + 1000), report(0, 'started', 1, since + 2000)])
  })
})

describe('changing the profile', () => {
  it('writes the patch rows the studio writes to turn a row off and a row that changes its configuration', () => {
    expect(disabledOverride('delo-benchmark-plugin-00')).toBe('- id: delo-benchmark-plugin-00\n  disabled: true\n')
    expect(configOverride('delo-benchmark-plugin-00', 2)).toBe('- id: delo-benchmark-plugin-00\n  config:\n    generation: 2\n')
  })

  it('appends rows on a line of their own', () => {
    expect(withRows('', '- id: a\n')).toBe('- id: a\n')
    expect(withRows('- id: b\n', '- id: a\n')).toBe('- id: b\n- id: a\n')
    expect(withRows('- id: b', '- id: a\n')).toBe('- id: b\n- id: a\n')
  })

  it('replaces a file by renaming a written sibling over it', () => {
    const path = join(directory(), 'cordis.patch.yml')
    writeFileSync(path, 'before\n')
    replaceFile(path, 'after\n')
    expect(readFileSync(path, 'utf8')).toBe('after\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(path, '..'))).toEqual(['cordis.patch.yml'])
  })
})

describe('the closure\'s pnpm', () => {
  it('reads the pnpm bin from a manifest\'s bin map or bin path', () => {
    expect(pnpmEntry({ bin: { pnpm: 'bin/pnpm.mjs', pnpx: 'bin/pnpx.mjs' } })).toBe('bin/pnpm.mjs')
    expect(pnpmEntry({ bin: 'bin/pnpm.cjs' })).toBe('bin/pnpm.cjs')
  })

  it('refuses a manifest without a pnpm bin', () => {
    for (const manifest of [null, 'pnpm', {}, { bin: null }, { bin: { pnpx: 'bin/pnpx.mjs' } }, { bin: '' }]) {
      expect(() => pnpmEntry(manifest)).toThrow('names no pnpm bin')
    }
  })

  it('writes a pnpm that runs the runtime\'s pnpm entry with the runtime\'s Node and passes its arguments', () => {
    const runtime = directory()
    mkdirSync(join(runtime, 'pnpm'), { recursive: true })
    mkdirSync(join(runtime, 'node', 'bin'), { recursive: true })
    writeFileSync(join(runtime, 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', bin: { pnpm: 'bin/pnpm.mjs' } }))
    writeFileSync(join(runtime, 'node', 'bin', 'node'), '#!/bin/sh\nprintf "%s|" "$@"\n')
    chmodSync(join(runtime, 'node', 'bin', 'node'), 0o755)
    const bin = writePnpmShim(runtime, join(runtime, 'shim'))
    expect(statSync(join(bin, 'pnpm')).mode & 0o777).toBe(0o755)
    expect(execFileSync(join(bin, 'pnpm'), ['add', 'a b'], { encoding: 'utf8' })).toBe(`${join(runtime, 'pnpm', 'bin/pnpm.mjs')}|add|a b|`)
  })

  it('quotes paths that hold a single quote', () => {
    expect(execFileSync('sh', ['-c', pnpmShim('/bin/echo', 'it\'s here').split('\n')[1]!.replace('"$@"', 'x')], { encoding: 'utf8' })).toBe('it\'s here x\n')
  })
})

describe('the suite', () => {
  it('declares the lifecycle and one start scenario per plugin count', () => {
    expect(PLUGINS_SCENARIOS.map(scenario => scenario.id)).toEqual(['lifecycle', 'start-0', 'start-5', 'start-20'])
    expect(START_PLUGIN_COUNTS).toEqual([0, 5, 20])
    expect(pluginsSuite.id).toBe('plugins')
    expect(pluginsSuite.scenarios).toBe(PLUGINS_SCENARIOS)
    expect(Object.keys(PLUGINS_ITEMS)).toEqual(['install', 'install:loaded', 'disable', 'enable', 'reload', 'start', 'start:studio', 'start:plugins'])
  })

  it('measures nothing when no scenario is selected and names what it does not measure', async () => {
    const context = { fixtures: () => Promise.resolve({} as SharedFixtures) } as SuiteContext
    const result = await pluginsSuite.run(context, [])
    expect(result).toMatchObject({ suite: 'plugins', scenarios: [] })
    expect(result.skipped.map(skipped => skipped.item)).toEqual(['installing from a registry', 'the studio\'s plugin manager'])
  })

  it('writes one tarball per plugin into a new directory', () => {
    const target = join(directory(), 'plugin-packages')
    const tarballs = writePluginTarballs(target, 2)
    expect(tarballs).toEqual([join(target, loadedPluginTarballName(0)), join(target, loadedPluginTarballName(1))])
    expect(readFileSync(tarballs[1]!).equals(packageTarball(loadedPluginFiles(1)))).toBe(true)
    expect(existsSync(join(target, loadedPluginTarballName(2)))).toBe(false)
  })

  it('waits until a probe answers', async () => {
    let calls = 0
    await expect(waitFor(() => ++calls >= 2 ? 'done' : undefined, 5_000, 'the probe')).resolves.toBe('done')
    expect(calls).toBe(2)
  })

  it('gives up after the deadline, naming what it waited for', async () => {
    await expect(waitFor(() => undefined, 0, 'the row starting')).rejects.toThrow('the row starting did not happen within 0 seconds')
  })
})
