/**
 * The trust bill's rows and badge: no plain pass while anything is failed, unchecked or unknown; red and amber only for
 * the release, the release log, plugins changed after their install and critical advisories; the person's own changes
 * a neutral count.
 */
import { describe, expect, it } from 'vitest'
import { TRUST_BILL_SCHEMA, trustBadge, trustRows, type TrustBill, type TrustChecks, type TrustPlugin } from '../src/client/trust-bill.ts'

const PLUGIN: TrustPlugin = { name: 'delorun-plugin-x', source: 'registry', version: '1.0.0', integrity: 'sha512-x', commit: null, match: 'match', warnings: [], criticalAdvisories: [] }

/** A bill in which everything verified and the person has no changes. */
const VERIFIED: TrustBill = {
  schema: TRUST_BILL_SCHEMA,
  stage: 'verify',
  generatedAt: '2026-11-11T10:00:00Z',
  release: {
    version: '0.1.0', commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), fileListSha256: 'c'.repeat(64),
    root: { version: 1, keyIds: ['d'.repeat(64)], anchored: 'shipped' }, launcher: { version: '0.1.0', path: '/launcher' },
    lastFullHashAt: '2026-11-11T10:00:00Z', startCheck: null, signature: 'pass', files: 'pass',
  },
  releaseLog: { state: 'verified', lastAttempt: '2026-11-11T10:00:00Z', uncheckedSince: null },
  plugins: { status: 'known', entries: [PLUGIN] },
  changes: { status: 'known', harnessEdits: [], approvedPlugins: [], notReviewed: 0 },
  patches: { status: 'known', rows: [], jsValues: 0 },
  skills: { roots: [] },
  mcp: { status: 'known', servers: [] },
}

/**
 * The badge of a bill.
 * @param bill - the bill.
 * @returns the badge.
 */
function badge(bill: TrustBill): ReturnType<typeof trustBadge> {
  return trustBadge(trustRows(bill))
}

describe('the trust badge', () => {
  it('is verified only when every row is', () => {
    expect(badge(VERIFIED)).toEqual({ state: 'verified', tone: 'ok', ownChanges: 0 })
    expect(trustRows(VERIFIED).map(row => row.id)).toEqual(['release', 'releaseLog', 'plugins', 'changes'])
  })

  it.each<[string, TrustBill, ReturnType<typeof trustBadge>['state'], ReturnType<typeof trustBadge>['tone']]>([
    ['a failed signature', { ...VERIFIED, release: { ...VERIFIED.release, signature: 'fail' } }, 'failed', 'red'],
    ['failed files', { ...VERIFIED, release: { ...VERIFIED.release, files: 'fail' } }, 'failed', 'red'],
    ['a release whose files were not checked', { ...VERIFIED, release: { ...VERIFIED.release, files: 'unknown' } }, 'unknown', 'amber'],
    ['a failed release log', { ...VERIFIED, releaseLog: { ...VERIFIED.releaseLog, state: 'failed' } }, 'failed', 'red'],
    ['an unchecked release log', { ...VERIFIED, releaseLog: { ...VERIFIED.releaseLog, state: 'unchecked' } }, 'unchecked', 'amber'],
    ['an unknown release log', { ...VERIFIED, releaseLog: { ...VERIFIED.releaseLog, state: 'unknown' } }, 'unknown', 'amber'],
    ['a plugin changed after its install', { ...VERIFIED, plugins: { status: 'known', entries: [{ ...PLUGIN, match: 'mismatch' }] } }, 'failed', 'red'],
    ['a critical advisory', { ...VERIFIED, plugins: { status: 'known', entries: [{ ...PLUGIN, criticalAdvisories: ['GHSA-xxxx'] }] } }, 'attention', 'amber'],
    ['an install check that is not available', { ...VERIFIED, plugins: { status: 'unknown', reason: 'not available', entries: [{ ...PLUGIN, match: 'unknown' }] } }, 'unknown', 'neutral'],
    ['a plugin the person links from a folder', { ...VERIFIED, plugins: { status: 'known', entries: [{ ...PLUGIN, source: 'link', match: 'unrecorded' }] } }, 'unknown', 'neutral'],
    ['Changes that cannot be read', { ...VERIFIED, changes: { ...VERIFIED.changes, status: 'unknown', reason: 'not available' } }, 'unknown', 'neutral'],
    ['a patch layer that does not read', { ...VERIFIED, patches: { status: 'unknown', reason: 'not YAML', rows: [], jsValues: 0 } }, 'unknown', 'neutral'],
  ])('is not verified with %s', (_case, bill, state, tone) => {
    expect(badge(bill)).toMatchObject({ state, tone })
  })

  it('counts the person\'s own changes neutrally, never as a warning', () => {
    const changed: TrustBill = {
      ...VERIFIED,
      changes: { status: 'known', harnessEdits: [{ file: 'lib/a.js' }], approvedPlugins: [{ plugin: 'x', version: '1.0.0', source: '/src/x' }], notReviewed: 3 },
      patches: { status: 'known', rows: [{ layer: 'cordis.patch.yml', id: 'mine', name: 'my-plugin' }], jsValues: 2 },
    }
    expect(badge(changed)).toEqual({ state: 'waiting', tone: 'neutral', ownChanges: 6 })
    expect(trustRows(changed).find(row => row.id === 'changes')).toEqual({ id: 'changes', state: 'waiting', tone: 'neutral', ownChanges: 6 })
    const reviewed: TrustBill = { ...changed, changes: { ...changed.changes, notReviewed: 0 } }
    expect(badge(reviewed)).toEqual({ state: 'verified', tone: 'ok', ownChanges: 3 })
  })

  it('reads verified for the release only when every runtime file was hashed', () => {
    const startCheck = { at: '2026-11-11T10:00:00Z', full: false, hashed: 160, files: 35_287 }
    expect(trustRows({ ...VERIFIED, stage: 'start', release: { ...VERIFIED.release, startCheck } })[0]).toEqual({ id: 'release', state: 'checked-at-start', tone: 'neutral', ownChanges: 0 })
    expect(trustRows({ ...VERIFIED, stage: 'start', release: { ...VERIFIED.release, startCheck: null } })[0]?.state).toBe('checked-at-start')
    expect(trustRows({ ...VERIFIED, stage: 'start', release: { ...VERIFIED.release, startCheck: { ...startCheck, full: true, hashed: 35_287 } } })[0]?.state).toBe('verified')
    expect(trustRows({ ...VERIFIED, checkedBy: { via: 'host', reason: 'launcher-unresolvable', seconds: 9 } })[0]).toEqual({ id: 'release', state: 'checked-in-studio', tone: 'neutral', ownChanges: 0 })
    expect(trustRows({ ...VERIFIED, checkedBy: { via: 'launcher', seconds: 19 } })[0]?.state).toBe('verified')
    expect(badge({ ...VERIFIED, stage: 'start', release: { ...VERIFIED.release, startCheck } })).toEqual({ state: 'checked-at-start', tone: 'neutral', ownChanges: 0 })
  })

  it('reads checking while the background full check waits or runs, and checked at start with any other state', () => {
    const startCheck = { at: '2026-11-11T10:00:00Z', full: false, hashed: 160, files: 35_287 }
    const start: TrustBill = { ...VERIFIED, stage: 'start', release: { ...VERIFIED.release, startCheck } }
    const checks = (full: TrustChecks['release']['full']): TrustChecks => ({
      release: { at: startCheck.at, running: false, full },
      releaseLog: { at: null, running: false }, plugins: { at: null, running: false }, changes: { at: null, running: false },
    })
    expect(trustRows(start, checks({ state: 'waiting' }))[0]).toEqual({ id: 'release', state: 'checking', tone: 'neutral', ownChanges: 0 })
    expect(trustRows(start, checks({ state: 'running' }))[0]?.state).toBe('checking')
    expect(trustBadge(trustRows(start, checks({ state: 'running' })))).toEqual({ state: 'checking', tone: 'neutral', ownChanges: 0 })
    for (const full of [{ state: 'unavailable', reason: 'no-launcher' }, { state: 'unavailable', reason: 'failed', detail: 'x' }, { state: 'done' }] as const) {
      expect(trustRows(start, checks(full))[0]?.state).toBe('checked-at-start')
    }
    expect(trustRows(start, null)[0]?.state).toBe('checked-at-start')
    // A full check never makes a check run inside the studio verified, and a failure stays red.
    expect(trustRows({ ...VERIFIED, checkedBy: { via: 'host', reason: 'no-launcher', seconds: 9 } }, checks({ state: 'waiting' }))[0]?.state).toBe('checked-in-studio')
    expect(trustRows({ ...start, release: { ...start.release, files: 'fail' } }, checks({ state: 'running' }))[0]?.state).toBe('failed')
  })

  it('takes the loudest tone and the first state in order of severity', () => {
    const bill: TrustBill = {
      ...VERIFIED,
      releaseLog: { ...VERIFIED.releaseLog, state: 'unchecked' },
      plugins: { status: 'known', entries: [{ ...PLUGIN, match: 'mismatch' }] },
      changes: { ...VERIFIED.changes, status: 'unknown' },
    }
    expect(badge(bill)).toEqual({ state: 'failed', tone: 'red', ownChanges: 0 })
  })

  it('is unknown and amber without a bill', () => {
    expect(trustBadge(null)).toEqual({ state: 'unknown', tone: 'amber', ownChanges: 0 })
    expect(trustBadge([])).toEqual({ state: 'unknown', tone: 'amber', ownChanges: 0 })
  })
})
