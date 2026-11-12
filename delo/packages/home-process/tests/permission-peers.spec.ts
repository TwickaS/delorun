/**
 * Asking the running profiles to read the permission store again (contract C19, `permission.reload`): the running
 * profiles are those whose home lock a live process holds, and each profile's answer is classified on its own, so a
 * profile that cannot be reached is named and never stops a later profile from being asked.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomLockId } from '@delo/home'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResponseLine } from '../src/client.ts'
import { PERMISSION_RELOAD_TIMEOUT_MS, profileRuns, reloadPermissionsIn, runningProfiles, type PermissionPeerSend } from '../src/permission-peers.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A fresh Delo home.
 * @returns its path.
 */
function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'delo-permission-peers-'))
  roots.push(root)
  return root
}

describe('the running profiles', () => {
  it('lists each profile whose home lock a live process holds or is damaged, sorted, and none without a run directory', () => {
    const deloHome = home()
    expect(runningProfiles(join(deloHome, 'no-home'))).toEqual([])
    for (const profile of ['work', 'cli', 'stopped']) mkdirSync(join(deloHome, 'run', profile), { recursive: true })
    writeFileSync(join(deloHome, 'run', 'file'), '')
    // This process holds the home lock of two profiles; the third has none.
    for (const profile of ['work', 'cli']) {
      writeFileSync(join(deloHome, 'run', profile, 'home.lock'), JSON.stringify({ v: 1, pid: process.pid, startId: randomLockId(), runtime: '0.0.0', startedAt: new Date(0).toISOString() }), { mode: 0o600 })
    }
    expect(runningProfiles(deloHome)).toEqual(['cli', 'work'])
    expect(profileRuns(deloHome, 'stopped')).toBe(false)
    // A damaged home lock is listed, so the caller asks that profile and names it when it does not answer.
    writeFileSync(join(deloHome, 'run', 'stopped', 'home.lock'), '{ not a record', { mode: 0o600 })
    expect(runningProfiles(deloHome)).toEqual(['cli', 'stopped', 'work'])
  })
})

describe('asking profiles to read the store again', () => {
  it('classifies each answer and keeps asking after a profile that cannot be reached', async () => {
    const asked: { profile: string, timeoutMs: number | undefined }[] = []
    const answers: Record<string, () => Promise<ResponseLine[]>> = {
      'a-stale': async () => Promise.reject(new Error('connect ENOENT update.sock')),
      'b-odd': async () => Promise.reject('no Error'),
      'c-read': async () => Promise.resolve([{ ok: true, digest: 'sha256:written' }]),
      'd-other': async () => Promise.resolve([{ ok: true, digest: 'sha256:other' }]),
      'e-stock': async () => Promise.resolve([{ ok: false, error: 'CONSENT_UNAVAILABLE' }]),
      'f-busy': async () => Promise.resolve([{ ok: false, error: 'BUSY' }]),
      'g-silent': async () => Promise.resolve([]),
    }
    const send: PermissionPeerSend = async (_home, profile, request, options) => {
      expect(request).toEqual({ op: 'permission.reload' })
      asked.push({ profile, timeoutMs: options.timeoutMs })
      return answers[profile]!()
    }
    const outcomes = await reloadPermissionsIn({ home: '/h', profiles: Object.keys(answers), written: 'sha256:written', send })
    expect(asked.map(entry => entry.profile)).toEqual(Object.keys(answers))
    expect(asked.every(entry => entry.timeoutMs === PERMISSION_RELOAD_TIMEOUT_MS)).toBe(true)
    expect(outcomes).toEqual([
      { profile: 'a-stale', kind: 'unread', reason: 'connect ENOENT update.sock' },
      { profile: 'b-odd', kind: 'unread', reason: 'its home process could not be reached' },
      { profile: 'c-read', kind: 'read' },
      { profile: 'd-other', kind: 'other-grants' },
      { profile: 'e-stock', kind: 'unavailable' },
      { profile: 'f-busy', kind: 'unread', reason: 'BUSY' },
      { profile: 'g-silent', kind: 'unread', reason: 'NO_ANSWER' },
    ])
  })
})
