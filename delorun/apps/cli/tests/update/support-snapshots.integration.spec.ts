/**
 * The profile's record of an update through `profileSnapshots`: the snapshot writes it as `applying`, the commit
 * rewrites it as `committed` with the same snapshot, and `delorun recover status` then names the update as committed,
 * never as applying.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { recover } from '@delorun/profile-safety'
import { profileSnapshots } from '../../src/update/support.ts'

const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
const NOW = new Date('2026-11-11T10:00:00.000Z')

let base: string
let home: string
let profileDir: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-update-record-')))
  home = join(base, 'h')
  profileDir = join(home, 'profiles', 'default')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/**
 * The update the profile's record holds.
 * @returns the record's `update` field.
 */
function recordedUpdate(): unknown {
  return (JSON.parse(readFileSync(join(profileDir, 'delorun-safety.json'), 'utf8')) as { readonly update?: unknown }).update
}

/**
 * The first line `delorun recover status` prints.
 * @returns the line.
 */
async function statusLine(): Promise<string | undefined> {
  return (await recover({ profileDir, homeDir: home, profile: 'default', action: { kind: 'status' } })).lines[0]
}

describe('the profile\'s record of an update', { timeout: 60_000 }, () => {
  it('is applying from the snapshot, and committed with the same snapshot once the update committed', async () => {
    const snapshots = profileSnapshots(home, 'default', () => NOW)
    const snapshot = await snapshots.save(v('0.1.0-preview.1'), v('0.1.0-preview.2'), { kind: 'report' })
    expect(recordedUpdate()).toMatchObject({ from: '0.1.0-preview.1', to: '0.1.0-preview.2', state: 'applying', snapshot })
    expect(await statusLine()).toBe('The last update, from Delorun 0.1.0-preview.1 to Delorun 0.1.0-preview.2, has not committed: it is applying, or it stopped before it committed.')
    await snapshots.committed(v('0.1.0-preview.1'), v('0.1.0-preview.2'))
    expect(recordedUpdate()).toEqual({ from: '0.1.0-preview.1', to: '0.1.0-preview.2', at: NOW.toISOString(), state: 'committed', snapshot })
    expect(await statusLine()).toBe('The last update, from Delorun 0.1.0-preview.1 to Delorun 0.1.0-preview.2, committed.')
    await snapshots.committed(v('0.1.0-preview.1'), v('0.1.0-preview.2'))
    expect(recordedUpdate()).toEqual({ from: '0.1.0-preview.1', to: '0.1.0-preview.2', at: NOW.toISOString(), state: 'committed', snapshot })
  })

  it('records a commit without a snapshot when the record names another update', async () => {
    const snapshots = profileSnapshots(home, 'default', () => NOW)
    await snapshots.save(v('0.1.0'), v('0.2.0'), { kind: 'report' })
    await snapshots.committed(v('0.2.0'), v('0.3.0'))
    expect(recordedUpdate()).toEqual({ from: '0.2.0', to: '0.3.0', at: NOW.toISOString(), state: 'committed' })
  })
})
