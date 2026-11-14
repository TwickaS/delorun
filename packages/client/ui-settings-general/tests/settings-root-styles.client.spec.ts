/** Settings carrier geometry is independent of contributed launcher markup; touch targets grow only under a coarse pointer. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/SettingsRoot.module.css', import.meta.url), 'utf8')

it('keeps the indicator carrier full-width without inspecting account state', () => {
  expect(css).toMatch(/\.triggerRow\s*\{[^}]*width: 100%;[^}]*margin: 4px 0;/)
  expect(css).not.toContain('data-signed-out')
  expect(css).toMatch(/\.triggerRow\.railRow\s*\{[^}]*width: 36px;/)
})

it('gives the tabs and the close control 44px targets under a coarse pointer only', () => {
  const coarse = /@media \(pointer: coarse\)\s*\{([^@]*?)\n\}/.exec(css)?.[1] ?? ''
  expect(coarse).toMatch(/\.navGroups \.navCell\s*\{[^}]*height: 44px;/)
  expect(coarse).toMatch(/\.close\s*\{[^}]*width: 44px;[^}]*height: 44px;/)
  expect(css).toMatch(/\.navCell\s*\{[^}]*height: 40px;/)
  expect(css).toMatch(/\.close\s*\{[^}]*width: 28px;[^}]*height: 28px;/)
})
