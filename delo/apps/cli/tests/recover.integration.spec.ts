/**
 * `delorun recover`: the command contract C3 offers beside the studio's update screen. The specs run it in-process
 * against a fixture home, so what they assert is what a person sees and which files changed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { journalPath, writeJournal } from '@delo/home-process'
import { parseRuntimeVersion, RuntimeStoreError, type LaunchCommand } from '@delo/runtime-store'
import { EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { runLauncher } from '../../npm-launcher/src/launcher.ts'
import { fixtureRelease } from '../../install/tests/support.ts'

/**
 * A release version.
 * @param text - its text.
 * @returns the version.
 */
function release(text: string): RuntimeVersion {
  const parsed = parseRuntimeVersion(text)
  if (parsed === undefined) throw new Error(`${text} is not a release version`)
  return parsed
}

let osHome: string
let deloHome: string

/**
 * Run `delorun` in this process against the fixture home.
 * @param args - the arguments.
 * @returns its exit code and both outputs.
 */
async function delorun(args: readonly string[]): Promise<{ code: number | undefined, stdout: string, stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await main(args, {
    env: { ...process.env, HOME: osHome, USERPROFILE: osHome, DELO_HOME: deloHome },
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  return { code, stdout, stderr }
}

beforeEach(() => {
  osHome = mkdtempSync(join(tmpdir(), 'delorun-recover-'))
  deloHome = join(osHome, '.delo')
  mkdirSync(join(deloHome, 'profiles', 'default'), { recursive: true, mode: 0o700 })
  writeFileSync(join(deloHome, 'profiles', 'default', 'package.json'), JSON.stringify({
    name: 'dsh-profile-default',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@delo/bundle-local'] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(deloHome, 'profiles', 'default', 'cordis.patch.yml'), '[]\n')
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('delorun recover', () => {
  it('reports where the profile stands and lists itself in the help', async () => {
    const help = await delorun(['--help'])
    expect(help.code).toBe(EXIT.ok)
    expect(help.stdout).toContain('recover')
    const status = await delorun(['recover'])
    expect(status.code).toBe(EXIT.ok)
    expect(status.stdout).toContain('This profile has not been through a Delo update yet.')
    expect(status.stdout).toContain('Safe mode is off.')
  })

  it('turns safe mode on and off through the marker under the home\'s run directory', async () => {
    const started = await delorun(['recover', 'safe-mode', '--reason', 'a plugin broke the start'])
    expect(started.code).toBe(EXIT.ok)
    const marker = join(deloHome, 'run', 'default', 'safe-mode.json')
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toContain('a plugin broke the start')
    const ended = await delorun(['recover', 'exit-safe-mode'])
    expect(ended.code).toBe(EXIT.ok)
    expect(ended.stdout).toContain('Safe mode is off')
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses a rollback with no recorded update, and a profile-only rollback on a profile with no history', async () => {
    const recorded = await delorun(['recover', 'rollback'])
    expect(recorded.code).toBe(EXIT.failed)
    expect(recorded.stderr).toContain('NO_UPDATE_RECORD')
    const result = await delorun(['recover', 'rollback', '--profile-only'])
    expect(result.code).toBe(EXIT.failed)
    expect(result.stderr).toContain('RECOVER_REFUSED')
    expect(result.stderr).toContain('What you can do')
  })

  it('refuses two actions, an unknown one, a missing argument and a misplaced option as usage errors', async () => {
    for (const args of [['rollback', 'safe-mode'], ['undo'], ['restore'], ['status', '--profile-only'], ['rollback', '--reason', 'x'], ['--bogus']]) {
      const result = await delorun(['recover', ...args])
      expect(result.code).toBe(EXIT.usage)
      expect(result.stderr).toContain('usage: delorun recover')
    }
  })

  it('lists the update record and the kept chat data in status, and removes only kept data it lists', async () => {
    mkdirSync(join(deloHome, 'data-set-aside', '1.1.0-20261110T130000Z', 'sessions'), { recursive: true })
    writeFileSync(join(deloHome, 'data-set-aside', '1.1.0-20261110T130000Z', 'sessions', 'chat'), 'twelve bytes')
    const status = await delorun(['recover', 'status', '--json'])
    expect(status.code).toBe(EXIT.ok)
    expect(status.stdout).toContain('No update is recorded for a rollback.')
    expect(status.stdout).toContain('Set-aside chat data: data-set-aside/1.1.0-20261110T130000Z (12 bytes)')
    const refused = await delorun(['recover', 'discard', 'sessions'])
    expect(refused.code).toBe(EXIT.failed)
    expect(refused.stderr).toContain('NOT_KEPT_DATA')
    const removed = await delorun(['recover', 'discard', 'data-set-aside/1.1.0-20261110T130000Z'])
    expect(removed.code).toBe(EXIT.ok)
    expect(existsSync(join(deloHome, 'data-set-aside', '1.1.0-20261110T130000Z'))).toBe(false)
  })
})

describe('a rollback that reaches a root', () => {
  it('refuses with ROOT_NOT_ANCHORED, changing nothing, when no launcher named its release roots', async () => {
    const path = journalPath(deloHome, 'default')
    mkdirSync(join(deloHome, 'run', 'default'), { recursive: true, mode: 0o700 })
    await writeJournal(path, { from: release('0.1.0'), to: release('0.2.0'), previous: undefined, startedAt: '2026-11-01T00:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    const before = readFileSync(path, 'utf8')
    let stderr = ''
    const environment: Record<string, string | undefined> = { ...process.env, HOME: osHome, USERPROFILE: osHome, DELO_HOME: deloHome }
    delete environment.DELO_LAUNCHER_ROOTS
    const code = await main(['recover', 'rollback'], { env: environment, stdout: () => undefined, stderr: (text) => { stderr += text } })
    expect(code).toBe(EXIT.failed)
    expect(stderr).toContain('ROOT_NOT_ANCHORED')
    expect(stderr).toContain('start Delo with its launcher')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})

describe('the launcher\'s rollback after the current runtime failed its start check', () => {
  it('starts the previous runtime with recover rollback, which refuses with NO_UPDATE_RECORD when no update is recorded, and the launcher exits with its status', async () => {
    const fixture = await fixtureRelease()
    mkdirSync(join(deloHome, 'trust'), { recursive: true, mode: 0o700 })
    writeFileSync(join(deloHome, 'trust', 'root.json'), fixture.roots[0]!, { mode: 0o600 })
    let stderr = ''
    let stdout = ''
    const status = await runLauncher({
      home: deloHome,
      profile: 'default',
      platform: 'linux-x64',
      args: [],
      passedThrough: [],
      mode: 'enforce',
      roots: fixture.roots,
      logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
      channel: { resolve: () => Promise.reject(new Error('no install')), fill: () => Promise.reject(new Error('no install')) },
      store: {
        prepareLaunch: () => Promise.reject(new RuntimeStoreError('RUNTIME_CHANGED', join(deloHome, 'runtimes', '0.2.0'), 'runtime 0.2.0 differs from its signed file list')),
        install: () => Promise.reject(new Error('no install')),
        retain: () => Promise.reject(new Error('no retention')),
        pointers: () => Promise.resolve({ current: release('0.2.0'), previous: release('0.1.0') }),
        checkRuntime: (version) => Promise.resolve({ version, manifest: fixture.manifest, files: fixture.files }),
        launchCommand: (_version, profile, args): LaunchCommand => ({ command: process.execPath, args: ['entry.js', ...args], env: { DELO_HOME: deloHome, DELO_PROFILE: profile } }),
      },
      // The previous runtime's own `delorun`, run in this process with the environment launch protocol 1 sets.
      spawn: async command => (await main(command.args.slice(1), {
        env: { ...process.env, HOME: osHome, USERPROFILE: osHome, ...command.env },
        stdout: (text) => { stdout += text },
        stderr: (text) => { stderr += text },
      })) ?? EXIT.ok,
      output: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    })
    expect(status).toBe(EXIT.failed)
    expect(stderr).toContain('Delo did not start release 0.2.0: it failed its start check. Starting release 0.1.0')
    expect(stderr).toContain('NO_UPDATE_RECORD')
    expect(stdout).toBe('')
  })
})
