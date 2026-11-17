// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddableCard } from '../src/client/steps/BundleCard.tsx'
import { en } from '../src/client/locales.ts'
import type { BundleState } from '../src/client/bundles.ts'
import { stepServices } from './fixtures.client.ts'

afterEach(cleanup)

const draw = (state: BundleState, remote: boolean) => {
  const onAdd = vi.fn()
  render(<ul><AddableCard services={stepServices({ remote })} state={state} title="Pi" description={undefined} onAdd={onAdd} /></ul>)
  return onAdd
}

describe('an addable card on a phone', () => {
  it('offers Add and Retry as on the computer, with no add-at-the-computer line', () => {
    draw('available', true)
    expect(screen.getByRole('button', { name: /Pi/ })).toBeTruthy()
    cleanup()
    draw('failed', true)
    expect(screen.getByRole('button', { name: en['bundle.retry'] })).toBeTruthy()
  })

  it('leaves an added package as it is', () => {
    draw('installed', true)
    expect(screen.getByText(en['bundle.added'])).toBeTruthy()
  })
})

describe('an unavailable card', () => {
  it('blames the computer only for a platform limit, and gives the reason a Host without plugin packs reports', () => {
    draw('unavailable', false)
    expect(screen.getByText(en['bundle.unavailable'])).toBeTruthy()
    cleanup()
    render(<ul><AddableCard services={stepServices({ remote: false })} state="unavailable" packsReason="Delorun is not running from an installed release." title="Pi" description={undefined} onAdd={vi.fn()} /></ul>)
    expect(screen.getByText('Not available here. Delorun is not running from an installed release.')).toBeTruthy()
    expect(screen.queryByText(en['bundle.unavailable'])).toBeNull()
  })
})
