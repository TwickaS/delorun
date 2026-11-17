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

  it('prints what each pack needs and the files each kind of plugin starts with', () => {
    expect(html).toContain('typescript-language-server installed')
    for (const paths of Object.values(data.scaffold)) for (const path of paths) expect(html).toContain(path)
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

  it('shows what a pack needs and what a plugin that is on does not', async () => {
    const pack = data.plugins.find((plugin) => plugin.requires.length > 0)!
    await act(async () => { host.querySelector<HTMLElement>(`[id="plugin-row-${pack.name}"]`)!.click() })
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain(pack.requires[0])
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain(ENGLISH_WORDS.requiresHeading)
  })

  it('opens the files disclosure with the repository count and a link to the folder', async () => {
    const aside = host.querySelector('[aria-live="polite"]')!
    expect(aside.querySelector('details')?.hasAttribute('open')).toBe(false)
    expect(aside.querySelector('a')?.getAttribute('href')).toBe(`https://github.com/Delo-Run/delorun/tree/main/${data.plugins[0]!.folder}`)
  })

  it('switches to Make your own and lists the files of the chosen kind', async () => {
    await act(async () => { host.querySelector<HTMLElement>('[role="tab"]:not([aria-selected="true"])')!.click() })
    expect(host.textContent).toContain('src/index.ts')
    expect(host.textContent).not.toContain('src/client/index.tsx')
    const screen = [...host.querySelectorAll<HTMLElement>('button')].find((button) => button.textContent === ENGLISH_WORDS.kinds.ui.name)!
    await act(async () => { screen.click() })
    expect(host.textContent).toContain('src/client/index.tsx')
    expect(host.querySelector(`a[href$="/guide/first-plugin"]`)).not.toBeNull()
  })
})
