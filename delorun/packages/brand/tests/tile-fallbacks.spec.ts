import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('the preview tiles on a page without the studio', () => {
  it('give every studio spacing, type, radius and focus property a fallback on the brand tokens', () => {
    const css = readFileSync(fileURLToPath(new URL('../src/settings/TileGroup.module.css', import.meta.url)), 'utf8')
    const bare = [...css.matchAll(/var\((--(?:delorun-space-\d|dsw-font-[\w-]+|dsw-radius-[\w-]+|dsw-focus-ring-[\w-]+))\)/g)].map(match => match[1])
    expect(bare).toEqual([])
  })
})
