// @vitest-environment jsdom
/**
 * The shared strong-action sheet (A498): one dialog for the sheet and the keypad, the action's glyph by the title, the
 * context list rendered from the request, and no control with focus on open.
 *
 * Each test's comment names the behaviour whose removal makes it fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ICON_SYMBOLS } from '@deepseek-ai/dsh-client-ui-primitives'
import { ANSWER_ICON, CHANGE_ICON, COPY_ICON } from '../src/client/face-id-icon-keys.ts'
import { FaceIdIcon } from '../src/client/face-id-icons.tsx'
import { en } from '../src/client/face-id-locales.ts'
import { fakeApi, fakeBrowser } from '../src/client/face-id-fake.ts'
import type { FaceIdAction } from '../src/client/face-id-types.ts'
import { FaceIdGrantFlow } from '../src/client/FaceIdGrantFlow.tsx'
import { callActionOf } from '../src/client/FaceIdGrantOverlay.tsx'

const t = makeTranslate(en)
const terminal: FaceIdAction = {
  grant: { actions: [{ action: 'terminal/create', hash: 'h', hold: { feature: 'terminal', id: 't1' } }] },
  title: 'Open a terminal',
  body: 'Commands you type there run on your computer, as you.',
  icon: 'terminal',
  context: { workspace: 'delorun', chat: 'Fix the tests' },
}
const install: FaceIdAction = { grant: { actions: [{ action: 'plugin-packs/add', hash: 'h' }] }, title: 'Install a plugin', body: 'It runs on your computer.' }

afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal') })

function flow(over: Partial<Parameters<typeof FaceIdGrantFlow>[0]> = {}) {
  const props = { t, action: terminal, kind: 'faceId' as const, api: fakeApi(), browser: fakeBrowser(), hasPasskey: true, secret: 'pin' as const,
    onGranted: vi.fn(), onCancel: vi.fn(), ...over }
  render(<FaceIdGrantFlow {...props} />)
  return props
}

describe('the shared action sheet', () => {
  // Moving focus to Confirm on open drew the blue ring the owner called ugly (A498).
  it('leaves focus on the dialog itself when it opens, not on a button', () => {
    flow()
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)
    expect(dialog.getAttribute('tabindex')).toBe('-1')
  })

  // The list is built from the request's own context; reverting it to a fixed layout loses the names or invents them.
  it('lists the workspace and chat the request names, what it allows and how long it lasts', () => {
    flow()
    const rows = [...document.querySelectorAll('dl > div')].map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
    expect(rows).toEqual([
      ['Workspace', 'delorun'],
      ['Chat', 'Fix the tests'],
      ['Allows', 'Commands you type there run on your computer, as you.'],
      ['Lasts', 'The terminal stays open until it has been unused for 5 minutes.'],
    ])
  })

  // A request that names no workspace or chat shows no row for them rather than an empty or invented one.
  it('shows only the rows it knows, and "Just this once" for an action with no hold', () => {
    flow({ action: install })
    expect([...document.querySelectorAll('dl dt')].map(row => row.textContent)).toEqual(['Allows', 'Lasts'])
    expect(document.querySelector('dl')?.textContent).toContain('Just this once')
  })

  // The glyph comes from the action's own key; the plain shield stands in when the request has none.
  it('draws the action\'s glyph by the title, and the shield when the action has none', () => {
    flow()
    expect(document.querySelector('header [data-icon]')?.getAttribute('data-icon')).toBe('dsw-icon-api-outline-medium')
    cleanup()
    flow({ action: install })
    expect(document.querySelector('header [data-icon]')?.getAttribute('data-icon')).toBe('dsw-icon-shield-outline-medium')
  })

  // A glyph key with no sprite symbol would draw an empty box by the title.
  it('draws every glyph key from a symbol of the product sprite', () => {
    for (const key of new Set([...Object.values(COPY_ICON), ...Object.values(CHANGE_ICON), ...Object.values(ANSWER_ICON)])) {
      const { container } = render(<FaceIdIcon icon={key} />)
      expect(Object.keys(ICON_SYMBOLS), key).toContain(container.querySelector('svg')?.getAttribute('data-icon'))
      cleanup()
    }
  })

  // The Face ID glyph sits in the primary button, not floating above it.
  it('puts the Face ID glyph inside the Confirm button', () => {
    flow()
    const confirm = screen.getByRole('button', { name: 'Confirm with Face ID' })
    expect(confirm.querySelector('svg')).not.toBeNull()
    expect(document.querySelector('[class*="glyph"]')).toBeNull()
  })

  // Opening the keypad in a second dialog would re-open the modal and drop the slide.
  it('slides the keypad in within the same dialog and back on Escape', async () => {
    const opened: HTMLDialogElement[] = []
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { opened.push(this); this.setAttribute('open', '') } })
    flow({ browser: fakeBrowser({ available: false }) })
    const dialog = screen.getByRole('dialog')
    expect(dialog.hasAttribute('data-face-id-sheet')).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with PIN' }))
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(dialog.hasAttribute('data-face-id-pin')).toBe(true)
    expect(screen.getByRole('button', { name: '1' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog.hasAttribute('data-face-id-sheet')).toBe(true)
    expect(screen.queryByRole('button', { name: '1' })).toBeNull()
    expect(opened).toEqual([dialog])
  })

  // A keypad that keeps its digits on the way back would show an old PIN to the next person to open it.
  it('empties the keypad each time it opens', async () => {
    flow({ browser: fakeBrowser({ available: false }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with PIN' }))
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    expect((document.querySelector('input[name="delorun-grant-pin"]') as HTMLInputElement | null)?.value).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with PIN' }))
    expect((document.querySelector('input[name="delorun-grant-pin"]') as HTMLInputElement | null)?.value).toBe('')
  })

  // Cancel is a plain button now; a link style would leave it underlined (A498).
  it('ends the confirmation from a Cancel button', () => {
    const props = flow()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  // "Lasts" is how long the Face ID holds; without its own row, full access would read as "Just this once" and mislead.
  it('names the state an action leaves in an Afterwards row, and none for a terminal', async () => {
    const full = await callActionOf(t, { action: 'plugin-permission-defaults/set-full-access', call: { method: 'POST', path: '/api/full-access', body: { workspace: '/home/user/delorun', on: true } } })
    expect(full.stays).toBe('Full access stays on for delorun until you turn it off.')
    const off = await callActionOf(t, { action: 'plugin-permission-defaults/set-full-access', call: { method: 'POST', path: '/api/full-access', body: { workspace: '/home/user/delorun', on: false } } })
    expect(off.stays).toBe('Full access stays off for delorun until you turn it on.')
    expect((await callActionOf(t, { action: 'plugin-packs/add', call: { method: 'POST', path: '/api/p', body: {} } })).stays).toBe('The plugin stays installed until you remove it.')
    expect((await callActionOf(t, { action: 'changes/update-begin', call: { method: 'POST', path: '/api/c', body: {} } })).stays).toBe('Delorun stays on the new release until you go back.')
    expect((await callActionOf(t, { action: 'terminal/create', call: { args: { request: { id: 't' } } } })).stays).toBeUndefined()
    flow({ action: full })
    const rows = [...document.querySelectorAll('dl > div')].map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent])
    expect(rows.slice(-2)).toEqual([['Lasts', 'Just this once'], ['Afterwards', 'Full access stays on for delorun until you turn it off.']])
    cleanup()
    flow()
    expect([...document.querySelectorAll('dl dt')].map(row => row.textContent)).not.toContain('Afterwards')
  })

  // A phone with no passkey has no sheet to confirm on; its keypad carries the one-line context instead.
  it('opens a phone with no passkey on the keypad with one context line, and Back ends the confirmation', () => {
    const props = flow({ hasPasskey: false })
    const dialog = screen.getByRole('dialog')
    expect(dialog.hasAttribute('data-face-id-pin')).toBe(true)
    expect(dialog.textContent).toContain('delorun · Fix the tests · The terminal stays open until it has been unused for 5 minutes.')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })
})
