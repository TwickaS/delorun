import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '../src/client')

/** Every client source file that draws a `<summary>`. */
function summaryFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return summaryFiles(path)
    return /\.tsx$/.test(entry.name) && readFileSync(path, 'utf8').includes('<summary') ? [path] : []
  })
}

describe('the guide\'s disclosures', () => {
  it('draw the studio\'s chevron, not the browser\'s triangle, on every summary', () => {
    const files = summaryFiles(SRC)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const plain = [...source.matchAll(/<summary(?![^>]*chevron\.summary)[^>]*>/g)]
      expect(plain, file).toEqual([])
    }
  })

  it('hides the browser marker and draws the chevron from the shared rule', () => {
    const css = readFileSync(join(SRC, 'ui/Chevron.module.css'), 'utf8')
    expect(css).toContain('::-webkit-details-marker')
    expect(css).toContain('list-style: none')
    expect(css).toMatch(/details\[open\] > \.summary::before/)
  })
})
