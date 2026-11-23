// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginEntryCard, PluginEntryList, PluginEntryPlaceholder, PluginEntrySkeleton, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('PluginEntryCard', () => {
  it('lays out the artwork, the title with its badges, the summary, the meta line, the content and the action', () => {
    render(
      <PluginEntryList label="Plugins">
        <PluginEntryCard data-entry="alpha" title="Alpha" badges={<Tag>Official</Tag>} description="Counts words." meta="1.0.0 · Delorun"
          action={<button type="button">Install</button>}>
          <p>Downloading</p>
        </PluginEntryCard>
      </PluginEntryList>,
    )
    const item = within(screen.getByRole('list', { name: 'Plugins' })).getByRole('listitem')
    expect(item.dataset['entry']).toBe('alpha')
    expect(item.textContent).toBe('AlphaOfficialCounts words.1.0.0 · DelorunDownloadingInstall')
    // Without artwork the frame shows the default plugin artwork, hidden because the title names the plugin.
    expect(item.querySelector('span[aria-hidden="true"] > svg')).not.toBeNull()
    expect(item.dataset['static']).toBe('')
    expect(within(item).queryByRole('heading')).toBeNull()
  })

  it('makes the title a button over the whole card when the entry opens a page, leaving the action its own control', () => {
    const onOpen = vi.fn()
    const onInstall = vi.fn()
    render(<ul><PluginEntryCard title="Alpha" onOpen={onOpen} openLabel="Open Alpha" action={<button type="button" onClick={onInstall}>Install</button>} /></ul>)
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha' }))
    expect(onOpen).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(onInstall).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledOnce()
    expect(screen.getByRole('listitem').dataset['static']).toBeUndefined()
  })

  it('shows the full text under a heading of the given level when the list has no page to open', () => {
    render(<ul><PluginEntryCard title="Alpha" heading={4} clamp={false} description="A long description." /></ul>)
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('Alpha')
    expect(screen.getByRole('listitem').dataset['clamp']).toBe('false')
  })

  it('shows the plugin\'s artwork, and the default artwork once the image fails to load', () => {
    const { container } = render(<ul><PluginEntryCard title="Alpha" icon="https://example.invalid/alpha.png" /></ul>)
    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('https://example.invalid/alpha.png')
    expect(image?.getAttribute('alt')).toBe('')
    fireEvent.error(image as HTMLImageElement)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('span[aria-hidden="true"] > svg')).not.toBeNull()
  })

  it('shows the list\'s own fallback instead of the default artwork when the plugin has none, and real artwork over both', () => {
    const { container, rerender } = render(<ul><PluginEntryCard title="Alpha" iconFallback={<b data-tile="">A</b>} /></ul>)
    expect(container.querySelector('[data-tile]')?.textContent).toBe('A')
    expect(container.querySelector('svg')).toBeNull()
    rerender(<ul><PluginEntryCard title="Alpha" icon="https://example.invalid/alpha.png" iconFallback={<b data-tile="">A</b>} /></ul>)
    expect(container.querySelector('[data-tile]')).toBeNull()
    fireEvent.error(container.querySelector('img') as HTMLImageElement)
    expect(container.querySelector('[data-tile]')?.textContent).toBe('A')
  })
})

describe('PluginEntrySkeleton', () => {
  it('is one named status region of hidden placeholder rows', () => {
    render(<PluginEntrySkeleton label="Loading plugins" count={3} />)
    const list = screen.getByRole('status', { name: 'Loading plugins' })
    expect(list.getAttribute('aria-busy')).toBe('true')
    expect(list.querySelectorAll('li[aria-hidden="true"]')).toHaveLength(3)
  })

  it('offers a single placeholder row for a list whose entries arrive one by one', () => {
    const { container } = render(<ul><PluginEntryPlaceholder /></ul>)
    expect(container.querySelectorAll('li[aria-hidden="true"]')).toHaveLength(1)
    expect(container.textContent).toBe('')
  })
})
