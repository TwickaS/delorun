// @vitest-environment jsdom
/**
 * The shared Browser choice: the readiness narrowed from the Host's requirement check, and the component that draws
 * the two choices, the planned third one that can never be chosen, and whether Browser is ready. Each denial test's
 * comment names the check whose removal makes it fail.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { RequirementsAnswer } from '@delorun/bundle-local/requirements-api'
import { BROWSER_BUNDLE, browserAdded, browserReadinessOf, BrowserChoices, createBrowserSetup, en, zh, type BrowserChoicesProps, type BrowserReadiness, type BrowserTranslate } from '../src/client/index.ts'

afterEach(cleanup)

const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element) }) }
const t: BrowserTranslate = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, value), en[key] as string)

const ROW = 'browser-use-playwright-mcp'
const NEEDS_COMMAND: BrowserReadiness = { kind: 'needs-setup', reason: 'Needs the Chromium build downloaded', fix: { kind: 'command', command: 'delorun browser install' } }

/** Render the choices with spies for every callback. */
function show(change: Partial<BrowserChoicesProps> = {}) {
  const onChoice = vi.fn()
  const onRetry = vi.fn()
  const onOpenSettings = vi.fn()
  const props: BrowserChoicesProps = { t, choice: 'isolated', onChoice, readiness: { kind: 'ready' }, planned: false, onRetry, onOpenSettings, ...change }
  return { ...render(<BrowserChoices {...props} />), onChoice, onRetry, onOpenSettings }
}

const radios = (): HTMLInputElement[] => screen.getAllByRole('radio') as HTMLInputElement[]
const named = (radio: HTMLInputElement): string => document.getElementById(radio.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''

describe('Browser\'s readiness, narrowed from the Host\'s requirement check', () => {
  const answer = (rows: RequirementsAnswer['rows'], problems: RequirementsAnswer['problems'] = []): RequirementsAnswer => ({ rows, problems })

  it('is ready when every row of the pack is, and not added when the Host lists none', () => {
    expect(browserReadinessOf(answer([{ packageName: BROWSER_BUNDLE, rowId: ROW, state: 'ready' }]))).toEqual({ kind: 'ready' })
    expect(browserReadinessOf(answer([{ packageName: '@delorun/bundle-other', rowId: 'row', state: 'needs-setup', reason: 'Needs x installed', fix: { kind: 'docs', url: 'https://example.test' } }]))).toEqual({ kind: 'not-added' })
    expect(browserReadinessOf(answer([]))).toEqual({ kind: 'not-added' })
  })

  it('carries the Host\'s reason and fix for the first row that needs setup, whatever they are', () => {
    const fix = { kind: 'command', command: 'npx playwright install chromium' } as const
    expect(browserReadinessOf(answer([
      { packageName: BROWSER_BUNDLE, rowId: 'browser-use', state: 'ready' },
      { packageName: BROWSER_BUNDLE, rowId: ROW, state: 'needs-setup', reason: 'Needs Chromium downloaded', fix },
    ]))).toEqual({ kind: 'needs-setup', reason: 'Needs Chromium downloaded', fix })
  })

  it('reports a declaration the Host could not read', () => {
    expect(browserReadinessOf(answer([], [{ packageName: BROWSER_BUNDLE, message: 'bad needs' }]))).toEqual({ kind: 'problem', message: 'bad needs' })
  })

  it('counts the pack as added for every state the Host reports about it', () => {
    expect(([{ kind: 'ready' }, NEEDS_COMMAND, { kind: 'problem', message: 'x' }] as BrowserReadiness[]).map(browserAdded)).toEqual([true, true, true])
    expect(([{ kind: 'checking' }, { kind: 'not-added' }, { kind: 'failed' }] as BrowserReadiness[]).map(browserAdded)).toEqual([false, false, false])
  })

  it('asks the check in the studio\'s language, shares one request between overlapping reads and tells its listeners', async () => {
    const urls: string[] = []
    let language = 'en'
    const store = createBrowserSetup(async (input) => {
      urls.push(input)
      return new Response(JSON.stringify(answer([{ packageName: BROWSER_BUNDLE, rowId: ROW, state: 'ready' }])), { status: 200 })
    }, () => language)
    expect(store.getSnapshot()).toEqual({ kind: 'checking' })
    const [first, second] = await Promise.all([store.refresh(), store.refresh()])
    expect([first, second, store.getSnapshot()]).toEqual([{ kind: 'ready' }, { kind: 'ready' }, { kind: 'ready' }])
    language = 'zh-CN'
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    await store.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    await store.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(urls.slice(0, 2)).toEqual(['/api/delorunRequirements.check?language=en', '/api/delorunRequirements.check?language=zh'])
  })

  it('is failed, with a warning, when the check cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createBrowserSetup(async () => new Response('{}', { status: 500 }), () => 'en')
    expect(await store.refresh()).toEqual({ kind: 'failed' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('the Browser choices', () => {
  it('draws the isolated browser and no browser as one radio group, with the choice in effect checked', () => {
    show({ choice: 'none' })
    const group = screen.getByRole('radiogroup', { name: en['browser.which'] })
    expect(within(group).getAllByRole('radio')).toHaveLength(2)
    expect(radios().map(radio => [named(radio), radio.checked, radio.disabled])).toEqual([['Isolated browser', false, false], ['No browser', true, false]])
    expect(screen.queryByText(en['browser.choice.mine.title'])).toBeNull()
    expect(screen.queryByText(en['previewFlag.chip'])).toBeNull()
  })

  it('tells the caller the choice and changes nothing itself', async () => {
    const { onChoice } = show({ choice: 'none' })
    await click(radios()[0] as HTMLInputElement)
    expect(onChoice).toHaveBeenCalledExactlyOnceWith('isolated')
    // The caller holds the choice: until it passes another, the group shows the one in effect.
    expect(radios().map(radio => radio.checked)).toEqual([false, true])
  })

  it('takes the caller\'s question in place of the home-wide one', () => {
    show({ heading: 'Can agents in this workspace use a web browser?' })
    expect(screen.getByRole('radiogroup', { name: 'Can agents in this workspace use a web browser?' })).toBeTruthy()
    expect(screen.queryByText(en['browser.which'])).toBeNull()
  })

  it('refuses a change while disabled', () => {
    show({ disabled: true })
    expect(radios().map(radio => radio.disabled)).toEqual([true, true])
  })

  it('shows Use my browser as a third choice that cannot be chosen, with the Preview chip beside its title', async () => {
    // Pins the disabled radio: the choice is not built, so nothing may select it or report it.
    const { onChoice } = show({ planned: true, choice: 'none' })
    const [, , mine] = radios()
    expect(radios()).toHaveLength(3)
    expect([named(mine as HTMLInputElement), mine?.disabled, mine?.checked]).toEqual(['Use my browser', true, false])
    await click(mine as HTMLInputElement)
    expect(onChoice).not.toHaveBeenCalled()
    expect(radios().map(radio => radio.checked)).toEqual([false, true, false])
    expect(screen.getByText(en['browser.choice.mine.text']).textContent).toBe('Your Chrome with your sign-ins, approved per chat.')
    const chips = screen.getAllByText('Preview')
    expect(chips).toHaveLength(1)
    expect(chips[0]?.closest('[data-planned]')?.textContent).toContain('Use my browser')
    fireEvent.focus(chips[0] as HTMLElement)
    expect((await screen.findByRole('tooltip')).textContent).toBe('Planned and not built yet, so it cannot be chosen.')
  })

  it('says Browser is ready while the isolated browser is chosen, and nothing about readiness for no browser', () => {
    const view = show()
    expect(screen.getByText(en['browser.ready'])).toBeTruthy()
    view.rerender(<BrowserChoices t={t} choice="none" onChoice={() => {}} readiness={NEEDS_COMMAND} planned={false} onRetry={() => {}} onOpenSettings={() => {}} />)
    expect(screen.queryByText(en['browser.ready'])).toBeNull()
    expect(screen.queryByText(/^Needs setup/)).toBeNull()
  })

  it('shows the Host\'s reason as "Needs setup · reason" with its command, and says whether the copy worked', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    show({ readiness: NEEDS_COMMAND })
    expect(screen.getByText('Needs setup · Needs the Chromium build downloaded')).toBeTruthy()
    expect(screen.getByText('delorun browser install').tagName).toBe('CODE')
    await click(screen.getByRole('button', { name: 'Copy delorun browser install' }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('delorun browser install')
    expect(screen.getByText(en['browser.copy.done'])).toBeTruthy()
    writeText.mockImplementationOnce(() => Promise.reject(new Error('denied')))
    await click(screen.getByRole('button', { name: 'Copy delorun browser install' }))
    expect(screen.getByText(en['browser.copy.failed'])).toBeTruthy()
  })

  it('links to the page that says how, and opens the Settings section a need is met in', async () => {
    const view = show({ readiness: { kind: 'needs-setup', reason: 'Needs Chrome or Chromium installed', fix: { kind: 'docs', url: 'https://www.google.com/chrome/' } } })
    const link = screen.getByRole('link', { name: en['browser.fix.docs'] })
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['https://www.google.com/chrome/', '_blank', 'noopener noreferrer'])
    view.unmount()
    const { onOpenSettings } = show({ readiness: { kind: 'needs-setup', reason: 'Needs BROWSER_KEY set', fix: { kind: 'settings', section: 'models' } } })
    await click(screen.getByRole('button', { name: en['browser.fix.settings'] }))
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith('models')
  })

  it('offers no control for the own-browser pairing fix, which belongs to the Plugins panel', () => {
    show({ readiness: { kind: 'needs-setup', reason: 'Needs the extension paired', fix: { kind: 'browse-pair', extension: 'browse-extension' } } })
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button', { name: en['browser.fix.settings'] })).toBeNull()
  })

  it.each<readonly [string, BrowserReadiness, string]>([
    ['is being checked', { kind: 'checking' }, en['browser.checking']],
    ['could not be read', { kind: 'problem', message: 'bad needs' }, 'Delorun could not read what Browser needs: bad needs'],
  ])('says when Browser %s', (_, readiness, text) => {
    show({ readiness })
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('offers Try again when the check cannot be read', async () => {
    const { onRetry } = show({ readiness: { kind: 'failed' } })
    expect(screen.getByText(en['browser.unread'])).toBeTruthy()
    await click(screen.getByRole('button', { name: en['browser.retry'] }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('draws the caller\'s own line while Browser is not in the profile, and nothing without one', () => {
    const line: ReactNode = <p>Turn Browser on for this home</p>
    const view = show({ readiness: { kind: 'not-added' }, notAdded: line })
    expect(screen.getByText('Turn Browser on for this home')).toBeTruthy()
    view.unmount()
    show({ readiness: { kind: 'not-added' } })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('has both languages for every key, with the same placeholders', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(placeholders(zh[key])).toEqual(placeholders(en[key]))
  })
})
