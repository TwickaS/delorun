// @vitest-environment jsdom
/** The replica pieces draw a simplified studio chat with the brand components and take every visible string as a prop. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Composer, MessageBubble, ToolCard, Transcript } from '../src/replica/index.ts'

afterEach(cleanup)

describe('MessageBubble', () => {
  it('records who wrote the message', () => {
    const { rerender } = render(<MessageBubble from="person">Hello</MessageBubble>)
    expect(screen.getByText('Hello').dataset.from).toBe('person')
    rerender(<MessageBubble from="agent">Hi</MessageBubble>)
    expect(screen.getByText('Hi').dataset.from).toBe('agent')
  })
})

describe('Transcript', () => {
  it('is a log named by its label that scrolls to its end after a rerender with more children', () => {
    const { rerender } = render(<Transcript label="Conversation"><p>One</p></Transcript>)
    const log = screen.getByRole('log', { name: 'Conversation' })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 640 })
    expect(log.scrollTop).not.toBe(640)
    rerender(<Transcript label="Conversation"><p>One</p><p>Two</p></Transcript>)
    expect(log.scrollTop).toBe(640)
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 900 })
    rerender(<Transcript label="Conversation"><p>One</p><p>Two</p><p>Three</p></Transcript>)
    expect(log.scrollTop).toBe(900)
  })
})

describe('ToolCard', () => {
  const base = { title: 'Bash', command: 'ls -la' } as const

  it('shows the title and the command on one row, and no status word for a finished call', () => {
    const { container } = render(<ToolCard {...base} status="done" />)
    expect(container.textContent).toBe('Bash·ls -la')
    expect((container.firstElementChild as HTMLElement).dataset.status).toBe('done')
    expect(container.querySelector('details')).toBeNull()
  })

  it('gives a running or failed call its status as hidden text, and a dot only while running', () => {
    const { container, rerender } = render(<ToolCard {...base} status="running" statusLabel="Running" />)
    expect(screen.getByText('Running')).toBeTruthy()
    expect(container.querySelector('[data-dot]')).toBeTruthy()
    rerender(<ToolCard {...base} status="failed" statusLabel="Failed" />)
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(container.querySelector('[data-dot]')).toBeNull()
  })

  it('folds the output open from the row itself', () => {
    const { container, rerender } = render(<ToolCard {...base} status="done" output="total 0" />)
    const details = container.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Bash·ls -la')
    expect(details.querySelector('pre')?.textContent).toBe('total 0')
    rerender(<ToolCard {...base} status="done" output="total 0" open />)
    expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(true)
  })
})

describe('Composer', () => {
  const base = { label: 'Message', placeholder: 'Ask for a change', sendLabel: 'Send' } as const

  it('shows the placeholder and a disabled send button while empty, with no caret', () => {
    const { container } = render(<Composer {...base} value="" typing />)
    expect(screen.getByRole('textbox', { name: 'Message' }).textContent).toBe('Ask for a change')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[data-caret]')).toBeNull()
  })

  it('shows the value with a caret while typing and enables the send button', () => {
    const { container } = render(<Composer {...base} value="Make the header blue" typing />)
    const box = screen.getByRole('textbox', { name: 'Message' })
    expect(box.textContent).toBe('Make the header blue')
    expect(box.getAttribute('aria-readonly')).toBe('true')
    expect(box.getAttribute('aria-multiline')).toBe('true')
    expect(container.querySelector('[data-caret]')?.getAttribute('aria-hidden')).toBe('true')
    expect((container.firstElementChild as HTMLElement).dataset.typing).toBe('true')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows no caret when the value is not being typed', () => {
    const { container } = render(<Composer {...base} value="Sent" />)
    expect(container.querySelector('[data-caret]')).toBeNull()
    expect((container.firstElementChild as HTMLElement).dataset.typing).toBeUndefined()
  })
})
