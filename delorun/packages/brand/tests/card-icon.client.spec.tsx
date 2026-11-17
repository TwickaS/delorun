// @vitest-environment jsdom
/** The card icon: a tinted square with the first letter, the same tint for the same name. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_ICON_TINTS, CardIcon, cardIconLetter, cardIconTint } from '../src/index.ts'

afterEach(cleanup)

describe('cardIconTint', () => {
  it('gives one name the same tint every time, ignoring case and surrounding space', () => {
    expect(cardIconTint('Claude Code')).toBe(cardIconTint('  claude code '))
  })

  it('stays inside the palette and uses more than one of its colours across ordinary names', () => {
    const names = ['Claude Code', 'Codex', 'Docs', 'Notes', 'Website', 'Research', 'Billing', 'Travel', 'Garden', 'Tests']
    const tints = names.map(cardIconTint)
    expect(tints.every(tint => (CARD_ICON_TINTS as readonly string[]).includes(tint))).toBe(true)
    expect(new Set(tints).size).toBeGreaterThan(3)
  })

  it('takes non-Latin and empty names without failing', () => {
    expect((CARD_ICON_TINTS as readonly string[]).includes(cardIconTint('文档'))).toBe(true)
    expect((CARD_ICON_TINTS as readonly string[]).includes(cardIconTint(''))).toBe(true)
  })
})

describe('cardIconLetter', () => {
  it('is the first letter or digit in upper case, or a dot where the name has none', () => {
    expect([cardIconLetter('codex'), cardIconLetter('  42 things'), cardIconLetter('文档'), cardIconLetter('--')]).toEqual(['C', '4', '文', '·'])
  })
})

describe('CardIcon', () => {
  it('shows the letter on its tint, hidden from assistive technology', () => {
    const { container } = render(<CardIcon name="Codex" />)
    const icon = container.firstElementChild as HTMLElement
    expect(icon.textContent).toBe('C')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.dataset.tint).toBe(cardIconTint('Codex'))
    expect(icon.style.getPropertyValue('--card-icon-color')).toBe(`var(--delorun-badge-${cardIconTint('Codex')})`)
  })

  it('takes a letter and a size of its own', () => {
    const { container } = render(<CardIcon name="Codex" letter="+" size={24} />)
    const icon = container.firstElementChild as HTMLElement
    expect(icon.textContent).toBe('+')
    expect(icon.style.getPropertyValue('--card-icon-size')).toBe('24px')
  })
})
