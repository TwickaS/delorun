// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_BUNDLES, AgentsStep, LookStep, NoticeStep, PluginsStep, ReachStep, StartStep } from '../src/client/steps.tsx'
import { en } from '../src/client/locales.ts'
import { ACCENT_PRESETS, PALETTE_CHOICES } from '../src/client/previews.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LOCATION_PROBLEMS } from '../src/wire.ts'
import { DEFAULT_WORKSPACE, HOME, installerFake, languageFace, liveForm, LOCALES, noticeFace, schemeFace, startFace, stepServices, THEME } from './fixtures.client.ts'
import type { StartTarget } from '../src/client/types.ts'
import type { ThemeSettings } from '@delo/plugin-theme'

afterEach(cleanup)

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const radio = (name: string | RegExp) => screen.getByRole('radio', { name })
const IDLE_FOLDER = { view: { kind: 'idle' }, added: vi.fn() } as const

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
    expect(screen.getByText(/turns Delo's studio additions off and closes this guide/)).toBeTruthy()
    expect(en['look.studio.lead']).toContain('Settings → Appearance switches between the two')
    expect(en['look.studio.lead']).toContain('with the stock look on, the Delo look row in Settings → General')
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

  it('names each Add button after what it adds, and installs only the bundle whose button is pressed', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'available' }, [codex.name]: { state: 'available' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} />)
    const adds = screen.getAllByRole('button', { name: /^Add / })
    expect(adds.map(each => [each.getAttribute('aria-label'), each.textContent])).toEqual([['Add Claude Code', en['bundle.add']], ['Add Codex', en['bundle.add']]])
    expect(fake.install).not.toHaveBeenCalled()
    await click(screen.getByRole('button', { name: 'Add Codex' }))
    expect(fake.install).toHaveBeenCalledOnce()
    expect(fake.install).toHaveBeenCalledWith(codex.name)
  })

  it.each<readonly [string, 'checking' | 'installing' | 'installed' | 'restart' | 'unavailable' | 'failed', string]>([
    ['is being checked', 'checking', en['bundle.checking']],
    ['is being added', 'installing', en['bundle.adding']],
    ['is added', 'installed', en['bundle.added']],
    ['is added but waits for a restart', 'restart', en['bundle.restart']],
    ['is not included in the installation', 'unavailable', en['bundle.unavailable']],
    ['could not be added', 'failed', en['bundle.failed']],
  ])('shows the state of a bundle that %s and no Add button', (_, state, text) => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} />)
    expect(screen.getAllByText(text).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull()
  })

  it('shows a bundle the installation does not include as a normal state with a way to Plugins, never as an error', async () => {
    const [claude, codex] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'unavailable' }, [codex.name]: { state: 'unavailable' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} />)
    expect(screen.getAllByText('Not included in this installation')).toHaveLength(2)
    expect(document.body.textContent).not.toContain(en['bundle.failed'])
    expect(document.querySelector('[data-tone="failed"]')).toBeNull()
    const opens = screen.getAllByRole('button', { name: 'Open Plugins' })
    expect(opens).toHaveLength(2)
    await click(opens[0] as HTMLElement)
    expect(fake.openPlugins).toHaveBeenCalledOnce()
  })

  it('shows a bundle that failed to be added as an error that Plugins can finish', async () => {
    const [claude] = AGENT_BUNDLES
    const fake = installerFake({ [claude.name]: { state: 'failed' } })
    render(<AgentsStep services={stepServices({ bundles: fake.installer })} />)
    expect(document.querySelector('[data-tone="failed"]')?.textContent).toBe(en['bundle.failed'])
    await click(screen.getByRole('button', { name: 'Open Plugins' }))
    expect(fake.openPlugins).toHaveBeenCalledOnce()
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
    expect(screen.getAllByRole('button', { name: /^Add/ }).map(each => each.getAttribute('aria-label'))).toEqual(['Add With meta'])
    await click(screen.getByRole('button', { name: 'Add With meta' }))
    expect(fake.install).toHaveBeenCalledWith('@scope/with-meta')
  })
})

describe('the reach step', () => {
  it('says what reach does for a phone, the command that turns it on at the computer, and what a phone session cannot do', () => {
    render(<ReachStep services={stepServices()} />)
    expect(document.body.textContent).toContain('open this studio from your phone')
    expect(document.body.textContent).toContain('Turn it on at the computer that runs Delo, in a terminal, never from this window:')
    expect(screen.getByText('delorun reach on tailscale').tagName).toBe('CODE')
    expect(document.body.textContent).toContain('A phone session cannot grant full access or approve devices.')
    expect(document.body.textContent).toContain('You can skip this')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names no relay, no Tailscale option list and no other way to reach', () => {
    render(<ReachStep services={stepServices()} />)
    expect(document.body.textContent).not.toMatch(/relay|domain|public/i)
    for (const [key, text] of Object.entries(en)) if (key.startsWith('reach.')) expect(text).not.toMatch(/relay|中继/i)
  })
})

describe('the start step', () => {
  it.each<readonly [string, StartTarget, readonly string[], readonly string[]]>([
    ['is looking for the default workspace', { kind: 'checking' }, [en['start.lead.checking']], [en['start.point.default'], en['start.point.none']]],
    ['has the default workspace', { kind: 'default', workspaceId: DEFAULT_WORKSPACE }, [en['start.lead.default'], 'you read it, change it if you like, and send it yourself'], [en['start.point.none']]],
    ['finds no default workspace but others', { kind: 'other' }, [en['start.lead.other']], [en['start.point.default'], en['start.point.none']]],
    ['finds no workspace', { kind: 'none' }, ['Delo could not set up a default workspace on this computer.', 'Choose a folder to work in.'], [en['start.point.default']]],
  ])('says what the chat is when it %s', (_, target, shown, absent) => {
    render(<StartStep services={stepServices({ start: startFace(target).face })} folder={IDLE_FOLDER} />)
    for (const text of shown) expect(document.body.textContent).toContain(text)
    for (const text of absent) expect(document.body.textContent).not.toContain(text)
    expect(document.body.textContent).toContain(en['start.later'])
  })

  it('changes its words when the lookup settles', async () => {
    const start = startFace({ kind: 'checking' })
    render(<StartStep services={stepServices({ start: start.face })} folder={IDLE_FOLDER} />)
    await act(async () => { start.set({ kind: 'none' }) })
    expect(document.body.textContent).toContain(en['start.lead.none'])
  })

  it.each(LOCATION_PROBLEMS.map(problem => [problem] as const))('says why a folder refused as %s was not added, and what to do instead', (problem) => {
    render(<StartStep services={stepServices({ start: startFace({ kind: 'none' }).face })} folder={{ view: { kind: 'problem', problem }, added: vi.fn() }} />)
    expect(screen.getByRole('alert').textContent).toBe(en[`problem.${problem}`])
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('says a folder that could not be added was not added', () => {
    render(<StartStep services={stepServices({ start: startFace({ kind: 'none' }).face })} folder={{ view: { kind: 'problem', problem: 'failed' }, added: vi.fn() }} />)
    expect(screen.getByRole('alert').textContent).toBe(en['problem.failed'])
  })

  it('shows its own chooser when asked, and passes the added workspace on', async () => {
    const start = startFace({ kind: 'none' })
    const added = vi.fn()
    render(<StartStep services={stepServices({ start: start.face })} folder={{ view: { kind: 'browse' }, added }} />)
    await act(async () => { await Promise.resolve() })
    await click(screen.getByRole('option', { name: 'projects' }))
    await click(screen.getByRole('button', { name: en['chooser.add'] }))
    expect(start.addFolder).toHaveBeenCalledExactlyOnceWith(`${HOME}/projects`)
    expect(added).toHaveBeenCalledExactlyOnceWith(DEFAULT_WORKSPACE)
  })
})

describe('a set of chips', () => {
  const group = (name: string) => screen.getByRole('radiogroup', { name })
  const radios = (name: string) => within(group(name)).getAllByRole('radio')
  const key = async (element: HTMLElement, name: string) => { await act(async () => { fireEvent.keyDown(element, { key: name }) }) }

  it('is one tab stop, on the chosen chip', () => {
    render(<LookStep services={stepServices()} />)
    for (const name of [en['look.language'], 'Mode', 'Theme', 'Accent', en['look.studio']]) {
      const stops = radios(name).filter(each => each.tabIndex === 0)
      expect(stops).toHaveLength(1)
      expect(stops[0]?.getAttribute('aria-checked')).toBe('true')
    }
  })

  it('puts the tab stop on the first chip when none is chosen', () => {
    const store = createSnapshotStore({ ...LOCALES, active: 'fr' })
    render(<LookStep services={stepServices({ language: { getSnapshot: store.getSnapshot, subscribe: store.subscribe, setLocale: vi.fn() } })} />)
    expect(radios(en['look.language']).map(each => each.tabIndex)).toEqual([0, -1])
  })

  it('moves to the next and previous chip with the arrow keys, wrapping, and chooses it', async () => {
    const { face, set } = schemeFace('light')
    render(<LookStep services={stepServices({ scheme: face })} />)
    const [light, dark, system] = radios('Mode') as [HTMLElement, HTMLElement, HTMLElement]
    light.focus()
    await key(light, 'ArrowRight')
    expect(document.activeElement).toBe(dark)
    expect(set).toHaveBeenLastCalledWith('dark')
    await key(dark, 'ArrowDown')
    expect(set).toHaveBeenLastCalledWith('system')
    await key(system, 'ArrowDown')
    expect(document.activeElement).toBe(light)
    expect(set).toHaveBeenLastCalledWith('light')
    await key(light, 'ArrowLeft')
    expect(document.activeElement).toBe(system)
    await key(system, 'ArrowUp')
    expect(document.activeElement).toBe(dark)
    expect(dark.tabIndex).toBe(0)
    expect([light.tabIndex, system.tabIndex]).toEqual([-1, -1])
  })

  it('moves to the first and last chip with Home and End, and leaves a chosen chip as it is', async () => {
    const { face, set } = schemeFace('light')
    render(<LookStep services={stepServices({ scheme: face })} />)
    const [light, , system] = radios('Mode') as [HTMLElement, HTMLElement, HTMLElement]
    await key(light, 'End')
    expect(document.activeElement).toBe(system)
    expect(set).toHaveBeenCalledExactlyOnceWith('system')
    await key(system, 'Home')
    expect(document.activeElement).toBe(light)
    expect(set).toHaveBeenLastCalledWith('light')
    set.mockClear()
    await key(light, 'Home')
    expect(set).not.toHaveBeenCalled()
  })

  it('only moves focus in the studio look set, so an arrow key never leaves Delo\'s look', async () => {
    const useStockLook = vi.fn(() => Promise.resolve(true))
    render(<LookStep services={stepServices({ look: { settings: liveForm<ThemeSettings>(THEME).form, useStockLook } })} />)
    const [delo, stock] = radios(en['look.studio']) as [HTMLElement, HTMLElement]
    delo.focus()
    await key(delo, 'ArrowRight')
    expect(document.activeElement).toBe(stock)
    expect(useStockLook).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(stock) })
    expect(useStockLook).toHaveBeenCalledOnce()
  })

  it('gives a set whose chips cannot be chosen no tab stop', () => {
    const waiting = liveForm<ThemeSettings>(undefined, { writable: false })
    render(<LookStep services={stepServices({ look: { settings: waiting.form, useStockLook: () => Promise.resolve(true) } })} />)
    for (const name of ['Theme', 'Accent', en['look.studio']]) expect(radios(name).every(each => each.tabIndex === -1)).toBe(true)
    expect(radios(en['look.language']).map(each => each.tabIndex)).toEqual([0, -1])
  })

  it('ignores other keys, and keys that do not come from a chip', async () => {
    const { face, set } = schemeFace('light')
    render(<LookStep services={stepServices({ scheme: face })} />)
    const [light] = radios('Mode') as [HTMLElement]
    await key(light, 'a')
    await key(group('Mode'), 'ArrowRight')
    expect(set).not.toHaveBeenCalled()
  })
})
