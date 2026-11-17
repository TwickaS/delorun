/** Shared Button geometry and inset stroke declarations. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/Button.module.css', import.meta.url)), 'utf8')

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`\\.${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (rule === null) throw new Error(`Button.module.css has no .${selector} rule`)
  return rule[1] ?? ''
}

describe('Button styles', () => {
  it('retains a transparent layout border and paints the DPR-aware stroke inside it', () => {
    const outline = declarations('outline')
    expect(outline).toContain('border: 0.5px solid transparent;')
    expect(outline).toContain('box-shadow: inset 0 0 0 var(--dsh-hairline-width, 0.5px)')
    expect(outline).toContain('var(--dsh-button-outline-color, var(--dsw-alias-border-l3))')
  })

  it('limits the inset stroke to outlined buttons', () => {
    for (const selector of ['button', 'primary', 'ghost:hover:not(:disabled)', 'toolbar']) {
      expect(declarations(selector)).not.toContain('box-shadow')
    }
    expect(declarations('outline:hover:not(:disabled)')).not.toContain('box-shadow')
  })

  it('keeps the shared medium and small control heights', () => {
    expect(declarations('md')).toContain('height: 36px;')
    expect(declarations('sm')).toContain('height: 28px;')
  })

  it('gives Settings inline buttons a 32px pointer target', () => {
    const rule = /@media \(min-width: 640px\) and \(pointer: fine\) \{\s*:global\(\[data-settings-anchor\]\) \.sm \{([^}]*)\}/.exec(css)
    expect(rule?.[1]).toContain('height: 32px;')
    expect(rule?.[1]).toContain('padding: 0 12px;')
    expect(rule?.[1]).toContain('font-size: 13px;')
  })

  it('sinks primary and outline buttons to 97% for 120ms while pressed, unless motion is reduced', () => {
    const block = /@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(block).toContain('transition: transform 120ms')
    expect(block).toContain('.primary:active:not(:disabled)')
    expect(block).toContain('transform: scale(0.97);')
  })
})
