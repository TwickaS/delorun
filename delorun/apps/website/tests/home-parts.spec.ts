// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Install, NEEDS_SCRIPT, ScriptsOff, WITHOUT_SCRIPT } from '../src/components/install.tsx'
import { NearScreen } from '../src/components/near-screen.tsx'
import { forgetPackageManager, PACKAGE_MANAGER_KEY } from '../src/components/package-manager.tsx'
import { INSTALL_COMMANDS, PACKAGE_MANAGERS } from '../src/site/copy.ts'
import { softwareData } from '../src/site/structured-data.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('the install command', () => {
  it('renders the chosen command for scripts, and every command as text for a browser without them', () => {
    const html = renderToStaticMarkup(createElement('div', null, createElement(ScriptsOff), createElement(Install, { manager: 'npm', onChange: () => undefined })))
    const body = new DOMParser().parseFromString(html, 'text/html').body
    const scripted = body.querySelector(`[data-script="${NEEDS_SCRIPT}"]`)!
    expect(scripted.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect([...scripted.querySelectorAll('pre')].map(pre => pre.textContent)).toEqual([INSTALL_COMMANDS.npm])
    const plain = body.querySelector(`[data-script="${WITHOUT_SCRIPT}"]`)!
    expect([...plain.querySelectorAll('pre')].map(pre => pre.textContent)).toEqual(PACKAGE_MANAGERS.map(manager => INSTALL_COMMANDS[manager]))
    expect(html).toContain(`<noscript><style>[data-script=${NEEDS_SCRIPT}]{display:none!important}[data-script=${WITHOUT_SCRIPT}]{display:block!important}</style></noscript>`)
  })
})

describe('forgetting the package-manager choice', () => {
  it('removes the stored choice', () => {
    localStorage.setItem(PACKAGE_MANAGER_KEY, 'bun')
    expect(forgetPackageManager()).toBe(true)
    expect(localStorage.getItem(PACKAGE_MANAGER_KEY)).toBeNull()
  })
})

describe('a living section behind the near-screen gate', () => {
  let host: HTMLElement
  let observed: ((entries: { isIntersecting: boolean }[]) => void) | undefined
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
    observed = undefined
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { observed = callback }
      observe() {}
      disconnect() {}
    })
  })
  afterEach(() => {
    host.remove()
    vi.unstubAllGlobals()
  })

  it('shows the still until the section nears the screen, then the section', async () => {
    const load = vi.fn(async () => ({ default: () => createElement('p', null, 'live') }))
    const root = createRoot(host)
    await act(async () => root.render(createElement(NearScreen, { load, still: createElement('p', null, 'still') })))
    expect(host.textContent).toBe('still')
    expect(load).not.toHaveBeenCalled()
    await act(async () => observed?.([{ isIntersecting: true }]))
    expect(load).toHaveBeenCalledOnce()
    expect(host.textContent).toBe('live')
    await act(async () => root.unmount())
  })

  it('keeps the still when the section’s script fails to load', async () => {
    const load = vi.fn(async () => { throw new Error('offline') })
    const root = createRoot(host)
    await act(async () => root.render(createElement(NearScreen, { load, still: createElement('p', null, 'still') })))
    await act(async () => observed?.([{ isIntersecting: true }]))
    expect(host.textContent).toBe('still')
    await act(async () => root.unmount())
  })
})

describe('the structured data', () => {
  it('describes a free MIT application and names the version only when one is assembled', () => {
    expect(softwareData(undefined)).not.toHaveProperty('softwareVersion')
    const data = softwareData('0.1.0-preview.2')
    expect(data).toMatchObject({ '@type': 'SoftwareApplication', softwareVersion: '0.1.0-preview.2', offers: { price: '0' }, isAccessibleForFree: true })
    expect(data.license).toMatch(/\/LICENSE$/)
  })
})
