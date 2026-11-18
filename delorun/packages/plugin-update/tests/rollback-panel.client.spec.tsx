// @vitest-environment jsdom
/** The Go back panel: when it shows, what it says about chats, who sees the button, and what it sends. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { RollbackPanel } from '../src/client/RollbackPanel.tsx'
import { UPDATE_CONTROLS, type UpdateControl, type UpdateMayView, type UpdateStateView } from '../src/wire.ts'

afterEach(cleanup)

const t = makeTranslate(en)

/** An idle state on 0.1.3 with a rollback to 0.1.2 on offer; `may` replaces the named controls' decisions. */
function stateOf(fields: Partial<UpdateStateView> = {}, may: Partial<Record<UpdateControl, UpdateMayView>> = {}): UpdateStateView {
  const access: UpdateStateView['access'] = {
    actor: 'computer', phonePowers: 'full',
    may: Object.fromEntries(UPDATE_CONTROLS.map(control => [control, may[control] ?? { ok: true }])) as Record<UpdateControl, UpdateMayView>,
  }
  return { release: { delorun: '0.1.3', dsh: '0.2.2' }, available: true, access, check: { enabled: true }, progress: { kind: 'idle' }, rollback: { available: true, to: '0.1.2' }, ...fields }
}

const granted = () => vi.fn(() => Promise.resolve({ ok: true as const, value: {} }))

describe('the Go back panel', () => {
  it('shows nothing while no committed update names the running release', () => {
    const { container } = render(<RollbackPanel state={stateOf({ rollback: { available: false } })} t={t} rollback={granted()} />)
    expect(container.innerHTML).toBe('')
  })

  it('says chats made since are set aside, asks first, and waits for running chats by default', async () => {
    const rollback = granted()
    render(<RollbackPanel state={stateOf()} t={t} rollback={rollback} />)
    expect(document.body.textContent).toContain('set aside, not deleted')
    expect(document.querySelector('[data-rollback-no-copy]')).toBeNull()
    fireEvent.click(screen.getByText(en['rollback.button']))
    expect(rollback).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(en['rollback.confirm']))
    await waitFor(() => { expect(rollback).toHaveBeenCalledWith({ chats: 'wait', profileOnly: false }) })
  })

  it('sends stop when the person ticks stopping the chats', async () => {
    const rollback = granted()
    render(<RollbackPanel state={stateOf()} t={t} rollback={rollback} />)
    fireEvent.click(screen.getByText(en['rollback.button']))
    fireEvent.click(screen.getByLabelText(en['rollback.chats.stop']))
    fireEvent.click(screen.getByText(en['rollback.confirm']))
    await waitFor(() => { expect(rollback).toHaveBeenCalledWith({ chats: 'stop', profileOnly: false }) })
  })

  it('offers only the settings when no copy of the chats exists, and sends profileOnly', async () => {
    const rollback = granted()
    render(<RollbackPanel state={stateOf({ rollback: { available: true, to: '0.1.2', dataCopyMissing: true } })} t={t} rollback={rollback} />)
    expect(document.querySelector('[data-rollback-no-copy]')?.textContent).toBe(en['rollback.noCopy'])
    expect(screen.queryByText(en['rollback.button'])).toBeNull()
    fireEvent.click(screen.getByText(en['rollback.buttonSettings']))
    fireEvent.click(screen.getByText(en['rollback.confirmSettings']))
    await waitFor(() => { expect(rollback).toHaveBeenCalledWith({ chats: 'wait', profileOnly: true }) })
  })

  it('update-rollback-refused-careful-phone: a phone that needs the computer gets the sentence and no button', () => {
    const rollback = granted()
    render(<RollbackPanel state={stateOf({}, { 'update-rollback': { ok: false, needs: 'computer' } })} t={t} rollback={rollback} />)
    expect(screen.getByText(en['needs.computer'])).toBeTruthy()
    expect(screen.queryByText(en['rollback.button'])).toBeNull()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('update-rollback-refused-phone-without-unlock: the button stays, and the Host\'s refusal is worded in the dialog', async () => {
    const rollback = vi.fn(() => Promise.resolve({ ok: false as const, refusal: { code: 'ELEVATION_REQUIRED', message: 'unlock first' } }))
    render(<RollbackPanel state={stateOf({}, { 'update-rollback': { ok: false, needs: 'unlock' } })} t={t} rollback={rollback} />)
    fireEvent.click(screen.getByText(en['rollback.button']))
    fireEvent.click(screen.getByText(en['rollback.confirm']))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['refusal.ELEVATION_REQUIRED']) })
  })

  it('keeps the dialog open and words the home process\'s refusal, then offers it again', async () => {
    const rollback = vi.fn(() => Promise.resolve({ ok: false as const, refusal: { code: 'CHATS_RUNNING', message: 'chats' } }))
    render(<RollbackPanel state={stateOf()} t={t} rollback={rollback} />)
    fireEvent.click(screen.getByText(en['rollback.button']))
    fireEvent.click(screen.getByText(en['rollback.confirm']))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['refusal.CHATS_RUNNING']) })
    expect(screen.getByText(en['rollback.confirm'])).toBeTruthy()
  })

  it('disables the button while an update or a rollback runs', () => {
    render(<RollbackPanel state={stateOf({ progress: { kind: 'rolling-back', phase: 'waiting', target: '0.1.2', runningChats: 1 } })} t={t} rollback={granted()} />)
    expect((screen.getByText(en['rollback.button']) as HTMLButtonElement).disabled).toBe(true)
  })

  it('has every word in Chinese too', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
