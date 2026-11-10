import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveSurface } from '@delo/logs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Finished, TimedLine } from '../src/harness/processes.ts'
import { CLI_COMMANDS, CLI_ITEMS, commandItems } from '../src/suites/cli/index.ts'
import { DATA_ITEMS, gatherIntoWorkspace, shellWord } from '../src/suites/data/index.ts'
import { INSTALL_ITEMS, installItems } from '../src/suites/install/index.ts'
import { oldestVersion } from '../src/suites/recovery/index.ts'
import { standInBrowser, studioLink } from '../src/suites/start/index.ts'
import { SUITES } from '../src/suites/index.ts'

const made: string[] = []
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A new temporary directory. */
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'delo-bench-spec-'))
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
    const run = finished([[1500, 'Resolving the release: the stable channel names 0.1.0.'], [1600, 'Checking the signature: 0.1.0 is signed under release root 1.'], [1700, 'Checking the release log: verified.'], [1710, 'Downloading delorun-0.1.0-linux-x64.tar.gz (90 MB).'], [5000, 'Installing release 0.1.0.'], [8000, 'Delo 0.1.0']])
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
  it('gathers every synthetic chat into the home\'s first workspace, keeping its own chats', () => {
    const home = scratch()
    mkdirSync(join(home, 'storages'))
    const path = join(home, 'storages', 'workspace.json')
    writeFileSync(path, JSON.stringify({ version: 1, tables: { workspaces: { w1: { path: '/w', title: 'W', sessionIds: ['own', 'bench-00001'] }, w2: { path: '/x', title: 'X', sessionIds: [] } } } }))
    expect(gatherIntoWorkspace(home, 2)).toBe('w1')
    const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number, tables: { workspaces: Record<string, { sessionIds: string[] }> } }
    expect(document.version).toBe(1)
    expect(document.tables.workspaces.w1!.sessionIds).toEqual(['own', 'bench-00001', 'bench-00000'])
    expect(document.tables.workspaces.w2!.sessionIds).toEqual([])
  })

  it('gathers nothing in a home without a registry or without a workspace', () => {
    const home = scratch()
    expect(gatherIntoWorkspace(home, 1)).toBeUndefined()
    mkdirSync(join(home, 'storages'))
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: {} }))
    expect(gatherIntoWorkspace(home, 1)).toBeUndefined()
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { w: { path: '/w', title: 'W' } } } }))
    expect(gatherIntoWorkspace(home, 1)).toBe('w')
  })

  it('quotes a shell word so the shell gives back the same text', () => {
    const text = 'it\'s a "path" with $HOME'
    expect(execFileSync('sh', ['-c', `printf %s ${shellWord(text)}`], { encoding: 'utf8' })).toBe(text)
    expect(Object.keys(DATA_ITEMS)).toContain('import-workspace')
  })
})

describe('the start suite', () => {
  it('reads the studio\'s start link from the home log, ignoring records from before the start', () => {
    const home = scratch()
    const file = resolveSurface({ kind: 'home', home, profile: 'default' }).file
    mkdirSync(dirname(file), { recursive: true })
    const record = (ts: string, msg: string): string => JSON.stringify({ ts, level: 'info', surface: 'home-default', pid: 1, logger: 'stdout', source: 'captured', msg })
    writeFileSync(file, [
      record('2026-11-10T00:00:00.000Z', 'dsh web: http://127.0.0.1:1111/?token=old'),
      record('2026-11-10T00:00:02.000Z', 'booting'),
      record('2026-11-10T00:00:03.000Z', 'dsh web: http://127.0.0.1:2222/?token=a-b_c'),
      '',
    ].join('\n'))
    expect(studioLink(home, Date.parse('2026-11-10T00:00:01.000Z'))).toBe('http://127.0.0.1:2222/?token=a-b_c')
    expect(studioLink(home, Date.parse('2026-11-10T00:00:04.000Z'))).toBeUndefined()
  })

  it('stands in for the browser with commands that record when they were asked', () => {
    const directory = scratch()
    const browser = standInBrowser(directory)
    execFileSync(join(browser.bin, 'xdg-open'), ['http://127.0.0.1:1/'])
    expect(existsSync(browser.record)).toBe(true)
    expect(Number(readFileSync(browser.record, 'utf8').trim())).toBeGreaterThan(1_700_000_000_000)
  })
})
