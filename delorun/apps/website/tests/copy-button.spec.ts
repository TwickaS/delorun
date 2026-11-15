// @vitest-environment jsdom
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyButton, copyText } from '../src/components/copy-button.tsx'
import { COPY, INSTALL_COMMANDS } from '../src/site/copy.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('the copy button', () => {
  let host: HTMLElement
  beforeEach(() => {
    vi.useFakeTimers()
    host = document.body.appendChild(document.createElement('div'))
  })
  afterEach(() => {
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('copies the command, shows Copied for a moment, then goes back', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const root = createRoot(host)
    await act(async () => root.render(createElement(CopyButton, { text: INSTALL_COMMANDS.pnpm })))
    const button = host.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Copy command')
    expect(host.querySelector('[aria-live="polite"]')!.textContent).toBe('')
    await act(async () => button.click())
    expect(writeText).toHaveBeenCalledWith('pnpm dlx delorun')
    expect(host.querySelector('[aria-live="polite"]')!.textContent).toBe('Copied')
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(host.querySelector('[aria-live="polite"]')!.textContent).toBe('')
    await act(async () => root.unmount())
  })

  it('falls back to a text area when the Clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const exec = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    expect(await copyText('npx delorun')).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })
})

describe('the platform note', () => {
  it('states the platforms and links the WSL2 section of the install guide', () => {
    const { before, linkText, href, after } = COPY.platformNote
    expect(before + linkText + after).toBe('For now, Delorun runs on Linux and on Windows through WSL2. macOS and native Windows come in a later release.')
    expect(href).toBe('https://docs.delorun.com/guide/install#windows-through-wsl2')
    expect(renderToStaticMarkup(createElement(CopyButton, { text: 'x' }))).toContain('Copy command')
  })
})
