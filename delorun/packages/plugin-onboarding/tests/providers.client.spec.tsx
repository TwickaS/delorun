// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelsStep as ProvidersStep } from '../src/client/steps/Models.tsx'
import { StepFrame } from '../src/client/frame/StepFrame.tsx'
import { createGuide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import { TEST_DELAY_MS } from '../src/client/providers.ts'
import type { KeyTestAnswer, LocalServer } from '../src/wire.ts'
import { hostFake, providersFake, stepServices } from './fixtures.client.ts'

afterEach(cleanup)
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const KEYS: KeyTestAnswer = { providers: [
  { provider: 'deepseek-official', name: 'DeepSeek', result: 'works' },
  { provider: 'openai', name: 'OpenAI', result: 'no-key' },
  { provider: 'typesafe', name: 'Typesafe', result: 'no-key' },
  { provider: 'gateway', name: 'Gateway', result: 'no-key' },
] }

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const type = async (field: HTMLElement, value: string) => { await act(async () => { fireEvent.change(field, { target: { value } }) }) }

async function mount(change: Parameters<typeof providersFake>[0] = {}, keys: KeyTestAnswer = KEYS) {
  const providers = providersFake(change)
  const next = vi.fn()
  const back = vi.fn()
  const guide = createGuide(hostFake({ keys }).host)
  render(
    <StepFrame title="Models" headingRef={null} count="Step 2 of 7" place={2} total={7} steps={['Welcome', 'Models']} stepsLabel="Steps" stepKey="models">
      <ProvidersStep services={stepServices({ providers: providers.face })} guide={guide} next={next} back={back} />
    </StepFrame>,
  )
  await flush()
  return { ...providers, next, back, guide }
}

describe('the providers landing', () => {
  it('lists the cards, ticks the ones with a key found and counts them on the button', async () => {
    await mount()
    expect(screen.getAllByRole('checkbox').map(box => [box.closest('li')?.querySelector('h4')?.textContent, (box as HTMLInputElement).checked])).toEqual([
      ['DeepSeek', true], ['OpenAI', false], ['Gateway', false], ['Typesafe', false],
    ])
    expect(screen.getByText(en['providers.found'])).toBeTruthy()
    expect(screen.getByRole('button', { name: en['providers.connect'] })).toBeTruthy()
    await click(screen.getByRole('checkbox', { name: /OpenAI/ }))
    expect(screen.getByRole('button', { name: en['providers.connect'] }).hasAttribute('disabled')).toBe(false)
    await click(screen.getByRole('checkbox', { name: /DeepSeek/ }))
    await click(screen.getByRole('checkbox', { name: /OpenAI/ }))
    // With nothing ticked the button leaves the step instead of showing a disabled count.
    expect(screen.queryByRole('button', { name: en['providers.connect'] })).toBeNull()
  })

  it('continues without a key when nothing is ticked', async () => {
    const { next } = await mount()
    await click(screen.getByRole('checkbox', { name: /DeepSeek/ }))
    await click(screen.getByRole('button', { name: en['providers.continueNoKey'] }))
    expect(next).toHaveBeenCalledOnce()
  })

  it.each<readonly [string, Parameters<typeof providersFake>[0], string, string]>([
    ['the directory cannot be read', { directory: undefined }, en['providers.unread'], en.continue],
    ['no provider connects with a key', { directory: [] }, en['providers.none'], en['providers.continueNoKey']],
  ])('says so when %s', async (_, change, text, label) => {
    const { next } = await mount(change)
    expect(screen.getByText(text)).toBeTruthy()
    await click(screen.getByRole('button', { name: label }))
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('the walk', () => {
  const start = async (change: Parameters<typeof providersFake>[0] = {}) => {
    const mounted = await mount(change)
    await click(screen.getByRole('checkbox', { name: /OpenAI/ }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    return mounted
  }

  it('shows k of N, one provider at a time, with Skip and Next', async () => {
    await start()
    expect(screen.getByText('DeepSeek · 1 of 2')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: 'DeepSeek' })).toBeTruthy()
    // A found key is never echoed: the field is empty and the status says so.
    expect((screen.getByLabelText(en['providers.key']) as HTMLInputElement).value).toBe('')
    expect(screen.getByText(en['providers.found'])).toBeTruthy()
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(screen.getByText('OpenAI · 2 of 2')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: 'OpenAI' })).toBeTruthy()
    expect(screen.getByRole('button', { name: en['providers.next'] }).hasAttribute('disabled')).toBe(true)
    await click(screen.getByRole('button', { name: en['providers.skipOne'] }))
    expect(screen.getByText(en['providers.outcome.connected'])).toBeTruthy()
    expect(screen.getByText(en['providers.outcome.skipped'])).toBeTruthy()
  })

  it('links to the official key page, in a new tab, only where there is one', async () => {
    await start()
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    const link = screen.getByRole('link', { name: en['providers.getKey'] })
    expect(link.getAttribute('href')).toBe('https://platform.openai.com/api-keys')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('tests a pasted key once, after the typing stops, and shows the model count and the default model', async () => {
    const { probe } = await start()
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    const field = screen.getByLabelText(en['providers.key'])
    await type(field, 'sk-a')
    await flush(TEST_DELAY_MS - 100)
    await type(field, 'sk-abc')
    await flush(TEST_DELAY_MS - 100)
    expect(probe).not.toHaveBeenCalled()
    expect(screen.getByText(en['providers.testing'])).toBeTruthy()
    await flush(200)
    expect(probe).toHaveBeenCalledOnce()
    expect(probe.mock.calls[0]?.slice(1)).toEqual(['sk-abc', undefined])
    expect(screen.getByText('Key works · 12 models')).toBeTruthy()
    expect(screen.getByText('Default model: deepseek-chat')).toBeTruthy()
  })

  it('says when a key cannot be confirmed and when it does not look like a key, without asking the provider', async () => {
    const { probe } = await start({ probe: { kind: 'failed' } })
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    const field = screen.getByLabelText(en['providers.key'])
    await type(field, 'two words')
    await flush(TEST_DELAY_MS)
    expect(probe).not.toHaveBeenCalled()
    expect(screen.getByText(en['providers.invalid'])).toBeTruthy()
    expect(screen.getByRole('button', { name: en['providers.next'] }).hasAttribute('disabled')).toBe(true)
    await type(field, 'sk-abc')
    await flush(TEST_DELAY_MS)
    expect(screen.getByText(en['providers.failed'])).toBeTruthy()
  })

  it('saves a typed key on Next and reports a key that was not saved', async () => {
    const mounted = await start({ save: false })
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    await type(screen.getByLabelText(en['providers.key']), 'sk-abc')
    await flush(TEST_DELAY_MS)
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(mounted.save.mock.calls[0]?.[1]).toBe('sk-abc')
    expect(screen.getByText(en['providers.saveFailed'])).toBeTruthy()
    mounted.save.mockResolvedValueOnce(true)
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(screen.getAllByText(en['providers.outcome.connected'])).toHaveLength(2)
  })

  it.each([
    ['a key that works', { kind: 'works', models: 3, defaultModel: undefined } as const, TEST_DELAY_MS, 'connected'],
    ['a key that fails its test', { kind: 'failed' } as const, TEST_DELAY_MS, 'failed'],
    ['a key saved before its test ran', { kind: 'works', models: 3, defaultModel: undefined } as const, 0, 'untested'],
  ])('summarises %s with its own verdict, never only "Key saved"', async (_, probe, wait, verdict) => {
    await start({ probe })
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    await type(screen.getByLabelText(en['providers.key']), 'sk-abc')
    await flush(wait)
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    const row = within(screen.getByRole('list', { name: en['providers.summary.label'] })).getAllByRole('listitem')[1]
    expect(row?.textContent).toContain(en[`providers.outcome.${verdict}` as keyof typeof en])
  })

  it('says no key works yet when every provider is skipped or failed, and Try again returns to that provider\'s key screen', async () => {
    await start({ probe: { kind: 'failed' } })
    await click(screen.getByRole('button', { name: en['providers.skipOne'] }))
    await type(screen.getByLabelText(en['providers.key']), 'sk-abc')
    await flush(TEST_DELAY_MS)
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(screen.getByText(en['providers.summary.none'])).toBeTruthy()
    expect(screen.queryByText(en['providers.summary.lead'])).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(en['providers.failedHelp'].replace('{name}', 'OpenAI').slice(0, 20))
    await click(screen.getByRole('button', { name: en['providers.tryAgain'] }))
    expect(screen.getByRole('heading', { level: 3, name: 'OpenAI' })).toBeTruthy()
    // A single provider has no counter of its own.
    expect(screen.queryByText(/ of 1$/)).toBeNull()
    expect(document.activeElement).toBe(screen.getByLabelText(en['providers.key']))
  })

  it('offers a base URL under More settings for a declared route only', async () => {
    const mounted = await mount()
    await click(screen.getByRole('checkbox', { name: /DeepSeek/ }))
    await click(screen.getByRole('checkbox', { name: /Gateway/ }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    await click(screen.getByText(en['providers.more']))
    await type(screen.getByLabelText(en['providers.baseURL']), ' http://127.0.0.1:9 ')
    await type(screen.getByLabelText(en['providers.key']), 'sk-abc')
    await flush(TEST_DELAY_MS)
    expect(mounted.probe.mock.calls[0]?.[2]).toBe('http://127.0.0.1:9')
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(mounted.save.mock.calls[0]?.[2]).toBe('http://127.0.0.1:9')
  })
})

describe('the summary', () => {
  it('lists each provider as connected, saved or skipped, tests the keys again and goes back to the cards on request', async () => {
    const { guide } = await mount()
    await click(screen.getByRole('checkbox', { name: /OpenAI/ }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    await type(screen.getByLabelText(en['providers.key']), 'sk-abc')
    await flush(TEST_DELAY_MS)
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(guide.providersPhase.getSnapshot()).toBe('summary')
    expect(within(screen.getByRole('list', { name: en['providers.summary.label'] })).getAllByRole('listitem').map(item => item.textContent)).toEqual([`DeepSeek✓ ${en['providers.outcome.connected']}`, `OpenAI✓ ${en['providers.outcome.connected']}`])
    await click(screen.getByRole('button', { name: en['providers.change'] }))
    expect(guide.providersPhase.getSnapshot()).toBe('landing')
  })
})

describe('local model servers', () => {
  const OLLAMA: LocalServer = { kind: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', models: ['llama3', 'qwen3'] }

  const mountLocal = async (servers: readonly LocalServer[], remote = false, declareLocal = true) => {
    const providers = providersFake({ declareLocal })
    const host = hostFake({ localModels: servers })
    render(
      <StepFrame title="Models" headingRef={null} count="Step 2 of 7" place={2} total={7} steps={['Welcome', 'Models']} stepsLabel="Steps" stepKey="models">
        <ProvidersStep services={stepServices({ providers: providers.face, host: host.host, remote })} guide={createGuide(host.host)} next={vi.fn()} back={vi.fn()} />
      </StepFrame>,
    )
    await flush()
    return providers
  }

  it('shows the found server with its model count and writes nothing until the person confirms', async () => {
    const { declareLocal } = await mountLocal([OLLAMA])
    expect(screen.getByText('Found at http://127.0.0.1:11434/v1 · 2 models')).toBeTruthy()
    await click(screen.getByRole('button', { name: 'Add Ollama' }))
    expect(declareLocal).not.toHaveBeenCalled()
    await click(screen.getByRole('button', { name: en['local.confirmYes'] }))
    expect(declareLocal).toHaveBeenCalledWith(OLLAMA)
    expect(screen.getByText(en['bundle.added'])).toBeTruthy()
  })

  it('writes nothing when the person declines, and reports a write that failed', async () => {
    const { declareLocal } = await mountLocal([OLLAMA], false, false)
    await click(screen.getByRole('button', { name: 'Add Ollama' }))
    await click(screen.getByRole('button', { name: en['local.confirmNo'] }))
    expect(declareLocal).not.toHaveBeenCalled()
    await click(screen.getByRole('button', { name: 'Add Ollama' }))
    await click(screen.getByRole('button', { name: en['local.confirmYes'] }))
    expect(screen.getByText(en['local.failed'])).toBeTruthy()
  })

  it('leaves the write to the computer on a phone', async () => {
    await mountLocal([OLLAMA], true)
    expect(screen.getByText(en['bundle.atComputer'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add Ollama' })).toBeNull()
  })

  it('offers nothing when no server answered', async () => {
    await mountLocal([])
    expect(screen.queryByRole('list', { name: en['local.label'] })).toBeNull()
  })
})
