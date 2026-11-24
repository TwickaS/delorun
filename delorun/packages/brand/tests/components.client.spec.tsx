// @vitest-environment jsdom
/** The Delorun components render upstream's behaviour with Delorun's variants, roles and names. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, Card, ConfirmAction, Dialog, Keypad, Link, Mark, Notice, OutcomePanel, PinDots, Pill, SecretPair, StatusCard, TextField } from '../src/index.ts'

afterEach(cleanup)

const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-icon="" {...props} />

describe('Button', () => {
  it('is a native button of the chosen variant that passes clicks and the disabled state through', () => {
    const onClick = vi.fn()
    const { rerender } = render(<Button variant="primary" onClick={onClick}>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button.dataset.variant).toBe('primary')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
    rerender(<Button variant="destructive" disabled>Delete</Button>)
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('when unavailable stays focusable, is marked aria-disabled, keeps its description and ignores presses', () => {
    const onClick = vi.fn()
    render(<><Button unavailable aria-describedby="note" onClick={onClick}>Download for macOS</Button><p id="note">Not available yet</p></>)
    const button = screen.getByRole('button', { name: 'Download for macOS' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-describedby')).toBe('note')
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('when unavailable does not submit its form', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => { event.preventDefault() })
    render(<form onSubmit={onSubmit}><input aria-label="Email" /><Button type="submit" unavailable>Sign up</Button></form>)
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('TextField', () => {
  it('names the input by its label, describes it with the help, and replaces the help with an announced error', () => {
    const { rerender } = render(<TextField label="Name" help="Shown in the sidebar" />)
    const input = screen.getByLabelText('Name')
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('Shown in the sidebar').id)
    expect(input.getAttribute('aria-invalid')).toBeNull()
    rerender(<TextField label="Name" help="Shown in the sidebar" error="Too long" />)
    expect(screen.getByRole('alert').textContent).toBe('Too long')
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true')
    expect(screen.queryByText('Shown in the sidebar')).toBeNull()
  })
})

describe('Card, Link and Mark', () => {
  it('names a card by its heading and leaves an untitled card unlabelled', () => {
    const { rerender } = render(<Card title="Colours">x</Card>)
    expect(screen.getByRole('region', { name: 'Colours' })).toBeTruthy()
    rerender(<Card>x</Card>)
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('draws a link as an anchor and the mark hidden unless it has a title', () => {
    render(<><Link href="/docs">Docs</Link><Mark title="Delorun" /><Mark /></>)
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe('/docs')
    expect(screen.getByRole('img', { name: 'Delorun' })).toBeTruthy()
    expect(document.querySelectorAll('[data-delorun-mark][aria-hidden="true"]')).toHaveLength(1)
  })
})

describe('Notice, OutcomePanel and StatusCard', () => {
  it('announces a notice with its tone, title, sentence and actions', () => {
    render(<Notice tone="error" role="alert" Icon={Icon} title="Paused" outcome="paused" actions={<button type="button">Retry</button>}>Try again later.</Notice>)
    const notice = screen.getByRole('alert')
    expect(notice.dataset.tone).toBe('error')
    expect(notice.dataset.outcome).toBe('paused')
    expect(screen.getByText('Paused').tagName).toBe('STRONG')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('shows an outcome as a heading with its sentence, and a status row with its pill', () => {
    render(<><OutcomePanel Icon={Icon} tone="warning" title="Cannot reach home">Check the address.</OutcomePanel><StatusCard Icon={Icon} on title="PIN mode" detail="On" pill="On" /></>)
    expect(screen.getByRole('heading', { name: 'Cannot reach home' })).toBeTruthy()
    expect(screen.getByRole('status', { name: '' }) ).toBeTruthy()
    expect(screen.getByText('PIN mode')).toBeTruthy()
  })
})

describe('PinDots and Keypad', () => {
  it('keeps at least the minimum slots, fills one per character and carries no value', () => {
    const { container, rerender } = render(<PinDots count={2} minimum={6} />)
    const dots = container.firstElementChild as HTMLElement
    expect(dots.children).toHaveLength(6)
    expect(dots.getAttribute('aria-hidden')).toBe('true')
    expect(dots.textContent).toBe('')
    rerender(<PinDots count={8} minimum={6} tone="error" shake />)
    expect((container.firstElementChild as HTMLElement).children).toHaveLength(8)
    expect((container.firstElementChild as HTMLElement).dataset.shake).toBe('')
  })

  it('reports a digit or delete per key and names delete', () => {
    const onKey = vi.fn()
    render(<Keypad onKey={onKey} deleteLabel="Delete" />)
    fireEvent.click(screen.getByRole('button', { name: '7' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onKey.mock.calls).toEqual([['7'], ['⌫']])
  })
})

describe('Pill, ConfirmAction and Dialog', () => {
  it('is a button when clickable and a static capsule when not', () => {
    const { rerender } = render(<Pill tone="accent">On</Pill>)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<Pill onClick={() => {}}>On</Pill>)
    expect(screen.getByRole('button', { name: 'On' })).toBeTruthy()
  })

  it('asks once before running a destructive action', () => {
    const onConfirm = vi.fn()
    const props = { onAsk: vi.fn(), onConfirm, onCancel: vi.fn(), label: 'Remove', question: 'Remove it?', yes: 'Yes', no: 'No' }
    const { rerender } = render(<ConfirmAction confirming={false} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(props.onAsk).toHaveBeenCalledOnce()
    rerender(<ConfirmAction confirming {...props} />)
    expect(screen.getByRole('group', { name: 'Remove' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('opens a named dialog with its actions and closes it with the close button', () => {
    const onClose = vi.fn()
    render(<Dialog open onClose={onClose} title="Remove device" closeLabel="Close" actions={<button type="button">Remove</button>}>Body</Dialog>)
    expect(screen.getByRole('dialog', { name: 'Remove device' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('puts the caller\'s class on the card and its content class on the region around the header', () => {
    render(<Dialog open onClose={() => {}} title="Rename" closeLabel="Close" className="wide" contentClassName="scrolls">Body</Dialog>)
    const card = screen.getByRole('dialog', { name: 'Rename' })
    expect(card.classList.contains('wide')).toBe(true)
    const content = card.querySelector('.scrolls')
    expect(content).not.toBeNull()
    expect(content?.textContent).toContain('Body')
    expect(content?.contains(screen.getByRole('heading', { name: 'Rename' }))).toBe(true)
  })

  it('when headless draws the caller\'s own frame in the card, with no header, close button or action row', () => {
    render(<Dialog open headless onClose={() => {}} title="A notice" className="frame" actions={<button type="button">Continue</button>}><h2>Our promise</h2></Dialog>)
    const card = screen.getByRole('dialog', { name: 'A notice' })
    expect(card.classList.contains('frame')).toBe(true)
    expect(screen.getByRole('heading', { name: 'Our promise' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(card.querySelector('h2')?.textContent).toBe('Our promise')
  })
})

describe('SecretPair', () => {
  it('draws two masked fields the browser does not remember, passes edits up and shows the error under the second', () => {
    const onSecret = vi.fn()
    const onAgain = vi.fn()
    render(<SecretPair label="PIN" confirmLabel="Again" help="At least 6 digits" error="No match" secret="" again="" onSecret={onSecret} onAgain={onAgain} />)
    const first = screen.getByLabelText('PIN') as HTMLInputElement
    const second = screen.getByLabelText('Again') as HTMLInputElement
    expect([first.type, second.type, first.autocomplete, second.autocomplete]).toEqual(['password', 'password', 'new-password', 'new-password'])
    fireEvent.change(first, { target: { value: '8246' } })
    fireEvent.change(second, { target: { value: '8247' } })
    expect(onSecret).toHaveBeenCalledWith('8246')
    expect(onAgain).toHaveBeenCalledWith('8247')
    expect(screen.getByRole('alert').textContent).toBe('No match')
    expect(screen.getByText('At least 6 digits')).toBeTruthy()
  })
})
