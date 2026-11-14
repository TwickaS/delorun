// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toolSettings } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import { ToolSettingsSection, type ToolSettingsEntry } from '../src/client/ToolSettingsSection.tsx'

afterEach(() => { cleanup() })

/** The slot registry's `plugins.item` ledger and the locale, as far as the section reads them. */
function bench(navigation: boolean) {
  const ctx = new Context()
  const listeners = new Set<() => void>()
  const localeListeners = new Set<() => void>()
  let items: { options: { id?: string; label?: string | (() => string) } }[] = [
    { options: { id: 'subagent', label: () => 'Subagent' } },
    { options: { id: 'web-search', label: 'Web search' } },
    { options: { id: 'unlabelled' } },
    { options: {} },
  ]
  ctx.provide('slots', {
    entries: () => items,
    subscribe: (_: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  ctx.provide('locale', { subscribe: (listener: () => void) => { localeListeners.add(listener); return () => { localeListeners.delete(listener) } } })
  const openItem = vi.fn<(id: string) => void>()
  if (navigation) ctx.provide('pluginNavigation', { openItem, openBundle: () => {}, openList: () => {} })
  const change = (next: typeof items): void => {
    items = next
    for (const listener of listeners) listener()
  }
  return { ctx, openItem, change, listeners, localeListeners }
}

describe('Tool settings', () => {
  it('lists the Plugins page\'s official items by name while the page can be opened, and opens one', () => {
    const { ctx, openItem, change } = bench(true)
    const face = toolSettings(ctx)
    const first = face.tools.getSnapshot()
    expect(first).toEqual([{ id: 'subagent', label: 'Subagent' }, { id: 'web-search', label: 'Web search' }, { id: 'unlabelled', label: 'unlabelled' }])
    // An unchanged ledger keeps the same list, so React does not render again.
    expect(face.tools.getSnapshot()).toBe(first)
    change([{ options: { id: 'shell', label: 'Shell' } }])
    expect(face.tools.getSnapshot()).toEqual([{ id: 'shell', label: 'Shell' }])
    face.open('shell')
    expect(openItem).toHaveBeenCalledWith('shell')
  })

  it('lists nothing and opens nothing without the Plugins page\'s navigation', () => {
    const { ctx } = bench(false)
    const face = toolSettings(ctx)
    expect(face.tools.getSnapshot()).toEqual([])
    expect(() => { face.open('subagent') }).not.toThrow()
  })

  it('follows the ledger and the language until unsubscribed', () => {
    const { ctx, listeners, localeListeners } = bench(true)
    const listener = vi.fn<() => void>()
    const off = toolSettings(ctx).tools.subscribe(listener)
    expect([listeners.size, localeListeners.size]).toEqual([1, 1])
    for (const notify of [...listeners, ...localeListeners]) notify()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    expect([listeners.size, localeListeners.size]).toEqual([0, 0])
  })

  it('opens a tool\'s page and closes Settings, and renders nothing with no tools', () => {
    const entries: ToolSettingsEntry[] = [{ id: 'subagent', label: 'Subagent' }]
    const open = vi.fn<(id: string) => void>()
    const close = vi.fn<() => void>()
    const tools = { getSnapshot: () => entries, subscribe: () => () => {} }
    const { container, rerender } = render(<ToolSettingsSection t={makeTranslate(en)} tools={tools} open={open} close={close} />)
    expect(screen.getByRole('heading', { name: en['tools.settings'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Subagent/ }))
    expect(open).toHaveBeenCalledWith('subagent')
    expect(close).toHaveBeenCalledOnce()
    const empty: ToolSettingsEntry[] = []
    const none = { getSnapshot: () => empty, subscribe: () => () => {} }
    rerender(<ToolSettingsSection t={makeTranslate(en)} tools={none} open={open} close={close} />)
    expect(container.innerHTML).toBe('')
  })
})
