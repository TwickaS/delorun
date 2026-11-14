// @vitest-environment jsdom
/** The sidebar's dangerous-mode badge: shown only while the home reports the mode on, and opening Permissions. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PERMISSION_ROUTES } from '@delorun/plugin-permission-defaults/wire'
import { DangerousBadge, type DangerousBadgeProps } from '../src/client/DangerousBadge.tsx'
import { en, zh } from '../src/client/consents-locales.ts'
import type { HostFetch } from '../src/client/host-api.ts'

afterEach(cleanup)

/**
 * A fake home that answers the dangerous-mode route.
 * @param answer - the HTTP status and body for the route.
 * @returns the request function.
 */
function homeAnswering(answer: { status: number, body: unknown }): HostFetch {
  return async (input) => {
    if (input !== PERMISSION_ROUTES.everywhere) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(answer.body), { status: answer.status })
  }
}

/**
 * Render the badge.
 * @param fetch - the request function.
 * @param open - the Settings opener.
 * @returns the render result.
 */
function renderBadge(fetch: HostFetch, open: () => void = () => {}) {
  const props = { t: makeTranslate(en), fetch, open } as DangerousBadgeProps
  return render(<DangerousBadge {...props} />)
}

describe('the dangerous-mode badge', () => {
  it('shows while the home reports the mode on, and opens Permissions when clicked', async () => {
    const open = vi.fn()
    renderBadge(homeAnswering({ status: 200, body: { on: true, grantedAt: '2026-11-13T09:00:00.000Z' } }), open)
    const badge = await screen.findByRole('button', { name: en['everywhere.badgeLabel'] })
    expect(badge.textContent).toBe(en['everywhere.badge'])
    fireEvent.click(badge)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the mode is off', { status: 200, body: { on: false } }],
    ['the home refuses the read', { status: 403, body: { error: 'LOOPBACK_REQUIRED', message: 'no' } }],
    ['the profile mounts no permission plugin', { status: 404, body: { error: 'NOT_FOUND', message: 'No such route' } }],
    ['the answer is unreadable', { status: 200, body: { on: 'yes' } }],
  ])('draws nothing when %s', async (_label, answer) => {
    const { container } = renderBadge(homeAnswering(answer))
    await waitFor(() => { expect(container.querySelector('button')).toBeNull() })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(container.querySelector('button')).toBeNull()
  })

  it('has Chinese copy for both keys', () => {
    expect(zh['everywhere.badge']).not.toBe(en['everywhere.badge'])
    expect(zh['everywhere.badgeLabel']).not.toBe(en['everywhere.badgeLabel'])
  })
})
