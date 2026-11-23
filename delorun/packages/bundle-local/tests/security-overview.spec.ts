/**
 * The security overview's rows (`delorun/packages/bundle-local/src/client/security-overview.ts`): each row's status comes
 * from its cause, a plugin row never claims more than "reviewed, no advisory", and a fact that could not be read asks
 * for a look instead of reading as protected.
 */
import { describe, expect, it } from 'vitest'
import {
  DEVICE_UNSEEN_MS, OVERVIEW_GREEN_CAUSES, OVERVIEW_OPEN_CAUSES, OVERVIEW_ROW_IDS, overviewHeadline, overviewRows,
  type OverviewFacts, type OverviewRow, type OverviewRowId,
} from '../src/client/security-overview.ts'
import { en, zh } from '../src/client/trust-locales.ts'
import { TRUST_BILL_SCHEMA, type TrustBill, type TrustChecks, type TrustPlugin } from '../src/client/trust-bill.ts'

const NOW = Date.parse('2026-11-23T12:00:00Z')

/** A verified bill. */
function bill(overrides: Partial<TrustBill> = {}): TrustBill {
  return {
    schema: TRUST_BILL_SCHEMA,
    stage: 'verify',
    generatedAt: '2026-11-23T11:55:00Z',
    release: {
      version: '0.1.0-preview.3', commit: null, manifestSha256: null, fileListSha256: null, root: null,
      launcher: { version: null, path: null }, lastFullHashAt: null, startCheck: null, signature: 'pass', files: 'pass',
    },
    releaseLog: { state: 'verified', lastAttempt: '2026-11-23T11:55:00Z', uncheckedSince: null },
    plugins: { status: 'known', entries: [] },
    changes: { status: 'known', harnessEdits: [], approvedPlugins: [], notReviewed: 0 },
    patches: { status: 'known', rows: [], jsValues: 0 },
    skills: { roots: [] },
    mcp: { status: 'known', servers: [] },
    checkedBy: { via: 'launcher', seconds: 9 },
    ...overrides,
  }
}

/** A plugin installed from npm whose files match. */
function plugin(overrides: Partial<TrustPlugin> = {}): TrustPlugin {
  return { name: 'delorun-plugin-notes', source: 'registry', version: '1.2.0', integrity: null, commit: null, match: 'match', warnings: [], criticalAdvisories: [], ...overrides }
}

/** Facts for a studio with every protection on. */
function facts(overrides: Partial<OverviewFacts> = {}): OverviewFacts {
  return {
    run: { dangerous: 'off', prompts: 'safer', reach: { on: false } },
    everywhere: { on: false },
    workspaces: [],
    undo: { protection: 'on', unreadable: 0, unversioned: 0 },
    devices: [],
    pin: { on: false },
    bill: bill(),
    checks: null,
    mcpWaiting: 0,
    agentLevels: [],
    update: null,
    now: NOW,
    ...overrides,
  }
}

/**
 * One row.
 * @param from - the facts.
 * @param id - the row.
 * @returns the row.
 */
function rowOf(from: OverviewFacts, id: OverviewRowId): OverviewRow {
  const found = overviewRows(from).find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no row ${id}`)
  return found
}

describe('overviewRows', () => {
  it('lists the five rows in a fixed order, all green when every protection is on', () => {
    const rows = overviewRows(facts())
    expect(rows.map(entry => entry.id)).toEqual(['agent', 'undo', 'reach', 'addons', 'copy'])
    expect(rows.map(entry => entry.status)).toEqual(['green', 'green', 'green', 'green', 'green'])
    expect(overviewHeadline(rows)).toBe('green')
    expect(rows.every(entry => entry.action === undefined && entry.kind === undefined)).toBe(true)
  })

  it('is red in dangerous mode, a choice, with when it was chosen', () => {
    const row = rowOf(facts({ everywhere: { on: true, grantedAt: '2026-11-20T08:00:00Z' } }), 'agent')
    expect(row).toMatchObject({ status: 'red', cause: 'agent.dangerous', kind: 'choice', chosenAt: Date.parse('2026-11-20T08:00:00Z'), action: { kind: 'open-section', section: 'delorun-permissions' } })
    expect(rowOf(facts({ run: { dangerous: 'on', prompts: 'dangerous', reach: { on: false } } }), 'agent').status).toBe('red')
  })

  it('marks Full access in a workspace as a quiet choice, naming the latest', () => {
    const row = rowOf(facts({
      workspaces: [
        { workspace: '/a', preset: 'danger-full-access', grantedAt: 1 },
        { workspace: '/b', title: 'Website', preset: 'danger-full-access', grantedAt: 5 },
        { workspace: '/c', preset: 'workspace-write', grantedAt: 9 },
      ],
    }), 'agent')
    expect(row).toMatchObject({ status: 'chosen', cause: 'agent.full-access', kind: 'choice', chosenAt: 5, params: { count: 2, workspace: 'Website' } })
  })

  it('keeps Workspace write green: an ordinary choice raises no alarm', () => {
    expect(rowOf(facts({ workspaces: [{ workspace: '/c', preset: 'workspace-write', grantedAt: 9 }] }), 'agent').status).toBe('green')
  })

  it('is green with review on and with review off, because every change is still recorded and can be undone', () => {
    expect(rowOf(facts(), 'undo')).toMatchObject({ status: 'green', cause: 'undo.on' })
    expect(rowOf(facts({ undo: { protection: 'off', unreadable: 0, unversioned: 0 } }), 'undo')).toMatchObject({ status: 'green', cause: 'undo.recorded' })
  })

  it.each([
    ['records Changes cannot read', { protection: 'off', unreadable: 1, unversioned: 0 }],
    ['a change recorded without a saved version', { protection: 'off', unreadable: 0, unversioned: 1 }],
    ['the same with review on', { protection: 'on', unreadable: 2, unversioned: 0 }],
  ] as const)('is red only when undo cannot work: %s, with Changes as the place to look', (_name, undo) => {
    expect(rowOf(facts({ undo }), 'undo')).toMatchObject({ status: 'red', cause: 'undo.broken', kind: 'fault', action: { kind: 'open-section' } })
  })

  it('marks phone access on as a choice, and a device unseen for weeks as needing a look', () => {
    const on = { dangerous: 'off', prompts: 'safer', reach: { on: true } } as const
    const fresh = { id: 'phone', label: 'Phone', approvedAt: NOW - 1000, lastSignInAt: NOW - 1000 }
    expect(rowOf(facts({ run: on, devices: [fresh], pin: { on: true } }), 'reach')).toMatchObject({ status: 'chosen', cause: 'reach.phone', params: { count: 1, pin: 'on' } })
    const stale = { id: 'tablet', label: 'Old tablet', approvedAt: NOW - DEVICE_UNSEEN_MS * 3, lastSignInAt: NOW - DEVICE_UNSEEN_MS - 1 }
    expect(rowOf(facts({ run: on, devices: [fresh, stale] }), 'reach')).toMatchObject({ status: 'look', cause: 'reach.unseen', kind: 'fault', params: { count: 1, device: 'Old tablet' } })
  })

  it('stays green with paired devices while phone access is off', () => {
    const device = { id: 'phone', label: 'Phone', approvedAt: 0, lastSignInAt: null }
    expect(rowOf(facts({ devices: [device] }), 'reach')).toMatchObject({ status: 'green', cause: 'reach.devices-off', params: { count: 1 } })
  })

  it('never calls plugins safe: green reads reviewed, no advisory', () => {
    const row = rowOf(facts({ bill: bill({ plugins: { status: 'known', entries: [plugin()] } }) }), 'addons')
    expect(row).toMatchObject({ status: 'green', cause: 'addons.reviewed', params: { count: 1 } })
  })

  it('is red for a critical advisory or a plugin changed after its install, which are faults', () => {
    expect(rowOf(facts({ bill: bill({ plugins: { status: 'known', entries: [plugin({ criticalAdvisories: ['GHSA-1'] })] } }) }), 'addons'))
      .toMatchObject({ status: 'red', cause: 'addons.advisory', kind: 'fault', params: { plugin: 'delorun-plugin-notes' } })
    expect(rowOf(facts({ bill: bill({ plugins: { status: 'known', entries: [plugin({ match: 'mismatch' })] } }) }), 'addons'))
      .toMatchObject({ status: 'red', cause: 'addons.changed' })
  })

  it('marks a plugin without an install record and an unrestricted external agent as choices', () => {
    expect(rowOf(facts({ bill: bill({ plugins: { status: 'known', entries: [plugin({ source: 'link', match: 'unrecorded' })] } }) }), 'addons'))
      .toMatchObject({ status: 'chosen', cause: 'addons.unlisted', kind: 'choice' })
    expect(rowOf(facts({ agentLevels: [{ provider: 'codex', level: 'unrestricted' }] }), 'addons'))
      .toMatchObject({ status: 'chosen', cause: 'addons.unrestricted', params: { agent: 'codex' } })
  })

  it('asks for a look while an MCP server waits for a decision', () => {
    expect(rowOf(facts({ mcpWaiting: 2 }), 'addons')).toMatchObject({ status: 'look', cause: 'addons.mcp-waiting', params: { count: 2 } })
  })

  it('reads this copy as green while the full check waits, and asks for a look when it cannot run', () => {
    const { checkedBy: _verifyRoute, ...start } = bill({ stage: 'start', release: { ...bill().release, startCheck: { at: '2026-11-23T11:00:00Z', full: false, hashed: 3, files: 35_000 } } })
    const waiting: TrustChecks = {
      release: { at: '2026-11-23T11:00:00Z', running: false, full: { state: 'waiting' } },
      releaseLog: { at: null, running: false }, plugins: { at: null, running: false }, changes: { at: null, running: false },
    }
    expect(rowOf(facts({ bill: start, checks: waiting }), 'copy')).toMatchObject({ status: 'green', cause: 'copy.checking' })
    // "Protected as Delorun intends" waits for the full check.
    expect(overviewHeadline(overviewRows(facts({ bill: start, checks: waiting })))).toBe('checking')
    expect(overviewHeadline(overviewRows(facts({ bill: start, checks: waiting, undo: { protection: 'off', unreadable: 1, unversioned: 0 } })))).toBe('red')
    const unavailable: TrustChecks = { ...waiting, release: { ...waiting.release, full: { state: 'unavailable', reason: 'no-launcher' } } }
    expect(rowOf(facts({ bill: start, checks: unavailable }), 'copy')).toMatchObject({ status: 'look', cause: 'copy.not-full', action: { kind: 'check-now' } })
  })

  it('asks for a look when only the signature was checked because the release log was not reached', () => {
    expect(rowOf(facts({ bill: bill({ releaseLog: { state: 'unchecked', lastAttempt: null, uncheckedSince: '2026-11-22T00:00:00Z' } }) }), 'copy'))
      .toMatchObject({ status: 'look', cause: 'copy.log' })
  })

  it('is red when a signature, a file or the release log failed', () => {
    expect(rowOf(facts({ bill: bill({ release: { ...bill().release, files: 'fail' } }) }), 'copy').status).toBe('red')
    expect(rowOf(facts({ bill: bill({ releaseLog: { state: 'failed', lastAttempt: null, uncheckedSince: null } }) }), 'copy').status).toBe('red')
  })

  it('asks for a look for a security update, and stays green for an ordinary one', () => {
    expect(rowOf(facts({ update: { version: '0.1.0-preview.4', security: true } }), 'copy')).toMatchObject({ status: 'look', cause: 'copy.security-update', params: { version: '0.1.0-preview.4' } })
    expect(rowOf(facts({ update: { version: '0.1.0-preview.4', security: false } }), 'copy').status).toBe('green')
  })

  it('never reads a fact it could not read as protected', () => {
    const rows = overviewRows(facts({ run: null, everywhere: null, undo: null, bill: null }))
    expect(rows.map(entry => [entry.id, entry.status, entry.cause])).toEqual([
      ['agent', 'look', 'agent.unread'],
      ['undo', 'look', 'undo.unread'],
      ['reach', 'look', 'reach.unread'],
      ['addons', 'look', 'addons.unread'],
      ['copy', 'look', 'copy.unread'],
    ])
  })
})

describe('a fact that could not be read', () => {
  it.each([
    ['the run settings', { run: null }, 'agent', 'agent.unread'],
    ['dangerous mode', { everywhere: null }, 'agent', 'agent.unread'],
    ['the workspaces\' access', { workspaces: null }, 'agent', 'agent.unread'],
    ['Changes\' state', { undo: null }, 'undo', 'undo.unread'],
    ['the devices, with phone access on', { run: { dangerous: 'off', prompts: 'safer', reach: { on: true } }, devices: null }, 'reach', 'reach.unread'],
    ['PIN mode, with phone access on', { run: { dangerous: 'off', prompts: 'safer', reach: { on: true } }, pin: null }, 'reach', 'reach.unread'],
    ['the MCP servers waiting for a decision', { mcpWaiting: null }, 'addons', 'addons.unread'],
    ['the external agents\' levels', { agentLevels: null }, 'addons', 'addons.unread'],
  ] as const)('asks for a look when %s did not read', (_name, unread, id, cause) => {
    expect(rowOf(facts(unread), id)).toMatchObject({ status: 'look', cause, kind: 'fault' })
  })

  it('keeps a red finding over an unread fact, and phone access off private whatever the devices', () => {
    expect(rowOf(facts({ everywhere: { on: true }, workspaces: null }), 'agent').status).toBe('red')
    expect(rowOf(facts({ devices: null, pin: null }), 'reach')).toMatchObject({ status: 'green', cause: 'reach.private' })
  })
})

describe('overviewHeadline', () => {
  it('takes the loudest row: red, then a look, then a choice', () => {
    expect(overviewHeadline(overviewRows(facts({ undo: { protection: 'on', unreadable: 1, unversioned: 0 }, mcpWaiting: 1 })))).toBe('red')
    expect(overviewHeadline(overviewRows(facts({ mcpWaiting: 1, run: { dangerous: 'off', prompts: 'safer', reach: { on: true } } })))).toBe('look')
    expect(overviewHeadline(overviewRows(facts({ run: { dangerous: 'off', prompts: 'safer', reach: { on: true } } })))).toBe('chosen')
  })
})

describe('the copy', () => {
  it('words every cause, and every open cause\'s meaning, reason and action, in English and Chinese', () => {
    const keys = [
      ...OVERVIEW_GREEN_CAUSES.map(cause => `overview.${cause}`),
      ...OVERVIEW_OPEN_CAUSES.flatMap(cause => ['', '.meaning', '.reason', '.action'].map(part => `overview.${cause}${part}`)),
      ...OVERVIEW_ROW_IDS.flatMap(id => [`overview.row.${id}`, `overview.${id}.checked`]),
      ...(['green', 'chosen', 'look', 'red'] as const).flatMap(status => [`overview.status.${status}`, `overview.headline.${status}`, `overview.headline.${status}.detail`]),
      'overview.headline.checking', 'overview.headline.checking.detail',
    ]
    for (const dictionary of [en, zh]) {
      expect(keys.filter(key => !Object.hasOwn(dictionary, key))).toEqual([])
    }
  })

  it('never calls an add-on safe', () => {
    for (const [dictionary, safe] of [[en, /\bsafe\b/i], [zh, /安全的|是安全/]] as const) {
      const words = Object.entries(dictionary).filter(([key]) => key.startsWith('overview.addons')).map(([, text]) => text)
      expect(words.filter(text => safe.test(text))).toEqual([])
    }
  })
})
