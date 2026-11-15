import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SHEETS = {
  sidebar: '../src/client/SettingsSection.module.css',
  appearance: '../../plugin-theme/src/client/AppearanceSection.module.css',
}

describe('range slider tracks', () => {
  for (const [name, path] of Object.entries(SHEETS)) {
    it(`${name}: both engines draw the neutral track and the accent fill, not the native one`, () => {
      const css = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
      expect(css).toContain('::-webkit-slider-runnable-track')
      expect(css).toContain('::-moz-range-track')
      expect(css).toContain('::-moz-range-progress')
      expect(css).toMatch(/linear-gradient\(to right, var\(--range-accent\) var\(--range-fill\), var\(--range-track\) var\(--range-fill\)\)/)
      expect(css).not.toContain('accent-color')
    })
  }
})
