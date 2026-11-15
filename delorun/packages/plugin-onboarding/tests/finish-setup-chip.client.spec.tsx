// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FinishSetupChip } from '../src/client/FinishSetupChip.tsx'
import { en } from '../src/client/locales.ts'
import type { OnboardingSettings } from '../src/config.ts'
import { liveForm, settings, t } from './fixtures.client.ts'

afterEach(cleanup)

/** The chip over a guide that was set aside or not and progress that is done or not. */
function mount(aside: boolean, overrides: Partial<OnboardingSettings> = {}, status: 'ready' | 'loading' = 'ready') {
  const later = createSnapshotStore(aside)
  const progress = liveForm<OnboardingSettings>(settings(overrides), { status })
  const reopen = vi.fn()
  const view = render(<FinishSetupChip t={t} later={later} progress={progress.form} reopen={reopen} />)
  return { ...view, later, reopen }
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
})
