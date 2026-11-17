import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** Every `.css` file under the brand source. */
function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? cssFiles(join(dir, entry.name)) : entry.name.endsWith('.css') ? [join(dir, entry.name)] : [])
}

/** The weight range each bundled face declares. */
function declared(): Record<string, readonly [number, number]> {
  const css = readFileSync(join(SRC, 'fonts.css'), 'utf8')
  const faces: Record<string, readonly [number, number]> = {}
  for (const match of css.matchAll(/font-family:\s*'([^']+)';[^}]*?font-weight:\s*(\d+)\s+(\d+)/g)) faces[match[1] ?? ''] = [Number(match[2]), Number(match[3])]
  return faces
}

describe('the bundled faces\' declared weights', () => {
  it('are the ranges the variable files cover, so no weight is drawn as faux bold', () => {
    expect(declared()).toEqual({ 'Schibsted Grotesk': [400, 900], 'JetBrains Mono': [400, 800] })
  })

  it('cover every numeric weight the brand stylesheets ask for', () => {
    const [low, high] = declared()['Schibsted Grotesk'] ?? [0, 0]
    const used = cssFiles(SRC).flatMap(file => [...readFileSync(file, 'utf8').matchAll(/font-weight:\s*(\d{3})\b/g)].map(match => ({ file, weight: Number(match[1]) })))
    expect(used.length).toBeGreaterThan(0)
    for (const { file, weight } of used) {
      if (file.endsWith('fonts.css')) continue
      expect(weight, file).toBeGreaterThanOrEqual(low)
      expect(weight, file).toBeLessThanOrEqual(high)
    }
  })
})
