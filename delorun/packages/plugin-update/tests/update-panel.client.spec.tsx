// @vitest-environment jsdom
/** The Updates section: it renders the release, the unavailable note and the continue setting from a form that reads its own state. */
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateLoad } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import { UpdatePanel, type UpdatePanelProps, type UpdateSettings } from '../src/client/UpdatePanel.tsx'
import { UPDATE_CONTROLS, type UpdateControl, type UpdateMayView, type UpdateStateView } from '../src/wire.ts'

afterEach(cleanup)

const OK: UpdateMayView = { ok: true }

/** An idle state at the computer, with the named fields replaced. */
function stateOf(fields: Partial<UpdateStateView> = {}): UpdateStateView {
  const may = Object.fromEntries(UPDATE_CONTROLS.map(control => [control, OK])) as Record<UpdateControl, UpdateMayView>
  return { release: { delorun: '0.1.2', dsh: '0.2.2' }, available: true, access: { actor: 'computer', may }, check: { enabled: false }, progress: { kind: 'idle' }, rollback: { available: false }, continueStopped: true, ...fields }
}

/** A settings form whose methods, like the real one's, read the form they are called on. */
class FormStub {
  private value: UpdateSettings = { continueStoppedChats: true }
  private readonly listeners = new Set<() => void>()
  private snapshot = { status: 'ready', value: this.value, writable: true }

  getSnapshot(): typeof this.snapshot { return this.snapshot }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(field: string, next: unknown): Promise<boolean> {
    this.value = { ...this.value, [field]: next }
    this.snapshot = { ...this.snapshot, value: this.value }
    for (const listener of this.listeners) listener()
    return Promise.resolve(true)
  }
}

/** Render the panel over a ready state and a stand-in form. */
function renderPanel(state: UpdateStateView, form = new FormStub()) {
  const load: UpdateLoad = { status: 'ready', state, reconnecting: false }
  const props = {
    t: makeTranslate(en), useLoad: (select: (value: UpdateLoad) => unknown) => select(load),
    reload: vi.fn(() => Promise.resolve()), check: vi.fn(), openDialog: vi.fn(), rollback: vi.fn(), settings: form,
  } as UpdatePanelProps
  return render(<UpdatePanel {...props} />)
}

describe('the Updates section', () => {
  it('shows the running release, the unavailable note and the continue setting', () => {
    renderPanel(stateOf({ available: false }))
    expect(screen.getByText(en.running.replace('{version}', '0.1.2'))).toBeTruthy()
    expect(document.querySelector('[data-update-unavailable]')?.textContent).toBe(en.unavailable)
    expect(document.querySelector('[data-update-continue-setting]')).not.toBeNull()
  })

  it('writes the continue setting through the form it was given', () => {
    const form = new FormStub()
    const set = vi.spyOn(form, 'set')
    renderPanel(stateOf(), form)
    fireEvent.click(screen.getByLabelText(en['continue.setting']))
    expect(set).toHaveBeenCalledWith('continueStoppedChats', false)
  })
})
