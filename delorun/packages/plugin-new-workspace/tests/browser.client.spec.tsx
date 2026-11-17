// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BrowserReadiness } from '@delorun/browser-setup'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { NewWorkspaceDialog } from '../src/client/NewWorkspaceDialog.tsx'
import { CATALOG, fakeApi, fakeBrowse, fakeBrowser, fakeFullAccess, HOME, NOW, t } from './fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const settle = async () => { await act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }) }
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }); await settle() }
const type = async (element: HTMLElement, value: string) => { await act(async () => { fireEvent.change(element, { target: { value } }) }); await settle() }
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
const heading = () => screen.getByRole('heading', { level: 2 }).textContent
const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) }) as HTMLInputElement

const SITE = `${HOME}/Projects/site`

/** The dialog over a fake Host, on the browser screen of a new folder called `site`. */
async function atBrowser(readiness?: BrowserReadiness, shell = true) {
  const fake = fakeApi()
  const shown = fakeBrowser(readiness, shell)
  const onCreated = vi.fn()
  render(<NewWorkspaceDialog t={t} api={fake.api} browse={fakeBrowse().browse} readModels={async () => CATALOG} fullAccess={fakeFullAccess().fullAccess}
    browser={shown.browser} from="sidebar" onClose={vi.fn()} onCreated={onCreated} wait={async () => {}} now={() => NOW} />)
  await settle()
  await click(button(/^New folder/))
  await click(button(en.continue))
  await type(screen.getByLabelText(en['new.name']), 'site')
  await click(button(en.continue))
  return { ...fake, ...shown, onCreated }
}

describe('the browser screen', () => {
  it('is step 3, between the place and the model, and asks the workspace\'s own question', async () => {
    await atBrowser()
    expect(heading()).toBe('New workspace · Browser')
    expect(screen.getByText('Step 3 of 5')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Can agents in this workspace use a web browser?')
    expect(button(en.createNow).disabled).toBe(false)
    await click(button(en.continue))
    expect(heading()).toBe('New workspace · Model')
    await click(button(en.back))
    await click(button(en.back))
    expect(heading()).toBe('New workspace · New folder')
  })

  it('shows the third choice disabled with its preview chip, and choosing it records nothing', async () => {
    const { setDefaults } = await atBrowser()
    const mine = radio(en['browser.choice.mine.title'])
    expect(mine.disabled).toBe(true)
    expect(mine.checked).toBe(false)
    expect(screen.getByText(en['previewFlag.chip'])).toBeTruthy()
    await click(mine)
    expect(radio(en['browser.choice.isolated.title']).checked).toBe(true)
    await click(button(en.createNow))
    expect(setDefaults).toHaveBeenCalledExactlyOnceWith(SITE, expect.objectContaining({ browser: 'isolated' }))
  })

  it('follows the readiness while it loads until the person picks, and a pick sticks', async () => {
    const { set } = await atBrowser({ kind: 'checking' })
    expect(radio(en['browser.choice.none.title']).checked).toBe(true)
    await act(async () => { set({ kind: 'ready' }) })
    expect(radio(en['browser.choice.isolated.title']).checked).toBe(true)
    await act(async () => { set({ kind: 'not-added' }) })
    expect(radio(en['browser.choice.none.title']).checked).toBe(true)
    await act(async () => { set({ kind: 'needs-setup', reason: 'Chrome is missing', fix: { kind: 'docs', url: 'https://example.com/chrome' } }) })
    expect(radio(en['browser.choice.isolated.title']).checked).toBe(true)
    await click(radio(en['browser.choice.none.title']))
    await act(async () => { set({ kind: 'ready' }) })
    expect(radio(en['browser.choice.none.title']).checked).toBe(true)
  })

  it('stores the pick with the model in one call', async () => {
    const { setDefaults, onCreated } = await atBrowser()
    await click(radio(en['browser.choice.none.title']))
    await click(button(en.createNow))
    expect(setDefaults).toHaveBeenCalledExactlyOnceWith(SITE, { model: { provider: 'deepseek', model: 'deepseek-pro', reasoningEffort: 'high' }, browser: 'none' })
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('keeps the pick across the model and safety screens and stores it from the last one', async () => {
    const { setDefaults } = await atBrowser({ kind: 'not-added' })
    await click(radio(en['browser.choice.isolated.title']))
    await click(button(en.continue))
    await click(button(en.continue))
    await click(button(en.create))
    expect(setDefaults).toHaveBeenCalledExactlyOnceWith(SITE, expect.objectContaining({ browser: 'isolated' }))
  })

  it('says the Browser plugin is off when the home has not added it, and opens the Plugins page', async () => {
    const { open } = await atBrowser({ kind: 'not-added' })
    await click(radio(en['browser.choice.isolated.title']))
    expect(screen.getByText(en['browser.notAdded'])).toBeTruthy()
    await click(button(en['browser.openPlugins']))
    expect(open).toHaveBeenCalledExactlyOnceWith('plugins')
  })

  it('offers no Plugins button on a page without a Settings shell', async () => {
    await atBrowser({ kind: 'not-added' }, false)
    await click(radio(en['browser.choice.isolated.title']))
    expect(screen.getByText(en['browser.notAdded'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en['browser.openPlugins'] })).toBeNull()
  })

  it('opens the Settings section a need is met in', async () => {
    const { open } = await atBrowser({ kind: 'needs-setup', reason: 'Chrome is missing', fix: { kind: 'settings', section: 'browser' } })
    await click(button(en['browser.fix.settings']))
    expect(open).toHaveBeenCalledExactlyOnceWith('browser')
  })

  it('reads the readiness when it opens and when the window regains focus, and Try again reads it too', async () => {
    const { refresh } = await atBrowser({ kind: 'failed' })
    await click(radio(en['browser.choice.isolated.title']))
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(refresh).toHaveBeenCalledTimes(2)
    await click(button(en['browser.retry']))
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('stops reading on focus once the screen is left', async () => {
    const { refresh } = await atBrowser()
    await click(button(en.continue))
    refresh.mockClear()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('holds the choices while the workspace is being made', async () => {
    const fake = fakeApi({ create: () => new Promise(() => {}) })
    const shown = fakeBrowser()
    render(<NewWorkspaceDialog t={t} api={fake.api} browse={fakeBrowse().browse} readModels={async () => CATALOG} fullAccess={fakeFullAccess().fullAccess}
      browser={shown.browser} from="sidebar" onClose={vi.fn()} onCreated={vi.fn()} wait={async () => {}} now={() => NOW} />)
    await settle()
    await click(button(/^New folder/))
    await click(button(en.continue))
    await type(screen.getByLabelText(en['new.name']), 'site')
    await click(button(en.continue))
    await click(button(en.createNow))
    expect(radio(en['browser.choice.none.title']).disabled).toBe(true)
  })
})
