/** The shared appearance chips' stylesheet sizes every chip to a 44px target. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('the chip stylesheet', () => {
  it('sizes every chip to a 44px target through the shared stylesheet', () => {
    const css = readFileSync(new URL('../src/settings/ChipGroup.module.css', import.meta.url), 'utf8')
    const chip = /\.chip \{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(chip).toContain('min-height: 44px;')
    expect(chip).toContain('min-width: 44px;')
  })
})
