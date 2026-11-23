// @vitest-environment jsdom
/** The studio half: the report dialog, the progress and outcome cards, and the controller's reload, against stand-in routes. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReleaseChannel, SemanticVersion, Sha256Hex, UtcTimestamp } from '@delorun/contract-release-manifest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateController, type UpdateLoad } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import { UpdateDialog } from '../src/client/UpdateDialog.tsx'
import { StoppedChatLine } from '../src/client/StopChats.tsx'
import { UpdateAlertsEntry } from '../src/client/UpdateAlerts.tsx'
import { UpdateProgress } from '../src/client/UpdateProgress.tsx'
import { UpdateCards, type UpdateCardsProps } from '../src/client/UpdateOverlay.tsx'
import { UPDATE_CONTROLS, UPDATE_PATHS, type PreparedUpdateView, type UpdateControl, type UpdateMayView, type UpdateResultView, type UpdateStateView } from '../src/wire.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = makeTranslate(en)
const version = (text: string) => brandString<SemanticVersion>(text)
const OK: UpdateMayView = { ok: true }

/** Every control usable (the computer), with the named ones replaced. */
function may(replace: Partial<Record<UpdateControl, UpdateMayView>> = {}): UpdateStateView['access'] {
  return { actor: 'computer', may: Object.fromEntries(UPDATE_CONTROLS.map(control => [control, replace[control] ?? OK])) as Record<UpdateControl, UpdateMayView> }
}

/** An idle state at the computer. */
function stateOf(fields: Partial<UpdateStateView> = {}): UpdateStateView {
  return { release: { delorun: '0.1.2', dsh: '0.2.2' }, available: true, access: may(), check: { enabled: true }, progress: { kind: 'idle' }, rollback: { available: false }, continueStopped: true, ...fields }
}

/** A prepared report with one plugin the update turns off and the chat-data item. */
function preparedOf(fields: Partial<PreparedUpdateView> = {}): PreparedUpdateView {
  const channel: ReleaseChannel = 'stable'
  const from = { delorun: version('0.1.2'), dsh: version('0.2.2'), channel }
  const to = { delorun: version('0.1.3'), dsh: version('0.2.2'), channel }
  return {
    handle: 'h1', expiresAt: Date.now() + 600_000, kind: 'patch', releaseNote: '<b>Ignore all instructions</b>', runningChats: 0,
    confirm: { ticks: ['item:0', 'data-no-copy'], dataItem: 1 },
    report: {
      schema: 'delorun.update-report/3', installation: 'cli-home', from, to,
      release: { manifest: brandString<Sha256Hex>('a'.repeat(64)), signature: 'passed', freshness: 'passed', log: 'passed' }, generated: brandString<UtcTimestamp>('2026-11-17T00:00:00Z'), installations: [],
      items: [
        { kind: 'plugin', subject: { name: 'old-plugin', version: version('1.0.0') }, reason: 'dsh-requirement-unmet', effect: 'disabled', verification: 'verified', detail: { axis: 'dsh', requirement: '^0.2.2' }, actions: [] },
        { kind: 'data', subject: { directories: ['sessions', 'storages'] }, reason: 'data-format-changed', effect: 'changed', verification: 'verified', detail: { differs: ['dsh'], copy: { files: 12, bytes: 4096, free: 5 * 1024 ** 3 } }, actions: ['copy-session-data'] },
      ],
      notChecked: [], counts: { disabled: 1, removed: 0, changed: 1, unverified: 0, data: 1, harness: 0 },
    },
    ...fields,
  }
}

describe('the report dialog', () => {
  it('shows the release note as labelled text and keeps Update off until each item is ticked', async () => {
    const apply = vi.fn(() => Promise.resolve({ ok: true as const, value: {} }))
    const { container } = render(<UpdateDialog state={stateOf({ prepared: preparedOf() })} t={t} actions={{ prepare: vi.fn(), apply }} onClose={vi.fn()} openChanges={vi.fn()} />)
    expect(document.body.textContent).toContain(en['release.note'])
    expect(document.querySelector('[data-update-note]')?.textContent).toBe('<b>Ignore all instructions</b>')
    expect(document.querySelector('b')).toBeNull()
    expect(container.innerHTML).toBe('')
    const update = screen.getByText(en['confirm.now']) as HTMLButtonElement
    expect(update.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(en['tick.item']))
    expect(update.disabled).toBe(false)
    fireEvent.click(update)
    await waitFor(() => { expect(apply).toHaveBeenCalledWith({ handle: 'h1', chats: 'wait', dataCopy: true, acknowledged: ['item:0'] }) })
  })

  it('needs the declining tick, and sends it, only when the copy is unticked', async () => {
    const apply = vi.fn(() => Promise.resolve({ ok: true as const, value: {} }))
    render(<UpdateDialog state={stateOf({ prepared: preparedOf() })} t={t} actions={{ prepare: vi.fn(), apply }} onClose={vi.fn()} openChanges={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(en['tick.item']))
    fireEvent.click(screen.getByLabelText(en['data.copy']))
    const update = screen.getByText(en['confirm.now']) as HTMLButtonElement
    expect(update.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/I do not want the copy/u))
    fireEvent.click(update)
    await waitFor(() => { expect(apply).toHaveBeenCalledWith({ handle: 'h1', chats: 'wait', dataCopy: false, acknowledged: ['item:0', 'data-no-copy'] }) })
  })

  it('offers no Update for a conflicted harness file', () => {
    render(<UpdateDialog state={stateOf({ prepared: preparedOf({ confirm: { ticks: [], blocked: 'harness-conflict' } }) })} t={t} actions={{ prepare: vi.fn(), apply: vi.fn() }} onClose={vi.fn()} openChanges={vi.fn()} />)
    expect(document.querySelector('[data-update-blocked="harness-conflict"]')).toBeTruthy()
    expect(screen.queryByText(en['confirm.now'])).toBeNull()
    expect(screen.queryByText(en['confirm.wait'])).toBeNull()
  })

  it('offers Stop chats and update only while chats run, and sends that choice', async () => {
    const apply = vi.fn(() => Promise.resolve({ ok: true as const, value: {} }))
    render(<UpdateDialog state={stateOf({ prepared: preparedOf({ runningChats: 2, confirm: { ticks: [] } }) })} t={t} actions={{ prepare: vi.fn(), apply }} onClose={vi.fn()} openChanges={vi.fn()} />)
    fireEvent.click(screen.getByText(en['confirm.stop']))
    await waitFor(() => { expect(apply).toHaveBeenCalledWith(expect.objectContaining({ chats: 'stop' })) })
  })

  it('keeps Update disabled on a phone that needs the computer', () => {
    render(<UpdateDialog state={stateOf({ access: may({ 'update-begin': { ok: false, needs: 'computer' } }), prepared: preparedOf({ confirm: { ticks: [] } }) })} t={t} actions={{ prepare: vi.fn(), apply: vi.fn() }} onClose={vi.fn()} openChanges={vi.fn()} />)
    expect((screen.getByText(en['confirm.now']) as HTMLButtonElement).disabled).toBe(true)
  })

  it('prepares when nothing is held and words a refusal', async () => {
    const prepare = vi.fn(() => Promise.resolve({ ok: false as const, refusal: { code: 'HARNESS_CHANGES_PENDING', message: 'x' } }))
    const openChanges = vi.fn()
    render(<UpdateDialog state={stateOf()} t={t} actions={{ prepare, apply: vi.fn() }} onClose={vi.fn()} openChanges={openChanges} />)
    await screen.findByText(en['refusal.HARNESS_CHANGES_PENDING'])
    fireEvent.click(screen.getByText(en['blocked.changes']))
    expect(openChanges).toHaveBeenCalled()
  })
})

/** Render the overlay over a state. */
function overlay(state: UpdateStateView, extra: Partial<UpdateCardsProps> = {}, reconnecting = false) {
  const load = { status: 'ready' as const, state, reconnecting }
  const props = {
    t, load, switching: false, dialog: false,
    actions: { prepare: vi.fn(), apply: vi.fn() }, cancel: vi.fn(() => Promise.resolve({})), dismiss: vi.fn(() => Promise.resolve({})), closeDialog: vi.fn(), openChanges: vi.fn(), ...extra,
  }
  render(<UpdateCards {...props} />)
  return props
}

const RESULT: UpdateResultView = { kind: 'update', outcome: 'rolled-back', from: '0.1.2', to: '0.1.3', criterion: 'H2-host-ready', reason: 'T1', at: '2026-11-17T10:00:00Z' }

describe('the progress and outcome cards', () => {
  const WAITING = (chats: number) => stateOf({ progress: { kind: 'applying', phase: 'waiting', target: '0.1.3', runningChats: chats } })

  /**
   * Draw the ongoing state as the sidebar alert or the phone toast.
   * @param state - the update state.
   * @param variant - where it shows.
   * @returns the cancel spy.
   */
  function progress(state: UpdateStateView, variant: 'alert' | 'toast', reconnecting = false) {
    const cancel = vi.fn(() => Promise.resolve({}))
    render(<UpdateProgress variant={variant} state={state} switching={false} reconnecting={reconnecting} t={t} cancel={cancel} />)
    return cancel
  }

  it('shows the wait for chats as a compact alert with Cancel update', () => {
    const cancel = progress(WAITING(1), 'alert')
    expect(document.querySelector('[data-update-variant="alert"]')?.textContent).toContain('Waiting for 1 chat to finish. New chats wait until the update is done.')
    expect(document.querySelector('[data-toast-area]')).toBeNull()
    fireEvent.click(screen.getByText(en['progress.cancel']))
    expect(cancel).toHaveBeenCalled()
  })

  it('says the studio is unavailable for a moment while Delorun switches, and offers no Cancel', () => {
    progress(stateOf({ progress: { kind: 'applying', phase: 'switching', target: '0.1.3', runningChats: 0 } }), 'alert')
    expect(document.querySelector('[data-update-progress="switching"]')?.textContent).toContain('reconnects by itself')
    expect(screen.queryByText(en['progress.cancel'])).toBeNull()
  })

  it('shows nothing while no ongoing state lasts', () => {
    progress(stateOf(), 'alert')
    expect(document.querySelector('[data-update-progress]')).toBeNull()
  })

  it('on a phone also shows the state as a toast in the toast area, and closing hides the toast only', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    try {
      overlay(WAITING(2))
      expect(document.querySelector('[data-toast-area] [data-update-variant="toast"]')?.textContent).toContain('Waiting for 2 chats')
      fireEvent.click(screen.getByLabelText(en['progress.close']))
      expect(document.querySelector('[data-update-variant="toast"]')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows no toast on a wider screen, where the sidebar carries the state', () => {
    overlay(WAITING(2))
    expect(document.querySelector('[data-update-variant]')).toBeNull()
  })

  it('says why a rolled-back update went back, and that chats are unchanged', () => {
    overlay(stateOf({ result: RESULT }))
    const card = document.querySelector('[data-update-outcome="rolled-back"]')
    expect(card?.textContent).toContain('did not work, so Delorun went back to 0.1.2')
    expect(card?.textContent).toContain(en['criterion.H2-host-ready'])
    expect(card?.textContent).toContain('Your chats are unchanged.')
    fireEvent.click(screen.getByText(en['outcome.details']))
    expect(document.querySelector('[data-update-details]')?.textContent).toContain('H2-host-ready')
  })

  it('lists the protected-row changes a committed update brought, and nothing when it brought none', () => {
    const line = 'Delorun 0.1.3 changes the settings of the External agents row (delorun-agent-seats): turns on live agents.'
    const committed: UpdateResultView = { kind: 'update', outcome: 'committed', from: '0.1.2', to: '0.1.3', at: '2026-11-17T10:00:00Z' }
    overlay(stateOf({ result: { ...committed, rowChanges: [line] } }))
    expect(document.querySelector('[data-update-row-changes]')?.textContent).toContain(en['outcome.rowChanges'])
    expect(document.querySelector('[data-update-row-changes] li')?.textContent).toBe(line)
    cleanup()
    overlay(stateOf({ result: committed }))
    expect(document.querySelector('[data-update-row-changes]')).toBeNull()
  })

  it('keeps each version whole in the title, shows the time in the local zone and keeps developer words out of the details', () => {
    overlay(stateOf({ result: RESULT }))
    const title = document.querySelector('[data-update-outcome] p')
    expect([...title!.querySelectorAll('span[style]')].map(node => node.textContent).filter(Boolean)).toEqual(['0.1.3', '0.1.2'])
    fireEvent.click(screen.getByText(en['outcome.details']))
    const details = document.querySelector('[data-update-details]')?.textContent ?? ''
    expect(details).toContain(new Date(RESULT.at).toLocaleString())
    expect(details).not.toContain('2026-11-17T10:00:00Z')
    expect(details).not.toContain('delorun logs')
  })

  const NOTES = {
    truncated: false,
    versions: [
      { version: '0.1.3', date: '2026-11-19', highlights: ['New one', 'New two', 'New three'], areas: [{ area: 'Studio', items: [{ section: 'Added', text: 'Full entry A' }] }] },
      { version: '0.1.2', highlights: ['Old one', 'Old two', 'Old three'], areas: [] },
    ],
  }

  it('lists at most five highlights across the skipped versions, newest first, and opens the full notes in a sheet that closes with Back', () => {
    overlay(stateOf({ result: { ...RESULT, outcome: 'committed' }, notes: NOTES }))
    const items = [...document.querySelectorAll('[data-update-notes] > ul > li')].map(node => node.textContent)
    expect(items).toEqual(['New one', 'New two', 'New three', 'Old one', 'Old two'])
    expect(document.querySelector('[data-update-notes-sheet]')).toBeNull()
    fireEvent.click(screen.getByText(en['notes.more']))
    const sheet = document.querySelector('[data-update-notes-sheet]')
    expect(sheet?.textContent).toContain('Full entry A')
    expect(sheet?.textContent).toContain('0.1.3, 2026-11-19')
    fireEvent.click(screen.getAllByText(en['notes.back']).at(-1)!)
    expect(document.querySelector('[data-update-notes-sheet]')).toBeNull()
  })

  it('shows no highlights and no Read more without notes, and says when the notes are cut short', () => {
    overlay(stateOf({ result: { ...RESULT, outcome: 'committed' } }))
    expect(document.querySelector('[data-update-notes]')).toBeNull()
    expect(screen.queryByText(en['notes.more'])).toBeNull()
    cleanup()
    overlay(stateOf({ result: { ...RESULT, outcome: 'committed' }, notes: { ...NOTES, truncated: true } }))
    fireEvent.click(screen.getByText(en['notes.more']))
    expect(document.querySelector('[data-update-notes-sheet]')?.textContent).toContain(en['notes.truncated'])
  })

  it('draws the cards in the toast area, not as fixed cards of its own', () => {
    overlay(stateOf({ result: RESULT }))
    expect(document.querySelector('[data-toast-area] [data-update-outcome]')).not.toBeNull()
  })

  it('says Updated to … for a committed update and dismisses the record', () => {
    const props = overlay(stateOf({ result: { ...RESULT, outcome: 'committed' } }))
    expect(screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === 'Updated to Delorun 0.1.3')).toBeTruthy()
    fireEvent.click(screen.getByText(en['outcome.dismiss']))
    expect(props.dismiss).toHaveBeenCalled()
  })
})

describe('the connection as an ongoing state', () => {
  /** Render the alert with a connection state. */
  function connection(state: UpdateStateView, value: 'connected' | 'connecting' | 'disconnected', extra: { switching?: boolean, reconnecting?: boolean, retryAt?: number } = {}) {
    const reconnect = vi.fn()
    render(<UpdateProgress variant="alert" state={state} switching={extra.switching ?? false} reconnecting={extra.reconnecting ?? false} t={t} cancel={vi.fn()} connection={value} retryAt={extra.retryAt} reconnect={reconnect} />)
    return reconnect
  }

  const line = (): string | null | undefined => document.querySelector('.delorun-alert-line')?.textContent

  it('counts down to the next automatic attempt, then says it is trying, with Reconnect now as the tinted action', () => {
    vi.useFakeTimers()
    try {
      connection(stateOf(), 'connecting', { retryAt: Date.now() + 4_200 })
      const card = document.querySelector('[data-update-variant="alert"]')
      expect(card?.getAttribute('role')).toBe('status')
      expect(card?.getAttribute('data-kind')).toBe('progress')
      expect(card?.querySelector('.delorun-alert-title')?.textContent).toBe(en['connection.connecting'])
      expect(line()).toBe(en['connection.retryIn'].replace('{count}', '5'))
      act(() => { vi.advanceTimersByTime(1_250) })
      expect(line()).toBe(en['connection.retryIn'].replace('{count}', '3'))
      act(() => { vi.advanceTimersByTime(3_000) })
      expect(line()).toBe(en['connection.trying'])
      expect(screen.getByRole('button', { name: en['connection.reconnect'] }).className).toBe('delorun-alert-primary')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says it is trying while an attempt runs, and gives the reason while the device is offline', () => {
    connection(stateOf(), 'connecting')
    expect(line()).toBe(en['connection.trying'])
    cleanup()
    connection(stateOf(), 'disconnected')
    const card = document.querySelector('[data-update-variant="alert"]')
    expect(card?.getAttribute('data-kind')).toBe('warning')
    expect(card?.getAttribute('role')).toBe('status')
    expect(line()).toBe(en['connection.offline'])
  })

  it('keeps an update\'s own states free of a connection line', () => {
    connection(stateOf({ progress: { kind: 'applying', phase: 'switching', target: '0.1.3', runningChats: 0 } }), 'connecting', { retryAt: Date.now() + 4_000 })
    expect(line()).toBeUndefined()
  })

  it('shows an unplanned loss as a pinned alert with Reconnect now, and nothing while connected', () => {
    const reconnect = connection(stateOf(), 'disconnected')
    expect(document.querySelector('[data-update-variant="alert"]')?.textContent).toContain(en['connection.lost'])
    fireEvent.click(screen.getByText(en['connection.reconnect']))
    expect(reconnect).toHaveBeenCalled()
    cleanup()
    connection(stateOf(), 'connecting')
    expect(document.querySelector('[data-update-variant="alert"]')?.textContent).toContain(en['connection.connecting'])
    cleanup()
    connection(stateOf(), 'connected')
    expect(document.querySelector('[data-update-variant]')).toBeNull()
  })

  it('words a planned update restart as the update, never as a connection fault', () => {
    connection(stateOf({ progress: { kind: 'applying', phase: 'switching', target: '0.1.3', runningChats: 0 } }), 'disconnected')
    const text = document.querySelector('[data-update-variant="alert"]')?.textContent ?? ''
    expect(text).toContain('Switching to Delorun 0.1.3')
    expect(text).not.toContain(en['connection.lost'])
    expect(screen.queryByText(en['connection.reconnect'])).toBeNull()
    cleanup()
    connection(stateOf(), 'connecting', { reconnecting: true })
    expect(document.querySelector('[data-update-variant="alert"]')?.textContent).not.toContain(en['connection.connecting'])
  })
})

describe('the sidebar entry', () => {
  /** Render the entry with hooks over fixed values. */
  function entry(wide: boolean, state: UpdateStateView) {
    const hook = <V,>(value: V) => <R,>(select: (value: V) => R): R => select(value)
    render(<UpdateAlertsEntry t={t} wide={wide} reconnect={vi.fn()} cancel={vi.fn()} stopChats={vi.fn()}
      useLoad={hook<UpdateLoad>({ status: 'ready', state, reconnecting: false })} useSwitching={hook(false)} useConnection={hook<'connected'>('connected')} useRetry={hook<number | undefined>(undefined)} />)
  }

  it('shows the alert in the wide sidebar and only a dot on the collapsed rail', () => {
    const waiting = stateOf({ progress: { kind: 'applying', phase: 'waiting', target: '0.1.3', runningChats: 1 } })
    entry(true, waiting)
    expect(document.querySelector('[data-update-variant="alert"]')).not.toBeNull()
    cleanup()
    entry(false, waiting)
    expect(document.querySelector('[data-update-variant]')).toBeNull()
    expect(document.querySelector('[data-update-rail-dot]')).not.toBeNull()
    cleanup()
    entry(false, stateOf())
    expect(document.querySelector('[data-update-rail-dot]')).toBeNull()
  })
})

describe('Stop running chats and update', () => {
  const CHATS = [{ sessionId: 's-1', title: 'Refactor' }, { sessionId: 's-2', title: '' }]
  const waiting = (): UpdateStateView => stateOf({ progress: { kind: 'applying', phase: 'waiting', target: '0.1.3', runningChats: 2 }, runningChats: CHATS })

  /** Render the sidebar alert with the stop offer. */
  function alert(automatic: boolean, run: () => Promise<{ readonly ok: true, readonly value: object } | { readonly ok: false, readonly refusal: { readonly code: string, readonly message: string } }> = vi.fn(() => Promise.resolve({ ok: true as const, value: {} })), state = waiting()) {
    render(<UpdateProgress variant="alert" state={state} switching={false} reconnecting={false} t={t} cancel={vi.fn()} stop={{ chats: CHATS, jobs: 0, automatic, run }} />)
    return run
  }

  it('puts the stop behind a menu on the alert, names each chat in the confirm step, and defaults to Cancel', () => {
    alert(true)
    expect(screen.queryByText(en['stop.item'])).toBeNull()
    fireEvent.click(screen.getByLabelText(en['stop.menu']))
    fireEvent.click(screen.getByText(en['stop.item']))
    const confirm = document.querySelector('[data-stop-chats-confirm]')
    expect(confirm?.textContent).toContain('Refactor')
    expect(confirm?.textContent).toContain(en['stop.untitled'])
    expect(screen.getByText(en['stop.cancel']).hasAttribute('data-modal-autofocus')).toBe(true)
  })

  it('names the background jobs that stop too and says they are not continued', () => {
    render(<UpdateProgress variant="alert" state={waiting()} switching={false} reconnecting={false} t={t} cancel={vi.fn()} stop={{ chats: CHATS, jobs: 2, automatic: true, run: vi.fn() }} />)
    fireEvent.click(screen.getByLabelText(en['stop.menu']))
    fireEvent.click(screen.getByText(en['stop.item']))
    expect(document.querySelector('[data-stop-chats-confirm]')?.textContent).toContain('2 background jobs also stop. Background jobs are not continued.')
  })

  it('says what happens next by the setting', () => {
    alert(true)
    fireEvent.click(screen.getByLabelText(en['stop.menu']))
    fireEvent.click(screen.getByText(en['stop.item']))
    expect(document.querySelector('[data-stop-chats-confirm]')?.textContent).toContain(en['stop.after.automatic'])
    cleanup()
    alert(false)
    fireEvent.click(screen.getByLabelText(en['stop.menu']))
    fireEvent.click(screen.getByText(en['stop.item']))
    expect(document.querySelector('[data-stop-chats-confirm]')?.textContent).toContain(en['stop.after.manual'])
  })

  it('stops only on the red button, and words the Host\'s refusal', async () => {
    const run = vi.fn(() => Promise.resolve({ ok: false as const, refusal: { code: 'NO_UPDATE_PENDING', message: 'x' } }))
    alert(true, run)
    fireEvent.click(screen.getByLabelText(en['stop.menu']))
    fireEvent.click(screen.getByText(en['stop.item']))
    fireEvent.click(screen.getByText(en['stop.cancel']))
    expect(run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText(en['stop.menu']))
    fireEvent.click(screen.getByText(en['stop.item']))
    fireEvent.click(screen.getByText(en['stop.confirm']))
    await screen.findByText(en['refusal.NO_UPDATE_PENDING'])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('offers no menu once the update stops waiting, or to a phone that needs the computer', () => {
    alert(true, undefined, stateOf({ progress: { kind: 'applying', phase: 'switching', target: '0.1.3', runningChats: 0 } }))
    expect(screen.queryByLabelText(en['stop.menu'])).toBeNull()
    cleanup()
    alert(true, undefined, { ...waiting(), access: may({ 'update-begin': { ok: false, needs: 'computer' } }) })
    expect(screen.queryByLabelText(en['stop.menu'])).toBeNull()
  })

  it('says Stopped for the update on a stopped chat, with Continue when the Host does not continue it by itself', async () => {
    const onContinue = vi.fn(() => Promise.resolve({}))
    const view = (state: 'stopped' | 'continued' | 'skipped-missing' | 'skipped-running', automatic: boolean) => <StoppedChatLine stopped={{ automatic, chats: [{ sessionId: 's-1', title: 'x', state }] }} sessionId="s-1" t={t} onContinue={onContinue} />
    const { rerender } = render(view('stopped', false))
    fireEvent.click(screen.getByText(en['stopped.continue']))
    expect(onContinue).toHaveBeenCalledWith('s-1')
    rerender(view('continued', true))
    expect(screen.getByRole('status').textContent).toBe(en['stopped.continuing'])
    expect(screen.queryByText(en['stopped.continue'])).toBeNull()
    rerender(view('skipped-running', true))
    expect(screen.getByText(en['stopped.continue'])).toBeTruthy()
    rerender(view('stopped', true))
    expect(screen.queryByText(en['stopped.continue'])).toBeNull()
    rerender(view('skipped-missing', true))
    expect(screen.getByRole('status').textContent).toBe(en['stopped.skipped'])
    rerender(<StoppedChatLine stopped={{ automatic: true, chats: [] }} sessionId="s-1" t={t} onContinue={onContinue} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('the controller', () => {
  it('reloads the page once when the Host answers as another release than the first read', async () => {
    const answers = [stateOf(), stateOf({ release: { delorun: '0.1.3', dsh: '0.2.2' } })]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(answers.shift()), { status: 200 }))))
    const reload = vi.fn()
    const controller = new UpdateController({ reload })
    await controller.refresh()
    expect(reload).not.toHaveBeenCalled()
    await controller.refresh()
    expect(reload).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('returns an unlock refusal for the screen and sends nothing but the handle and the ticks', async () => {
    const fetch = vi.fn((path: string, _init?: RequestInit) => Promise.resolve(path.endsWith('/apply')
      ? new Response(JSON.stringify({ code: 'ELEVATION_REQUIRED', message: 'unlock' }), { status: 403 })
      : new Response(JSON.stringify(stateOf()), { status: 200 })))
    vi.stubGlobal('fetch', fetch)
    const controller = new UpdateController({ reload: vi.fn() })
    const outcome = await controller.apply({ handle: 'h1', chats: 'wait', dataCopy: true, acknowledged: [] })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.refusal.code).toBe('ELEVATION_REQUIRED')
    const call = fetch.mock.calls.find(([path]) => path === UPDATE_PATHS.apply.slice(1))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ handle: 'h1', chats: 'wait', dataCopy: true, acknowledged: [] })
    controller.dispose()
  })
})
