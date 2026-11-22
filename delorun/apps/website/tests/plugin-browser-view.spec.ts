// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import data from '../src/plugin-browser/plugins.generated.json'
import { PluginBrowser } from '../src/plugin-browser/PluginBrowser.tsx'
import { ENGLISH_WORDS } from '../src/plugin-browser/words.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('the plugin browser without scripts', () => {
  const html = renderToStaticMarkup(createElement(PluginBrowser, { words: ENGLISH_WORDS }))

  it('prints every plugin\'s title and sentence as text, and no tabs', () => {
    for (const plugin of data.plugins) {
      expect(html).toContain(plugin.title.replaceAll("'", '&#x27;'))
      expect(html).toContain(plugin.sentence.replaceAll("'", '&#x27;'))
    }
    expect(html).not.toContain('role="tablist"')
  })

  it('prints the list as terms and descriptions, with no box of its own to scroll', () => {
    expect(html.match(/<dt [^>]*data-plugin-term/g)).toHaveLength(data.plugins.length)
    expect(html.match(/<dl /g)?.length).toBeGreaterThan(0)
    expect(html).not.toContain('tabindex')
  })

  it('prints what each pack needs and the files each kind of plugin starts with', () => {
    expect(html).toContain('typescript-language-server installed')
    for (const paths of Object.values(data.scaffold)) for (const path of paths) expect(html).toContain(path)
  })

  it('keeps each kind\'s files in a collapsed disclosure and each file apart from its note', () => {
    expect(html.match(/<details/g)).toHaveLength(Object.keys(data.scaffold).length)
    expect(html).not.toContain('<details open')
    expect(html).toContain('<dt><code>package.json</code></dt><dd>')
    expect(html).not.toContain('</code><span>')
  })
})

describe('the plugin browser with scripts', () => {
  let host: HTMLElement
  let root: Root
  beforeEach(async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root.render(createElement(PluginBrowser, { words: ENGLISH_WORDS })) })
  })
  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
  })

  const press = async (element: Element, key: string) => { await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) }) }
  const detailTitle = () => host.querySelector('[aria-live="polite"] h3')?.textContent

  it('shows the first plugin\'s detail and moves with the arrow keys', async () => {
    const first = data.plugins[0]!
    const second = data.plugins[1]!
    expect(detailTitle()).toBe(first.title)
    const row = host.querySelector(`[id="plugin-row-${first.name}"]`)!
    await press(row, 'ArrowDown')
    expect(detailTitle()).toBe(second.title)
    expect(host.querySelector(`[id="plugin-row-${second.name}"]`)?.getAttribute('aria-current')).toBe('true')
    await press(host.querySelector(`[id="plugin-row-${second.name}"]`)!, 'End')
    expect(detailTitle()).toBe(data.plugins.at(-1)!.title)
  })

  const rows = () => [...host.querySelectorAll<HTMLButtonElement>('[id^="plugin-row-"]')]
  const showAll = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === ENGLISH_WORDS.showAll(data.plugins.length))

  it('shows the first rows and a control for the rest, which then takes the focus to the next row', async () => {
    expect(rows()).toHaveLength(8)
    const control = showAll()
    expect(control).toBeDefined()
    await act(async () => { control!.click() })
    expect(rows()).toHaveLength(data.plugins.length)
    expect(showAll()).toBeUndefined()
    expect(document.activeElement?.id).toBe(`plugin-row-${data.plugins[8]!.name}`)
    await press(document.activeElement!, 'ArrowDown')
    expect(detailTitle()).toBe(data.plugins[9]!.title)
    expect(document.activeElement?.id).toBe(`plugin-row-${data.plugins[9]!.name}`)
  })

  it('updates the detail for every row chosen, opens it under the row and keeps each full title', async () => {
    expect(host.querySelector('li > [id^="plugin-row-"] + div')).toBeNull()
    await act(async () => { showAll()!.click() })
    for (const plugin of data.plugins) {
      const row = host.querySelector<HTMLButtonElement>(`[id="plugin-row-${plugin.name}"]`)!
      await act(async () => { row.click() })
      expect(detailTitle()).toBe(plugin.title)
      expect(row.nextElementSibling?.querySelector('h3')?.textContent).toBe(plugin.title)
      expect(row.getAttribute('title')).toBe(plugin.title)
      expect(row.getAttribute('aria-current')).toBe('true')
    }
  })

  it('shows the whole list when a key moves past the first rows', async () => {
    await press(rows()[0]!, 'End')
    expect(rows()).toHaveLength(data.plugins.length)
    expect(document.activeElement?.id).toBe(`plugin-row-${data.plugins.at(-1)!.name}`)
  })

  it('shows what a pack needs and what a plugin that is on does not', async () => {
    const pack = data.plugins.find((plugin) => plugin.requires.length > 0)!
    await act(async () => { showAll()!.click() })
    await act(async () => { host.querySelector<HTMLElement>(`[id="plugin-row-${pack.name}"]`)!.click() })
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain(pack.requires[0])
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain(ENGLISH_WORDS.requiresHeading)
  })

  it('opens the files disclosure with the repository count and a link to the folder', async () => {
    const aside = host.querySelector('[aria-live="polite"]')!
    expect(aside.querySelector('details')?.hasAttribute('open')).toBe(false)
    expect(aside.querySelector('a')?.getAttribute('href')).toBe(`https://github.com/twickas/delorun/tree/main/${data.plugins[0]!.folder}`)
  })

  it('switches to Make your own and lists the files of the chosen kind', async () => {
    await act(async () => { host.querySelector<HTMLElement>('[role="tab"]:not([aria-selected="true"])')!.click() })
    expect(host.textContent).toContain('src/index.ts')
    expect(host.textContent).not.toContain('src/client/index.tsx')
    const screen = [...host.querySelectorAll<HTMLElement>('button')].find((button) => button.textContent === ENGLISH_WORDS.kinds.ui.name)!
    await act(async () => { screen.click() })
    expect(host.textContent).toContain('src/client/index.tsx')
    expect(host.querySelector(`a[href$="/guide/plugin-guides/first-plugin"]`)).not.toBeNull()
  })
})

describe('the plugin browser still', () => {
  it('is the same text the browser prints before its scripts run', async () => {
    const { PluginBrowserStill } = await import('../src/plugin-browser/PluginBrowserStill.tsx')
    const still = renderToStaticMarkup(createElement(PluginBrowserStill, { words: ENGLISH_WORDS }))
    for (const plugin of data.plugins) expect(still).toContain(plugin.title.replaceAll("'", '&#x27;'))
    expect(still).not.toContain('role="tablist"')
  })
})
