import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('visible focus, hit areas and the chosen segment on the sites', () => {
  const stand = css('../src/upstream.web.module.css')

  it('puts the focus ring on the input itself, the element that is focused', () => {
    expect(stand).toMatch(/\.input:focus-visible\s*\{[^}]*outline:\s*var\(--dl-focus-ring\)/)
  })

  it('makes a text field at least 44 px tall', () => {
    expect(stand).toMatch(/\.wrap\s*\{[^}]*min-height:\s*44px/)
  })

  it('sets the chosen segment apart from its track with a 1px outline on tokens', () => {
    expect(css('../src/settings/ChoiceGroup.module.css')).toMatch(/\.indicator\s*\{[^}]*outline:\s*1px solid var\(--dsw-alias-border-l2, var\(--dl-border\)\)/)
  })

  it('fills the solid button with the text colour and reads the surface colour on it', () => {
    expect(css('../src/components/Button.module.css')).toMatch(/\.button\.solid\s*\{[^}]*background:\s*var\(--dl-text\)[^}]*color:\s*var\(--dl-surface\)/)
  })
})
