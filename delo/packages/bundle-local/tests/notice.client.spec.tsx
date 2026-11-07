// @vitest-environment jsdom
/** Delo's preview notice shows once per notice version on a browser, then reports its onboarding step complete. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DeloNotice, type DeloNoticeProps, NOTICE_STORAGE_KEY, NOTICE_VERSION, acknowledgeNotice, noticeAcknowledged } from '../src/client/DeloNotice.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  globalThis.localStorage.clear()
})

/**
 * Render the notice with a stub copy lookup that returns the English dictionary.
 * @param complete - the onboarding step's completion callback.
 */
function renderNotice(complete: () => void): void {
  const props = { complete, t: (key: keyof typeof en) => en[key] } as DeloNoticeProps
  render(<DeloNotice {...props} />)
}

describe('the Delo preview notice', () => {
  it('states Delo\'s own status and names no DeepSeek preview copy', () => {
    renderNotice(() => {})
    expect(screen.getByRole('dialog', { name: en['notice.title'] })).toBeTruthy()
    expect(en['notice.body']).toContain('pre-release community fork of DeepSeek Harness')
    expect(en['notice.body']).not.toContain('still in preview, and many areas need continued improvement and refinement. We welcome')
  })

  it('records the acknowledgement and completes the step on Continue', () => {
    const complete = vi.fn()
    renderNotice(complete)
    fireEvent.click(screen.getByRole('button', { name: en['notice.continue'] }))
    expect(complete).toHaveBeenCalledTimes(1)
    expect(noticeAcknowledged()).toBe(true)
    expect(globalThis.localStorage.getItem(NOTICE_STORAGE_KEY)).toBe(NOTICE_VERSION)
  })

  it('shows nothing and completes at once when this browser acknowledged the current version', () => {
    acknowledgeNotice()
    const complete = vi.fn()
    renderNotice(complete)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('treats another stored version as unacknowledged', () => {
    globalThis.localStorage.setItem(NOTICE_STORAGE_KEY, 'older')
    expect(noticeAcknowledged()).toBe(false)
  })

  it('has a Chinese entry for every English key', () => {
    expect(Object.keys(en).filter(key => key.startsWith('notice.')).sort()).toEqual(['notice.body', 'notice.continue', 'notice.title'])
  })
})
