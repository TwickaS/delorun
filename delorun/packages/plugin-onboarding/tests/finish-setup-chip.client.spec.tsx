// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FinishSetupChip, FloatingFinishSetupChip } from '../src/client/FinishSetupChip.tsx'
import { en } from '../src/client/locales.ts'
import type { OnboardingSettings } from '../src/config.ts'
import { liveForm, settings, t } from './fixtures.client.ts'

afterEach(cleanup)

/** The chip over a guide that was set aside or not and progress that is done or not. */
function mount(aside: boolean, overrides: Partial<OnboardingSettings> = {}, status: 'ready' | 'loading' = 'ready') {
  const later = createSnapshotStore(aside)
  const progress = liveForm<OnboardingSettings>(settings(overrides), { status })
  const reopen = vi.fn()
  const docked = createSnapshotStore(false)
  const view = render(<FinishSetupChip t={t} later={later} docked={docked} progress={progress.form} reopen={reopen} />)
  return { ...view, later, docked, reopen }
}

describe('the Finish setup chip', () => {
  it('shows after Finish later and brings the guide back', async () => {
    const { reopen } = mount(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.finishSetup })) })
    expect(reopen).toHaveBeenCalledOnce()
  })

  it.each<readonly [string, boolean, Partial<OnboardingSettings>, 'ready' | 'loading']>([
    ['the guide is showing', false, {}, 'ready'],
    ['the guide is finished', true, { done: true }, 'ready'],
    ['progress is not read yet', true, {}, 'loading'],
  ])('is absent while %s', (_, aside, overrides, status) => {
    mount(aside, overrides, status)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('marks the dock as holding the chip while mounted, so the floating chip steps aside', async () => {
    const { docked, later, reopen, unmount } = mount(true)
    expect(docked.getSnapshot()).toBe(true)
    const floating = render(<FloatingFinishSetupChip t={t} later={later} docked={docked} progress={liveForm<OnboardingSettings>(settings()).form} reopen={reopen} />)
    expect(floating.container.querySelector('button')).toBeNull()
    unmount()
    expect(docked.getSnapshot()).toBe(false)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('button', { name: en.finishSetup })).toBeTruthy()
  })
})
