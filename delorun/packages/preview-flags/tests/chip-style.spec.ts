/**
 * The preview chip's look, read from its stylesheet: a small muted label, not a badge. The owner asked for it to be
 * unobtrusive, so a fill, a bold weight or motion fails here.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('the preview chip\'s stylesheet', () => {
  it('draws the muted ink on a hairline at the smallest size, with no fill, bold weight or motion', () => {
    const css = readFileSync(fileURLToPath(new URL('../src/client/PreviewChip.module.css', import.meta.url)), 'utf8')
    const rule = /\.chip \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toContain('color: var(--dl-text-muted)')
    expect(rule).toContain('border: 1px solid var(--dl-border)')
    expect(rule).toContain('font-weight: 400')
    expect(rule).toContain('font-size: var(--dsw-font-xxxs-11-font-size, 11px)')
    expect(css).not.toMatch(/background|animation|transition|box-shadow|text-transform/)
  })
})
