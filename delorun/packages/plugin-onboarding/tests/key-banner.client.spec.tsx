// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { bannerState, hasNoWorkingKey, KeyBanner, type KeyBannerProps } from '../src/client/KeyBanner.tsx'
import type { KeyResult, KeyTestAnswer } from '../src/wire.ts'
import { t } from './fixtures.client.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const answer = (...results: KeyResult[]): KeyTestAnswer => ({ providers: results.map((result, index) => ({ provider: `p${String(index)}`, name: `P${String(index)}`, result })) })

describe('when the banner shows', () => {
  it.each<readonly [string, KeyTestAnswer | undefined, boolean]>([
    ['no provider is usable', answer(), true],
    ['every provider has no key or a rejected one', answer('no-key', 'rejected'), true],
    ['a key works', answer('no-key', 'works'), false],
    ['every provider is no-key', answer('no-key', 'no-key'), true],
    ['a provider has a credential but no listing, and no other provider works', answer('no-key', 'untested'), false],
    ['a provider has a credential but no listing, alone', answer('untested'), false],
    ['a lone keyless local provider, which discovery cannot list', answer('untested'), false],
    ['a provider has no listing, and another works', answer('untested', 'works'), false],
    ['a provider cannot be reached', answer('unreachable'), false],
    ['a provider\'s test failed', answer('failed'), false],
    ['the key test could not be read', undefined, false],
  ])('%s: %s', (_, test, shows) => { expect(hasNoWorkingKey(test)).toBe(shows) })
})

/** The banner over a key test that answers from a list, one answer per ask, the last repeated. */
function mount(...answers: (KeyTestAnswer | undefined)[]) {
  let asks = 0
  const keyTest = vi.fn(() => Promise.resolve(answers[Math.min(asks++, answers.length - 1)]))
  const openModels = vi.fn()
  const props: KeyBannerProps = { t, keyTest, openModels }
  const view = render(<KeyBanner {...props} />)
  return { ...view, keyTest, openModels }
}
const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('the banner', () => {
  it('shows a calm line with a button that opens Models while no key works', async () => {
    const { openModels, container } = mount(answer('no-key'))
    await settle()
    expect(screen.getByRole('status').textContent).toBe(`${en['keyBanner.text']}${en['keyBanner.open']}`)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    // It is the shared alert: a banner of the info kind, a polite status.
    expect(screen.getByRole('status').getAttribute('data-kind')).toBe('info')
    expect(screen.getByRole('status').getAttribute('data-variant')).toBe('banner')
    fireEvent.click(screen.getByRole('button', { name: en['keyBanner.open'] }))
    expect(openModels).toHaveBeenCalledOnce()
  })

  it('takes the composer card radius, so the pair reads as one surface (#89)', async () => {
    // Vitest serves stylesheets to specs as empty modules, so the rule is read from disk.
    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/KeyBanner.module.css'), 'utf8')
    const rule = /\.banner\[data-variant\]\s*\{([^{}]*)\}/.exec(sheet)?.[1] ?? ''
    // The composer card is `--dsw-radius-panel` (packages/client/ui-conversation InputBar.module.css `.card`).
    expect(rule).toContain('border-radius: var(--dsw-radius-panel)')
    expect(rule).not.toContain('--delorun-glass-radius')
  })

  it('stays away, and never asks again, when a key works', async () => {
    const { keyTest, container } = mount(answer('works'))
    await settle(60_000)
    fireEvent.focus(window)
    expect(container.textContent).toBe('')
    expect(keyTest).toHaveBeenCalledOnce()
  })

  it('stays away when the key test cannot be read', async () => {
    const { container } = mount(undefined)
    await settle()
    expect(container.textContent).toBe('')
  })

  it('asks again only when the window regains focus, and leaves once a key is added', async () => {
    const { keyTest, container } = mount(answer('no-key'), answer('no-key'), answer('works'))
    await settle()
    const asked = keyTest.mock.calls.length
    await settle(60_000)
    expect(keyTest).toHaveBeenCalledTimes(asked)
    expect(screen.queryByRole('status')).not.toBeNull()
    fireEvent.focus(window)
    await settle()
    expect(container.textContent).toBe('')
    const after = keyTest.mock.calls.length
    expect(after).toBeGreaterThan(asked)
    fireEvent.focus(window)
    await settle(60_000)
    expect(keyTest).toHaveBeenCalledTimes(after)
  })

  it('ignores an answer that arrives after it was removed', async () => {
    let resolve: (value: KeyTestAnswer) => void = () => {}
    const keyTest = vi.fn(() => new Promise<KeyTestAnswer>((done) => { resolve = done }))
    const view = render(<KeyBanner {...{ t, keyTest, openModels: vi.fn() } satisfies KeyBannerProps} />)
    view.unmount()
    resolve(answer('no-key'))
    await settle()
    expect(document.body.textContent).toBe('')
  })
})

describe('what the banner says', () => {
  it('names the provider whose saved key was refused, preferring DeepSeek, and offers to check it', async () => {
    const refused: KeyTestAnswer = { providers: [{ provider: 'openai', name: 'OpenAI', result: 'rejected' }, { provider: 'deepseek-official', name: 'DeepSeek', result: 'rejected' }] }
    expect(bannerState(refused)).toEqual({ kind: 'failed', name: 'DeepSeek' })
    const { openModels } = mount(refused)
    await settle()
    expect(screen.getByRole('status').textContent).toBe(`Your DeepSeek key did not pass its test${en['keyBanner.check']}`)
    fireEvent.click(screen.getByRole('button', { name: en['keyBanner.check'] }))
    expect(openModels).toHaveBeenCalledOnce()
  })

  it('asks to add a key when none is saved, and says nothing when a key might work', () => {
    expect(bannerState(answer('no-key'))).toEqual({ kind: 'add' })
    expect(en['keyBanner.open']).toBe('Add a key')
    expect(bannerState(answer('works'))).toEqual({ kind: 'none' })
    expect(bannerState(undefined)).toEqual({ kind: 'none' })
  })
})
