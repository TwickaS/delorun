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
  it.each(['available', 'failed'] as const)('says to add it at the computer instead of offering %s', (state) => {
    draw(state, true)
    expect(screen.getByText(en['bundle.atComputer'])).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers Add and Retry on the computer', () => {
    draw('available', false)
    expect(screen.getByRole('button', { name: /Pi/ })).toBeTruthy()
    expect(screen.queryByText(en['bundle.atComputer'])).toBeNull()
    cleanup()
    draw('failed', false)
    expect(screen.getByRole('button', { name: en['bundle.retry'] })).toBeTruthy()
  })

  it('leaves an added package as it is', () => {
    draw('installed', true)
    expect(screen.getByText(en['bundle.added'])).toBeTruthy()
  })
})
