/** Round brand shapes stay round under the studio's global corner style, which squares off shapes that lack `corner-shape: round`. */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const directory = new URL('../src/components/', import.meta.url)

describe('circular shapes', () => {
  it('declare corner-shape: round beside every 50% border radius', () => {
    const missing: string[] = []
    for (const file of readdirSync(directory).filter(name => name.endsWith('.module.css'))) {
      for (const rule of readFileSync(new URL(file, directory), 'utf8').split('}')) {
        if (/border-radius:\s*50%/.test(rule) && !/corner-shape:\s*round/.test(rule)) missing.push(`${file}: ${rule.trim().split('{')[0]?.trim()}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('covers the PIN dots and keypad', () => {
    for (const file of ['PinDots.module.css', 'Keypad.module.css']) {
      expect(readFileSync(new URL(file, directory), 'utf8')).toContain('corner-shape: round')
    }
  })
})
