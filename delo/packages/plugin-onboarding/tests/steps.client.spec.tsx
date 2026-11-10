// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_BUNDLES, AgentsStep, LookStep, NoticeStep, PluginsStep, ReachStep, StartStep } from '../src/client/steps.tsx'
import { en } from '../src/client/locales.ts'
import { ACCENT_PRESETS, PALETTE_CHOICES } from '../src/client/previews.ts'
import { installerFake, languageFace, liveForm, noticeFace, schemeFace, stepServices, THEME } from './fixtures.client.ts'
import type { ThemeSettings } from '@delo/plugin-theme'

afterEach(cleanup)

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const radio = (name: string | RegExp) => screen.getByRole('radio', { name })

describe('the look step', () => {
  it('lists the languages as chips and switches the interface language when one is chosen', async () => {
    const { face, setLocale } = languageFace()
    render(<LookStep services={stepServices({ language: face })} />)
    const group = screen.getByRole('radiogroup', { name: en['look.language'] })
    expect(within(group).getAllByRole('radio').map(each => [each.textContent, each.getAttribute('aria-checked')])).toEqual([['English', 'true'], ['中文', 'false']])
    await click(radio('中文'))
    expect(setLocale).toHaveBeenCalledWith('zh')
    expect(radio('中文').getAttribute('aria-checked')).toBe('true')
  })

  it('offers light, dark and system and sets the colour scheme', async () => {
    const { face, set } = schemeFace('system')
    render(<LookStep services={stepServices({ scheme: face })} />)
    const group = screen.getByRole('radiogroup', { name: 'Mode' })
    expect(within(group).getAllByRole('radio').map(each => [each.textContent, each.getAttribute('aria-checked')])).toEqual([['Light', 'false'], ['Dark', 'false'], ['System', 'true']])
    await click(radio('Dark'))
    expect(set).toHaveBeenCalledWith('dark')
  })

  it('shows every palette the theme has as a chip with its preview and writes the one chosen', async () => {
    const services = stepServices()
    render(<LookStep services={services} />)
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    const chips = within(group).getAllByRole('radio')
    expect(chips.map(each => each.textContent)).toEqual(['Soft', 'T3 Code', 'T3 Chat', 'Grove', 'Ocean', 'Ember', 'Iris'])
    expect(PALETTE_CHOICES).toHaveLength(chips.length)
    expect(chips.every(each => each.querySelector('[aria-hidden="true"]') !== null)).toBe(true)
    expect(radio('Soft').getAttribute('aria-checked')).toBe('true')
    await click(radio('Soft'))
    expect(services.look.settings.getSnapshot().value?.palette).toBe('soft')
    await click(radio('Iris'))
    expect(services.look.settings.getSnapshot().value?.palette).toBe('iris')
    expect(radio('Iris').getAttribute('aria-checked')).toBe('true')
  })

  it('offers the accent presets with the Soft palette, writes the one chosen, and replaces them with a note for a theme that brings its own', async () => {
    const services = stepServices()
    render(<LookStep services={services} />)
    const group = screen.getByRole('radiogroup', { name: 'Accent' })
    expect(within(group).getAllByRole('radio').map(each => each.textContent)).toEqual(['Peach', 'Cobalt', 'Moss', 'Mono'])
    expect(ACCENT_PRESETS).toHaveLength(4)
    await click(radio('Peach'))
    await click(radio('Cobalt'))
    expect(services.look.settings.getSnapshot().value?.accent).toBe('cobalt')
    await click(radio('Grove'))
    expect(screen.queryByRole('radiogroup', { name: 'Accent' })).toBeNull()
    expect(screen.getByText(/Set by the theme/)).toBeTruthy()
  })

  it('starts from Soft and Peach until the theme settings arrive, and disables the choices it cannot save', () => {
    const waiting = liveForm<ThemeSettings>(undefined, { writable: false })
    render(<LookStep services={stepServices({ look: { settings: waiting.form, useStockLook: () => Promise.resolve(true) } })} />)
    expect(radio('Soft').getAttribute('aria-checked')).toBe('true')
    expect(radio('Peach').getAttribute('aria-checked')).toBe('true')
    expect([radio('Iris'), radio('Cobalt'), radio('Stock')].every(each => (each as HTMLButtonElement).disabled)).toBe(true)
    expect((radio('English') as HTMLButtonElement).disabled).toBe(false)
  })

  it('says, before the choice, that the stock look turns Delo\'s additions and this guide off, and switches only when it is chosen', async () => {
    const useStockLook = vi.fn(() => Promise.resolve(true))
    render(<LookStep services={stepServices({ look: { settings: liveForm<ThemeSettings>(THEME).form, useStockLook } })} />)
    const group = screen.getByRole('radiogroup', { name: en['look.studio'] })
    expect(within(group).getAllByRole('radio').map(each => [each.textContent, each.getAttribute('aria-checked')])).toEqual([['Delo', 'true'], ['Stock', 'false']])
    expect(screen.getByText(/turns Delo's studio additions off, which removes this guide/)).toBeTruthy()
    expect(useStockLook).not.toHaveBeenCalled()
    await click(radio('Delo'))
    expect(useStockLook).not.toHaveBeenCalled()
    await click(radio('Stock'))
    expect(useStockLook).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each<readonly [string, () => Promise<boolean>]>([
    ['refuses the write', () => Promise.resolve(false)],
    ['cannot be reached', () => Promise.reject(new Error('transport'))],
  ])('shows a failure and keeps the choice open when the host %s', async (_, write) => {
    render(<LookStep services={stepServices({ look: { settings: liveForm<ThemeSettings>(THEME).form, useStockLook: write } })} />)
    await click(radio('Stock'))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
  })

  it.each<readonly [string, boolean | 'reject', string]>([
    ['refuses a palette', false, 'Iris'],
    ['cannot be reached for a palette', 'reject', 'Iris'],
    ['refuses an accent', false, 'Cobalt'],
    ['cannot be reached for an accent', 'reject', 'Cobalt'],
  ])('shows a failure when the host %s', async (_, result, choice) => {
    const form = liveForm<ThemeSettings>(THEME, { result })
    render(<LookStep services={stepServices({ look: { settings: form.form, useStockLook: () => Promise.resolve(true) } })} />)
    await click(radio(choice))
    expect(screen.getByRole('alert').textContent).toBe(en.saveFailed)
  })

  it('clears a failure on the next attempt', async () => {
    const form = liveForm<ThemeSettings>(THEME, { result: false })
    render(<LookStep services={stepServices({ look: { settings: form.form, useStockLook: () => Promise.resolve(true) } })} />)
    await click(radio('Cobalt'))
    expect(screen.getByRole('alert')).toBeTruthy()
    form.set.mockImplementationOnce(() => Promise.resolve(true))
    await click(radio('Moss'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the preview notice step', () => {
  it('shows the notice paragraphs unchanged, and nothing without a notice', () => {
    const { face } = noticeFace()
    render(<NoticeStep services={stepServices({ notice: face })} />)
    expect(screen.getAllByText(/Delo is a pre-release|no telemetry/)).toHaveLength(2)
    cleanup()
    const { container } = render(<NoticeStep services={stepServices()} />)
    expect(container.textContent).toBe('')
  })
})

describe('the agents step', () => {
  it('names Claude Code and Codex as programs with their own permissions outside Delo\'s prompts, and claims no consent', () => {
    const services = stepServices()
    render(<AgentsStep services={services} />)
    const note = screen.getByRole('note').textContent ?? ''
    expect(note).toContain('Claude Code and Codex run as their own programs, with their own permissions, outside Delo\'s permission prompts')
    expect(document.body.textContent).not.toMatch(/consent|ask you first/i)
    expect(screen.getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual(['Claude Code', 'Codex'])
  })

  it('reads where the two bundles stand when it opens and installs nothing', () => {
    const services = stepServices()
    render(<AgentsStep services={services} />)
    expect(services.spies.refresh).toHaveBeenCalledWith(AGENT_BUNDLES.map(each => each.name))
    expect(services.spies.install).not.toHaveBeenCalled()
    expect(AGENT_BUNDLES.map(each => each.name)).toEqual(['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex'])
  })

  it('installs only the bundle whose Add button is pressed', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' }, [codex.name]: { state: 'available' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} />)
    const adds = screen.getAllByRole('button', { name: en['bundle.add'] })
    expect(adds).toHaveLength(2)
    expect(fake.install).not.toHaveBeenCalled()
    await click(adds[1] as HTMLElement)
    expect(fake.install).toHaveBeenCalledOnce()
    expect(fake.install).toHaveBeenCalledWith(codex.name)
  })

  it.each<readonly [string, 'checking' | 'installing' | 'installed' | 'restart' | 'unavailable' | 'failed', string]>([
    ['is being checked', 'checking', en['bundle.checking']],
    ['is being added', 'installing', en['bundle.adding']],
    ['is added', 'installed', en['bundle.added']],
    ['is added but waits for a restart', 'restart', en['bundle.restart']],
    ['is not offered by the installation', 'unavailable', en['bundle.unavailable']],
    ['could not be added', 'failed', en['bundle.failed']],
  ])('shows the state of a bundle that %s and no Add button', (_, state, text) => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} />)
    expect(screen.getAllByText(text).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: en['bundle.add'] })).toBeNull()
  })

  it('shows Checking until a bundle is first read, and opens Plugins for a bundle that could not be added', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [codex.name]: { state: 'failed' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} />)
    expect(screen.getAllByText(en['bundle.checking'])).toHaveLength(1)
    expect(claude.name).toBeTruthy()
    await click(screen.getByRole('button', { name: en['bundle.open'] }))
    expect(fake.openPlugins).toHaveBeenCalledOnce()
  })
})

describe('the recommended plugins step', () => {
  it('lists the configured packages with the title and description the plugin manager gives, and the package name without them', async () => {
    const fake = installerFake({
      '@scope/with-meta': { state: 'available', title: { en: 'With meta', zh: '带元数据' }, description: 'Does a thing.' },
      '@scope/plain': { state: 'installed' },
    })
    render(<PluginsStep services={stepServices({ bundles: fake.installer, plugins: ['@scope/with-meta', '@scope/plain', '@scope/unread'] })} />)
    expect(fake.refresh).toHaveBeenCalledWith(['@scope/with-meta', '@scope/plain', '@scope/unread'])
    expect(screen.getAllByRole('heading', { level: 4 }).map(each => each.textContent)).toEqual(['With meta', '@scope/plain', '@scope/unread'])
    expect(screen.getByText('Does a thing.')).toBeTruthy()
    expect(fake.install).not.toHaveBeenCalled()
    await click(screen.getByRole('button', { name: en['bundle.add'] }))
    expect(fake.install).toHaveBeenCalledWith('@scope/with-meta')
  })
})

describe('the reach and start steps', () => {
  it('explain reach without a command line: where it is set up, the options, and that it can wait', () => {
    render(<ReachStep services={stepServices()} />)
    expect(document.body.textContent).toContain('You set it up at the computer that runs Delo, in a terminal, never from this window.')
    expect(document.body.textContent).toContain('None of them uses Delo\'s servers.')
    expect(document.body.textContent).toContain('You can skip this')
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.body.textContent).not.toMatch(/delorun/)
  })

  it('say that the last button opens a chat whose starting prompts only write into the message box', () => {
    render(<StartStep services={stepServices()} />)
    expect(document.body.textContent).toContain('Delo opens a new chat in your default workspace.')
    expect(document.body.textContent).toContain('you read it, change it if you like, and send it yourself')
  })
})
