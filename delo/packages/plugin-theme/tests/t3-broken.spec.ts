import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/palette/t3-themes.ts', () => ({
  T3_THEMES: {
    'odd': { label: 'Odd', light: { sidebar: 'not-a-colour', canvas: '#ffffff', accent: '#336699' }, dark: { accent: '#336699' } },
    'bare': { label: 'Bare', light: { sidebar: '#fafafa', canvas: '#ffffff' }, dark: {} },
  },
}))

const { t3Palette } = await import('../src/palette/t3.ts')

describe('a theme file that does not hold what the palettes read', () => {
  it('refuses a colour in a form other than #RRGGBB or oklch(L C H)', () => {
    expect(() => t3Palette('odd' as never)).toThrow('T3 Code colour not-a-colour is neither #RRGGBB nor oklch(L C H)')
  })

  it('refuses a theme that lacks a role', () => {
    expect(() => t3Palette('bare' as never)).toThrow('T3 Code theme bare has no light accent colour')
  })
})
