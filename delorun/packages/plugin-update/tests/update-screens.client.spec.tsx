// @vitest-environment jsdom
/** The studio half: the report dialog, the progress and outcome cards, and the controller's reload, against stand-in routes. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReleaseChannel, SemanticVersion, Sha256Hex, UtcTimestamp } from '@delorun/contract-release-manifest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateController } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import { UpdateDialog } from '../src/client/UpdateDialog.tsx'
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
  return { actor: 'computer', phonePowers: 'careful', may: Object.fromEntries(UPDATE_CONTROLS.map(control => [control, replace[control] ?? OK])) as Record<UpdateControl, UpdateMayView> }
}

/** An idle state at the computer. */
function stateOf(fields: Partial<UpdateStateView> = {}): UpdateStateView {
  return { release: { delorun: '0.1.2', dsh: '0.2.2' }, available: true, access: may(), check: { enabled: true }, progress: { kind: 'idle' }, rollback: { available: false }, ...fields }
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
  it('shows the wait for chats with Cancel update', () => {
    const props = overlay(stateOf({ progress: { kind: 'applying', phase: 'waiting', target: '0.1.3', runningChats: 2 } }))
    expect(document.body.textContent).toContain('Waiting for 2 chats')
    fireEvent.click(screen.getByText(en['progress.cancel']))
    expect(props.cancel).toHaveBeenCalled()
  })

  it('says the studio is unavailable for a moment while Delorun switches', () => {
    overlay(stateOf({ progress: { kind: 'applying', phase: 'switching', target: '0.1.3', runningChats: 0 } }))
    expect(document.querySelector('[data-update-progress="switching"]')?.textContent).toContain('reconnects by itself')
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

  it('says Updated to … for a committed update and dismisses the record', () => {
    const props = overlay(stateOf({ result: { ...RESULT, outcome: 'committed' } }))
    expect(screen.getByText('Updated to Delorun 0.1.3')).toBeTruthy()
    fireEvent.click(screen.getByText(en['outcome.dismiss']))
    expect(props.dismiss).toHaveBeenCalled()
  })
})

describe('the controller', () => {
  it('reloads the page once when the Host answers as another release than the first read', async () => {
    const answers = [stateOf(), stateOf({ release: { delorun: '0.1.3', dsh: '0.2.2' } })]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(answers.shift()), { status: 200 }))))
    const reload = vi.fn()
    const controller = new UpdateController({ unlockNeeded: vi.fn(), reload })
    await controller.refresh()
    expect(reload).not.toHaveBeenCalled()
    await controller.refresh()
    expect(reload).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('opens the unlock dialog for an unlock refusal and sends nothing but the handle and the ticks', async () => {
    const fetch = vi.fn((path: string, _init?: RequestInit) => Promise.resolve(path.endsWith('/apply')
      ? new Response(JSON.stringify({ code: 'ELEVATION_REQUIRED', message: 'unlock' }), { status: 403 })
      : new Response(JSON.stringify(stateOf()), { status: 200 })))
    vi.stubGlobal('fetch', fetch)
    const unlockNeeded = vi.fn()
    const controller = new UpdateController({ unlockNeeded, reload: vi.fn() })
    const outcome = await controller.apply({ handle: 'h1', chats: 'wait', dataCopy: true, acknowledged: [] })
    expect(outcome.ok).toBe(false)
    expect(unlockNeeded).toHaveBeenCalledWith('update-begin')
    const call = fetch.mock.calls.find(([path]) => path === UPDATE_PATHS.apply.slice(1))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ handle: 'h1', chats: 'wait', dataCopy: true, acknowledged: [] })
    controller.dispose()
  })
})
