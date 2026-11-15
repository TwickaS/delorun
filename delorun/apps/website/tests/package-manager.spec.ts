// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PACKAGE_MANAGER_KEY, PackageManagerPicker, usePackageManager } from '../src/components/package-manager.tsx'
import { INSTALL_COMMANDS } from '../src/site/copy.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function Probe() {
  const [manager, setManager] = usePackageManager()
  return createElement('div', null, createElement('output', null, INSTALL_COMMANDS[manager]), createElement(PackageManagerPicker, { value: manager, onChange: setManager }))
}

describe('the package-manager choice', () => {
  let host: HTMLElement
  beforeEach(() => {
    localStorage.clear()
    host = document.body.appendChild(document.createElement('div'))
  })
  afterEach(() => host.remove())

  it('renders pnpm on the server', () => {
    const html = renderToStaticMarkup(createElement(Probe))
    expect(html).toContain('pnpm dlx delorun')
    expect(html).toContain('role="radiogroup"')
  })

  it('restores the stored choice after mount and ignores an unknown value', async () => {
    localStorage.setItem(PACKAGE_MANAGER_KEY, 'bun')
    const root = createRoot(host)
    await act(async () => root.render(createElement(Probe)))
    expect(host.querySelector('output')!.textContent).toBe('bunx delorun')
    expect(host.querySelector('[aria-checked="true"]')!.textContent).toBe('bun')
    await act(async () => root.unmount())
    localStorage.setItem(PACKAGE_MANAGER_KEY, 'yarn')
    const again = createRoot(host)
    await act(async () => again.render(createElement(Probe)))
    expect(host.querySelector('output')!.textContent).toBe('pnpm dlx delorun')
    await act(async () => again.unmount())
  })

  it('moves with the arrow keys, wraps, stores the pick and keeps one tab stop', async () => {
    const root = createRoot(host)
    await act(async () => root.render(createElement(Probe)))
    const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const press = async (key: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    await act(async () => radios()[0]!.focus())
    await press('ArrowRight')
    expect(host.querySelector('output')!.textContent).toBe('npx delorun')
    expect(document.activeElement).toBe(radios()[1])
    await press('End')
    expect(localStorage.getItem(PACKAGE_MANAGER_KEY)).toBe('bun')
    await press('ArrowRight')
    expect(host.querySelector('output')!.textContent).toBe('pnpm dlx delorun')
    await press('ArrowLeft')
    expect(host.querySelector('output')!.textContent).toBe('bunx delorun')
    await press('Home')
    await press('x')
    expect(host.querySelector('output')!.textContent).toBe('pnpm dlx delorun')
    expect(radios().map(radio => radio.tabIndex)).toEqual([0, -1, -1])
    await act(async () => radios()[1]!.click())
    expect(host.querySelector('output')!.textContent).toBe('npx delorun')
    await act(async () => root.unmount())
  })

  it('keeps working when storage is blocked', async () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => { throw new Error('blocked') }
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new Error('blocked') }
    try {
      const root = createRoot(host)
      await act(async () => root.render(createElement(Probe)))
      await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[2]!.click())
      expect(host.querySelector('output')!.textContent).toBe('bunx delorun')
      await act(async () => root.unmount())
    } finally {
      Storage.prototype.getItem = original
      Storage.prototype.setItem = set
    }
  })
})
