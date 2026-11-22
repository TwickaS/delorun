// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarFooter } from '../src/components/sidebar-footer.tsx'
import { THEME_COPY } from '../src/site/shell-copy.ts'

// Fumadocs' language picker keeps its own copy of React under the docs app's node_modules, which a spec run from the
// repository root cannot share with the design package's copy; a stand-in with the same button stands for it here. The
// built pages show the real one (the pictures of the sidebar footer).
vi.mock('fumadocs-ui/layouts/shared/slots/language-select', () => ({
  LanguageSelect: ({ children, className }: { children: ReactNode, className?: string }) => createElement('button', { type: 'button', 'aria-label': 'Choose a language', className }, children),
  LanguageSelectText: ({ className }: { className?: string }) => createElement('span', { className }, 'English'),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
  document.documentElement.removeAttribute('data-look')
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** Renders the footer in a locale and returns its element. */
async function render(locale: 'en' | 'zh'): Promise<HTMLElement> {
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => { root!.render(createElement(SidebarFooter, { theme: THEME_COPY[locale] })) })
  return container.querySelector<HTMLElement>('[data-sidebar-footer]')!
}

describe('the sidebar footer', () => {
  it('is one row holding the language picker and a labelled theme control', async () => {
    const row = await render('en')
    const buttons = [...row.querySelectorAll('button')]
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.textContent).toBe('English')
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Choose a language')
    expect(buttons[1]!.textContent).toBe('Soft')
    expect(buttons[1]!.getAttribute('aria-label')).toBe('Look: Soft, light')
    expect(buttons[1]!.getAttribute('title')).toBe('Look: Soft, light')
  })

  it('names the theme in Chinese on a Chinese page, and the dark scheme when the page is dark', async () => {
    document.documentElement.classList.add('dark')
    const row = await render('zh')
    const theme = row.querySelectorAll('button')[1]!
    expect(theme.textContent).toBe('柔和')
    expect(theme.getAttribute('aria-label')).toBe('外观：柔和，深色')
  })
})
