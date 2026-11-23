// @vitest-environment jsdom
/** The studio half: the Changes section, its dialogs, the outcome toast and the work-session badge against a stand-in harness. */
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FunctionComponent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, CHANGES_SECTION_ID, CHANGES_SECTION_ORDER, inject, NS, STATE_REFRESH_MS, WORK_BADGE_ID, WORK_BADGE_ORDER } from '../src/client/index.ts'
import { RELEASE_COMMAND } from '../src/client/SelfGroup.tsx'
import { en, zh } from '../src/client/locales.ts'
import { ACTION_PATHS, HARNESS_PATHS, NOTICE_SEEN_PATH, PROTECTION_PATHS, RESTART_PATHS, SHOW_PATH, STATE_PATH, type AccessView, type ActorView, type ChangesStateView, type ChangeView, type EntryView, type HarnessEffectView, type HarnessEntryView, type HarnessPendingView, type HarnessReviewView, type MayView, type RestartStateView, type PendingView, type WorkReviewView } from '../src/wire.ts'

const VERSION = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9'
const HOUR = 3_600_000

/**
 * What the stand-in harness holds: the state, with the changes `show?pending` lists in place of the folders it names
 * and of the copy's waiting changes, and why the copy could not be read.
 */
type FakeState = Omit<ChangesStateView, 'folders'> & {
  readonly pending: readonly PendingView[]
  readonly harnessPending: readonly HarnessPendingView[]
  readonly harnessProblem?: string
}

/** Every control usable: the person at the computer. */
const ACCESS_COMPUTER: AccessView = {
  actor: 'computer',
  may: {
    'harness-apply': { ok: true }, 'harness-undo': { ok: true }, 'harness-discard': { ok: true },
    'protection-off': { ok: true }, 'protection-on': { ok: true },
    'make-copy': { ok: true }, 'restart': { ok: true },
    'plugin-apply': { ok: true }, 'plugin-undo': { ok: true }, 'plugin-discard': { ok: true }, 'plugin-other': { ok: true },
    'notice-seen': { ok: true },
    'update-check': { ok: true }, 'update-begin': { ok: true }, 'update-cancel': { ok: true }, 'update-rollback': { ok: true }, 'update-dismiss': { ok: true }, 'update-continue': { ok: true }, 'stop': { ok: true },
  },
}

const UNLOCK: MayView = { ok: false, needs: 'unlock' }
const COMPUTER: MayView = { ok: false, needs: 'computer' }

const FACE: MayView = { ok: false, needs: 'face' }

/**
 * A paired phone's access, as the route computes it: with no grant store the controls that change what runs stay at
 * the computer; with it on they ask Face ID (or a PIN) for the call.
 * @param actor - the phone's state.
 * @param flag - `off` for no grant store, `on` for a grant store.
 * @returns the access.
 */
function phoneAccess(actor: ActorView, flag: 'off' | 'on'): AccessView {
  const locked = actor !== 'device-unlocked'
  const fresh: MayView = locked ? UNLOCK : { ok: true }
  const kept: MayView = flag === 'off' ? COMPUTER : FACE
  return {
    actor,
    may: {
      'harness-apply': kept, 'harness-undo': kept, 'harness-discard': fresh,
      'protection-off': kept, 'protection-on': fresh,
      'make-copy': kept, 'restart': kept,
      'plugin-apply': kept, 'plugin-undo': fresh, 'plugin-discard': fresh, 'plugin-other': kept,
      'notice-seen': COMPUTER,
      'update-check': { ok: true }, 'update-begin': kept, 'update-cancel': fresh, 'update-rollback': kept, 'update-dismiss': fresh, 'update-continue': fresh, 'stop': fresh,
    },
  }
}

/** A state with nothing in it, at the computer, with no way to change Delorun itself. */
function emptyState(fields: Partial<FakeState> = {}): FakeState {
  return {
    atComputer: true, access: ACCESS_COMPUTER, profile: 'default', protection: 'on', leftOut: [], pending: [], requests: [], recent: [], harness: [], harnessPending: [],
    harnessAvailable: { kind: 'unavailable' }, unreviewedSinceOff: 0, notices: [], problems: [], ...fields,
  }
}

/**
 * @param state - what the harness holds.
 * @returns the state route's answer: the plugin of each change waiting for review named as a folder.
 */
function stateView({ pending, harnessPending: _waiting, harnessProblem: _problem, ...state }: FakeState): ChangesStateView {
  return { ...state, folders: pending.map(({ plugin, source, kind }) => ({ plugin, source, kind })) }
}

/** A logged change; `plugin` or `decidedAt` given as null is left out. */
function logged(fields: Omit<Partial<EntryView>, 'plugin' | 'decidedAt'> & Pick<EntryView, 'id'> & { readonly plugin?: string | null, readonly decidedAt?: string | null }): EntryView {
  const { plugin = 'hello-plugin', decidedAt = new Date(Date.now() - HOUR).toISOString(), ...rest } = fields
  return {
    kind: 'plugin-edit', state: 'applied', summary: `Change ${fields.id}`, createdAt: new Date(Date.now() - 2 * HOUR).toISOString(), undoable: true, ...rest,
    ...plugin === null ? {} : { plugin }, ...decidedAt === null ? {} : { decidedAt },
  }
}

const PENDING: PendingView = { id: 'c0000000001', kind: 'plugin-edit', plugin: 'hello-plugin', source: '/work/hello-plugin', files: 2, riskKinds: [] }
const FLAGGED: PendingView = { id: 'c0000000002', kind: 'plugin-edit', plugin: 'net-plugin', source: '/work/net-plugin', files: 1, riskKinds: ['network', 'not-shown'] }

/** A pending change in full. */
function change(fields: Partial<ChangeView> = {}): ChangeView {
  return {
    id: PENDING.id, kind: 'plugin-edit', plugin: 'hello-plugin', source: '/work/hello-plugin',
    files: [{ path: 'index.js', status: 'modified', binary: false, dependency: false }, { path: 'native.node', status: 'added', binary: true, dependency: false }],
    skipped: [],
    risk: { kinds: [], phrases: [], needsSecondConfirmation: false, findings: [] },
    diff: { text: 'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-old line\n+new line\n context\n', truncated: false, omitted: [] },
    ...fields,
  }
}

const FLAGGED_CHANGE = change({
  id: FLAGGED.id, plugin: 'net-plugin', source: '/work/net-plugin',
  risk: {
    kinds: ['network', 'not-shown'], phrases: [], needsSecondConfirmation: true,
    findings: [
      { kind: 'network', file: 'index.js', line: 3, excerpt: 'fetch(url)' },
      { kind: 'network', file: 'lib.js', excerpt: 'net' },
      { kind: 'not-shown', file: 'native.node', excerpt: 'native.node: not text, and Node can load it' },
    ],
  },
  diff: { text: '+fetch(url)\n', truncated: true, omitted: ['big.js'] },
  skipped: ['socket'],
})

const SELF_FILE = 'app/node_modules/delorun/lib/main.js'

/** A logged change to Delorun itself. */
function self(fields: Partial<HarnessEntryView> & Pick<HarnessEntryView, 'id' | 'state'>): HarnessEntryView {
  const at = new Date(Date.now() - 3 * HOUR).toISOString()
  return { file: SELF_FILE, runtime: '0.4.0', summary: `Delorun 0.4.0 itself: ${SELF_FILE}`, createdAt: at, decidedAt: at, undoable: false, ...fields }
}

/** A change waiting in the person's copy of Delorun. */
const WAITING: HarnessPendingView = { id: 'c00000000b1', file: SELF_FILE, runtime: '0.4.0', status: 'modified', to: VERSION }

/** A waiting change whose checks flagged it: the route asks a second confirmation. */
const WAITING_FLAGGED: HarnessPendingView = { id: 'c00000000b2', file: 'app/node_modules/delorun/lib/net.js', runtime: '0.4.0', status: 'added', to: 'c'.repeat(64) }

/** The person's copy of Delorun exists. */
const COPY_MADE = { kind: 'available', runtime: '0.4.0', copy: true } as const

/** The person has no copy of Delorun yet. */
const COPY_NONE = { kind: 'available', runtime: '0.4.0', copy: false } as const

/** The review of a change to Delorun itself. */
const SELF_REVIEW: HarnessReviewView = {
  kind: 'harness-edit',
  files: [{ path: SELF_FILE, status: 'modified', binary: false, dependency: false }],
  risk: { kinds: [], phrases: [], needsSecondConfirmation: false, findings: [] },
  diff: { text: `--- a/${SELF_FILE}\n+++ b/${SELF_FILE}\n@@ -1 +1 @@\n-one\n+two\n`, truncated: false, omitted: [] },
}

type Route = (request: { readonly url: URL, readonly body: Record<string, unknown> }) => Response | Promise<Response>

/** A stand-in harness: the state, one change per id, the work review, and every action, each replaceable. */
function harness(initial: FakeState = emptyState()) {
  let state = initial
  const calls: Array<{ path: string, body: Record<string, unknown> }> = []
  const replaced = new Map<string, Route>()
  const changes = new Map<string, ChangeView>([[PENDING.id, change()], [FLAGGED.id, FLAGGED_CHANGE]])
  let effect: HarnessEffectView = { kind: 'live', page: false }
  let work: WorkReviewView = { kind: 'work', plugin: 'hello-plugin', source: '/work/hello-plugin', startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + HOUR).toISOString(), version: VERSION, failedToLoad: false, change: change() }
  const decided = (body: Record<string, unknown>, fields: Partial<EntryView>) => logged({ id: String(body.id), ...fields })
  const routes: Record<string, Route> = {
    [STATE_PATH]: () => Response.json(stateView(state)),
    [SHOW_PATH]: ({ url }) => {
      if (url.searchParams.has('pending')) {
        return Response.json({ kind: 'pending-list', pending: state.pending, harness: state.harnessPending, ...state.harnessProblem === undefined ? {} : { harnessProblem: state.harnessProblem } })
      }
      const work = url.searchParams.get('work')
      if (work !== null) return Response.json(workReview())
      const waiting = state.harnessPending.find(item => item.id === url.searchParams.get('id'))
      if (waiting !== undefined) return Response.json({ kind: 'harness-pending', change: waiting, review: SELF_REVIEW })
      const harnessEntry = state.harness.find(entry => entry.id === url.searchParams.get('id'))
      if (harnessEntry !== undefined) return Response.json({ kind: 'harness', entry: harnessEntry, ...harnessEntry.state === 'applied' ? { review: SELF_REVIEW } : {} })
      const shown = changes.get(String(url.searchParams.get('id')))
      return shown === undefined ? Response.json({ kind: 'logged', entry: logged({ id: String(url.searchParams.get('id')) }) }) : Response.json({ kind: 'pending', change: shown })
    },
    [ACTION_PATHS.apply]: ({ body }) => {
      const request = state.requests.find(item => item.id === body.id)
      if (request !== undefined) {
        if (body.confirmedRisk !== true) return Response.json({ code: 'CONFIRM_RISK', message: 'Confirm again.', kinds: ['dependency-or-build', 'not-shown'], notShown: ['left-pad@1.3.0'] }, { status: 409 })
        state = { ...state, requests: state.requests.filter(item => item.id !== body.id) }
        return Response.json({ entry: decided(body, { kind: request.kind }), reload: { kind: 'reloaded' } })
      }
      const shown = changes.get(String(body.id))
      if (shown?.risk.needsSecondConfirmation === true && body.confirmedRisk !== true) {
        return Response.json({ code: 'CONFIRM_RISK', message: 'Confirm again.', kinds: shown.risk.kinds, notShown: ['native.node: not text, and Node can load it'] }, { status: 409 })
      }
      state = { ...state, pending: state.pending.filter(item => item.id !== body.id), leftOut: state.leftOut.filter(item => item.id !== body.id) }
      return Response.json({ entry: decided(body, {}), reload: { kind: 'reloaded' } })
    },
    [ACTION_PATHS.discard]: ({ body }) => {
      state = { ...state, pending: state.pending.filter(item => item.id !== body.id), requests: state.requests.filter(item => item.id !== body.id) }
      return Response.json({ entry: decided(body, { state: 'discarded' }) })
    },
    [ACTION_PATHS.undo]: ({ body }) => Response.json({ entry: decided(body, { state: 'undone' }), reload: { kind: 'reloaded' } }),
    [HARNESS_PATHS.apply]: ({ body }) => {
      const waiting = state.harnessPending.find(item => item.id === body.id)
      if (waiting?.id === WAITING_FLAGGED.id && body.confirmedRisk !== true) {
        return Response.json({ code: 'CONFIRM_RISK', message: 'Confirm again.', kinds: ['network'], notShown: [] }, { status: 409 })
      }
      const entry = self({ id: String(body.id), state: 'applied', undoable: true, file: waiting?.file ?? SELF_FILE })
      state = { ...state, harnessPending: state.harnessPending.filter(item => item.id !== body.id), harness: [entry, ...state.harness] }
      return Response.json({ kind: 'harness', entry, effect })
    },
    [HARNESS_PATHS.undo]: ({ body }) => {
      const entry = self({ id: String(body.id), state: 'undone' })
      state = { ...state, harness: state.harness.map(item => item.id === body.id ? entry : item) }
      return Response.json({ kind: 'harness', entry, effect })
    },
    [HARNESS_PATHS.discard]: ({ body }) => {
      state = { ...state, harnessPending: state.harnessPending.filter(item => item.id !== body.id) }
      return Response.json({ kind: 'harness', entry: self({ id: String(body.id), state: 'discarded' }) })
    },
    [HARNESS_PATHS.copy]: () => {
      state = { ...state, harnessAvailable: COPY_MADE }
      return Response.json({ kind: 'copy', created: true, runtime: '0.4.0', place: '<Delorun home>/runtimes/0.4.0/app' })
    },
    [PROTECTION_PATHS.on]: () => {
      state = { ...state, protection: 'on' }
      return Response.json({ protection: 'on', unreviewedSinceOff: state.unreviewedSinceOff })
    },
    [PROTECTION_PATHS.off]: ({ body }) => {
      if (body.confirmed !== true) {
        return Response.json({ code: 'CONFIRM_PROTECTION', message: 'Confirm.', willLoad: { plugins: state.pending.map(item => item.plugin), harnessFiles: state.harnessPending.length } }, { status: 409 })
      }
      state = { ...state, protection: 'off' }
      return Response.json({ protection: 'off', unreviewedSinceOff: 0 })
    },
    [RESTART_PATHS.restart]: () => {
      const runningChats = state.restart?.kind === 'needed' ? state.restart.runningChats : 0
      state = { ...state, restart: { kind: 'restarting', since: new Date().toISOString(), phase: runningChats === 0 ? 'starting' : 'waiting', runningChats } }
      return Response.json({ kind: 'restarting', runningChats })
    },
    [RESTART_PATHS.cancel]: () => {
      const waiting = state.restart?.kind === 'restarting' && state.restart.phase === 'waiting' ? state.restart : undefined
      if (waiting !== undefined) state = { ...state, restart: { kind: 'needed', changes: 1, runningChats: waiting.runningChats, available: true } }
      return Response.json({ cancelled: waiting !== undefined })
    },
    [NOTICE_SEEN_PATH]: ({ body }) => {
      state = { ...state, notices: state.notices.filter(item => item.id !== body.id) }
      return Response.json({ dismissed: true })
    },
    [ACTION_PATHS.work]: ({ body }) => {
      const session = { plugin: String(body.plugin), source: '/work/hello-plugin', startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 2 * HOUR).toISOString() }
      state = { ...state, workSession: session }
      return Response.json({ session, load: { kind: 'loaded' } })
    },
    [ACTION_PATHS.done]: ({ body }) => {
      if (work.change?.risk.needsSecondConfirmation === true && body.confirmedRisk !== true) {
        return Response.json({ code: 'CONFIRM_RISK', message: 'Confirm again.', kinds: work.change.risk.kinds, notShown: [] }, { status: 409 })
      }
      const { workSession: _ended, ...rest } = state
      state = rest
      return Response.json({ kind: 'ended', plugin: String(body.plugin) })
    },
  }
  const workReview = () => work
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(`/${String(input)}`, 'http://studio.test')
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: url.pathname, body })
    expect(init?.method).toBe(init?.body === undefined ? 'GET' : 'POST')
    return await (replaced.get(url.pathname) ?? routes[url.pathname] as Route)({ url, body })
  })
  vi.stubGlobal('fetch', fetch)
  const callsTo = (path: string) => calls.filter(call => call.path === path).map(call => call.body)
  return {
    calls, callsTo,
    set: (next: FakeState) => { state = next },
    /** When the harness says a change to Delorun itself takes effect. */
    setEffect: (next: HarnessEffectView) => { effect = next },
    setWork: (next: WorkReviewView) => { work = next },
    replace: (path: string, route: Route) => { replaced.set(path, route) },
  }
}

type Entry = {
  readonly options: { readonly name: string, readonly id?: string, readonly order?: number, readonly label?: () => string, readonly locale?: string, readonly inject?: () => object }
  readonly component: FunctionComponent<object>
}

/** The page as far as the plugin uses it: slots and the locale. */
async function load() {
  const ctx = new Context()
  const dictionaries = new Map<string, unknown>()
  ctx.provide('locale', {
    bind: () => makeTranslate(en),
    register: (ns: string, dicts: unknown) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns) } },
  })
  const entries = new Set<Entry>()
  ctx.provide('slots', {
    inject: (_: string, register: () => () => void) => { register() },
    register: (options: Entry['options'], component: Entry['component']) => {
      const added = { options, component }
      entries.add(added)
      return () => { entries.delete(added) }
    },
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entryOf = (name: string): Entry => [...entries].find(candidate => candidate.options.name === name) as Entry
  /** Render a slot entry with the props the renderer would bind from its injected face. */
  const mount = (name: string, owner: object = {}) => {
    const { options, component } = entryOf(name)
    const face = (options.inject?.() ?? {}) as { hooks?: Record<string, never> } & Record<string, unknown>
    const hooks = Object.fromEntries(Object.entries(face.hooks ?? {}).map(([key, source]) =>
      [`use${key.charAt(0).toUpperCase()}${key.slice(1)}`, bindSnapshotSelector(source)]))
    const props = { t: makeTranslate(en), ...owner, ...face, ...hooks }
    const Component = component
    return render(<Component {...props} />)
  }
  return { ctx, fiber, dictionaries, entries, entryOf, mount, dispose: () => fiber.dispose() }
}

/** The section's toasts on display. */
function toasts(): Array<string | null> {
  return screen.queryAllByRole('alert').filter(alert => alert.closest('[role="dialog"]') === null && alert.closest('li') === null).map(alert => alert.textContent)
}

/** Open the section with the toast host. */
async function openSection(state?: FakeState) {
  const fake = harness(state)
  const page = await load()
  page.mount('shell.overlay')
  page.mount('settings.section')
  await screen.findByRole('heading', { name: en.title })
  await waitFor(() => { expect(document.querySelector('[aria-busy="true"]')).toBeNull() })
  await waitFor(() => { expect(screen.queryByText(en['pending.reading'])).toBeNull() })
  return { fake, page }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the plugin', () => {
  it('has the same keys in both dictionaries', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('registers its dictionaries, the toast, the Changes section and the badge, and removes its dictionaries on disposal', async () => {
    harness()
    const page = await load()
    expect(page.dictionaries.get(NS)).toEqual({ en, zh })
    const section = page.entryOf('settings.section')
    expect([section.options.id, section.options.order, section.options.label?.(), section.options.locale]).toEqual([CHANGES_SECTION_ID, CHANGES_SECTION_ORDER, en.nav, NS])
    const badge = page.entryOf('sidebar.footer.action')
    expect([badge.options.id, badge.options.order]).toEqual([WORK_BADGE_ID, WORK_BADGE_ORDER])
    expect(page.entryOf('shell.overlay').options.id).toBe('delorun-changes.toast')
    await page.dispose()
    expect(page.dictionaries.size).toBe(0)
  })

  it('reads the state at load, again while the page is visible, and not while it is hidden or after disposal', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const fake = harness()
    const page = await load()
    await waitFor(() => { expect(fake.callsTo(STATE_PATH)).toHaveLength(1) })
    act(() => { vi.advanceTimersByTime(STATE_REFRESH_MS) })
    await waitFor(() => { expect(fake.callsTo(STATE_PATH)).toHaveLength(2) })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { vi.advanceTimersByTime(STATE_REFRESH_MS) })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fake.callsTo(STATE_PATH)).toHaveLength(2)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => { expect(fake.callsTo(STATE_PATH)).toHaveLength(3) })
    await page.dispose()
    act(() => { vi.advanceTimersByTime(STATE_REFRESH_MS) })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fake.callsTo(STATE_PATH)).toHaveLength(3)
  })
})

describe('the outcome toast', () => {
  it('shows a later outcome in place of the one on display, and clears it when its hold ends', async () => {
    const { fake } = await openSection(emptyState({ recent: [logged({ id: 'c0000000006' })] }))
    fireEvent.click(screen.getByRole('button', { name: en['confirm.undo'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['confirm.undo'] }))
    await waitFor(() => { expect(toasts()).toEqual([en['toast.undone']]) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fake.replace(ACTION_PATHS.undo, () => Response.json({ code: 'NOT_ALLOWED', message: 'No.' }, { status: 409 }))
    fireEvent.click(screen.getByRole('button', { name: en['confirm.undo'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['confirm.undo'] }))
    await vi.waitFor(() => { expect(toasts()).toEqual([en['toast.failed'].replace('{message}', 'No.')]) })
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(toasts()).toEqual([])
  })
})

describe('the Changes section', () => {
  it('shows a skeleton until the state arrives, a failure with Try again, and keeps a state already shown when a later read fails', async () => {
    const fake = harness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    fake.replace(STATE_PATH, async () => {
      await gate
      return new Response(null, { status: 500 })
    })
    const page = await load()
    page.mount('settings.section')
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    release()
    expect((await screen.findByRole('alert')).textContent).toBe(en['load.failed'])
    fake.replace(STATE_PATH, () => Response.json(stateView(emptyState())))
    fireEvent.click(screen.getByRole('button', { name: en['load.retry'] }))
    expect(await screen.findByText(en['pending.empty'])).toBeTruthy()
    fake.replace(STATE_PATH, () => { throw new TypeError('offline') })
    await act(async () => { await (page.entryOf('settings.section').options.inject?.() as { reload: () => Promise<void> }).reload() })
    expect(screen.getByText(en['pending.empty'])).toBeTruthy()
  })

  it('shows each part of the state: the work session, changes left out, pending changes, requests, recent changes and the protection switch', async () => {
    await openSection(emptyState({
      problems: ['The change log cannot be read: bad JSON'],
      safeMode: { since: new Date().toISOString(), reason: 'asked', skipped: ['x'] },
      lastStart: { at: new Date().toISOString(), failure: 'boom', plugins: [{ plugin: 'hello-plugin', loaded: true }, { plugin: 'broken-plugin', loaded: false, error: 'row broken is failed' }, { plugin: 'quiet-plugin', loaded: false }] },
      leftOut: [logged({ id: 'c0000000009', state: 'left-out-at-start', plugin: 'broken-plugin', undoable: false, leftOut: { at: new Date().toISOString(), failure: 'row broken is failed' } })],
      pending: [PENDING, { ...FLAGGED, lastFailure: { at: new Date().toISOString(), failure: 'SyntaxError' } }],
      requests: [logged({ id: 'c0000000005', kind: 'plugin-install', state: 'pending', summary: 'Install left-pad', undoable: false })],
      recent: [logged({ id: 'c0000000006', summary: 'Applied hello', decidedAt: new Date(Date.now() - 5 * 60_000).toISOString() }), logged({ id: 'c0000000007', state: 'discarded', summary: 'Discarded net', undoable: false, decidedAt: null })],
    }))
    expect(screen.getByText(en.problem.replace('{problem}', 'The change log cannot be read: bad JSON'))).toBeTruthy()
    expect(screen.getByText(en.safeMode)).toBeTruthy()
    expect(screen.getByText(en['lastStart.failed'].replace('{failure}', 'boom'))).toBeTruthy()
    const work = screen.getByRole('region', { name: en['work.heading'] })
    expect(within(work).getByText(en['work.idle'])).toBeTruthy()
    expect(within(work).getAllByRole('button', { name: en['work.start'] })).toHaveLength(3)
    expect(within(work).getByText('row broken is failed')).toBeTruthy()
    expect(within(work).getByText(en['work.notLoaded'])).toBeTruthy()
    const leftOut = screen.getByRole('region', { name: en['leftOut.heading'] })
    expect(within(leftOut).getByText(en['leftOut.body'].replace('{plugin}', 'broken-plugin').replace('{failure}', 'row broken is failed'))).toBeTruthy()
    const pending = screen.getByRole('region', { name: en['pending.heading'] })
    const rows = within(pending).getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain(`hello-plugin${en['kind.plugin-edit']}${en['pending.files.other'].replace('{n}', '2')}/work/hello-plugin`)
    expect(rows[1]?.textContent).toContain(en['pending.files.one'].replace('{n}', '1'))
    expect(rows[1]?.textContent).toContain(en['risk.network'])
    expect(rows[1]?.textContent).toContain(en['risk.not-shown'])
    expect(rows[1]?.textContent).toContain(en['pending.failed'].replace('{failure}', 'SyntaxError'))
    const requests = screen.getByRole('region', { name: en['requests.heading'] })
    expect(within(requests).getByText('Install left-pad')).toBeTruthy()
    expect(within(requests).getByText('delorun changes apply c0000000005')).toBeTruthy()
    const recent = screen.getByRole('region', { name: en['recent.heading'] })
    const recentRows = within(recent).getAllByRole('listitem')
    expect(recentRows[0]?.textContent).toContain(`Applied hello${en['state.applied']}${en['recent.at.minutes'].replace('{n}', '5')}`)
    expect(within(recentRows[0] as HTMLElement).getByRole('button', { name: en['confirm.undo'] })).toBeTruthy()
    expect(recentRows[1]?.textContent).toContain(en['state.discarded'])
    expect(within(recentRows[1] as HTMLElement).queryByRole('button')).toBeNull()
    const protection = screen.getByRole('region', { name: en['protection.heading'] })
    expect(within(protection).getByText(en['protection.on'])).toBeTruthy()
    expect(within(protection).getByRole('switch', { name: en['protection.switch'] }).getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-delorun-changes-live]')).toBeNull()
    expect(document.querySelector('[data-delorun-changes-remote]')).toBeNull()
  })

  it('says when nothing waits, no change was made yet and no plugin is linked, and leaves out the setting it cannot read', async () => {
    const { protection: _unread, ...state } = emptyState({ problems: ['The protection setting cannot be read: EACCES'] })
    await openSection(state)
    expect(screen.getByText(en.problem.replace('{problem}', 'The protection setting cannot be read: EACCES'))).toBeTruthy()
    expect(screen.queryByText(en.safeMode)).toBeNull()
    expect(screen.getByText(en['pending.empty'])).toBeTruthy()
    expect(screen.getByText(en['recent.empty'])).toBeTruthy()
    expect(screen.getByText(en['work.none'])).toBeTruthy()
    const selfGroup = screen.getByRole('region', { name: en['self.heading'] })
    expect(within(selfGroup).getByText(en['self.empty'])).toBeTruthy()
    expect(within(selfGroup).getByText(en['self.unavailable'])).toBeTruthy()
    expect(within(selfGroup).queryByText(RELEASE_COMMAND)).toBeNull()
    expect(screen.queryByRole('region', { name: en['protection.heading'] })).toBeNull()
    expect(screen.queryByRole('region', { name: en['leftOut.heading'] })).toBeNull()
    expect(screen.queryByRole('region', { name: en['requests.heading'] })).toBeNull()
  })

  it('with protection off, says that changes load and linked plugins reload live on save without review, and shows the switch off', async () => {
    await openSection(emptyState({ protection: 'off' }))
    expect(document.querySelector('[data-delorun-changes-live]')?.textContent).toBe(en.live)
    const protection = screen.getByRole('region', { name: en['protection.heading'] })
    expect(within(protection).getByText(en['protection.off'])).toBeTruthy()
    expect(within(protection).getByRole('switch', { name: en['protection.switch'] }).getAttribute('aria-checked')).toBe('false')
  })

  it('reads the plugins\' folders only through show?pending: when it opens, after an action and when asked, never on the state\'s poll', async () => {
    const { fake, page } = await openSection(emptyState({ pending: [PENDING], recent: [logged({ id: 'c0000000006' })] }))
    expect(fake.callsTo(SHOW_PATH)).toHaveLength(1)
    const pending = screen.getByRole('region', { name: en['pending.heading'] })
    expect(within(pending).getByText('hello-plugin')).toBeTruthy()
    // The state's poll reads the records only.
    await act(async () => { await (page.entryOf('settings.section').options.inject?.() as { reload: () => Promise<void> }).reload() })
    expect(fake.callsTo(SHOW_PATH)).toHaveLength(1)
    // The person asks; the list on display stays while the read is under way, and a read that fails says the folders could not be read.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    fake.replace(SHOW_PATH, async () => {
      await gate
      return new Response(null, { status: 500 })
    })
    fireEvent.click(within(pending).getByRole('button', { name: en['pending.check'] }))
    await waitFor(() => { expect(fake.callsTo(SHOW_PATH)).toHaveLength(2) })
    expect(within(pending).getByText('hello-plugin')).toBeTruthy()
    release()
    expect((await within(screen.getByRole('region', { name: en['pending.heading'] })).findByRole('alert')).textContent).toBe(en['pending.unread'])
    expect(fake.callsTo(SHOW_PATH)).toHaveLength(2)
    // A folder that holds what was approved waits for nothing.
    fake.replace(SHOW_PATH, () => Response.json({ kind: 'pending-list', pending: [], harness: [] }))
    fireEvent.click(screen.getByRole('button', { name: en['pending.check'] }))
    expect(await screen.findByText(en['pending.empty'])).toBeTruthy()
    // An action reads the folders again.
    fireEvent.click(within(screen.getByRole('region', { name: en['recent.heading'] })).getByRole('button', { name: en['confirm.undo'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['confirm.undo'] }))
    await waitFor(() => { expect(fake.callsTo(SHOW_PATH)).toHaveLength(4) })
  })

  it('reviews a change with its folder, files, risk summary, the files the diff does not show and the diff, and applies one the checks did not flag', async () => {
    const { fake } = await openSection(emptyState({ pending: [PENDING] }))
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    const dialog = await screen.findByRole('dialog', { name: en['review.title'].replace('{plugin}', 'hello-plugin') })
    expect(await within(dialog).findByText(en['review.folder'].replace('{folder}', '/work/hello-plugin'))).toBeTruthy()
    expect(within(dialog).getByText(en['risk.notice'])).toBeTruthy()
    expect(within(dialog).getByText(en['risk.nothing'])).toBeTruthy()
    const files = within(dialog).getByRole('region', { name: en['review.files'] })
    expect(within(files).getAllByRole('listitem').map(row => row.textContent)).toEqual([`${en['review.file.modified']}index.js`, `${en['review.file.added']}native.node${en['review.file.binary']}`])
    const diff = within(dialog).getByRole('region', { name: en['review.diff'] })
    expect(diff.querySelector('pre')?.textContent).toBe('diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-old line\n+new line\n context\n')
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.apply'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.apply)).toEqual([{ id: PENDING.id }]) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(toasts()).toContain(en['toast.applied'])
    expect(await screen.findByText(en['pending.empty'])).toBeTruthy()
  })

  it('the studio asks a second confirmation before applying a flagged change', async () => {
    const { fake } = await openSection(emptyState({ pending: [FLAGGED] }))
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    let dialog = await screen.findByRole('dialog', { name: en['review.title'].replace('{plugin}', 'net-plugin') })
    const risk = await within(dialog).findByRole('region', { name: en['review.risk'] })
    expect(within(risk).getByText(en['risk.notice'])).toBeTruthy()
    expect(within(risk).getByText(en['risk.network'])).toBeTruthy()
    expect(within(risk).getByText('index.js:3, lib.js')).toBeTruthy()
    expect(within(within(dialog).getByRole('region', { name: en['review.notShown'] })).getByText('native.node: not text, and Node can load it')).toBeTruthy()
    expect(within(dialog).getByText('big.js')).toBeTruthy()
    expect(within(dialog).getByText('socket')).toBeTruthy()
    // The first Apply sends no confirmation; the route's 409 opens the second one, which names what the checks found.
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.apply'] }))
    dialog = await screen.findByRole('dialog', { name: en['second.title'] })
    expect(fake.callsTo(ACTION_PATHS.apply)).toEqual([{ id: FLAGGED.id }])
    expect(within(dialog).getAllByRole('listitem').map(row => row.textContent)).toEqual([en['risk.network'], en['risk.not-shown'], 'native.node: not text, and Node can load it'])
    expect(within(dialog).getByText(en['risk.notice'])).toBeTruthy()
    // Cancelling applies nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fake.callsTo(ACTION_PATHS.apply)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    dialog = await screen.findByRole('dialog', { name: en['review.title'].replace('{plugin}', 'net-plugin') })
    await within(dialog).findByRole('region', { name: en['review.risk'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.apply'] }))
    dialog = await screen.findByRole('dialog', { name: en['second.title'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['second.apply'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.apply)).toEqual([{ id: FLAGGED.id }, { id: FLAGGED.id }, { id: FLAGGED.id, confirmedRisk: true }]) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(toasts()).toContain(en['toast.applied'])
  })

  it('marks removed files and dependencies, says when no text line changed, and names the files the diff left out', async () => {
    const { fake } = await openSection(emptyState({ pending: [PENDING] }))
    fake.replace(SHOW_PATH, () => Response.json({ kind: 'pending', change: change({
      files: [{ path: 'old.js', status: 'removed', binary: false, dependency: false }, { path: 'node_modules/x/index.js', status: 'added', binary: false, dependency: true }],
      diff: { text: '', truncated: false, omitted: ['huge.txt'] },
    }) }))
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    const dialog = await screen.findByRole('dialog')
    const files = await within(dialog).findByRole('region', { name: en['review.files'] })
    expect(within(files).getAllByRole('listitem').map(row => row.textContent)).toEqual([`${en['review.file.removed']}old.js`, `${en['review.file.added']}node_modules/x/index.js${en['review.file.dependency']}`])
    expect(within(dialog).getByText(en['review.noDiff'])).toBeTruthy()
    expect(within(dialog).getByText(en['review.omitted'])).toBeTruthy()
    expect(within(dialog).getByText('huge.txt')).toBeTruthy()
  })

  it('asks the second confirmation when the route names no kinds, and ignores a change read after its dialog closed', async () => {
    const { fake } = await openSection(emptyState({ pending: [PENDING] }))
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    fake.replace(SHOW_PATH, async () => {
      await gate
      return Response.json({ kind: 'pending', change: change() })
    })
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en['confirm.cancel'] }))
    release()
    fake.replace(SHOW_PATH, () => new Response(null, { status: 500 }))
    let failed: () => void = () => {}
    const failing = new Promise<void>((resolve) => { failed = resolve })
    fake.replace(SHOW_PATH, async () => {
      await failing
      return new Response(null, { status: 500 })
    })
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en['confirm.cancel'] }))
    failed()
    await act(async () => { await gate })
    expect(screen.queryByRole('dialog')).toBeNull()
    fake.replace(SHOW_PATH, () => Response.json({ kind: 'pending', change: change() }))
    fake.replace(ACTION_PATHS.apply, () => Response.json({ code: 'CONFIRM_RISK', message: 'Confirm again.' }, { status: 409 }))
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    const review = await screen.findByRole('dialog')
    await within(review).findByRole('region', { name: en['review.files'] })
    fireEvent.click(within(review).getByRole('button', { name: en['review.apply'] }))
    const second = await screen.findByRole('dialog', { name: en['second.title'] })
    expect(within(second).queryAllByRole('listitem')).toEqual([])
    expect(within(second).queryByText(en['second.notShown'])).toBeNull()
  })

  it('discards a change from its review', async () => {
    const { fake } = await openSection(emptyState({ pending: [PENDING] }))
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('region', { name: en['review.files'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.discard'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.discard)).toEqual([{ id: PENDING.id }]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.discarded']) })
  })

  it('says a change no longer waits, or could not be read, and offers no action on it', async () => {
    const { fake } = await openSection(emptyState({ pending: [{ ...PENDING, id: 'c00000000ff' }] }))
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    let dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(en['review.gone'])).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: en['review.apply'] }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.close'] }))
    fake.replace(SHOW_PATH, () => new Response('not json', { status: 500 }))
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    dialog = await screen.findByRole('dialog')
    expect((await within(dialog).findByRole('alert')).textContent).toBe(en['review.failed'])
    expect(within(dialog).getByRole('button', { name: en['review.discard'] }).hasAttribute('disabled')).toBe(true)
  })

  it('undoes a recent change and a change left out at start, and applies a left-out change again, each after a confirmation', async () => {
    const leftOut = logged({ id: 'c0000000009', state: 'left-out-at-start', plugin: 'broken-plugin', undoable: false, leftOut: { at: new Date().toISOString(), failure: 'row broken is failed' } })
    const { fake } = await openSection(emptyState({ leftOut: [leftOut], recent: [logged({ id: 'c0000000006', summary: 'Applied hello' })] }))
    const recent = screen.getByRole('region', { name: en['recent.heading'] })
    fireEvent.click(within(recent).getByRole('button', { name: en['confirm.undo'] }))
    let dialog = screen.getByRole('dialog', { name: en['confirm.undo.title'] })
    expect(within(dialog).getByText(en['confirm.undo.body'].replace('{summary}', 'Applied hello'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    expect(fake.callsTo(ACTION_PATHS.undo)).toEqual([])
    fireEvent.click(within(recent).getByRole('button', { name: en['confirm.undo'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['confirm.undo'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.undo)).toEqual([{ id: 'c0000000006' }]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.undone']) })
    const left = screen.getByRole('region', { name: en['leftOut.heading'] })
    fireEvent.click(within(left).getByRole('button', { name: en['leftOut.applyAgain'] }))
    dialog = screen.getByRole('dialog', { name: en['confirm.applyAgain.title'] })
    expect(within(dialog).getByText(en['confirm.applyAgain.body'].replace('{summary}', 'Change c0000000009'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['leftOut.applyAgain'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.apply)).toEqual([{ id: 'c0000000009' }]) })
  })

  it('undoes a change left out at start', async () => {
    const leftOut = logged({ id: 'c0000000009', state: 'left-out-at-start', plugin: null, summary: 'Edit broken', undoable: false })
    const { fake } = await openSection(emptyState({ leftOut: [leftOut] }))
    const left = screen.getByRole('region', { name: en['leftOut.heading'] })
    expect(within(left).getAllByText('Edit broken')).toHaveLength(1)
    expect(within(left).getByText(en['leftOut.body'].replace('{plugin}', 'Edit broken').replace('{failure}', ''), { normalizer: text => text })).toBeTruthy()
    fireEvent.click(within(left).getByRole('button', { name: en['confirm.undo'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['confirm.undo'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.undo)).toEqual([{ id: 'c0000000009' }]) })
    fireEvent.click(within(left).getByRole('button', { name: en['leftOut.applyAgain'] }))
    expect(within(screen.getByRole('dialog')).getByText(en['confirm.applyAgain.body'].replace('{summary}', 'Edit broken'))).toBeTruthy()
  })

  it('applies an agent\'s plugin request after a confirmation and the second confirmation that names what it installs', async () => {
    const request = logged({ id: 'c0000000005', kind: 'plugin-install', state: 'pending', summary: 'Install left-pad@1.3.0', undoable: false })
    const { fake } = await openSection(emptyState({ requests: [request] }))
    const requests = screen.getByRole('region', { name: en['requests.heading'] })
    expect(within(requests).getByText(en['requests.terminal'])).toBeTruthy()
    fireEvent.click(within(requests).getByRole('button', { name: en['review.apply'] }))
    let dialog = screen.getByRole('dialog', { name: en['confirm.applyRequest.title'] })
    expect(within(dialog).getByText(en['confirm.applyRequest.body'].replace('{summary}', 'Install left-pad@1.3.0'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.apply'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.apply)).toEqual([{ id: 'c0000000005' }]) })
    dialog = await screen.findByRole('dialog', { name: en['confirm.applyRequest.title'] })
    expect(within(dialog).getByText(en['second.request'].replace('{summary}', 'Install left-pad@1.3.0'))).toBeTruthy()
    expect(within(dialog).queryByText(en['second.body'])).toBeNull()
    expect(within(dialog).getByText(en['risk.dependency-or-build'])).toBeTruthy()
    expect(within(dialog).getByText(en['risk.not-shown'])).toBeTruthy()
    expect(within(dialog).getByText('left-pad@1.3.0')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['second.apply'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.apply)).toEqual([{ id: 'c0000000005' }, { id: 'c0000000005', confirmedRisk: true }]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.applied']) })
    await waitFor(() => { expect(screen.queryByRole('region', { name: en['requests.heading'] })).toBeNull() })
  })

  it.each([
    [{ kind: 'not-running' }, en['toast.notRunning']],
    [{ kind: 'failed', failure: 'Error: no' }, en['toast.installNotLoaded'].replace('{failure}', 'Error: no')],
  ] as const)('reports how the running Delorun took an applied request: %o', async (reload, words) => {
    const request = logged({ id: 'c0000000005', kind: 'plugin-remove', state: 'pending', summary: 'Remove old', undoable: false })
    const { fake } = await openSection(emptyState({ requests: [request] }))
    fake.replace(ACTION_PATHS.apply, ({ body }) => Response.json({ entry: logged({ id: String(body.id), kind: 'plugin-remove' }), reload }))
    fireEvent.click(screen.getByRole('button', { name: en['review.apply'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['review.apply'] }))
    await waitFor(() => { expect(toasts()).toContain(words) })
  })

  it('discards an agent\'s plugin request after a confirmation', async () => {
    const request = logged({ id: 'c0000000005', kind: 'plugin-install', state: 'pending', summary: 'Install left-pad', undoable: false })
    const { fake } = await openSection(emptyState({ requests: [request] }))
    const requests = screen.getByRole('region', { name: en['requests.heading'] })
    fireEvent.click(within(requests).getByRole('button', { name: en['review.discard'] }))
    const dialog = screen.getByRole('dialog', { name: en['confirm.discardRequest.title'] })
    expect(within(dialog).getByText(en['confirm.discardRequest.body'].replace('{summary}', 'Install left-pad'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.discard'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.discard)).toEqual([{ id: 'c0000000005' }]) })
  })

  it('starts working on a plugin after a confirmation, then Done shows the version and its diff and approves exactly that version', async () => {
    const { fake } = await openSection(emptyState({ lastStart: { at: new Date().toISOString(), plugins: [{ plugin: 'hello-plugin', loaded: true }] } }))
    fireEvent.click(screen.getByRole('button', { name: en['work.start'] }))
    let dialog = screen.getByRole('dialog', { name: en['confirm.work.title'].replace('{plugin}', 'hello-plugin') })
    expect(within(dialog).getByText(en['confirm.work.body'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['work.start'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.work)).toEqual([{ plugin: 'hello-plugin' }]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.workStarted']) })
    const work = await screen.findByRole('region', { name: en['work.heading'] })
    expect(await within(work).findByText(en['work.active'].replace('{plugin}', 'hello-plugin'))).toBeTruthy()
    fireEvent.click(within(work).getByRole('button', { name: en['work.done'] }))
    dialog = await screen.findByRole('dialog', { name: en['done.title'].replace('{plugin}', 'hello-plugin') })
    expect(await within(dialog).findByText(en['done.version'].replace('{version}', 'a1b2c3d'))).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: en['review.diff'] })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['done.approve'].replace('{version}', 'a1b2c3d') }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.done)).toEqual([{ plugin: 'hello-plugin', version: VERSION }]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.workEnded']) })
    expect(await screen.findByText(en['work.idle'])).toBeTruthy()
  })

  it('starts safe mode after a confirmation, and leaves it after a confirmation while it is on', async () => {
    const { fake } = await openSection(emptyState())
    fake.replace(ACTION_PATHS['safe-mode'], () => Response.json({ lines: ['Safe mode is on.'], skipped: ['x'] }))
    fake.replace(ACTION_PATHS['exit-safe-mode'], () => Response.json({ lines: ['Safe mode is off.'], skipped: [] }))
    fireEvent.click(screen.getByRole('button', { name: en['safeMode.start'] }))
    expect(fake.callsTo(ACTION_PATHS['safe-mode'])).toEqual([])
    const dialog = screen.getByRole('dialog', { name: en['confirm.safeModeOn.title'] })
    expect(within(dialog).getByText(en['confirm.safeModeOn.body'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['safeMode.start'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS['safe-mode'])).toEqual([{}]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.safeMode.on']) })
  })

  it('leaves safe mode after a confirmation', async () => {
    const { fake } = await openSection(emptyState({ safeMode: { since: new Date().toISOString(), reason: 'asked', skipped: ['x'] } }))
    fake.replace(ACTION_PATHS['exit-safe-mode'], () => Response.json({ lines: ['Safe mode is off.'], skipped: [] }))
    expect(screen.getByText(en['safeMode.onBody'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['safeMode.leave'] }))
    const dialog = screen.getByRole('dialog', { name: en['confirm.safeModeOff.title'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['safeMode.leave'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS['exit-safe-mode'])).toEqual([{}]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.safeMode.off']) })
  })

  it('keeps the safe-mode button at the computer for a phone with no grant store, and enabled for a phone with it on', async () => {
    await openSection(emptyState({ atComputer: false, access: phoneAccess('device-unlocked', 'off') }))
    expect((screen.getByRole('button', { name: en['safeMode.start'] }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    await openSection(emptyState({ atComputer: false, access: phoneAccess('device-unlocked', 'on') }))
    expect((screen.getByRole('button', { name: en['safeMode.start'] }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('asks a second confirmation before Done approves a flagged version', async () => {
    const session = { plugin: 'hello-plugin', source: '/work/hello-plugin', startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + HOUR).toISOString() }
    const { fake } = await openSection(emptyState({ workSession: session }))
    fake.setWork({ kind: 'work', ...session, version: VERSION, failedToLoad: true, change: FLAGGED_CHANGE })
    fireEvent.click(screen.getByRole('button', { name: en['work.done'] }))
    let dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(en['done.failedToLoad'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['done.approve'].replace('{version}', 'a1b2c3d') }))
    dialog = await screen.findByRole('dialog', { name: en['second.title'] })
    expect(within(dialog).getAllByRole('listitem').map(row => row.textContent)).toEqual([en['risk.network'], en['risk.not-shown']])
    fireEvent.click(within(dialog).getByRole('button', { name: en['second.approve'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.done)).toEqual([{ plugin: 'hello-plugin', version: VERSION }, { plugin: 'hello-plugin', version: VERSION, confirmedRisk: true }]) })
  })

  it('ends a session whose folder holds the approved version, and offers nothing when the folder is gone', async () => {
    const session = { plugin: 'hello-plugin', source: '/work/hello-plugin', startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + HOUR).toISOString(), lastError: { at: new Date().toISOString(), error: 'SyntaxError: x' } }
    const { fake } = await openSection(emptyState({ workSession: session }))
    expect(screen.getByText(en['work.lastError'].replace('{error}', 'SyntaxError: x'))).toBeTruthy()
    fake.setWork({ kind: 'work', ...session, version: VERSION, failedToLoad: false })
    fireEvent.click(screen.getByRole('button', { name: en['work.done'] }))
    let dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(en['done.same'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.close'] }))
    fake.setWork({ kind: 'work', ...session, failedToLoad: false })
    fireEvent.click(screen.getByRole('button', { name: en['work.done'] }))
    dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(en['done.gone'])).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: en['done.end'] })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    fake.setWork({ kind: 'work', ...session, version: VERSION, failedToLoad: false })
    fireEvent.click(screen.getByRole('button', { name: en['work.done'] }))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: en['done.end'] }))
    await waitFor(() => { expect(fake.callsTo(ACTION_PATHS.done)).toEqual([{ plugin: 'hello-plugin', version: VERSION }]) })
  })

  it('reports how the Host took each action: a reload that went back, Delorun not running, a changed folder, a refusal and no answer', async () => {
    const { fake } = await openSection(emptyState({ pending: [PENDING], lastStart: { at: new Date().toISOString(), plugins: [{ plugin: 'hello-plugin', loaded: true }] }, recent: [logged({ id: 'c0000000006' })] }))
    const review = async () => {
      fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
      const dialog = await screen.findByRole('dialog')
      await within(dialog).findByRole('region', { name: en['review.files'] })
      fireEvent.click(within(dialog).getByRole('button', { name: en['review.apply'] }))
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    }
    fake.replace(ACTION_PATHS.apply, ({ body }) => Response.json({ entry: logged({ id: String(body.id) }), reload: { kind: 'went-back', failure: 'TypeError: y' } }))
    await review()
    expect(toasts()).toContain(en['toast.wentBack'].replace('{failure}', 'TypeError: y'))
    fake.replace(ACTION_PATHS.apply, ({ body }) => Response.json({ entry: logged({ id: String(body.id) }), reload: { kind: 'not-running' } }))
    await review()
    expect(toasts()).toContain(en['toast.notRunning'])
    fake.replace(ACTION_PATHS.apply, () => Response.json({ code: 'NOT_ALLOWED', message: 'Not now.' }, { status: 409 }))
    await review()
    expect(toasts()).toContain(en['toast.failed'].replace('{message}', 'Not now.'))
    fake.replace(ACTION_PATHS.apply, () => new Response('gateway', { status: 502 }))
    await review()
    expect(toasts()).toContain(en['toast.unreachable'])
    fake.replace(ACTION_PATHS.apply, () => { throw new TypeError('Failed to fetch') })
    await review()
    expect(toasts()).toContain(en['toast.unreachable'])
    fake.replace(ACTION_PATHS.work, () => Response.json({ session: { plugin: 'hello-plugin', source: '/w', startedAt: '', endsAt: '' }, load: { kind: 'went-back', failure: 'boom' } }))
    fireEvent.click(screen.getByRole('button', { name: en['work.start'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['work.start'] }))
    await waitFor(() => { expect(toasts()).toContain(en['toast.wentBack'].replace('{failure}', 'boom')) })
    fake.replace(ACTION_PATHS.undo, ({ body }) => Response.json({ entry: logged({ id: String(body.id) }), reload: { kind: 'not-running' } }))
    fireEvent.click(screen.getByRole('button', { name: en['confirm.undo'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['confirm.undo'] }))
    await waitFor(() => { expect(toasts()).toContain(en['toast.notRunning']) })
  })

  it('says the folder changed since the person looked, and when Done went back', async () => {
    const session = { plugin: 'hello-plugin', source: '/work/hello-plugin', startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + HOUR).toISOString() }
    const { fake } = await openSection(emptyState({ workSession: session }))
    const done = async () => {
      fireEvent.click(screen.getByRole('button', { name: en['work.done'] }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(await within(dialog).findByRole('button', { name: en['done.approve'].replace('{version}', 'a1b2c3d') }))
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    }
    fake.replace(ACTION_PATHS.done, () => Response.json({ code: 'CHANGED_SINCE_REVIEW', message: 'look again' }, { status: 409 }))
    await done()
    expect(toasts()).toContain(en['toast.changedSinceReview'])
    fake.replace(ACTION_PATHS.done, () => Response.json({ kind: 'went-back', plugin: 'hello-plugin', failure: 'Error: z' }))
    await done()
    expect(toasts()).toContain(en['toast.wentBack'].replace('{failure}', 'Error: z'))
  })

  it('lists the changes to Delorun itself with Review, and Undo where one takes the change back', async () => {
    const applied = self({ id: 'c00000000a1', state: 'applied', undoable: true, decidedAt: new Date(Date.now() - 2 * HOUR).toISOString() })
    const leftOut = self({ id: 'c00000000a2', state: 'left-out-at-start', file: 'app/node_modules/delorun/lib/added.js', leftOut: { at: new Date().toISOString(), failure: 'SyntaxError: no' } })
    const { decidedAt: _undecided, ...discarded } = self({ id: 'c00000000a3', state: 'discarded' })
    const { fake } = await openSection(emptyState({ harness: [applied, leftOut, discarded] }))
    const group = screen.getByRole('region', { name: en['self.heading'] })
    const rows = within(group).getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain(`${SELF_FILE}${en['state.applied']}${en['recent.at.hours'].replace('{n}', '2')}${en['self.version'].replace('{version}', '0.4.0')}`)
    expect(within(rows[1] as HTMLElement).getByText(en['self.leftOut'].replace('{failure}', 'SyntaxError: no'))).toBeTruthy()
    expect(rows[2]?.textContent).toContain(`${en['state.discarded']}${en['recent.at.hours'].replace('{n}', '3')}`)
    expect(within(group).getAllByRole('button').map(button => button.textContent)).toEqual([en['pending.review'], en['confirm.undo'], en['pending.review'], en['pending.review']])
    expect(group.textContent).not.toContain('delorun changes apply')
    expect(group.textContent).not.toContain('delorun changes undo')
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: en['pending.review'] }))
    let dialog = await screen.findByRole('dialog', { name: en['self.title'].replace('{file}', SELF_FILE) })
    const diff = await within(dialog).findByRole('region', { name: en['review.diff'] })
    expect(diff.querySelector('pre')?.textContent).toBe(SELF_REVIEW.diff.text)
    expect(within(dialog).getByRole('button', { name: en['confirm.undo'] })).toBeTruthy()
    fireEvent.click(within(dialog).getAllByRole('button', { name: en['confirm.close'] }).at(-1) as HTMLElement)
    expect(screen.queryByRole('dialog')).toBeNull()
    // A change whose content Delorun no longer keeps is shown without its diff.
    fireEvent.click(within(rows[2] as HTMLElement).getByRole('button', { name: en['pending.review'] }))
    dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(en['self.gone'])).toBeTruthy()
    expect(within(dialog).queryByRole('region', { name: en['review.diff'] })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: en['confirm.undo'] })).toBeNull()
    fireEvent.click(within(dialog).getAllByRole('button', { name: en['confirm.close'] }).at(-1) as HTMLElement)
    // A review that cannot be read says so.
    fake.replace(SHOW_PATH, () => new Response(null, { status: 500 }))
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: en['pending.review'] }))
    dialog = await screen.findByRole('dialog')
    expect((await within(dialog).findByRole('alert')).textContent).toBe(en['review.failed'])
    expect(within(dialog).queryByText(en['self.gone'])).toBeNull()
    expect(fake.calls.filter(call => call.path !== STATE_PATH && call.path !== SHOW_PATH)).toEqual([])
  })

  it('names the device that decided a change, in Recent and among the changes to Delorun itself', async () => {
    await openSection(emptyState({
      recent: [logged({ id: 'c0000000006', decidedOn: 'Ana\'s phone' })],
      harness: [self({ id: 'c00000000a1', state: 'applied', decidedOn: 'Ben\'s tablet' })],
    }))
    const recent = screen.getByRole('region', { name: en['recent.heading'] })
    expect(within(recent).getByText(en.decidedOn.replace('{device}', 'Ana\'s phone'))).toBeTruthy()
    const group = screen.getByRole('region', { name: en['self.heading'] })
    expect(within(group).getByText(en.decidedOn.replace('{device}', 'Ben\'s tablet'))).toBeTruthy()
  })

  it('offers the release command, and no other terminal command, where Delorun can change its own files', async () => {
    await openSection(emptyState({ harnessAvailable: COPY_MADE, harness: [self({ id: 'c00000000a1', state: 'applied', undoable: true })] }))
    const group = screen.getByRole('region', { name: en['self.heading'] })
    expect(within(group).getByText(en['self.intro'])).toBeTruthy()
    expect(within(group).getByText(RELEASE_COMMAND)).toBeTruthy()
    expect(within(group).queryByText(en['self.unavailable'])).toBeNull()
    expect(within(group).getAllByText(/^delorun /).map(command => command.textContent)).toEqual([RELEASE_COMMAND])
  })

  it('says a copy of Delorun cannot be read, in the group, and lists nothing as waiting', async () => {
    await openSection(emptyState({ harnessAvailable: COPY_MADE, harnessProblem: 'EACCES: permission denied' }))
    const group = screen.getByRole('region', { name: en['self.heading'] })
    expect(within(group).getByRole('alert').textContent).toBe(en['self.problem'].replace('{problem}', 'EACCES: permission denied'))
    expect(within(group).queryByText(en['self.nothingWaits'])).toBeNull()
    expect(toasts()).toEqual([])
  })

  it('shows a change waiting in the copy and applies exactly the version its review showed', async () => {
    const reviewed = 'b'.repeat(64)
    const { fake } = await openSection(emptyState({ harnessAvailable: COPY_MADE, harnessPending: [WAITING] }))
    const group = screen.getByRole('region', { name: en['self.heading'] })
    const row = within(group).getByText(en['self.waiting']).closest('li') as HTMLElement
    expect(row.textContent).toContain(`${SELF_FILE}${en['self.waiting']}${en['review.file.modified']}`)
    // The file changed again after the list was read: the review shows, and Apply sends, what the copy holds now.
    fake.set(emptyState({ harnessAvailable: COPY_MADE, harnessPending: [{ ...WAITING, to: reviewed }] }))
    fireEvent.click(within(row).getByRole('button', { name: en['pending.review'] }))
    const dialog = await screen.findByRole('dialog', { name: en['self.title'].replace('{file}', SELF_FILE) })
    expect(await within(dialog).findByText(en['self.reviewVersion'].replace('{version}', 'bbbbbbb'))).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: en['review.diff'] })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.apply'] }))
    await waitFor(() => { expect(fake.callsTo(HARNESS_PATHS.apply)).toEqual([{ id: WAITING.id, to: reviewed }]) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(toasts()).toContain(en['toast.self.live'])
  })

  it.each([
    [{ kind: 'live', page: false }, 'toast.self.live', 'self.effect.live'],
    [{ kind: 'restart' }, 'toast.self.restart', 'self.effect.restart'],
    [{ kind: 'not-running' }, 'toast.self.nextStart', 'self.effect.not-running'],
  ] as const)('tells when an applied change to Delorun itself takes effect: %o', async (effect, toast, tag) => {
    const { fake } = await openSection(emptyState({ harnessAvailable: COPY_MADE, harnessPending: [WAITING] }))
    fake.setEffect(effect)
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('region', { name: en['review.diff'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.apply'] }))
    await waitFor(() => { expect(toasts()).toContain(en[toast]) })
    const row = await screen.findByText(en['state.applied'])
    expect(within(row.closest('li') as HTMLElement).getByText(en[tag])).toBeTruthy()
  })

  it('asks a second confirmation before applying a flagged change to Delorun itself, and sends the confirmation with the reviewed version', async () => {
    const { fake } = await openSection(emptyState({ harnessAvailable: COPY_MADE, harnessPending: [WAITING_FLAGGED] }))
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    let dialog = await screen.findByRole('dialog', { name: en['self.title'].replace('{file}', WAITING_FLAGGED.file) })
    await within(dialog).findByRole('region', { name: en['review.diff'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.apply'] }))
    dialog = await screen.findByRole('dialog', { name: en['second.title'] })
    expect(within(dialog).getAllByRole('listitem').map(row => row.textContent)).toEqual([en['risk.network']])
    expect(within(dialog).getByText(en['self.notice'])).toBeTruthy()
    expect(fake.callsTo(HARNESS_PATHS.apply)).toEqual([{ id: WAITING_FLAGGED.id, to: WAITING_FLAGGED.to }])
    fireEvent.click(within(dialog).getByRole('button', { name: en['second.apply'] }))
    await waitFor(() => { expect(fake.callsTo(HARNESS_PATHS.apply)).toEqual([{ id: WAITING_FLAGGED.id, to: WAITING_FLAGGED.to }, { id: WAITING_FLAGGED.id, to: WAITING_FLAGGED.to, confirmedRisk: true }]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.self.live']) })
  })

  it('discards a change waiting in the copy only after a confirmation', async () => {
    const { fake } = await openSection(emptyState({ harnessAvailable: COPY_MADE, harnessPending: [WAITING] }))
    const group = screen.getByRole('region', { name: en['self.heading'] })
    fireEvent.click(within(group).getByRole('button', { name: en['review.discard'] }))
    let dialog = screen.getByRole('dialog', { name: en['confirm.selfDiscard.title'] })
    expect(within(dialog).getByText(en['confirm.selfDiscard.body'].replace('{file}', SELF_FILE))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fake.callsTo(HARNESS_PATHS.discard)).toEqual([])
    fireEvent.click(within(group).getByRole('button', { name: en['review.discard'] }))
    dialog = screen.getByRole('dialog', { name: en['confirm.selfDiscard.title'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['review.discard'] }))
    await waitFor(() => { expect(fake.callsTo(HARNESS_PATHS.discard)).toEqual([{ id: WAITING.id }]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.discarded']) })
    expect(await within(group).findByText(en['self.nothingWaits'])).toBeTruthy()
  })

  it.each([
    [{ kind: 'live', page: false }, 'toast.self.undoneLive'],
    [{ kind: 'restart' }, 'toast.self.undoneRestart'],
  ] as const)('undoes a decided change to Delorun itself after a confirmation, and tells when the undo takes effect: %o', async (effect, toast) => {
    const applied = self({ id: 'c00000000a1', state: 'applied', undoable: true })
    const { fake } = await openSection(emptyState({ harnessAvailable: COPY_MADE, harness: [applied] }))
    fake.setEffect(effect)
    const group = screen.getByRole('region', { name: en['self.heading'] })
    fireEvent.click(within(group).getByRole('button', { name: en['confirm.undo'] }))
    let dialog = screen.getByRole('dialog', { name: en['confirm.undo.title'] })
    expect(within(dialog).getByText(en['confirm.selfUndo.body'].replace('{file}', SELF_FILE))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    expect(fake.callsTo(HARNESS_PATHS.undo)).toEqual([])
    fireEvent.click(within(group).getByRole('button', { name: en['confirm.undo'] }))
    dialog = screen.getByRole('dialog', { name: en['confirm.undo.title'] })
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.undo'] }))
    await waitFor(() => { expect(fake.callsTo(HARNESS_PATHS.undo)).toEqual([{ id: 'c00000000a1' }]) })
    await waitFor(() => { expect(toasts()).toContain(en[toast]) })
    expect(await within(group).findByText(en['state.undone'])).toBeTruthy()
    expect(within(group).queryByRole('button', { name: en['confirm.undo'] })).toBeNull()
  })

  it.each([
    [true, 'self.copy.made', 'toast.copy.made'],
    [false, 'self.copy.found', 'toast.copy.found'],
  ] as const)('makes the person\'s copy of Delorun and shows where it is (created: %s)', async (created, line, toast) => {
    const place = '<Delorun home>/runtimes/0.4.0/app'
    const { fake } = await openSection(emptyState({ harnessAvailable: COPY_NONE }))
    fake.replace(HARNESS_PATHS.copy, () => Response.json({ kind: 'copy', created, runtime: '0.4.0', place }))
    const group = screen.getByRole('region', { name: en['self.heading'] })
    expect(within(group).getByText(en['self.copy.none'])).toBeTruthy()
    fireEvent.click(within(group).getByRole('button', { name: en['self.copy.make'] }))
    await waitFor(() => { expect(fake.callsTo(HARNESS_PATHS.copy)).toEqual([{}]) })
    expect(await within(group).findByText(en[line].replace('{version}', '0.4.0'))).toBeTruthy()
    expect(within(group).getByText(place)).toBeTruthy()
    await waitFor(() => { expect(toasts()).toContain(en[toast]) })
  })

  it('names no harness, integrity, trust or drift in its copy', () => {
    for (const dictionary of [en, zh]) {
      for (const [key, text] of Object.entries(dictionary)) expect(text, key).not.toMatch(/harness|integrity|trust|drift/i)
    }
  })

  it('a locked phone sees the changes, the controls kept at the computer are disabled, and a refused Undo opens no unlock dialog', async () => {
    const leftOut = logged({ id: 'c0000000009', state: 'left-out-at-start', plugin: 'broken-plugin', undoable: false })
    const session = { plugin: 'hello-plugin', source: '/work/hello-plugin', startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + HOUR).toISOString() }
    const { fake, page } = await openSection(emptyState({
      atComputer: false, access: phoneAccess('device-locked', 'off'), workSession: session, leftOut: [leftOut], pending: [PENDING],
      requests: [logged({ id: 'c0000000005', kind: 'plugin-install', state: 'pending', undoable: false })], recent: [logged({ id: 'c0000000006' })],
    }))
    const denied: Array<{ endpoint: string, reason?: string | undefined }> = []
    page.ctx.on('remote/call-denied', (denial) => { denied.push(denial) })
    const note = document.querySelector('[data-delorun-changes-remote="device-locked"]')
    expect(note?.textContent).toContain(en['access.device.title'])
    expect(note?.textContent).toContain(en['access.device.body'])
    // What stays at the computer is disabled with the reason; the rest stays enabled.
    for (const name of [en['work.done'], en['leftOut.applyAgain'], en['review.apply']]) {
      for (const button of screen.getAllByRole('button', { name })) {
        expect(button.hasAttribute('disabled'), name).toBe(true)
        expect(button.getAttribute('title'), name).toBe(en['access.needsComputer'])
      }
    }
    const undo = within(screen.getByRole('region', { name: en['recent.heading'] })).getByRole('button', { name: en['confirm.undo'] })
    expect(undo.hasAttribute('disabled')).toBe(false)
    expect(undo.getAttribute('title')).toBe(en['access.needsUnlock'])
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('region', { name: en['review.files'] })
    expect(within(dialog).getByRole('button', { name: en['review.apply'] }).hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getByRole('button', { name: en['review.discard'] }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    // The route refuses the grant-less Undo; the studio words the refusal and opens no unlock dialog (A483).
    fake.replace(ACTION_PATHS.undo, () => Response.json({ code: 'ELEVATION_REQUIRED', message: 'Unlock this phone.' }, { status: 403 }))
    fireEvent.click(within(screen.getByRole('region', { name: en['recent.heading'] })).getByRole('button', { name: en['confirm.undo'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['confirm.undo'] }))
    await waitFor(() => { expect(toasts()).toContain(en['toast.unlock']) })
    // Removing the unlock dialog's removal from the controller makes a no-passkey phone ask for a page unlock again.
    expect(denied).toEqual([])
    expect(fake.callsTo(ACTION_PATHS.undo)).toEqual([{ id: 'c0000000006' }])
  })

  it('a phone in its approval grace is told what it confirms, not that it must unlock', async () => {
    await openSection(emptyState({ atComputer: false, access: phoneAccess('device-grace', 'on') }))
    const note = document.querySelector('[data-delorun-changes-remote="device-grace"]')
    expect(note?.textContent).toContain(en['access.device.title'])
    expect(note?.textContent).toContain(en['access.device.body'])
    expect(note?.textContent).not.toContain('Phone powers')
  })

  it('an unlocked phone with a grant store sees what it takes without asking and what it confirms, and no Phone powers level', async () => {
    await openSection(emptyState({ atComputer: false, access: phoneAccess('device-unlocked', 'on'), pending: [PENDING] }))
    const note = document.querySelector('[data-delorun-changes-remote="device-unlocked"]')
    expect(note?.textContent).toContain(en['access.device.title'])
    expect(note?.textContent).toContain(en['access.device.body'])
    expect(note?.textContent).not.toContain('Unlock this phone')
    expect(note?.textContent).not.toContain('Phone powers')
    expect(note?.hasAttribute('data-phone-powers')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en['pending.review'] }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('region', { name: en['review.files'] })
    // Apply asks Face ID for the call, so the button stays enabled; the Face ID sheet itself is covered in face-grant.client.spec.ts.
    expect(within(dialog).getByRole('button', { name: en['review.apply'] }).hasAttribute('disabled')).toBe(false)
  })

  it('an unlocked phone with no grant store cannot turn protection off or apply, and the notices wait for the computer', async () => {
    const notice = { id: 'n1', level: 'off', at: new Date().toISOString(), device: 'Ana\'s phone' } as const
    await openSection(emptyState({ atComputer: false, access: phoneAccess('device-unlocked', 'off'), notices: [notice], pending: [PENDING] }))
    const note = document.querySelector('[data-delorun-changes-remote="device-unlocked"]')
    expect(note?.textContent).toContain(en['access.device.title'])
    const protection = screen.getByRole('region', { name: en['protection.heading'] })
    const toggle = within(protection).getByRole('switch', { name: en['protection.switch'] })
    expect(toggle.hasAttribute('disabled')).toBe(true)
    expect(toggle.getAttribute('title')).toBe(en['access.needsComputer'])
    expect(within(screen.getByRole('list', { name: en['notice.heading'] })).getByRole('button', { name: en['notice.dismiss'] }).hasAttribute('disabled')).toBe(false)
  })

  it('shows the computer no access note', async () => {
    await openSection(emptyState())
    expect(document.querySelector('[data-delorun-changes-remote]')).toBeNull()
  })

  it.each([1, 3])('asks once before turning protection on, and says how many changes loaded without review while it was off (%i)', async (count) => {
    const { fake } = await openSection(emptyState({ protection: 'off', unreviewedSinceOff: count }))
    const loaded = en[count === 1 ? 'protection.on.loaded.one' : 'protection.on.loaded.other'].replace('{n}', String(count))
    const protection = screen.getByRole('region', { name: en['protection.heading'] })
    expect(within(protection).getByText(en[count === 1 ? 'protection.loaded.one' : 'protection.loaded.other'].replace('{n}', String(count)))).toBeTruthy()
    fireEvent.click(within(protection).getByRole('switch', { name: en['protection.switch'] }))
    const dialog = screen.getByRole('dialog', { name: en['protection.on.title'] })
    expect(within(dialog).getByText(loaded)).toBeTruthy()
    expect(fake.callsTo(PROTECTION_PATHS.on)).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: en['protection.on.confirm'] }))
    await waitFor(() => { expect(fake.callsTo(PROTECTION_PATHS.on)).toEqual([{}]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.protection.on']) })
    expect(within(await screen.findByRole('region', { name: en['protection.heading'] })).getByRole('switch', { name: en['protection.switch'] }).getAttribute('aria-checked')).toBe('true')
  })

  it('names the plugins and files that load without review before protection goes off, and turns it off with the confirmation', async () => {
    const { fake } = await openSection(emptyState({ pending: [PENDING, FLAGGED], harnessAvailable: COPY_MADE, harnessPending: [WAITING] }))
    fireEvent.click(screen.getByRole('switch', { name: en['protection.switch'] }))
    const dialog = await screen.findByRole('dialog', { name: en['protection.off.title'] })
    expect(within(dialog).getAllByRole('listitem').map(row => row.textContent)).toEqual(['hello-plugin', 'net-plugin'])
    expect(dialog.textContent).toContain(en['protection.off.files.one'].replace('{n}', '1'))
    expect(fake.callsTo(PROTECTION_PATHS.off)).toEqual([{}])
    expect(toasts()).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: en['protection.off.confirm'] }))
    await waitFor(() => { expect(fake.callsTo(PROTECTION_PATHS.off)).toEqual([{}, { confirmed: true }]) })
    await waitFor(() => { expect(toasts()).toContain(en['toast.protection.off']) })
    await waitFor(() => { expect(screen.getByRole('switch', { name: en['protection.switch'] }).getAttribute('aria-checked')).toBe('false') })
  })

  it('says nothing waits for review when protection goes off with nothing waiting, and Cancel sends nothing more', async () => {
    const { fake } = await openSection(emptyState())
    fireEvent.click(screen.getByRole('switch', { name: en['protection.switch'] }))
    const dialog = await screen.findByRole('dialog', { name: en['protection.off.title'] })
    expect(within(dialog).getByText(en['protection.off.nothing'])).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en['confirm.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fake.callsTo(PROTECTION_PATHS.off)).toEqual([{}])
    expect(screen.getByRole('switch', { name: en['protection.switch'] }).getAttribute('aria-checked')).toBe('true')
  })

  it('shows a protection notice from a phone and dismisses it by its id', async () => {
    const notices = [
      { id: 'n1', level: 'off', at: new Date().toISOString(), device: 'Ana\'s phone' },
      { id: 'n2', level: 'on', at: new Date().toISOString(), device: 'Ben\'s tablet' },
    ] as const
    const { fake } = await openSection(emptyState({ notices }))
    const list = screen.getByRole('list', { name: en['notice.heading'] })
    const [off, on] = within(list).getAllByRole('note')
    expect(off?.textContent).toContain('Ana\'s phone')
    expect(off?.textContent).toContain(en['notice.offBody'])
    expect(on?.textContent).toContain('Ben\'s tablet')
    expect(on?.textContent).not.toContain(en['notice.offBody'])
    fireEvent.click(within(off as HTMLElement).getByRole('button', { name: en['notice.dismiss'] }))
    await waitFor(() => { expect(fake.callsTo(NOTICE_SEEN_PATH)).toEqual([{ id: 'n1' }]) })
    await waitFor(() => { expect(within(screen.getByRole('list', { name: en['notice.heading'] })).getAllByRole('note')).toHaveLength(1) })
    expect(toasts()).toEqual([])
  })
})

describe('the restart', () => {
  const NEEDED: RestartStateView = { kind: 'needed', changes: 2, runningChats: 1, available: true }
  const card = () => document.querySelector('[data-restart]')

  it('says what a restart interrupts, waits for the running chat, and shows Restarting until Delorun answers again without one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const { fake } = await openSection(emptyState({ restart: NEEDED }))
    expect(card()?.textContent).toContain(en['restart.needed.other'].replace('{n}', '2'))
    expect(card()?.textContent).toContain(en['restart.body'])
    expect(card()?.getAttribute('role')).toBe('note')
    expect(card()?.getAttribute('data-kind')).toBe('info')
    fireEvent.click(screen.getByRole('button', { name: en['restart.now'] }))
    const dialog = await screen.findByRole('dialog', { name: en['restart.title'] })
    expect(dialog.textContent).toContain(en['restart.chats.one'].replace('{n}', '1'))
    fireEvent.click(within(dialog).getByRole('button', { name: en['restart.wait'] }))
    await waitFor(() => { expect(card()?.getAttribute('data-restart')).toBe('restarting') })
    expect(fake.callsTo(RESTART_PATHS.restart)).toEqual([{}])
    expect(card()?.textContent).toContain(en['restart.waiting.one'].replace('{n}', '1'))
    expect(card()?.getAttribute('role')).toBe('status')
    expect(card()?.getAttribute('data-kind')).toBe('progress')
    // While the Host is down, a failed read keeps the card; the next read without a restart ends it.
    fake.replace(STATE_PATH, () => { throw new TypeError('offline') })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(card()?.getAttribute('data-restart')).toBe('restarting')
    const { restart: _done, ...back } = emptyState({ restart: NEEDED })
    fake.set(back)
    fake.replace(STATE_PATH, () => Response.json({ ...back, folders: [] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    await waitFor(() => { expect(card()).toBeNull() })
    expect(toasts()).toContain(en['toast.restarted'])
  })

  it('stops the running chats when asked, and cancels a restart still waiting for them', async () => {
    const { fake } = await openSection(emptyState({ restart: NEEDED }))
    fireEvent.click(screen.getByRole('button', { name: en['restart.now'] }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en['restart.stopChats'] }))
    await waitFor(() => { expect(fake.callsTo(RESTART_PATHS.restart)).toEqual([{ stopChats: true }]) })
    await waitFor(() => { expect(screen.getByRole('button', { name: en['restart.cancel'] })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en['restart.cancel'] }))
    await waitFor(() => { expect(toasts()).toContain(en['toast.restartCancelled']) })
    expect(fake.callsTo(RESTART_PATHS.cancel)).toEqual([{}])
    await waitFor(() => { expect(card()?.getAttribute('data-restart')).toBe('needed') })
  })

  it('says the changes run at the next start where Delorun cannot restart itself, with no Restart', async () => {
    await openSection(emptyState({ restart: { ...NEEDED, available: false } }))
    expect(card()?.textContent).toContain(en['restart.unavailable'])
    expect(screen.queryByRole('button', { name: en['restart.now'] })).toBeNull()
  })

  it('after a failed start says Delorun kept running and names the change left out, which Undo takes back after a confirmation', async () => {
    const leftOut = self({ id: 'c00000000c1', state: 'left-out-at-start', undoable: true })
    const { fake } = await openSection(emptyState({ harness: [leftOut], restart: { kind: 'failed', at: new Date().toISOString(), failure: 'The new start did not answer.', reason: 'health', leftOut: { id: leftOut.id, file: SELF_FILE } } }))
    expect(card()?.getAttribute('role')).toBe('alert')
    expect(card()?.getAttribute('data-kind')).toBe('error')
    expect(card()?.textContent).toContain(en['restart.failed.health'])
    expect(card()?.textContent).toContain(en['restart.failed.kept'].replace('{failure}', 'The new start did not answer.'))
    expect(card()?.textContent).toContain(en['restart.failed.leftOut'].replace('{file}', SELF_FILE))
    expect(within(card() as HTMLElement).queryByRole('button', { name: en['restart.again'] })).toBeNull()
    fireEvent.click(within(card() as HTMLElement).getByRole('button', { name: en['restart.failed.undo'] }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en['confirm.undo'] }))
    await waitFor(() => { expect(fake.callsTo(HARNESS_PATHS.undo)).toEqual([{ id: leftOut.id }]) })
  })

  it('offers Try again when the chats were still running, without claiming how many', async () => {
    const { fake } = await openSection(emptyState({ restart: { kind: 'failed', at: new Date().toISOString(), failure: 'Two chats still ran.', reason: 'chats' } }))
    expect(card()?.textContent).toContain(en['restart.failed.chats'])
    fireEvent.click(screen.getByRole('button', { name: en['restart.again'] }))
    const dialog = await screen.findByRole('dialog', { name: en['restart.title'] })
    expect(dialog.textContent).toContain(en['restart.chats.unknown'])
    fireEvent.click(within(dialog).getByRole('button', { name: en['restart.wait'] }))
    await waitFor(() => { expect(fake.callsTo(RESTART_PATHS.restart)).toEqual([{}]) })
  })

  it('keeps Restart at the computer with no grant store, and leaves it enabled for a phone with a grant store', async () => {
    await openSection(emptyState({ atComputer: false, access: phoneAccess('device-unlocked', 'off'), restart: NEEDED }))
    const careful = screen.getByRole('button', { name: en['restart.now'] })
    expect(careful.hasAttribute('disabled')).toBe(true)
    expect(careful.getAttribute('title')).toBe(en['access.needsComputer'])
    cleanup()
    await openSection(emptyState({ atComputer: false, access: phoneAccess('device-locked', 'on'), restart: NEEDED }))
    expect(screen.getByRole('button', { name: en['restart.now'] }).hasAttribute('disabled')).toBe(false)
  })

  it('offers to reload the page after a change to the studio\'s own files, and says when a change could not run live and is left out', async () => {
    const { fake } = await openSection(emptyState({ harnessAvailable: COPY_MADE, harnessPending: [WAITING, WAITING_FLAGGED] }))
    fake.setEffect({ kind: 'live', page: true })
    const apply = async (file: string) => {
      const row = (await screen.findByText(file)).closest('li') as HTMLElement
      fireEvent.click(within(row).getByRole('button', { name: en['pending.review'] }))
      const dialog = await screen.findByRole('dialog')
      await within(dialog).findByRole('region', { name: en['review.files'] })
      fireEvent.click(within(dialog).getByRole('button', { name: en['review.apply'] }))
    }
    await apply(WAITING.file)
    await waitFor(() => { expect(toasts()).toContain(en['toast.self.livePage']) })
    const row = (await screen.findByRole('button', { name: en['self.reloadPage'] })).closest('li')
    expect(row?.getAttribute('data-change-id')).toBe(WAITING.id)
    fake.setEffect({ kind: 'left-out', failure: 'It did not load.' })
    fake.replace(HARNESS_PATHS.apply, ({ body }) => Response.json({ kind: 'harness', entry: self({ id: String(body.id), state: 'left-out-at-start', file: WAITING_FLAGGED.file }), effect: { kind: 'left-out', failure: 'It did not load.' } }))
    await apply(WAITING_FLAGGED.file)
    await waitFor(() => { expect(toasts()).toContain(en['toast.self.leftOut'].replace('{failure}', 'It did not load.')) })
  })
})

describe('the work-session badge', () => {
  it('a work session\'s badge is shown while it lasts', async () => {
    const session = { plugin: 'hello-plugin', source: '/work/hello-plugin', startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + HOUR).toISOString() }
    const fake = harness(emptyState())
    const page = await load()
    const reload = (page.entryOf('settings.section').options.inject?.() as { reload: () => Promise<void> }).reload
    page.mount('sidebar.footer.action', { wide: true })
    await act(async () => { await reload() })
    expect(document.querySelector('[data-delorun-work-badge]')).toBeNull()
    fake.set(emptyState({ workSession: session }))
    await act(async () => { await reload() })
    const badge = screen.getByRole('status')
    expect(badge.textContent).toBe(en['badge.working'].replace('{plugin}', 'hello-plugin'))
    expect(badge.getAttribute('data-delorun-work-badge')).toBe('hello-plugin')
    // Once the state no longer names the session, the badge is gone.
    fake.set(emptyState())
    await act(async () => { await reload() })
    expect(document.querySelector('[data-delorun-work-badge]')).toBeNull()
  })

  it('shows nothing before the state arrives', async () => {
    const fake = harness()
    fake.replace(STATE_PATH, () => new Promise<Response>(() => {}))
    const page = await load()
    page.mount('sidebar.footer.action', { wide: true })
    expect(document.querySelector('[data-delorun-work-badge]')).toBeNull()
  })

  it('is a dot named for the plugin in the narrow rail, and is gone once the session\'s end time has passed', async () => {
    const session = { plugin: 'hello-plugin', source: '/work/hello-plugin', startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + HOUR).toISOString() }
    harness(emptyState({ workSession: session }))
    const page = await load()
    const rail = page.mount('sidebar.footer.action', { wide: false })
    expect((await screen.findByRole('status', { name: en['badge.working'].replace('{plugin}', 'hello-plugin') })).textContent).toBe('')
    rail.unmount()
    const later = Date.now() + 2 * HOUR
    vi.spyOn(Date, 'now').mockReturnValue(later)
    page.mount('sidebar.footer.action', { wide: true })
    expect(document.querySelector('[data-delorun-work-badge]')).toBeNull()
  })
})
