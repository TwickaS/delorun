/**
 * `delorun recover`: the command contract C3 offers beside the studio's update screen. The specs run it in-process
 * against a fixture home, so what they assert is what a person sees and which files changed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'

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
