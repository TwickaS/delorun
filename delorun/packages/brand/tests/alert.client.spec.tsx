// @vitest-environment jsdom
/** The studio's alert: the role each kind takes, one glyph per kind, the action buttons, the banner row and the leave. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Alert, ALERT_CLASSES, ALERT_EXIT_MS, type AlertKind } from '../src/alert.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const KINDS: readonly AlertKind[] = ['info', 'success', 'warning', 'error', 'progress']

describe('the role', () => {
  it('is alert for a warning or an error and status otherwise', () => {
    for (const kind of KINDS) {
      const { unmount } = render(<Alert kind={kind} title={`A ${kind} alert`} />)
      const expected = kind === 'warning' || kind === 'error' ? 'alert' : 'status'
      expect(screen.getByRole(expected).getAttribute('data-kind')).toBe(kind)
      unmount()
    }
  })

  it('follows the caller when it names one', () => {
    render(<Alert kind="error" role="status" title="Saved, with a warning" />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the anatomy', () => {
  it('draws a different glyph for each kind, hidden from assistive technology, so colour is never the only signal', () => {
    const glyphs = KINDS.map((kind) => {
      const { container, unmount } = render(<Alert kind={kind} title="Title" />)
      const icon = container.querySelector(`.${ALERT_CLASSES.icon}`)
      expect(icon?.getAttribute('aria-hidden')).toBe('true')
      const glyph = icon?.querySelector('svg')?.getAttribute('data-glyph')
      unmount()
      return glyph
    })
    expect(glyphs).toEqual(KINDS)
  })

  it('shows the title, the muted line and the two actions as real buttons, the tinted one first', () => {
    const retry = vi.fn()
    const details = vi.fn()
    const { container } = render(
      <Alert kind="warning" title="Reconnecting…" line="Trying again in 4 s" primary={{ label: 'Reconnect now', onClick: retry }} secondary={{ label: 'Details', onClick: details }} />,
    )
    expect(container.querySelector(`.${ALERT_CLASSES.title}`)?.textContent).toBe('Reconnecting…')
    expect(container.querySelector(`.${ALERT_CLASSES.line}`)?.textContent).toBe('Trying again in 4 s')
    const buttons = [...container.querySelectorAll(`.${ALERT_CLASSES.actions} button`)]
    expect(buttons.map(button => button.className)).toEqual([ALERT_CLASSES.primary, ALERT_CLASSES.secondary])
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(details).toHaveBeenCalledOnce()
  })

  it('names the close button with the caller\'s label', () => {
    const close = vi.fn()
    render(<Alert kind="info" title="Saved" close={{ label: 'Hide this message', onClick: close }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide this message' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('puts a banner\'s actions on its row, after the text', () => {
    const { container } = render(<Alert kind="info" variant="banner" title="Add a key" primary={{ label: 'Add key', onClick: () => {} }} />)
    const root = container.querySelector(`.${ALERT_CLASSES.root}`)
    expect(root?.getAttribute('data-variant')).toBe('banner')
    expect(root?.querySelector(`.${ALERT_CLASSES.body} .${ALERT_CLASSES.actions}`)).toBeNull()
    expect(root?.querySelector(`:scope > .${ALERT_CLASSES.actions}`)).not.toBeNull()
  })

  it('leaves out the line and the action row when there are none', () => {
    const { container } = render(<Alert kind="success" title="Saved" />)
    expect(container.querySelector(`.${ALERT_CLASSES.line}`)).toBeNull()
    expect(container.querySelector(`.${ALERT_CLASSES.actions}`)).toBeNull()
  })
})

describe('the leave', () => {
  it('marks the alert closing and reports the end of its opacity transition once', () => {
    const closed = vi.fn()
    const { container, rerender } = render(<Alert kind="info" title="Saved" onClosed={closed} />)
    const root = container.querySelector<HTMLElement>(`.${ALERT_CLASSES.root}`)
    expect(root?.getAttribute('data-state')).toBe('open')
    rerender(<Alert kind="info" title="Saved" closing onClosed={closed} />)
    expect(root?.getAttribute('data-state')).toBe('closing')
    const transform = new Event('transitionend') as TransitionEvent
    Object.defineProperty(transform, 'propertyName', { value: 'transform' })
    act(() => { root?.dispatchEvent(transform) })
    expect(closed).not.toHaveBeenCalled()
    const opacity = new Event('transitionend') as TransitionEvent
    Object.defineProperty(opacity, 'propertyName', { value: 'opacity' })
    act(() => { root?.dispatchEvent(opacity) })
    act(() => { root?.dispatchEvent(opacity) })
    expect(closed).toHaveBeenCalledOnce()
  })

  it('reports the end without a transition, as under reduced motion, shortly after the leave time', () => {
    vi.useFakeTimers()
    const closed = vi.fn()
    render(<Alert kind="info" title="Saved" closing onClosed={closed} />)
    act(() => { vi.advanceTimersByTime(ALERT_EXIT_MS) })
    expect(closed).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(60) })
    expect(closed).toHaveBeenCalledOnce()
  })
})
