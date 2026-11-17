// @vitest-environment jsdom
/** The sites' toast: one at a time, a named region, an action that is a real button, and a hold that ends by itself. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { showToast, ToastCard, Toaster } from '../src/toast.web.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the toaster', () => {
  it('names its region, shows one toast and replaces it with the next', async () => {
    render(<Toaster label="Notifications" />)
    expect(screen.getByRole('region', { name: /Notifications/ })).toBeTruthy()
    act(() => { showToast({ message: 'Theme changed to Ocean' }) })
    await screen.findByText('Theme changed to Ocean')
    act(() => { showToast({ message: 'Theme changed to Forest' }) })
    await screen.findByText('Theme changed to Forest')
    expect(screen.queryByText('Theme changed to Ocean')).toBeNull()
    expect(document.querySelectorAll('[data-sonner-toast]')).toHaveLength(1)
  })

  it('runs the action from a focusable button and then closes the toast', async () => {
    const back = vi.fn()
    render(<Toaster label="Notifications" />)
    act(() => { showToast({ message: 'Theme changed to Ocean', action: { label: 'Back to Soft', onClick: back } }) })
    const action = await screen.findByRole('button', { name: 'Back to Soft' })
    expect(action.tabIndex).not.toBe(-1)
    fireEvent.click(action)
    expect(back).toHaveBeenCalledOnce()
    await waitFor(() => { expect(screen.queryByText('Theme changed to Ocean')).toBeNull() })
  })
})

describe('ToastCard', () => {
  it('draws the sentence and calls back after its action', () => {
    const onDone = vi.fn()
    const onClick = vi.fn()
    render(<ToastCard message="Theme changed to Ocean" action={{ label: 'Back to Soft', onClick }} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to Soft' }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('has no button without an action', () => {
    render(<ToastCard message="Saved" onDone={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
