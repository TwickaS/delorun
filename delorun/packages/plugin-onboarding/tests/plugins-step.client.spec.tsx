// @vitest-environment jsdom
/**
 * Recommended plugins draws each offered plugin as the plugin market's entry row, over the guide's real bundle
 * installer, so pressing Add reaches the downloads panel exactly as before; the Browser pack stays with its own step and
 * the step is left out when nothing is on offer.
 */
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BROWSER_BUNDLE } from '@delorun/browser-setup'
import { currentDownloadsSource } from '@delorun/plugin-downloads/row'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBundleInstaller } from '../src/client/bundles.ts'
import { buildSteps, STEPS } from '../src/client/flow.tsx'
import { createGuide } from '../src/client/guide.ts'
import { en } from '../src/client/locales.ts'
import { PluginsStep } from '../src/client/steps/Plugins.tsx'
import { NO_RECORD } from '../src/wire.ts'
import { hostFake, stepServices } from './fixtures.client.ts'

// The Host's packs routes publish no pack, so the bundles read as the plugin manager lists them.
beforeEach(() => { vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ supported: true, release: '0.1.0', packs: [], queue: [] }))) })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  for (const item of currentDownloadsSource().snapshot()) currentDownloadsSource().remove(item.key)
})

const flush = async () => { await act(async () => { for (let tick = 0; tick < 12; tick += 1) await Promise.resolve() }) }
const panelRow = (key: string) => currentDownloadsSource().snapshot().find(item => item.key === key)
const entries = () => within(screen.getByRole('list', { name: en['step.plugins'] })).getAllByRole('listitem')
const entry = (title: string) => {
  const found = entries().find(each => within(each).queryByRole('heading', { level: 3, name: title }) !== null)
  if (found === undefined) throw new Error(`no entry titled ${title}`)
  return found
}

/** A real installer over a scripted plugin manager that lists two catalog plugins with install targets. */
function installer(alphaDescription = 'Counts the words of a reply.') {
  const ctx = new Context()
  const listed = [
    { name: '@scope/alpha', availability: 'missing', installed: false, enabled: false, installTarget: { spec: '@scope/alpha@1.0.0', version: '1.0.0' }, meta: { title: 'Alpha', description: alphaDescription } },
    { name: '@scope/beta', availability: 'installation', enabled: false, meta: { title: 'Beta', description: 'Reads a reply aloud.' } },
  ]
  let answer: (value: { ok: true, value: { application: 'applied' } }) => void = () => undefined
  const pluginManager = {
    listBundles: vi.fn(() => Promise.resolve({ ok: true as const, value: listed })),
    installBundle: vi.fn(() => new Promise((resolve) => { answer = resolve })),
    setBundleEnabled: vi.fn(() => Promise.resolve({ ok: true as const, value: { application: 'applied' } })),
  }
  ctx.provide('remote.pluginManager', pluginManager as never)
  const bundles = createBundleInstaller(ctx, { addWaitMs: () => 60_000, pollMs: 1000, resolveText: text => (typeof text === 'string' ? text : text.en) })
  return { bundles, pluginManager, finish: () => { answer({ ok: true, value: { application: 'applied' } }) } }
}

const guide = () => createGuide(hostFake({ recommend: undefined }).host)
const LONG = `${'Counts the words of a reply and shows the total beside it. '.repeat(3)}Nothing leaves the studio.`

describe('the recommended plugins step drawn as the plugin market', () => {
  it('draws each offered plugin as a market entry: its letter tile in the frame, title, description and Add', async () => {
    const { bundles } = installer()
    render(<PluginsStep services={stepServices({ bundles, plugins: ['@scope/alpha', '@scope/beta'] })} guide={guide()} />)
    await flush()
    expect(entries()).toHaveLength(2)
    for (const [title, description] of [['Alpha', 'Counts the words of a reply.'], ['Beta', 'Reads a reply aloud.']] as const) {
      const row = entry(title)
      expect(within(row).getByText(description)).toBeTruthy()
      expect(within(row).getByRole('button', { name: `Add ${title}` }).textContent).toBe(en['bundle.add'])
      // A plugin without artwork shows the guide's coloured letter tile in the market's frame, hidden because the title names it.
      expect(row.querySelector('span[aria-hidden="true"] > [data-tint]')?.textContent).toBe(title.charAt(0))
      // A list with no page to open shows the whole description.
      expect(row.getAttribute('data-clamp')).toBe('false')
    }
  })

  it('puts a plugin in the downloads panel when Add is pressed, and draws its download under the description', async () => {
    const { bundles, pluginManager, finish } = installer()
    render(<PluginsStep services={stepServices({ bundles, plugins: ['@scope/alpha', '@scope/beta'] })} guide={guide()} />)
    await flush()
    await act(async () => { fireEvent.click(within(entry('Alpha')).getByRole('button', { name: 'Add Alpha' })) })
    await flush()
    expect(pluginManager.installBundle).toHaveBeenCalledOnce()
    expect(panelRow('@scope/alpha')).toMatchObject({ state: 'downloading', title: 'Alpha' })
    expect(panelRow('@scope/beta')).toBeUndefined()
    const row = entry('Alpha')
    expect(within(row).getByRole('status').textContent).toBe(en['bundle.adding'])
    expect(within(row).getByRole('progressbar', { name: 'Alpha' })).toBeTruthy()
    expect(within(entry('Beta')).getByRole('button', { name: 'Add Beta' })).toBeTruthy()
    await act(async () => { finish() })
    await flush()
    expect(panelRow('@scope/alpha')?.state).toBe('ready')
    expect(within(entry('Alpha')).getByText(en['bundle.added'])).toBeTruthy()
    expect(within(entry('Alpha')).queryByRole('button', { name: 'Add Alpha' })).toBeNull()
  })

  it('holds each row\'s place with a market placeholder, names what a plugin fits in the quiet line, and opens a long description with More', async () => {
    const { bundles } = installer(LONG)
    const fitting = createGuide(hostFake({ recommend: { plugins: [{ name: '@scope/alpha', connections: ['provider:deepseek-official'], source: 'installed' }], registry: 'not-asked' } }).host)
    render(<PluginsStep services={stepServices({ bundles, plugins: ['@scope/alpha', '@scope/beta'] })} guide={fitting} />)
    const list = screen.getByRole('list', { name: en['step.plugins'] })
    // Before the plugin manager answers, each offered plugin is one hidden placeholder row with the market's icon frame.
    expect(list.querySelectorAll('li[aria-hidden="true"]')).toHaveLength(2)
    expect(within(list).queryAllByRole('heading')).toHaveLength(0)
    await flush()
    const alpha = entry('Alpha')
    expect(within(alpha).getByText(en['plugins.fits'].replace('{names}', 'DeepSeek'))).toBeTruthy()
    expect(within(entry('Beta')).queryByText(/^Fits /u)).toBeNull()
    const more = within(alpha).getByRole('button', { name: en['more'] })
    const summary = alpha.ownerDocument.getElementById(more.getAttribute('aria-controls') ?? '')
    expect(summary?.textContent).toBe(LONG)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { fireEvent.click(more) })
    expect(within(alpha).getByRole('button', { name: en['less'] }).getAttribute('aria-expanded')).toBe('true')
  })

  it('leaves the Browser pack out of the list while the Browser step offers it', async () => {
    const { bundles } = installer()
    render(<PluginsStep services={stepServices({ bundles, plugins: [BROWSER_BUNDLE, '@scope/alpha'] })} guide={guide()} />)
    await flush()
    expect(entries().map(each => within(each).getByRole('heading', { level: 3 }).textContent)).toEqual(['Alpha'])
  })

  it.each<readonly [string, readonly string[]]>([
    ['nothing is on offer', []],
    ['the Browser pack is the only plugin on offer', [BROWSER_BUNDLE]],
  ])('is left out of the guide when %s', (_, plugins) => {
    const ids = buildSteps({
      services: stepServices({ plugins, optionalRows: [] }), guide: guide(), record: NO_RECORD,
      extra: [], reach: 'absent', phone: 'untouched', target: { kind: 'other' }, notice: undefined, keepCurrent: false, first: false,
    }).map(step => step.id)
    expect(ids).not.toContain(STEPS.plugins.id)
  })
})
