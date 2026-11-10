/**
 * The start's record of which plugins under Changes loaded (`run/<profile>/changes-boot.json`): written after the
 * profile booted or failed to, and never a reason for the start to stop.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enforceApprovedContent, readBootRecord } from '@delo/changes'
import type { DeloLogger } from '@delo/logs'
import { recordChangesBoot } from '../src/changes/start.ts'

// The first start under Changes records a profile history version with git; under a loaded host that takes a while.
vi.setConfig({ testTimeout: 120_000 })

let base: string
let home: string
let warnings: string[]
let logger: DeloLogger

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-changes-boot-')))
  home = join(base, '.delo')
  mkdirSync(home, { mode: 0o700 })
  warnings = []
  logger = { error: () => {}, warn: (message) => { warnings.push(message) }, info: () => {}, debug: () => {} }
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/**
 * A profile linking `plug` from a folder, after its first start under Changes.
 */
async function profileWithPlug(): Promise<void> {
  const folder = join(base, 'plug')
  mkdirSync(folder)
  writeFileSync(join(folder, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', dependencies: { plug: `link:${folder}` } })}\n`)
  symlinkSync(relative(join(profileDir, 'node_modules'), folder), join(profileDir, 'node_modules', 'plug'))
  await enforceApprovedContent({ home, profile: 'default', profileDir })
}

describe('recordChangesBoot', () => {
  it('records the rows of each plugin under Changes after a boot, and the failure of a boot that failed', async () => {
    await profileWithPlug()
    await recordChangesBoot({ home, profile: 'default', logger }, [{ id: 'plug', name: 'plug', disabled: false, state: 'active' }, { id: 'other', name: 'other', disabled: false, state: 'failed' }])
    expect((await readBootRecord(home, 'default'))?.plugins).toEqual([{ plugin: 'plug', rows: [{ id: 'plug', state: 'active' }], loaded: true }])
    await recordChangesBoot({ home, profile: 'default', logger }, [], new Error('plug threw'))
    expect(await readBootRecord(home, 'default')).toMatchObject({ failure: 'plug threw', plugins: [{ plugin: 'plug', loaded: false }] })
    await recordChangesBoot({ home, profile: 'default', logger }, [], 'a thrown string')
    expect((await readBootRecord(home, 'default'))?.failure).toBe('a thrown string')
    expect(warnings).toEqual([])
  })

  it('logs a record it cannot write and returns, so the start goes on', async () => {
    await recordChangesBoot({ home, profile: 'default', logger }, [])
    expect(warnings).toEqual([expect.stringMatching(/^Changes could not record which plugins loaded at this start: .*package\.json is not a record Delo wrote/u)])
    await profileWithPlug()
    writeFileSync(join(home, 'run'), 'not a directory\n')
    await recordChangesBoot({ home, profile: 'default', logger }, [])
    expect(warnings[1]).toMatch(/^Changes could not record which plugins loaded at this start: Error: (?:ENOTDIR|EEXIST)/u)
  })
})
