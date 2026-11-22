import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveSurface } from '@delorun/logs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Finished, TimedLine } from '../src/harness/processes.ts'
import { CLI_COMMANDS, CLI_ITEMS, commandItems } from '../src/suites/cli/index.ts'
import { addPlugins, chatIds, corpusModules, upstreamVersion } from '../src/fixtures/data.ts'
import { DATA_ITEMS, gatherIntoWorkspace, shellWord } from '../src/suites/data/index.ts'
import { INSTALL_ITEMS, installItems } from '../src/suites/install/index.ts'
import { oldestVersion } from '../src/suites/recovery/index.ts'
import { signInLink, studioOrigin } from '../src/suites/start/index.ts'
import { SUITES } from '../src/suites/index.ts'

const made: string[] = []
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A new temporary directory. */
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'delorun-bench-spec-'))
  made.push(directory)
  return directory
}

/** A finished command with these lines. */
function finished(lines: readonly [number, string][], extra: Partial<Finished> = {}): Finished {
  return { code: 0, signal: null, startedAt: 1000, firstOutputAt: 1100, endedAt: 9000, timedOut: false, lines: lines.map(([at, text]): TimedLine => ({ at, stream: 'stdout', text })), ...extra }
}

describe('the suite list', () => {
  it('names each suite, scenario and item once', () => {
    expect(new Set(SUITES.map(suite => suite.id)).size).toBe(SUITES.length)
    for (const suite of SUITES) expect(new Set(suite.scenarios.map(scenario => scenario.id)).size).toBe(suite.scenarios.length)
    expect(Object.keys(CLI_ITEMS)).toHaveLength(3 + 2 * CLI_COMMANDS.length)
  })
})

describe('the CLI suite', () => {
  it('times a command to its first output and its exit, and leaves out a first output it never printed', () => {
    expect(commandItems('status', finished([]))).toEqual({ 'status:first-output': 100, 'status:exit': 8000 })
    expect(commandItems('status', finished([], { firstOutputAt: undefined }))).toEqual({ 'status:exit': 8000 })
  })
})

describe('the install suite', () => {
  it('reads the install\'s steps from the launcher\'s progress lines', () => {
    const run = finished([[1500, '✔ Found release 0.1.0 on the stable channel  0.4s'], [1600, '✔ Signature checked (release root 1)  0.1s'], [1700, '✔ Release log checked  0.1s'], [1710, 'Downloading delorun-0.1.0-linux-x64.tar.gz…'], [5000, '✔ Unpacked the runtime (3,516 files)  3.3s'], [8000, 'Delorun 0.1.0']])
    expect(installItems(run)).toEqual({ 'install': 8000, 'install:resolve': 500, 'install:signature': 100, 'install:log': 100, 'install:download': 3290, 'install:store-and-start': 3000 })
    expect(installItems(finished([]))).toEqual({ install: 8000 })
    expect(Object.keys(installItems(run)).every(item => item in INSTALL_ITEMS)).toBe(true)
  })
})

describe('the recovery suite', () => {
  it('restores the oldest history version, and finds none in an empty history', () => {
    expect(oldestVersion(finished([[1, '{"versions": [{"id": "new"},'], [1, '{"id": "old"}]}']]))).toBe('old')
    expect(oldestVersion(finished([[1, '{"versions": []}']]))).toBeUndefined()
    expect(oldestVersion(finished([[1, '{}']]))).toBeUndefined()
  })
})

describe('the data suite', () => {
  it('installs synthetic plugins that declare their ranges, and reads the upstream version from the ledger', () => {
    const home = scratch()
    mkdirSync(join(home, 'profiles', 'default'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'default', 'package.json'), JSON.stringify({ name: 'profile', dependencies: { kept: '1.0.0' } }))
    addPlugins(home, 2, { dsh: '>=1.0.0' })
    const profile = JSON.parse(readFileSync(join(home, 'profiles', 'default', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(profile.dependencies).toEqual({ 'kept': '1.0.0', '@delorun-benchmark/plugin-00': '1.0.0', '@delorun-benchmark/plugin-01': '1.0.0' })
    const plugin = JSON.parse(readFileSync(join(home, 'profiles', 'default', 'node_modules', '@delorun-benchmark', 'plugin-01', 'package.json'), 'utf8')) as { engines: unknown }
    expect(plugin.engines).toEqual({ dsh: '>=1.0.0' })
    expect(upstreamVersion(join(import.meta.dirname, '..', '..', '..', '..'))).toMatch(/^\d+\.\d+\.\d+/u)
    const fake = scratch()
    mkdirSync(join(fake, 'delorun'))
    writeFileSync(join(fake, 'delorun', 'upstream-patches.json'), JSON.stringify({ upstream: { ref: 'main' } }))
    expect(() => upstreamVersion(fake)).toThrow('names no dsh-v')
  })

  it('names the synthetic chats as upstream\'s corpus does', async () => {
    expect(await chatIds(2)).toEqual(['bench-00000', 'bench-00001'])
    expect(typeof (await corpusModules()).SyntheticCorpusWriter).toBe('function')
  })

  it('gathers every synthetic chat into the home\'s first workspace, keeping its own chats', () => {
    const home = scratch()
    mkdirSync(join(home, 'storages'))
    const path = join(home, 'storages', 'workspace.json')
    writeFileSync(path, JSON.stringify({ version: 1, tables: { workspaces: { w1: { path: '/w', title: 'W', sessionIds: ['own', 'bench-00001'] }, w2: { path: '/x', title: 'X', sessionIds: [] } } } }))
    expect(gatherIntoWorkspace(home, ['bench-00000', 'bench-00001'])).toBe('w1')
    const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number, tables: { workspaces: Record<string, { sessionIds: string[] }> } }
    expect(document.version).toBe(1)
    expect(document.tables.workspaces.w1!.sessionIds).toEqual(['own', 'bench-00001', 'bench-00000'])
    expect(document.tables.workspaces.w2!.sessionIds).toEqual([])
  })

  it('gathers nothing in a home without a registry or without a workspace', () => {
    const home = scratch()
    expect(gatherIntoWorkspace(home, ['c'])).toBeUndefined()
    mkdirSync(join(home, 'storages'))
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: {} }))
    expect(gatherIntoWorkspace(home, ['c'])).toBeUndefined()
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { w: { path: '/w', title: 'W' } } } }))
    expect(gatherIntoWorkspace(home, ['c'])).toBe('w')
  })

  it('quotes a shell word so the shell gives back the same text', () => {
    const text = 'it\'s a "path" with $HOME'
    expect(execFileSync('sh', ['-c', `printf %s ${shellWord(text)}`], { encoding: 'utf8', timeout: 30_000 })).toBe(text)
    expect(Object.keys(DATA_ITEMS)).toContain('import-workspace')
  })
})

describe('the start suite', () => {
  it('reads the studio\'s address from the home log, ignoring records from before the start', () => {
    const home = scratch()
    const file = resolveSurface({ kind: 'home', home, profile: 'default' }).file
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const record = (ts: string, msg: string): string => JSON.stringify({ ts, level: 'info', surface: 'home-default', pid: 1, logger: 'stdout', source: 'captured', msg })
    writeFileSync(file, [
      record('2026-11-10T00:00:00.000Z', 'dsh web: http://127.0.0.1:1111'),
      record('2026-11-10T00:00:02.000Z', 'booting'),
      record('2026-11-10T00:00:03.000Z', 'dsh web: http://127.0.0.1:2222/'),
      '',
    ].join('\n'), { mode: 0o600 })
    expect(studioOrigin(home, Date.parse('2026-11-10T00:00:01.000Z'))).toBe('http://127.0.0.1:2222')
    expect(studioOrigin(home, Date.parse('2026-11-10T00:00:04.000Z'))).toBeUndefined()
  })

  it('reads the sign-in link from what delorun open --print printed', () => {
    expect(signInLink(['Sign in within one minute:', 'http://127.0.0.1:2222/?token=a-b_c'])).toBe('http://127.0.0.1:2222/?token=a-b_c')
    expect(signInLink(['no link here'])).toBeUndefined()
  })
})
