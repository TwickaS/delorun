// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelsStep as ProvidersStep } from '../src/client/steps/Models.tsx'
import { StepFrame } from '../src/client/frame/StepFrame.tsx'
import { createGuide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import { TEST_DELAY_MS } from '../src/client/providers.ts'
import { DIRECTORY } from './directory.fixture.ts'
import type { DirectoryEntry, KeyProbe } from '../src/client/providers.ts'
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

async function mount(change: Parameters<typeof providersFake>[0] = {}, keys: KeyTestAnswer = KEYS, remote = false, pinOn = false) {
  const providers = providersFake(change)
  const next = vi.fn()
  const back = vi.fn()
  const guide = createGuide(hostFake({ keys }).host)
  render(
    <StepFrame title="Models" headingRef={null} count="Step 2 of 7" place={2} total={7} steps={['Welcome', 'Models']} stepsLabel="Steps" stepKey="models">
      <ProvidersStep services={stepServices({ providers: providers.face, remote })} guide={guide} next={next} back={back} remote={remote} pinOn={pinOn} />
    </StepFrame>,
  )
  await flush()
  return { ...providers, next, back, guide }
}

describe('the providers landing', () => {
  it('lists the cards, ticks the ones with a key found and counts them on the button', async () => {
    await mount()
    expect(screen.getAllByRole('checkbox').map(box => [box.closest('li')?.querySelector('h4')?.textContent, (box as HTMLInputElement).checked])).toEqual([
      ['DeepSeek', true], ['OpenAI', false], ['Gateway', false], ['Typesafe', false], [en['providers.custom.name'], false],
    ])
    expect(screen.getByText(en['providers.connected'])).toBeTruthy()
    // Every ticked provider has its key, so the primary goes straight on.
    expect(screen.getByRole('button', { name: en.continue })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['providers.connect'] })).toBeNull()
    await click(screen.getByRole('checkbox', { name: 'Use OpenAI' }))
    expect(screen.getByRole('button', { name: en['providers.connect'] }).hasAttribute('disabled')).toBe(false)
    await click(screen.getByRole('checkbox', { name: /DeepSeek/ }))
    await click(screen.getByRole('checkbox', { name: 'Use OpenAI' }))
    // With nothing ticked the button leaves the step instead of showing a disabled count.
    expect(screen.queryByRole('button', { name: en['providers.connect'] })).toBeNull()
  })

  it('puts the found providers on top and every other provider a key connects under Add another provider', async () => {
    const GROQ: DirectoryEntry = { provider: 'groq', displayName: 'Groq', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'groq'], authEnv: ['GROQ_API_KEY'], baseURLEnv: [] }
    const HIDDEN: DirectoryEntry = { provider: 'quiet', displayName: 'Quiet', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'quiet'], authEnv: ['QUIET_API_KEY'], baseURLEnv: [] }
    await mount({ directory: [...DIRECTORY, GROQ, HIDDEN] }, { ...KEYS, hidden: ['quiet'] })
    const names = (list: HTMLElement | undefined) => [...list?.querySelectorAll('h4') ?? []].map(heading => heading.textContent)
    expect(names(screen.getByText('DeepSeek').closest('ul') ?? undefined)).toEqual(['DeepSeek'])
    const heading = screen.getByRole('heading', { level: 3, name: en['providers.add.heading'] })
    const section = heading.closest('section')
    // A route the directory knows but the profile has not configured is offered; a hidden route is not.
    expect(names(section?.querySelector('ul') ?? undefined)).toEqual(['OpenAI', 'Groq', 'Gateway', 'Typesafe', en['providers.custom.name']])
    expect(screen.queryByRole('checkbox', { name: /Quiet/ })).toBeNull()
  })

  it('keeps the longer list behind Show all providers, and keeps a ticked provider in view', async () => {
    const many = Array.from({ length: 9 }, (_, n): DirectoryEntry => ({ provider: `extra${String(n)}`, displayName: `Extra ${String(n)}`, settingsNs: 'llm-pi-ai', settingsPath: ['providers', `extra${String(n)}`], authEnv: [`EXTRA${String(n)}_API_KEY`], baseURLEnv: [] }))
    await mount({ directory: [...DIRECTORY, ...many] })
    expect(screen.queryByRole('checkbox', { name: /Extra 8/ })).toBeNull()
    await click(screen.getByRole('button', { name: /^Show all \d+ providers$/ }))
    await click(screen.getByRole('checkbox', { name: /Extra 8/ }))
    await click(screen.getByRole('button', { name: en['providers.add.showFewer'] }))
    expect((screen.getByRole('checkbox', { name: /Extra 8/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole('checkbox', { name: /Extra 7/ })).toBeNull()
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

// Offering Try again on a phone loops: the home refuses a device's key test once a PIN or any passkey exists (F37 P3-1).
describe('the providers step on a phone', () => {
  it('with a PIN set, says the keys are tested at the computer, offers no Try again and keeps Continue', async () => {
    const { next } = await mount({ directory: undefined }, KEYS, true, true)
    expect(screen.getByText(en['providers.atComputer'])).toBeTruthy()
    expect(screen.queryByText(en['providers.unread'])).toBeNull()
    expect(screen.queryByRole('button', { name: en['key.again'] })).toBeNull()
    await click(screen.getByRole('button', { name: en.continue }))
    expect(next).toHaveBeenCalledOnce()
  })

  // Without a PIN the phone's key test may still be admitted (no passkey yet), so a transient failure keeps its retry.
  it('without a PIN, keeps Try again with words that say when keys are tested only at the computer', async () => {
    const { next } = await mount({ directory: undefined }, KEYS, true, false)
    expect(screen.getByText(en['providers.atComputerMaybe'])).toBeTruthy()
    expect(screen.queryByText(en['providers.atComputer'])).toBeNull()
    expect(screen.getByRole('button', { name: en['key.again'] })).toBeTruthy()
    await click(screen.getByRole('button', { name: en.continue }))
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('the walk', () => {
  const start = async (change: Parameters<typeof providersFake>[0] = {}) => {
    const mounted = await mount(change)
    await click(screen.getByRole('checkbox', { name: 'Use OpenAI' }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    return mounted
  }

  it('shows k of N, one provider at a time, with Skip and Next', async () => {
    await start()
    expect(screen.getByText('1 of 2')).toBeTruthy()
    // The name is said once, in the heading, which carries the provider's letter.
    expect(screen.getAllByText('DeepSeek')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 3, name: 'DeepSeek' }).textContent).toBe('DDeepSeek')
    expect(screen.getByRole('heading', { level: 3, name: 'DeepSeek' })).toBeTruthy()
    // A found key has no input at all; the status says so.
    expect(screen.queryByLabelText(en['providers.key'])).toBeNull()
    expect(screen.getByText(en['providers.found'])).toBeTruthy()
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(screen.getByText('2 of 2')).toBeTruthy()
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

describe('a key that was not checked', () => {
  const GROQ: DirectoryEntry = { provider: 'groq', displayName: 'Groq', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'groq'], authEnv: ['GROQ_API_KEY'], baseURLEnv: [] }

  it.each<readonly [string, KeyProbe, string]>([
    ['refused', { kind: 'failed' }, en['providers.failed']],
    ['unchecked', { kind: 'unchecked' }, en['providers.unchecked']],
  ])('is never shown as working when the key was %s', async (_, probe, line) => {
    const mounted = await mount({ directory: [...DIRECTORY, GROQ], probe })
    await click(screen.getByRole('checkbox', { name: 'Use Groq' }))
    await click(screen.getByRole('checkbox', { name: /DeepSeek/ }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    await type(screen.getByLabelText(en['providers.key']), 'gsk-abc')
    await flush(TEST_DELAY_MS)
    expect(screen.getByText(line)).toBeTruthy()
    expect(screen.queryByText(/Key works/)).toBeNull()
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(mounted.save).toHaveBeenCalledOnce()
    expect(screen.queryByText(en['providers.outcome.connected'])).toBeNull()
    expect(screen.queryByText(/Key works/)).toBeNull()
  })
})

describe('adding a provider the profile has not configured', () => {
  const GROQ: DirectoryEntry = { provider: 'groq', displayName: 'Groq', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'groq'], authEnv: ['GROQ_API_KEY'], baseURLEnv: [] }

  it('walks to its key field and saves the key through the same save as Settings', async () => {
    const mounted = await mount({ directory: [...DIRECTORY, GROQ] })
    await click(screen.getByRole('checkbox', { name: /Groq/ }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(screen.getByRole('heading', { level: 3, name: 'Groq' })).toBeTruthy()
    expect(screen.getByRole('link', { name: en['providers.getKey'] }).getAttribute('href')).toBe('https://console.groq.com/keys')
    await type(screen.getByLabelText(en['providers.key']), 'gsk-abc')
    await flush(TEST_DELAY_MS)
    expect(mounted.probe.mock.calls[0]?.[0].provider).toBe('groq')
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(mounted.save.mock.calls[0]?.slice(0, 2)).toEqual([expect.objectContaining({ provider: 'groq', settingsPath: ['providers', 'groq'] }), 'gsk-abc'])
    expect(mounted.guide.providersPhase.getSnapshot()).toBe('summary')
  })

  it('declares an OpenAI-compatible endpoint from a name, an address and a key', async () => {
    const mounted = await mount()
    await click(screen.getByRole('checkbox', { name: new RegExp(en['providers.custom.name']) }))
    await click(screen.getByRole('checkbox', { name: /DeepSeek/ }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    const next = screen.getByRole('button', { name: en['providers.next'] })
    await type(screen.getByLabelText(en['providers.key']), 'sk-abc')
    expect(next.hasAttribute('disabled')).toBe(true)
    await type(screen.getByLabelText(en['providers.custom.nameField']), 'Company gateway')
    await type(screen.getByLabelText(en['providers.baseURL']), 'gateway.example')
    expect(screen.getByText(en['providers.custom.invalid'])).toBeTruthy()
    expect(next.hasAttribute('disabled')).toBe(true)
    await type(screen.getByLabelText(en['providers.baseURL']), 'https://gateway.example/v1')
    await flush(TEST_DELAY_MS)
    expect(mounted.probe.mock.calls[0]?.[2]).toBe('https://gateway.example/v1')
    await click(next)
    expect(mounted.declareCustom).toHaveBeenCalledWith({ name: 'Company gateway', baseURL: 'https://gateway.example/v1', key: 'sk-abc' })
    expect(mounted.save).not.toHaveBeenCalled()
  })

  it('says so when the endpoint was not added', async () => {
    await mount({ declareCustom: false })
    await click(screen.getByRole('checkbox', { name: new RegExp(en['providers.custom.name']) }))
    await click(screen.getByRole('checkbox', { name: /DeepSeek/ }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    await type(screen.getByLabelText(en['providers.key']), 'sk-abc')
    await type(screen.getByLabelText(en['providers.custom.nameField']), 'Gateway')
    await type(screen.getByLabelText(en['providers.baseURL']), 'https://gateway.example/v1')
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(screen.getByText(en['providers.custom.failed'])).toBeTruthy()
  })
})

describe('the summary', () => {
  it('lists each provider as connected, saved or skipped, tests the keys again and goes back to the cards on request', async () => {
    const { guide } = await mount()
    await click(screen.getByRole('checkbox', { name: 'Use OpenAI' }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    await type(screen.getByLabelText(en['providers.key']), 'sk-abc')
    await flush(TEST_DELAY_MS)
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(guide.providersPhase.getSnapshot()).toBe('summary')
    expect(within(screen.getByRole('list', { name: en['providers.summary.label'] })).getAllByRole('listitem').map(item => item.textContent)).toEqual([`DDeepSeek✓ ${en['providers.outcome.connected']}`, `OOpenAI✓ ${en['providers.outcome.connected']}`])
    await click(screen.getByRole('button', { name: en['providers.addAnother'] }))
    expect(guide.providersPhase.getSnapshot()).toBe('landing')
    // The ticks stay, and connecting again walks only what has not ended.
    expect((screen.getByRole('checkbox', { name: 'Use OpenAI' }) as HTMLInputElement).checked).toBe(true)
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    expect(guide.providersPhase.getSnapshot()).toBe('summary')
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

  it('offers Add on a phone too; the studio asks for the unlock', async () => {
    await mountLocal([OLLAMA], true)
    expect(screen.getByRole('button', { name: 'Add Ollama' })).toBeTruthy()
  })

  it('offers nothing when no server answered', async () => {
    await mountLocal([])
    expect(screen.queryByRole('list', { name: en['local.label'] })).toBeNull()
  })
})

describe('a key Delorun already has', () => {
  const FAKE_KEY = 'sk-FAKEFAKE0123456789'
  const found = (source?: KeyTestAnswer['providers'][number]['source']): KeyTestAnswer => ({ providers: [
    { provider: 'deepseek-official', name: 'DeepSeek', result: 'works', ...(source === undefined ? {} : { source }) },
    { provider: 'openai', name: 'OpenAI', result: 'no-key' },
  ] })
  const walk = async (source?: KeyTestAnswer['providers'][number]['source'], change: Parameters<typeof providersFake>[0] = {}) => {
    const mounted = await mount(change, found(source))
    // A ticked provider that still needs a key keeps Connect; the found provider's own screen is the first one walked.
    await click(screen.getByRole('checkbox', { name: 'Use OpenAI' }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    return mounted
  }

  it('says where the key came from on the landing, for each source kind', async () => {
    const cases = [
      [{ kind: 'environment', variable: 'DEEPSEEK_API_KEY' }, 'From DEEPSEEK_API_KEY in the environment Delorun started with'],
      [{ kind: 'saved', variable: 'DEEPSEEK_API_KEY' }, 'Saved by Delorun on this computer as DEEPSEEK_API_KEY'],
      [{ kind: 'project-file', variable: 'DEEPSEEK_API_KEY' }, 'From DEEPSEEK_API_KEY in the .env file of the folder Delorun started in'],
      [{ kind: 'home-file', variable: 'DEEPSEEK_API_KEY' }, 'From DEEPSEEK_API_KEY in the .env file in Delorun\'s home folder'],
      [{ kind: 'unknown' }, 'Delorun already has a key for this provider'],
      [undefined, 'Delorun already has a key for this provider'],
    ] as const
    for (const [source, line] of cases) {
      await mount({}, found(source))
      expect(screen.getByText(line)).toBeTruthy()
      expect(screen.getByText(en['providers.connected'])).toBeTruthy()
      cleanup()
    }
  })

  it('explains how Delorun knows once for the step, however many connected providers it lists', async () => {
    await mount({}, { providers: [
      { provider: 'deepseek-official', name: 'DeepSeek', result: 'works', source: { kind: 'environment', variable: 'DEEPSEEK_API_KEY' } },
      { provider: 'openai', name: 'OpenAI', result: 'works', source: { kind: 'saved', variable: 'OPENAI_API_KEY' } },
    ] })
    expect(screen.getAllByText(en['providers.how'])).toHaveLength(1)
    expect(screen.getAllByText(en['providers.connected'])).toHaveLength(2)
  })

  it('says it on the key\'s own screen too, in the full sentence', async () => {
    await walk({ kind: 'environment', variable: 'DEEPSEEK_API_KEY' })
    expect(screen.getByText('From DEEPSEEK_API_KEY in the environment Delorun started with')).toBeTruthy()
  })

  it('explains behind a disclosure how Delorun knows', async () => {
    await mount({}, found({ kind: 'environment', variable: 'DEEPSEEK_API_KEY' }))
    const summary = screen.getByText(en['providers.how'])
    expect(summary.closest('details')?.hasAttribute('open')).toBe(false)
    expect(screen.getByText(en['providers.how.body']).textContent).toContain('never shows it')
  })

  it('renders no input while the key is found, announces the source, and makes Next the focused primary action', async () => {
    await walk({ kind: 'environment', variable: 'DEEPSEEK_API_KEY' })
    expect(document.body.querySelector('input')).toBeNull()
    expect(document.body.innerHTML).not.toContain(FAKE_KEY)
    expect(screen.getByLabelText('Key saved. From DEEPSEEK_API_KEY in the environment Delorun started with')).toBeTruthy()
    const next = screen.getByRole('button', { name: en['providers.next'] })
    expect(document.activeElement).toBe(next)
    expect(next.hasAttribute('disabled')).toBe(false)
  })

  it('says Found on the host computer, and shows no key, when the studio is open on a paired device', async () => {
    const answer = found({ kind: 'environment', variable: 'DEEPSEEK_API_KEY' })
    await mount({}, answer, true)
    await click(screen.getByRole('checkbox', { name: 'Use OpenAI' }))
    await click(screen.getByRole('button', { name: en['providers.connect'] }))
    expect(screen.getByText(en['providers.found.host'])).toBeTruthy()
    expect(screen.queryByText(en['providers.found'])).toBeNull()
    expect(document.body.querySelector('input')).toBeNull()
    expect(document.body.innerHTML).not.toContain(FAKE_KEY)
    // Pasting a key is still allowed: Replace key opens the field.
    await click(screen.getByRole('button', { name: en['providers.replace'] }))
    expect(screen.getByLabelText(en['providers.key'])).toBeTruthy()
  })

  it('says Key found at the computer itself', async () => {
    await walk({ kind: 'environment', variable: 'DEEPSEEK_API_KEY' })
    expect(screen.getByText(en['providers.found'])).toBeTruthy()
    expect(screen.queryByText(en['providers.found.host'])).toBeNull()
  })

  it('keeps the provider connected, and saves nothing, when Next is pressed untouched', async () => {
    const { save } = await walk({ kind: 'saved' })
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    await click(screen.getByRole('button', { name: en['providers.skipOne'] }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByText(en['providers.outcome.connected'])).toBeTruthy()
  })

  it('shows the input, focused and empty, only after Replace key, and sends the new key', async () => {
    const { save } = await walk({ kind: 'saved' })
    await click(screen.getByRole('button', { name: en['providers.replace'] }))
    const field = screen.getByLabelText(en['providers.key']) as HTMLInputElement
    expect(field.value).toBe('')
    expect(document.activeElement).toBe(field)
    expect(screen.getByRole('button', { name: en['providers.next'] }).hasAttribute('disabled')).toBe(true)
    await type(field, 'sk-new-key')
    await flush(TEST_DELAY_MS)
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(save).toHaveBeenCalledWith(expect.anything(), 'sk-new-key', undefined)
  })

  it('goes back to the found state, with no input, when Replace is cancelled', async () => {
    const { save } = await walk({ kind: 'saved' })
    await click(screen.getByRole('button', { name: en['providers.replace'] }))
    await type(screen.getByLabelText(en['providers.key']), 'sk-half')
    await click(screen.getByRole('button', { name: en['providers.replace.cancel'] }))
    expect(document.body.querySelector('input')).toBeNull()
    expect(screen.getByText(en['providers.found'])).toBeTruthy()
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(save).not.toHaveBeenCalled()
  })

  it('replaces a found key from the landing, then returns to the landing without a summary', async () => {
    const { save } = await mount({}, found({ kind: 'environment', variable: 'DEEPSEEK_API_KEY' }))
    expect(screen.getByText('From DEEPSEEK_API_KEY in the environment Delorun started with')).toBeTruthy()
    await click(screen.getByRole('button', { name: en['providers.replace'] }))
    await type(screen.getByLabelText(en['providers.key']), 'sk-new-key')
    await flush(TEST_DELAY_MS)
    await click(screen.getByRole('button', { name: en['providers.next'] }))
    expect(save).toHaveBeenCalledWith(expect.anything(), 'sk-new-key', undefined)
    expect(screen.queryByText(en['providers.summary.lead'])).toBeNull()
    expect(screen.getByRole('button', { name: en.continue })).toBeTruthy()
  })
})
