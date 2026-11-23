// @vitest-environment jsdom
/**
 * The trust badge at the sidebar's foot and its panel: the badge's label, colour and tone for every state; that only
 * an all-verified bill reads "Verified" and that the person's own changes show as a neutral count that never colours
 * the badge; that a missing, refused or invalid bill reads unknown; the rows' disclosure; Check now's busy, success and
 * failure; the remote session without Check now; and the checks' limit stated in the panel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { applyTrustBadge, TRUST_BADGE, TRUST_NS } from '../src/client/index.ts'
import { NO_HOST_FACTS, OverviewStore, type OverviewHostFacts } from '../src/client/security-overview-api.ts'
import type { OverviewAction } from '../src/client/security-overview.ts'
import { OVERVIEW_VIEW_KEY } from '../src/client/SecurityOverview.tsx'
import {
  fetchTrustBill, fetchTrustSnapshot, postTrustCheck, TRUST_POLL_IDLE_MS, TRUST_POLL_RUNNING_MS, TRUST_POLL_WAITING_MS, trustPollDelay, TrustStore,
  type TrustApi, type TrustCheckOutcome,
} from '../src/client/trust-api.ts'
import { TRUST_BILL_PATH, TRUST_BILL_SCHEMA, TRUST_CHECK_PATH, type TrustBill, type TrustChecks, type TrustPlugin } from '../src/client/trust-bill.ts'
import { TrustBadge, VERIFY_COMMAND, type TrustBadgeInjected } from '../src/client/TrustBadge.tsx'
import { en, zh } from '../src/client/trust-locales.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
})

/** The facts of a studio whose every protection is on. */
const PROTECTED: OverviewHostFacts = {
  ...NO_HOST_FACTS,
  run: { prompts: 'safer', dangerous: 'off', reach: { on: false } },
  everywhere: { on: false },
  workspaces: [],
  protection: 'on',
  devices: [],
  pin: { on: false },
  mcpWaiting: 0,
  agentLevels: [],
}

/** A bill in which every row is verified and the person has no changes. */
function verifiedBill(): TrustBill {
  return {
    schema: TRUST_BILL_SCHEMA,
    stage: 'verify',
    generatedAt: '2026-11-11T10:00:00Z',
    release: {
      version: '0.1.0',
      commit: 'a'.repeat(40),
      manifestSha256: 'b'.repeat(64),
      fileListSha256: 'c'.repeat(64),
      root: { version: 2, keyIds: ['k1', 'k2'], anchored: 'shipped' },
      launcher: { version: '0.1.0', path: '/home/person/.local/share/delorun/a/very/long/path/to/the/launcher/bin/delorun' },
      lastFullHashAt: '2026-11-10T09:00:00Z',
      startCheck: { at: '2026-11-11T09:59:00Z', full: false, hashed: 40, files: 900 },
      signature: 'pass',
      files: 'pass',
    },
    releaseLog: { state: 'verified', lastAttempt: '2026-11-11T09:00:00Z', uncheckedSince: null },
    plugins: { status: 'known', entries: [plugin({})] },
    changes: { status: 'known', harnessEdits: [], approvedPlugins: [], notReviewed: 0 },
    patches: { status: 'known', rows: [], jsValues: 0 },
    skills: { roots: [{ path: '/home/person/.agents/skills', source: 'user-agents' }] },
    mcp: { status: 'known', servers: [{ name: 'files', transport: 'stdio' }] },
  }
}

/**
 * One plugin, matching its install unless overridden.
 * @param fields - the fields to change.
 * @returns the plugin.
 */
function plugin(fields: Partial<TrustPlugin>): TrustPlugin {
  return {
    name: '@acme/delorun-plugin', source: 'registry', version: '1.2.3', integrity: `sha512-${'d'.repeat(80)}`, commit: null,
    match: 'match', warnings: [], criticalAdvisories: [], ...fields,
  }
}

/**
 * A verified bill with some sections changed.
 * @param change - changes the bill.
 * @returns the bill.
 */
function billWith(change: (bill: TrustBill) => TrustBill): TrustBill {
  return change(verifiedBill())
}

/** Each state's bill, with the label and tone the badge shows. */
const CASES: readonly { readonly name: string, readonly bill: TrustBill | null, readonly label: string, readonly tone: string, readonly state: string }[] = [
  { name: 'every row verified', bill: verifiedBill(), label: 'Verified', tone: 'ok', state: 'verified' },
  {
    name: 'the person\'s own approved changes, which stay neutral',
    bill: billWith(bill => ({ ...bill, changes: { ...bill.changes, harnessEdits: [{ file: 'packages/core/agent/src/a.ts' }, { file: 'b.ts' }], approvedPlugins: Array.from({ length: 10 }, (_, at) => ({ plugin: `p${String(at)}`, version: '1.0.0', source: 'registry' })) } })),
    label: 'Verified · 12 of your changes',
    tone: 'ok',
    state: 'verified',
  },
  {
    name: 'the person\'s changes waiting for review, which are never a warning',
    bill: billWith(bill => ({ ...bill, changes: { ...bill.changes, harnessEdits: [{ file: 'a.ts' }, { file: 'b.ts' }], notReviewed: 10 } })),
    label: 'Changes to review · 12 of your changes',
    tone: 'neutral',
    state: 'waiting',
  },
  {
    name: 'a start check that hashed only the files its record could not vouch for',
    bill: billWith(bill => ({ ...bill, stage: 'start' })),
    label: 'Checked at start',
    tone: 'neutral',
    state: 'checked-at-start',
  },
  {
    name: 'a check run inside the studio',
    bill: billWith(bill => ({ ...bill, checkedBy: { via: 'host', reason: 'launcher-unresolvable', seconds: 9 } })),
    label: 'Checked in the studio',
    tone: 'neutral',
    state: 'checked-in-studio',
  },
  { name: 'a failed signature', bill: billWith(bill => ({ ...bill, release: { ...bill.release, signature: 'fail', detail: 'the manifest signature does not verify' } })), label: 'Check failed', tone: 'red', state: 'failed' },
  { name: 'a plugin changed after its install', bill: billWith(bill => ({ ...bill, plugins: { status: 'known', entries: [plugin({ match: 'mismatch' })] } })), label: 'Check failed', tone: 'red', state: 'failed' },
  { name: 'a critical advisory', bill: billWith(bill => ({ ...bill, plugins: { status: 'known', entries: [plugin({ criticalAdvisories: ['GHSA-1234'] })] } })), label: 'Needs attention', tone: 'amber', state: 'attention' },
  { name: 'an unchecked release log', bill: billWith(bill => ({ ...bill, releaseLog: { state: 'unchecked', lastAttempt: '2026-11-11T09:00:00Z', uncheckedSince: '2026-11-09T09:00:00Z', detail: 'the log did not answer' } })), label: 'Not checked', tone: 'amber', state: 'unchecked' },
  {
    name: 'an unchecked release log with own changes',
    bill: billWith(bill => ({ ...bill, releaseLog: { state: 'unchecked', lastAttempt: null, uncheckedSince: '2026-11-09T09:00:00Z' }, changes: { ...bill.changes, notReviewed: 3 } })),
    label: 'Not checked · 3 of your changes',
    tone: 'amber',
    state: 'unchecked',
  },
  { name: 'an unknown release', bill: billWith(bill => ({ ...bill, release: { ...bill.release, files: 'unknown' } })), label: 'Not checked', tone: 'amber', state: 'unknown' },
  { name: 'an unknown plugin install check', bill: billWith(bill => ({ ...bill, plugins: { status: 'unknown', reason: 'no install records', entries: [] } })), label: 'Not checked', tone: 'neutral', state: 'unknown' },
  { name: 'unknown Changes', bill: billWith(bill => ({ ...bill, changes: { ...bill.changes, status: 'unknown', reason: 'Changes is not available' } })), label: 'Not checked', tone: 'neutral', state: 'unknown' },
  { name: 'no bill', bill: null, label: 'Not checked', tone: 'amber', state: 'unknown' },
]

/**
 * An API whose answers the test controls.
 * @param bill - what reads answer.
 * @param check - what a check answers.
 * @returns the API and its calls.
 */
function api(bill: TrustBill | null, check: () => Promise<TrustCheckOutcome> = async () => ({ kind: 'checked', bill: verifiedBill(), checks: null })) {
  const calls = { read: 0, check: 0 }
  const value: TrustApi = {
    read: async () => { calls.read++; return { bill, checks: null } },
    check: () => { calls.check++; return check() },
  }
  return { api: value, calls }
}

/**
 * Render the badge over a store.
 * @param store - the store.
 * @param options - the foot's width and whether Check now is offered.
 * @param options.wide - whether the sidebar is wide.
 * @param options.remote - whether the page is a remote session.
 * @param dictionary - the copy.
 * @returns the render.
 */
function renderBadge(
  store: TrustStore,
  options: { readonly wide?: boolean, readonly remote?: boolean, readonly facts?: OverviewHostFacts, readonly act?: (action: OverviewAction) => Promise<boolean> } = {},
  dictionary: Record<string, string> = en,
) {
  const facts = createSnapshotStore<OverviewHostFacts>(options.facts ?? PROTECTED)
  const loaded = createSnapshotStore(true)
  const face: TrustBadgeInjected = {
    hooks: { bill: store.bill, checks: store.checks, checking: store.checking, overview: facts, overviewLoaded: loaded },
    check: options.remote === true ? null : () => { void store.check() },
    watchOverview: () => () => {},
    act: options.act ?? (async () => true),
  }
  return render(
    <TrustBadge wide={options.wide ?? true} t={makeTranslate(dictionary)} useBill={bindSnapshotSelector(face.hooks.bill)}
      useChecks={bindSnapshotSelector(face.hooks.checks)} useChecking={bindSnapshotSelector(face.hooks.checking)}
      useOverview={bindSnapshotSelector(face.hooks.overview)} useOverviewLoaded={bindSnapshotSelector(face.hooks.overviewLoaded)}
      check={face.check} watchOverview={face.watchOverview} act={face.act} />,
  )
}

/**
 * A store holding one bill.
 * @param bill - the bill.
 * @param check - what a check answers.
 * @returns the store and the API's calls.
 */
function storeOf(bill: TrustBill | null, check?: () => Promise<TrustCheckOutcome>) {
  const { api: value, calls } = api(bill, check)
  const store = new TrustStore(value)
  store.bill.set(bill)
  return { store, calls }
}

/**
 * Open the panel from the badge.
 * @returns the dialog.
 */
function openPanel(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /^Trust: / }))
  return screen.getByRole('dialog', { name: en['overview.title'] })
}

/**
 * Open the panel in the advanced view, which shows the trust bill's four rows under this copy of Delorun.
 * @returns the dialog.
 */
function openAdvanced(): HTMLElement {
  const dialog = openPanel()
  fireEvent.click(within(dialog).getByRole('tab', { name: en['overview.view.advanced'] }))
  return dialog
}

describe('the badge', () => {
  for (const entry of CASES) {
    it(`reads "${entry.label}" in the ${entry.tone} tone for ${entry.name}`, () => {
      renderBadge(storeOf(entry.bill).store)
      const badge = screen.getByRole('button', { name: `Trust: ${entry.label}` })
      expect({ text: badge.textContent, tone: badge.getAttribute('data-tone'), state: badge.getAttribute('data-state') })
        .toEqual({ text: '', tone: entry.tone, state: entry.state })
    })
  }

  it('reads "Verified" only when every row is verified', () => {
    for (const entry of CASES) {
      const { unmount } = renderBadge(storeOf(entry.bill).store)
      const name = screen.getByRole('button', { name: /^Trust: / }).getAttribute('aria-label') ?? ''
      expect({ name: entry.name, verified: name.startsWith('Trust: Verified') }).toEqual({ name: entry.name, verified: entry.state === 'verified' })
      unmount()
    }
  })

  it('never turns amber for the person\'s own changes alone', () => {
    const many = billWith(bill => ({
      ...bill,
      changes: { status: 'known', harnessEdits: [{ file: 'a.ts' }], approvedPlugins: [{ plugin: '@acme/x', version: '1.0.0', source: 'registry' }], notReviewed: 40 },
      patches: { status: 'known', rows: [{ layer: 'cordis.patch.yml', id: 'mine', name: '@acme/x' }], jsValues: 2 },
    }))
    renderBadge(storeOf(many).store)
    const badge = screen.getByRole('button', { name: /^Trust: / })
    expect({ text: badge.textContent, tone: badge.getAttribute('data-tone') }).toEqual({ text: '', tone: 'neutral' })
    expect(badge.getAttribute('aria-label')).toBe('Trust: Changes to review · 43 of your changes')
  })

  it('shows the shield alone on the rail, named and with its tooltip', () => {
    renderBadge(storeOf(verifiedBill()).store, { wide: false })
    const badge = screen.getByRole('button', { name: 'Trust: Verified' })
    expect(badge.textContent).toBe('')
    fireEvent.focus(badge)
    expect(screen.getByRole('tooltip').textContent).toContain('Verified')
  })

  it('is the same square icon button, with no text label, in the wide foot', () => {
    renderBadge(storeOf(verifiedBill()).store, { wide: true })
    const badge = screen.getByRole('button', { name: 'Trust: Verified' })
    expect(badge.textContent).toBe('')
    expect(badge.querySelector('svg')).not.toBeNull()
  })

  it('names the full label in a tooltip on the wide badge', () => {
    renderBadge(storeOf(null).store, { wide: true })
    const badge = screen.getByRole('button', { name: 'Trust: Not checked' })
    fireEvent.focus(badge)
    expect(screen.getByRole('tooltip').textContent).toContain('Not checked')
  })

  it('reads in Chinese', () => {
    renderBadge(storeOf(CASES[1]?.bill ?? null).store, {}, zh)
    expect(screen.getByRole('button', { name: '可信状态：已验证 · 你的 12 项更改' })).toBeTruthy()
  })
})

describe('the panel', () => {
  it('names the four rows, discloses each one\'s details and states the checks\' limit', () => {
    renderBadge(storeOf(verifiedBill()).store)
    const dialog = openAdvanced()
    const rows = within(dialog).getAllByRole('button', { expanded: false }).filter(button => button.getAttribute('aria-controls') !== null)
    expect(rows.map(row => row.textContent)).toEqual([
      'Signed releaseVerified', 'Release logVerified', 'PluginsVerified', 'Your changesVerified',
    ])
    expect(within(dialog).queryByText('Manifest SHA-256')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Signed release/ }))
    expect(within(dialog).getByRole('button', { name: /^Signed release/ }).getAttribute('aria-expanded')).toBe('true')
    expect(within(dialog).getByText('Manifest SHA-256')).toBeTruthy()
    // A digest is cut on screen; its whole value is the control's name and shows once chosen.
    const digest = within(dialog).getByRole('button', { name: 'b'.repeat(64) })
    expect(digest.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(digest)
    expect(digest.getAttribute('aria-expanded')).toBe('true')
    expect(within(dialog).getByText('Anchored on the launcher\'s roots')).toBeTruthy()
    expect(within(dialog).getByText(/hashed 40 of 900 files; a record vouched for the rest/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Signed release/ }))
    expect(within(dialog).queryByText('Manifest SHA-256')).toBeNull()
    expect(within(dialog).getByText(en['panel.notice'])).toBeTruthy()
    expect(within(dialog).getByText(VERIFY_COMMAND)).toBeTruthy()
  })

  it('shows the plugins with their source, install match, warnings and critical advisories', () => {
    const bill = billWith(value => ({ ...value, plugins: { status: 'known', entries: [plugin({ match: 'mismatch', warnings: ['a lifecycle script ran'], criticalAdvisories: ['GHSA-1234'] })] } }))
    renderBadge(storeOf(bill).store)
    const dialog = openAdvanced()
    fireEvent.click(within(dialog).getByRole('button', { name: /^Plugins/ }))
    for (const text of ['@acme/delorun-plugin', 'npm registry', 'Differs from its install', 'a lifecycle script ran', 'GHSA-1234']) {
      expect(within(dialog).getByText(text)).toBeTruthy()
    }
  })

  it('shows the person\'s changes as a neutral count, not as a warning', () => {
    const bill = billWith(value => ({ ...value, changes: { ...value.changes, harnessEdits: [{ file: 'packages/core/agent/src/a.ts' }], notReviewed: 4 } }))
    renderBadge(storeOf(bill).store)
    const dialog = openAdvanced()
    const row = within(dialog).getByRole('button', { name: /^Your changes/ })
    expect(row.textContent).toBe('Your changesWaiting for your review · 5 of your changes')
    expect(row.closest('li')?.getAttribute('data-tone')).toBe('neutral')
    fireEvent.click(row)
    expect(within(dialog).getByText('Not reviewed').nextSibling?.textContent).toBe('4')
    expect(within(dialog).getByRole('button', { name: 'packages/core/agent/src/a.ts' })).toBeTruthy()
  })

  it('says nothing counts as checked when no bill could be read, and still states the checks\' limit', () => {
    renderBadge(storeOf(null).store)
    const dialog = openPanel()
    expect(within(dialog).getByText(en['panel.noBill'])).toBeTruthy()
    expect(within(dialog).getByText(en['panel.notice'])).toBeTruthy()
  })
})

describe('Check now', () => {
  it('shows it busy while it runs, then the new bill', async () => {
    let finish: (outcome: TrustCheckOutcome) => void = () => {}
    const start = billWith(bill => ({ ...bill, releaseLog: { state: 'unchecked', lastAttempt: null, uncheckedSince: '2026-11-09T09:00:00Z' } }))
    const { store, calls } = storeOf(start, () => new Promise((resolve) => { finish = resolve }))
    renderBadge(store)
    const dialog = openPanel()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check now' }))
    const busy = within(dialog).getByRole('button', { name: 'Checking' })
    expect({ disabled: (busy as HTMLButtonElement).disabled, busy: busy.getAttribute('aria-busy') }).toEqual({ disabled: true, busy: 'true' })
    fireEvent.click(busy)
    expect(calls.check).toBe(1)
    expect(within(dialog).getByRole('status').textContent).toBe(en['check.progress.studio'])
    expect(within(dialog).getByText(/^\d+ s$/)).toBeTruthy()
    await act(async () => { finish({ kind: 'checked', bill: { ...verifiedBill(), stage: 'verify', checkedBy: { via: 'launcher', seconds: 21.4 } }, checks: null }) })
    expect(within(dialog).getByText(en['overview.copy.verified'].replace('{version}', '0.1.0'))).toBeTruthy()
    expect(within(dialog).getByText(en['checked.launcher'].replace('{seconds}', '21.4'))).toBeTruthy()
    expect(within(dialog).queryByText(en['check.progress.studio'])).toBeNull()
    expect(screen.getByRole('button', { name: 'Trust: Verified' })).toBeTruthy()
  })

  it('names the launcher in its progress only when the bill says Check now runs through it', async () => {
    const { store } = storeOf(billWith(bill => ({ ...bill, checkNow: { via: 'launcher' } })), () => new Promise(() => {}))
    renderBadge(store)
    const dialog = openPanel()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check now' }))
    expect(within(dialog).getByRole('status').textContent).toBe(en['check.progress.launcher'])
  })

  it.each(['no-launcher', 'launcher-unresolvable'] as const)('says a check run inside the studio, because of %s, ran code that was not hashed first', async (reason) => {
    const { store } = storeOf(verifiedBill(), async () => ({ kind: 'checked', bill: { ...verifiedBill(), stage: 'verify', checkedBy: { via: 'host', reason, seconds: 9 } }, checks: null }))
    renderBadge(store)
    const dialog = openPanel()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Check now' })) })
    expect(within(dialog).getByText(en[`checked.host.${reason}`].replace('{seconds}', '9.0'))).toBeTruthy()
  })

  it('reports a failed check in place and keeps the last bill', async () => {
    const { store } = storeOf(verifiedBill(), async () => ({ kind: 'failed' }))
    renderBadge(store)
    const dialog = openPanel()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Check now' })) })
    expect(within(dialog).getByRole('alert').textContent).toBe(en['check.failed'])
    expect(within(dialog).getByRole('button', { name: 'Check now' }).getAttribute('aria-describedby')).not.toBeNull()
    expect(within(dialog).getByText(en['overview.copy.verified'].replace('{version}', '0.1.0'))).toBeTruthy()
  })

  it('reports the Host\'s refusal in place', async () => {
    const { store } = storeOf(verifiedBill(), async () => ({ kind: 'refused' }))
    renderBadge(store)
    const dialog = openPanel()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Check now' })) })
    expect(within(dialog).getByRole('alert').textContent).toBe(en['check.refused'])
  })

  it('is not offered on a remote session, which says where to run it', () => {
    const { store, calls } = storeOf(verifiedBill())
    renderBadge(store, { remote: true })
    const dialog = openPanel()
    const button = within(dialog).getByRole('button', { name: 'Check now' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(calls.check).toBe(0)
    const note = within(dialog).getByText(en['check.remote'])
    expect(button.getAttribute('aria-describedby')).toBe(note.id)
  })
})

describe('the wire', () => {
  /**
   * A fetch that answers once.
   * @param response - the answer, or the failure.
   * @returns the fetch and its calls.
   */
  const answering = (response: Response | Error) => vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
    if (response instanceof Error) throw response
    return response
  })
  const signal = new AbortController().signal
  const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('reads a valid bill document-relative', async () => {
    const fetch = answering(json({ bill: verifiedBill() }))
    await expect(fetchTrustBill(fetch, signal)).resolves.toEqual(verifiedBill())
    expect(fetch.mock.calls[0]?.[0]).toBe(TRUST_BILL_PATH.slice(1))
  })

  it('reads no bill for null, a 404, a failed request, a body that is not JSON and an invalid bill', async () => {
    for (const response of [
      json({ bill: null }),
      new Response('not found', { status: 404 }),
      new Error('offline'),
      new Response('<html>', { status: 200 }),
      json({ bill: { ...verifiedBill(), schema: 'delorun.trust-bill/2' } }),
      json({ bill: { ...verifiedBill(), plugins: { status: 'known', entries: [{ ...plugin({}), criticalAdvisories: undefined }] } } }),
    ]) {
      await expect(fetchTrustBill(answering(response), signal)).resolves.toBeNull()
    }
  })

  it('posts a JSON check and reads its outcome', async () => {
    const fetch = answering(json({ bill: verifiedBill() }))
    await expect(postTrustCheck(fetch)).resolves.toEqual({ kind: 'checked', bill: verifiedBill(), checks: null })
    expect(fetch.mock.calls[0]).toEqual([TRUST_CHECK_PATH.slice(1), expect.objectContaining({ method: 'POST', body: '{}', headers: expect.objectContaining({ 'content-type': 'application/json' }) })])
    await expect(postTrustCheck(answering(new Response('forbidden', { status: 403 })))).resolves.toEqual({ kind: 'refused' })
    await expect(postTrustCheck(answering(json({ error: 'TRUST_CHECK_FAILED', message: 'x' }, 500)))).resolves.toEqual({ kind: 'failed' })
    await expect(postTrustCheck(answering(json({ bill: null })))).resolves.toEqual({ kind: 'failed' })
    await expect(postTrustCheck(answering(new Error('offline')))).resolves.toEqual({ kind: 'failed' })
  })

  it('shows an unknown badge when the read fails, and reads again on reset and focus', async () => {
    const { api: value, calls } = api(null)
    const store = new TrustStore(value)
    let reset: () => void = () => {}
    const stop = store.start((listener) => { reset = listener; return () => {} })
    renderBadge(store)
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Trust: Not checked' }).getAttribute('data-tone')).toBe('amber')
    expect(calls.read).toBe(1)
    await act(async () => { reset() })
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(calls.read).toBe(3)
    stop()
    window.dispatchEvent(new Event('focus'))
    expect(calls.read).toBe(3)
  })
})

describe('the registration', () => {
  it('registers the badge at the sidebar\'s foot, without Check now on a remote session', async () => {
    for (const remote of [false, true]) {
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      ctx.get('slots')?.register({ name: 'root', children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } }, inject: () => ({}) },
        ({ renderSlot }) => <>{renderSlot('sidebar.footer.action', { wide: true })}</>)
      if (remote) ctx.provide('connection', { remoteMedia: 'placeholder' } as never)
      try {
        const { api: value } = api(verifiedBill())
        const fetch = async (): Promise<Response> => new Response('not found', { status: 404 })
        await ctx.plugin({ inject: ['slots', 'locale'], apply: (scope: Context) => { applyTrustBadge(scope, value, new OverviewStore(fetch), fetch) } }).await()
        const [entry] = ctx.get('slots')?.entries('sidebar.footer.action') ?? []
        expect(entry?.options).toMatchObject({ id: TRUST_BADGE.id, order: TRUST_BADGE.order })
        const face = entry?.inject?.()
        expect({ remote, offered: typeof face?.['check'] === 'function' }).toEqual({ remote, offered: !remote })
        expect(ctx.get('locale')?.bind(TRUST_NS)('badge.verified')).toBe('Verified')
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })
})

/** A start bill whose start check hashed only part of the release, with Check now through the launcher. */
function startBill(): TrustBill {
  const { checkedBy: _verifyRoute, ...bill } = billWith(value => ({ ...value, stage: 'start', checkNow: { via: 'launcher' } }))
  return bill
}

/**
 * Freshness with one background full check state.
 * @param full - the background full check.
 * @param release - the release row's freshness.
 * @returns the freshness.
 */
function checksWith(full: TrustChecks['release']['full'], release: { readonly at: string | null, readonly running: boolean } = { at: '2026-11-11T09:59:00Z', running: false }): TrustChecks {
  return {
    release: { ...release, full },
    releaseLog: { at: '2026-11-11T09:00:00Z', running: release.running },
    plugins: { at: '2026-11-11T09:59:30Z', running: release.running },
    changes: { at: '2026-11-11T09:59:30Z', running: release.running },
  }
}

/**
 * A store holding a bill and its freshness.
 * @param bill - the bill.
 * @param checks - the freshness.
 * @returns the store.
 */
function storeWith(bill: TrustBill, checks: TrustChecks | null) {
  const made = storeOf(bill)
  made.store.checks.set(checks)
  return made
}

describe('the release row\'s states', () => {
  it('reads "Signature verified · checking files" while the background full check waits, and says what comes next', () => {
    renderBadge(storeWith(startBill(), checksWith({ state: 'waiting' })).store)
    expect(screen.getByRole('button', { name: 'Trust: Checking files' }).getAttribute('data-tone')).toBe('neutral')
    const dialog = openAdvanced()
    expect(within(dialog).getByRole('button', { name: /^Signed release/ }).textContent).toBe('Signed releaseSignature verified · checking files')
    expect(within(dialog).getByText(en['full.waiting'])).toBeTruthy()
  })

  it('says it is hashing while the background full check runs', () => {
    renderBadge(storeWith(startBill(), checksWith({ state: 'running' }, { at: '2026-11-11T09:59:00Z', running: true })).store)
    const dialog = openAdvanced()
    expect(within(dialog).getByText(en['full.running'])).toBeTruthy()
    expect(within(dialog).getAllByText(en['fresh.checking']).length).toBeGreaterThan(0)
  })

  it.each([
    [{ state: 'unavailable', reason: 'no-launcher' }, en['full.reason.no-launcher']],
    [{ state: 'unavailable', reason: 'launcher-unresolvable' }, en['full.reason.launcher-unresolvable']],
    [{ state: 'unavailable', reason: 'off' }, en['full.reason.off']],
    [{ state: 'unavailable', reason: 'failed', detail: 'stopped after 600 s' }, en['full.reason.failed'].replace('{detail}', 'stopped after 600 s')],
  ] as const)('stays "Checked at start" with the honest reason when the full check cannot run (%o)', (full, reason) => {
    renderBadge(storeWith(startBill(), checksWith(full)).store)
    const dialog = openAdvanced()
    expect(within(dialog).getByRole('button', { name: /^Signed release/ }).textContent).toBe('Signed releaseChecked at start')
    expect(within(dialog).getByText(reason)).toBeTruthy()
  })

  it('reads "Verified" once a full check passed', () => {
    renderBadge(storeWith(verifiedBill(), checksWith({ state: 'done' })).store)
    expect(screen.getByRole('button', { name: 'Trust: Verified' })).toBeTruthy()
  })

  it('keeps a check run inside the studio short of Verified, with its reason', async () => {
    const hosted = billWith(bill => ({ ...bill, checkedBy: { via: 'host', reason: 'no-launcher', seconds: 4 } }))
    renderBadge(storeWith(hosted, checksWith({ state: 'unavailable', reason: 'no-launcher' })).store)
    expect(screen.getByRole('button', { name: 'Trust: Checked in the studio' })).toBeTruthy()
    const dialog = openAdvanced()
    expect(within(dialog).getByText(en['checked.host.no-launcher'].replace('{seconds}', '4.0'))).toBeTruthy()
  })
})

describe('freshness', () => {
  it('says how long ago each check ran, live, with the exact time on hover', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: Date.parse('2026-11-11T10:02:10Z') })
    renderBadge(storeWith(verifiedBill(), checksWith({ state: 'done' }, { at: '2026-11-11T09:59:00Z', running: false })).store)
    const dialog = openAdvanced()
    const line = within(dialog).getAllByText('Checked 3 minutes ago')[0]
    expect(line?.tagName).toBe('TIME')
    expect(line?.getAttribute('dateTime')).toBe('2026-11-11T09:59:00Z')
    expect(line?.getAttribute('title')).toBe(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date('2026-11-11T09:59:00Z')))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(within(dialog).getAllByText('Checked 4 minutes ago').length).toBeGreaterThan(0)
  })

  it('reads "Checked just now" under a minute and "Not checked yet" before any check', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: Date.parse('2026-11-11T09:59:20Z') })
    const checks = { ...checksWith({ state: 'done' }), releaseLog: { at: null, running: false } }
    renderBadge(storeWith(verifiedBill(), checks).store)
    const dialog = openAdvanced()
    expect(within(dialog).getAllByText(en['fresh.justNow']).length).toBeGreaterThan(0)
    expect(within(dialog).getByText(en['fresh.never'])).toBeTruthy()
  })
})

describe('the overview', () => {
  it('shows one calm line when every row is green, with the rows folded', () => {
    renderBadge(storeWith(verifiedBill(), checksWith({ state: 'done' })).store)
    const dialog = openPanel()
    expect(within(dialog).getByText(en['overview.headline.green'])).toBeTruthy()
    expect(within(dialog).queryByText(en['overview.headline.green.detail'])).toBeNull()
    const disclosure = within(dialog).getByRole('button', { name: new RegExp(en['overview.list.show']) })
    const list = within(dialog).getByText(en['overview.row.agent']).closest('ul')
    expect({ hidden: list?.hidden, expanded: disclosure.getAttribute('aria-expanded') }).toEqual({ hidden: true, expanded: 'false' })
    fireEvent.click(disclosure)
    expect({ hidden: list?.hidden, expanded: disclosure.getAttribute('aria-expanded') }).toEqual({ hidden: false, expanded: 'true' })
    for (const row of ['agent', 'undo', 'reach', 'addons', 'copy'] as const) expect(within(dialog).getByText(en[`overview.row.${row}`])).toBeTruthy()
    expect(within(dialog).getByText(en['overview.addons.reviewed'].replace('{count}', '2'))).toBeTruthy()
  })

  it('opens a row that is not green with what it means, why, whether it was chosen, and its fix', async () => {
    const act$ = vi.fn(async (_action: OverviewAction) => true)
    renderBadge(storeWith(verifiedBill(), checksWith({ state: 'done' })).store, { facts: { ...PROTECTED, protection: 'off' }, act: act$ })
    const dialog = openPanel()
    expect(within(dialog).getByText(en['overview.headline.red'])).toBeTruthy()
    const row = within(dialog).getByText(en['overview.row.undo']).closest('li')
    expect(row?.getAttribute('data-status')).toBe('red')
    expect(row?.textContent).toContain(en['overview.status.red'])
    expect(row?.textContent).toContain(en['overview.undo.off.meaning'])
    expect(row?.textContent).toContain(en['overview.kind.choice'])
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['overview.undo.off.action'] })) })
    expect(act$).toHaveBeenCalledWith({ kind: 'protection-on' })
    expect(within(dialog).getByText(en['overview.row.agent'])).toBeTruthy()
  })

  it('says so in place when turning change protection on fails', async () => {
    renderBadge(storeWith(verifiedBill(), null).store, { facts: { ...PROTECTED, protection: 'off' }, act: async () => false })
    const dialog = openPanel()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['overview.undo.off.action'] })) })
    expect(within(dialog).getByRole('alert').textContent).toBe(en['overview.protectionFailed'])
  })

  it('closes and opens the settings section for a row whose fix lives there', async () => {
    const act$ = vi.fn(async (_action: OverviewAction) => true)
    const facts: OverviewHostFacts = { ...PROTECTED, run: { prompts: 'safer', dangerous: 'off', reach: { on: true } }, devices: [{ id: 'p', label: 'Phone', approvedAt: Date.now(), lastSignInAt: Date.now() }] }
    renderBadge(storeWith(verifiedBill(), null).store, { facts, act: act$ })
    const dialog = openPanel()
    expect(within(dialog).getByText(en['overview.headline.chosen'])).toBeTruthy()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['overview.reach.phone.action'] })) })
    expect(act$).toHaveBeenCalledWith({ kind: 'open-section', section: 'delorun-devices' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('runs the full check from this copy\'s row when it could not check every file', () => {
    const { store, calls } = storeWith(startBill(), checksWith({ state: 'unavailable', reason: 'failed', detail: 'stopped' }))
    renderBadge(store)
    const dialog = openPanel()
    expect(within(dialog).getByText(en['overview.headline.look'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['overview.copy.not-full.action'] }))
    expect(calls.check).toBe(1)
  })

  it('never reads a fact it could not read as protected', () => {
    renderBadge(storeWith(verifiedBill(), null).store, { facts: NO_HOST_FACTS })
    const dialog = openPanel()
    expect(within(dialog).getByText(en['overview.headline.look'])).toBeTruthy()
    expect(within(dialog).getByText(en['overview.undo.unread'])).toBeTruthy()
  })

  it('remembers the advanced view, which breaks every row down', () => {
    const { unmount } = renderBadge(storeWith(verifiedBill(), null).store)
    const dialog = openAdvanced()
    expect(localStorage.getItem(OVERVIEW_VIEW_KEY)).toBe('advanced')
    expect(within(dialog).getByText(en['overview.undo.checked'])).toBeTruthy()
    expect(within(dialog).getByText(en['overview.states'])).toBeTruthy()
    unmount()
    renderBadge(storeWith(verifiedBill(), null).store)
    const again = openPanel()
    expect(within(again).getByRole('tab', { name: en['overview.view.advanced'] }).getAttribute('aria-selected')).toBe('true')
  })

  it('reads in Chinese', () => {
    renderBadge(storeWith(verifiedBill(), checksWith({ state: 'done' })).store, {}, zh)
    fireEvent.click(screen.getByRole('button', { name: /^可信状态：/ }))
    const dialog = screen.getByRole('dialog', { name: zh['overview.title'] })
    expect(within(dialog).getByText(zh['overview.headline.green'])).toBeTruthy()
  })
})

describe('polling', () => {
  it('reads every 3 s while a check runs, every 15 s while the full check waits, and every 60 s otherwise', () => {
    expect(trustPollDelay(null)).toBe(TRUST_POLL_IDLE_MS)
    expect(trustPollDelay(checksWith({ state: 'waiting' }))).toBe(TRUST_POLL_WAITING_MS)
    expect(trustPollDelay(checksWith({ state: 'running' }, { at: null, running: true }))).toBe(TRUST_POLL_RUNNING_MS)
    expect(trustPollDelay(checksWith({ state: 'done' }))).toBe(TRUST_POLL_IDLE_MS)
    expect([TRUST_POLL_RUNNING_MS, TRUST_POLL_WAITING_MS, TRUST_POLL_IDLE_MS]).toEqual([3_000, 15_000, 60_000])
  })

  it('reads the freshness beside the bill, and reads again on its timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const checks = checksWith({ state: 'waiting' })
    let reads = 0
    const store = new TrustStore({ read: async () => { reads++; return { bill: startBill(), checks } }, check: async () => ({ kind: 'failed' }) })
    const stop = store.start(() => () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(store.checks.getSnapshot()).toEqual(checks)
    expect(reads).toBe(1)
    await vi.advanceTimersByTimeAsync(TRUST_POLL_WAITING_MS)
    expect(reads).toBe(2)
    stop()
    await vi.advanceTimersByTimeAsync(TRUST_POLL_IDLE_MS)
    expect(reads).toBe(2)
  })

  it('parses the freshness on the wire, and reads none from a Host that sends none', async () => {
    const checks = checksWith({ state: 'unavailable', reason: 'failed', detail: 'x' })
    const answer = (body: object) => async (): Promise<Response> => new Response(JSON.stringify(body), { status: 200 })
    await expect(fetchTrustSnapshot(answer({ bill: verifiedBill(), checks }), new AbortController().signal)).resolves.toEqual({ bill: verifiedBill(), checks })
    await expect(fetchTrustSnapshot(answer({ bill: verifiedBill() }), new AbortController().signal)).resolves.toEqual({ bill: verifiedBill(), checks: null })
  })
})
