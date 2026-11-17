/** The empty-chat workspace row wraps on a narrow screen and its workspace chip never takes more than 60% of the row. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../src/client/skeleton/${name}`, import.meta.url)), 'utf8')

/**
 * The declaration block of one selector.
 * @param css - stylesheet text.
 * @param selector - the class selector at the start of a rule.
 * @returns the text between its braces.
 */
function block(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('hero workspace row', () => {
  it('wraps with a 4px row gap', () => {
    const row = block(read('ConversationRoot.module.css'), '.heroWorkspaceRow')
    expect(row).toContain('flex-wrap: wrap;')
    expect(row).toContain('row-gap: 4px;')
  })

  it('caps the workspace chip at 60% of the row and ellipsizes its label', () => {
    const css = read('HeroShell.module.css')
    expect(block(css, '.workspace')).toContain('max-width: min(60%, 360px);')
    expect(block(css, '.workspaceLabel')).toContain('text-overflow: ellipsis;')
  })
})
