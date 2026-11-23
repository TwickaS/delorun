// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetAsideBanner, type SetAsideBannerProps } from '../src/client/SetAsideBanner.tsx'
import { en, zh } from '../src/client/locales.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { t } from './fixtures.client.ts'

afterEach(cleanup)

/** The notice over a Host answer and a dismissal store that starts as given. */
function mount(answer: readonly string[] | undefined, dismissed = false) {
  const store = createSnapshotStore(dismissed)
  const setAside = vi.fn(() => Promise.resolve(answer))
  const dismiss = vi.fn(() => { store.set(true) })
  const props: SetAsideBannerProps = { t, setAside, dismissed: store, dismiss }
  const view = render(<SetAsideBanner {...props} />)
  return { ...view, setAside, dismiss }
}
const settle = async () => { await act(async () => { await Promise.resolve() }) }

describe('the set-aside notice', () => {
  it('names the files and points at the doctor when records were set aside', async () => {
    mount(['workspaces.json.quarantined-20261114T101500Z.json', 'workspaces.json.quarantined-20261114T101600Z.json'])
    await settle()
    expect(screen.getByRole('status').textContent).toBe(
      'Some workspace records could not be read and were set aside: workspaces.json.quarantined-20261114T101500Z.json, workspaces.json.quarantined-20261114T101600Z.json. Run delorun doctor for details.Dismiss',
    )
    // It is the shared alert: a banner of the warning kind that stays a polite status.
    expect(screen.getByRole('status').getAttribute('data-kind')).toBe('warning')
    expect(screen.getByRole('status').getAttribute('data-variant')).toBe('banner')
  })

  it.each<readonly [string, readonly string[] | undefined]>([
    ['nothing was set aside', []],
    ['the Host cannot be asked', undefined],
  ])('stays away when %s', async (_, answer) => {
    const { container } = mount(answer)
    await settle()
    expect(container.textContent).toBe('')
  })

  it('hides when dismissed and does not ask the Host again for a notice already dismissed', async () => {
    const shown = mount(['a.json'])
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en['setAside.dismiss'] }))
    expect(shown.dismiss).toHaveBeenCalledOnce()
    expect(shown.container.textContent).toBe('')
    cleanup()
    const again = mount(['a.json'], true)
    await settle()
    expect(again.setAside).not.toHaveBeenCalled()
    expect(again.container.textContent).toBe('')
  })

  it('has the same copy keys and placeholder in Chinese', () => {
    expect(zh['setAside.text']).toContain('{files}')
    expect(zh['setAside.dismiss']).not.toBe('')
  })
})
