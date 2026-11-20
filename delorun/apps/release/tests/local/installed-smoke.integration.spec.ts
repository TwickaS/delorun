/**
 * The installed-release smoke's own logic: the home-log check and its allowlist, the packs list read from a channel's
 * signed packs file, the load check over the plugin manager's answers, the commands' environment, the clean-up of a
 * leftover home process, and the command line.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELEASE_SCHEMAS } from '@delorun/contract-release-manifest'
import { currentHolder, holderIdentity, holderOf, newStartId, SYSTEM_PROCESS_TABLE, type ProcessHolder } from '@delorun/home'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { BENIGN_LOG_LINES, FORBIDDEN_LOG_LINES, logProblems } from '../../src/installed-smoke/home-log.ts'
import { channelSource, offeredPacks, packsForPlatform } from '../../src/installed-smoke/offered-packs.ts'
import { HOME_LOG_TAIL_LINES, installsState, loadProblems, parseSmokeArgs, redactTokens, smokeEnvironment, stopLeftover, tailLines } from '../../scripts/installed-smoke.ts'
import { PacksSnapshot, readAnswer } from '../../src/installed-smoke/wire.ts'
import { manifestContent, rootFile, throwawayKeys } from '../sign/fixture.ts'

const envelope = (signed: object, keys: Parameters<typeof signEnvelope>[1]): Buffer => Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, keys), undefined, 2)}\n`)

const NOW = Date.parse('2026-11-06T12:00:00Z') / 1000

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A pack entry with the given variants; the variant bodies are not read by the list. */
function pack(name: string, platforms: readonly string[]) {
  const variant = { archive: { name: `${name}.tar.gz`, length: 1, sha256: '0'.repeat(64), sha512: `${'A'.repeat(86)}==` }, files: [], external: [], peers: [] }
  return { name, version: '1.0.0', experimental: false, variants: Object.fromEntries(platforms.map(platform => [platform, variant])) }
}

/** A channel directory with one root, one release's manifest and, unless `packs` is undefined, its packs file. */
function channel(packs: readonly ReturnType<typeof pack>[] | undefined, sign: 'targets' | 'other' = 'targets'): string {
  const keys = throwawayKeys()
  const directory = mkdtempSync(join(tmpdir(), 'installed-smoke-'))
  directories.push(directory)
  mkdirSync(join(directory, 'root'))
  writeFileSync(join(directory, 'root', '1.root.json'), rootFile(keys).bytes)
  const release = join(directory, 'releases', 'download', 'v0.1.0')
  mkdirSync(release, { recursive: true })
  const manifest = envelope(manifestContent('0.1.0', Buffer.from('a')), [keys.targets])
  writeFileSync(join(release, 'delorun-0.1.0.manifest.json'), manifest)
  if (packs !== undefined) {
    const signed = { schema: RELEASE_SCHEMAS.packs, version: '0.1.0', manifest: createHash('sha256').update(manifest).digest('hex'), packs }
    writeFileSync(join(release, 'delorun-0.1.0.packs.json'), envelope(signed, [sign === 'targets' ? keys.targets : generateKeyPairSync('ed25519').privateKey]))
  }
  return directory
}

describe('the home-log check', () => {
  it('refuses each line an earlier release failed with', () => {
    const lines = [
      'packs: Error: failed to import @delorun/bundle-browser',
      'Error [ERR_MODULE_NOT_FOUND]: Cannot find package \'@deepseek-ai/dsh-timeout\' imported from /x',
      'plugin row could not load: @delorun/bundle-webhooks',
      'delorun start: @delorun/bundle-local is not this Delorun\'s own copy',
      'packs: installing @deepseek-ai/dsh-subagent-codex failed: tar header uid is not an octal number',
      'delorun start: the profile would boot without protections',
    ]
    for (const line of lines) expect(logProblems(`ok\n${line}\nok`), line).toHaveLength(1)
    expect(FORBIDDEN_LOG_LINES).toHaveLength(lines.length)
  })

  it('lets the allowlisted lines through, and only those', () => {
    expect(logProblems('hooks-codex: could not load hook config "/tmp/itest-x/home/.codex/hooks.json": Error: ENOENT: no such file or directory')).toEqual([])
    expect(logProblems('hooks-claude-code: could not load hook config "/tmp/itest-x/home/.claude/settings.json": Error: ENOENT: no such file or directory')).toEqual([])
    expect(logProblems('hooks-claude-code: could not load hook config "/tmp/itest-x/home/.claude/settings.json": Error: EACCES: permission denied')).toHaveLength(1)
    expect(logProblems('Delorun could not load @delorun/bundle-browser from its folder: Error: atomic-write: timed out waiting for the writer lock')).toHaveLength(1)
    expect(BENIGN_LOG_LINES.length).toBeLessThanOrEqual(3)
  })

  it('names what a refused line means and quotes it, or the message of a JSON record', () => {
    expect(logProblems('x Cannot find package \'a\'')).toEqual(['a package is missing: x Cannot find package \'a\''])
    expect(logProblems(`${JSON.stringify({ ts: 't', level: 'warn', msg: 'packs: installing a failed: offline' })}\n`)).toEqual(['a pack install failed: packs: installing a failed: offline'])
    expect(logProblems('')).toEqual([])
  })
})

describe('the offered packs', () => {
  it('lists the packs of the signed packs file that install on the platform, sorted', async () => {
    const directory = channel([pack('zeta', ['any']), pack('alpha', ['linux-x64']), pack('mac-only', ['darwin-arm64'])])
    await expect(offeredPacks(channelSource(directory), '0.1.0', 'linux-x64', NOW)).resolves.toEqual(['alpha', 'zeta'])
  })

  it('lists none for a release without a packs file', async () => {
    await expect(offeredPacks(channelSource(channel(undefined)), '0.1.0', 'linux-x64', NOW)).resolves.toEqual([])
  })

  it('refuses a packs file no targets key signed, and a channel without the release or a root', async () => {
    await expect(offeredPacks(channelSource(channel([pack('alpha', ['any'])], 'other')), '0.1.0', 'linux-x64', NOW)).rejects.toThrow()
    const directory = channel([])
    await expect(offeredPacks(channelSource(directory), '0.2.0', 'linux-x64', NOW)).rejects.toThrow(/no manifest for 0\.2\.0/u)
    rmSync(join(directory, 'root'), { recursive: true })
    await expect(offeredPacks(channelSource(directory), '0.1.0', 'linux-x64', NOW)).rejects.toThrow(/no root\/1\.root\.json/u)
  })

  it('filters by platform', () => {
    expect(packsForPlatform([pack('b', ['linux-arm64']), pack('a', ['any'])], 'linux-arm64')).toEqual(['a', 'b'])
  })
})

describe('the load check', () => {
  const bundle = (name: string, rows: { rowId: string, entryId?: string }[], extra: object = {}) => ({ name, installed: true, enabled: true, rows: rows.map(row => ({ moduleName: `${name}/${row.rowId}`, ...row })), ...extra })
  const plugin = (entryId: string, fiberPhase: string | null, extra: object = {}) => ({ entryId, moduleName: 'm', enabled: true, fiberPhase, ...extra })

  it('passes when every row of every pack has an active entry; a disabled entry need not be active', () => {
    const bundles = [bundle('a', [{ rowId: 'r1', entryId: 'e1' }, { rowId: 'r2', entryId: 'e2' }])]
    expect(loadProblems(['a'], bundles, [plugin('e1', 'active'), plugin('e2', null, { enabled: false })])).toEqual([])
  })

  it('names a missing bundle, a disabled one, a row without an entry, and a failed entry', () => {
    const bundles = [bundle('b', [], { enabled: false }), bundle('c', [{ rowId: 'r1' }, { rowId: 'r2', entryId: 'e2' }])]
    const problems = loadProblems(['a', 'b', 'c'], bundles, [plugin('e2', 'failed', { diagnostic: 'Cannot find package x' })])
    expect(problems).toEqual([
      'a: the plugin manager lists no such bundle',
      'b: installed true, enabled false',
      'b: its patch inserts no rows',
      'c: row r1 (c/r1) has no live loader entry',
      'c: row r2 (c/r2) is failed: Cannot find package x',
    ])
  })
})

describe('the install wait', () => {
  it('reads the install list by the wire\'s field names and refuses a list whose items lack them', () => {
    const snapshot = { supported: true, packs: [{ name: 'a', version: '1.0.0' }], queue: [{ key: 'a', state: 'ready', receivedBytes: 1, reloadNeeded: false }] }
    expect(readAnswer(PacksSnapshot, snapshot, 'list').queue[0]?.key).toBe('a')
    expect(() => readAnswer(PacksSnapshot, { ...snapshot, queue: [{ name: 'a', state: 'ready' }] }, 'list')).toThrow(/list answered fields this smoke does not read: queue\.0\.key/u)
  })

  it('waits while any pack is working, and ends when the Host has dropped the finished items at its reload', () => {
    expect(installsState(['a', 'b'], [{ key: 'a', state: 'ready' }, { key: 'b', state: 'needs-reload' }, { key: 'other', state: 'failed' }])).toEqual({ kind: 'working', items: [{ key: 'b', state: 'needs-reload' }] })
    expect(installsState(['a', 'b'], [])).toEqual({ kind: 'ended', items: [] })
    expect(installsState(['a', 'b'], [{ key: 'a', state: 'ready' }])).toEqual({ kind: 'ended', items: [] })
  })

  it('names the packs whose install failed or was cancelled', () => {
    const failed = { key: 'b', state: 'failed', failure: { code: 'failed', message: 'tar header' } }
    expect(installsState(['a', 'b', 'c'], [{ key: 'a', state: 'ready' }, failed, { key: 'c', state: 'cancelled' }])).toEqual({ kind: 'ended', items: [failed, { key: 'c', state: 'cancelled' }] })
  })
})

describe('the run log', () => {
  it('leaves out the sign-in link\'s token and keeps the rest of the line', () => {
    expect(redactTokens('http://127.0.0.1:18982/?token=ULNh-x_1&a=b\nnext')).toBe('http://127.0.0.1:18982/?token=<redacted>&a=b\nnext')
  })
})

describe('the commands\' environment', () => {
  it('holds the scratch folders and no model key or other variable of the person running the cut, the launcher build included', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-not-for-the-smoke')
    vi.stubEnv('OPENAI_API_KEY', 'sk-not-for-the-smoke')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-not-for-the-smoke')
    vi.stubEnv('NPM_TOKEN', 'not-for-the-smoke')
    try {
      const env = smokeEnvironment({ home: '/s/home', delorun: '/s/home/.delorun', tmp: '/s/tmp', npm: '/s/npm' }, 'person')
      expect(Object.keys(env).sort()).toEqual(['DELORUN_HOME', 'HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR', 'USER', 'npm_config_cache', 'npm_config_update_notifier'])
      expect(env).toMatchObject({ HOME: '/s/home', DELORUN_HOME: '/s/home/.delorun', TMPDIR: '/s/tmp', npm_config_cache: '/s/npm', USER: 'person' })
      expect(JSON.stringify(env)).not.toContain('not-for-the-smoke')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('the leftover home process', () => {
  /** A scratch Delorun home whose default profile's home lock records the holder. */
  function homeWithLock(holder: ProcessHolder): string {
    const home = mkdtempSync(join(tmpdir(), 'installed-smoke-home-'))
    directories.push(home)
    mkdirSync(join(home, 'run', 'default'), { recursive: true })
    const record = { v: 1, startId: newStartId(), runtime: '0.1.0', startedAt: new Date().toISOString(), ...holder }
    writeFileSync(join(home, 'run', 'default', 'home.lock'), `${JSON.stringify(record)}\n`, { mode: 0o600 })
    return home
  }

  /** A child process that runs until it is stopped. */
  async function sleeper() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await once(child, 'spawn')
    return child
  }

  const startReadable = process.platform === 'linux' || process.platform === 'darwin'

  it.skipIf(!startReadable)('leaves alone a process that now has the recorded pid but is not the recorded holder', async () => {
    const child = await sleeper()
    try {
      // The record names the child's pid with another process's start identity, this test's: the pid was reused.
      const home = homeWithLock({ ...holderOf(child.pid!), ...holderIdentity({ processStart: currentHolder().processStart }) })
      const said: string[] = []
      stopLeftover(home, line => said.push(line))
      expect(said).toEqual([])
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      expect(SYSTEM_PROCESS_TABLE.exists(child.pid!)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  })

  it('leaves alone a process it cannot confirm as the holder, and says so', async () => {
    const child = await sleeper()
    try {
      const home = homeWithLock({ pid: child.pid! })
      const said: string[] = []
      stopLeftover(home, line => said.push(line))
      expect(said).toEqual([`      left process ${String(child.pid)} running: the home lock names it, but it cannot be confirmed as the home process (${startReadable ? 'no-start-identity' : 'no-start-reader'})`])
      expect(SYSTEM_PROCESS_TABLE.exists(child.pid!)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  })

  it.skipIf(!startReadable)('stops the recorded holder while it runs', async () => {
    const child = await sleeper()
    const exited = once(child, 'exit')
    const home = homeWithLock(holderOf(child.pid!))
    const said: string[] = []
    stopLeftover(home, line => said.push(line))
    expect(said).toEqual([`      stopped the home process ${String(child.pid)} that delorun stop left running`])
    expect(await exited).toEqual([null, 'SIGKILL'])
  })

  it('does nothing without a home lock', () => {
    const home = mkdtempSync(join(tmpdir(), 'installed-smoke-home-'))
    directories.push(home)
    const said: string[] = []
    stopLeftover(home, line => said.push(line))
    expect(said).toEqual([])
  })
})

describe('the command line', () => {
  it('reads a channel directory or origin and the version, with the scratch ports by default', () => {
    const request = parseSmokeArgs(['--channel', 'http://127.0.0.1:18431/', '--version', '0.1.0-preview.1.6'])
    expect(request).toMatchObject({ channel: 'http://127.0.0.1:18431', version: '0.1.0-preview.1.6', launcher: undefined, channelPort: 18981, studioPort: 18982, budgetMinutes: 30, keepGoing: false, keys: undefined })
  })

  it('keeps the scratch home only when asked to', () => {
    expect(parseSmokeArgs(['--channel', 'x', '--version', '0.1.0', '--keep-home']).keepHome).toBe(true)
    expect(parseSmokeArgs(['--channel', 'x', '--version', '0.1.0', '--keep-going']).keepHome).toBe(false)
  })

  it('refuses a missing channel, a missing version and a port or budget out of range', () => {
    expect(() => parseSmokeArgs(['--version', '0.1.0'])).toThrow(/--channel/u)
    expect(() => parseSmokeArgs(['--channel', 'x'])).toThrow(/--version/u)
    expect(() => parseSmokeArgs(['--channel', 'x', '--version', '0.1.0', '--studio-port', '80'])).toThrow(/--studio-port/u)
    expect(() => parseSmokeArgs(['--channel', 'x', '--version', '0.1.0', '--budget-minutes', '0'])).toThrow(/--budget-minutes/u)
  })
})

describe('the home log a failed run prints', () => {
  it('is the last lines of the log without its trailing newline', () => {
    const log = Array.from({ length: HOME_LOG_TAIL_LINES + 5 }, (_, index) => `line ${String(index + 1)}`).join('\n')
    const tail = tailLines(`${log}\n\n`, HOME_LOG_TAIL_LINES).split('\n')
    expect(tail).toHaveLength(HOME_LOG_TAIL_LINES)
    expect(tail[0]).toBe('line 6')
    expect(tail.at(-1)).toBe(`line ${String(HOME_LOG_TAIL_LINES + 5)}`)
    expect(tailLines('one\ntwo', 5)).toBe('one\ntwo')
  })
})
