/**
 * `delorun recover workspaces`: restores the workspace registry's previous good copy. The specs run it in-process
 * against a fixture home and assert what the person sees and which files change.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireHomeLock, ensureHomeTree, newStartId, runDirectory } from '@delo/home'
import { updateChannelProbe } from '@delo/home-process'
import type { CommandContext } from '../src/command.ts'
import { EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { recoverWorkspaces, terminalRestoreConfirm } from '../src/recover-workspaces.ts'
import { runtimeOfFile } from '../src/update/runtime.ts'

const record = { path: '/p', title: 't', sessionIds: [], createdAt: 'x', updatedAt: 'x' }
const registry = (workspaces: Record<string, unknown>, order: string[]): string =>
  `${JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: order }, tables: { workspaces } })}\n`

const GOOD = registry({ a: record, b: { ...record, path: '/q' } }, ['a', 'b'])

let osHome: string
let deloHome: string
let current: string
let previous: string

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

const output = () => {
  const out = { stdout: '', stderr: '' }
  const context: CommandContext = { env: {}, stdout: (text) => { out.stdout += text }, stderr: (text) => { out.stderr += text } }
  return { out, context }
}

beforeEach(async () => {
  osHome = mkdtempSync(join(tmpdir(), 'delorun-recover-workspaces-'))
  deloHome = join(osHome, '.delo')
  mkdirSync(join(deloHome, 'profiles', 'default'), { recursive: true, mode: 0o700 })
  await ensureHomeTree(deloHome, 'default')
  mkdirSync(join(deloHome, 'storages'), { recursive: true })
  current = join(deloHome, 'storages', 'workspace.json')
  previous = `${current}.previous`
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('delorun recover workspaces', () => {
  it('restores the previous copy with --yes, moving the damaged file aside and keeping the copy', async () => {
    writeFileSync(current, 'half a file')
    writeFileSync(previous, GOOD)
    const result = await delorun(['recover', 'workspaces', '--yes'])
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toContain('The current registry')
    expect(result.stdout).toContain('not readable')
    expect(result.stdout).toContain('The previous copy holds: 2 workspaces.')
    expect(readFileSync(current, 'utf8')).toBe(GOOD)
    expect(readFileSync(previous, 'utf8')).toBe(GOOD)
    const aside = readdirSync(join(deloHome, 'storages')).filter(name => name.includes('.quarantined-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(deloHome, 'storages', aside[0]!), 'utf8')).toBe('half a file')
    expect(result.stdout).toContain(aside[0]!)
  })

  it('restores when the current file is missing, without moving anything aside', async () => {
    writeFileSync(previous, GOOD)
    const result = await delorun(['recover', 'workspaces', '--yes'])
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toContain('holds: no file.')
    expect(readFileSync(current, 'utf8')).toBe(GOOD)
    expect(readdirSync(join(deloHome, 'storages')).filter(name => name.includes('.quarantined-'))).toEqual([])
  })

  it('says there is no backup and changes nothing', async () => {
    writeFileSync(current, 'half a file')
    const result = await delorun(['recover', 'workspaces', '--yes'])
    expect(result.code).toBe(EXIT.failed)
    expect(result.stderr).toContain('NO_BACKUP')
    expect(readFileSync(current, 'utf8')).toBe('half a file')
  })

  it('refuses a copy that is itself damaged', async () => {
    writeFileSync(previous, registry({ a: record }, ['a', 'ghost']))
    const result = await delorun(['recover', 'workspaces', '--yes'])
    expect(result.code).toBe(EXIT.failed)
    expect(result.stderr).toContain('BACKUP_UNUSABLE')
    expect(existsSync(current)).toBe(false)
  })

  it('asks first, and does nothing when the answer is no or nobody can answer', async () => {
    writeFileSync(current, 'half a file')
    writeFileSync(previous, GOOD)
    const asked: string[] = []
    const base = { home: deloHome, profile: 'default', yes: false }
    const declined = output()
    expect(await recoverWorkspaces({ ...base, confirm: async (question) => { asked.push(question); return false } }, declined.context)).toBe(EXIT.failed)
    expect(asked).toEqual(['Replace the current workspace registry with the previous copy?'])
    expect(declined.out.stderr).toContain('you declined')
    const silent = output()
    expect(await recoverWorkspaces({ ...base, confirm: undefined }, silent.context)).toBe(EXIT.failed)
    expect(silent.out.stderr).toContain('needs your confirmation')
    expect(readFileSync(current, 'utf8')).toBe('half a file')
    const agreed = output()
    expect(await recoverWorkspaces({ ...base, confirm: async () => true }, agreed.context)).toBe(EXIT.ok)
    expect(readFileSync(current, 'utf8')).toBe(GOOD)
  })

  it('has no terminal question without a terminal', () => {
    expect(terminalRestoreConfirm()).toBeUndefined()
  })

  it('refuses while Delorun runs for the profile, and takes --yes only with workspaces', async () => {
    writeFileSync(previous, GOOD)
    const lock = await acquireHomeLock({ runDirectory: runDirectory(deloHome, 'default'), runtime: runtimeOfFile(deloHome, fileURLToPath(import.meta.url)).version, probe: updateChannelProbe(deloHome, 'default'), startId: newStartId() })
    try {
      await expect(recoverWorkspaces({ home: deloHome, profile: 'default', yes: true, confirm: undefined }, output().context)).rejects.toThrow()
    } finally {
      lock.release()
    }
    expect(existsSync(current)).toBe(false)
    const misplaced = await delorun(['recover', 'status', '--yes'])
    expect(misplaced.code).toBe(EXIT.usage)
    expect(misplaced.stderr).toContain('--yes belongs to workspaces')
  })
})
