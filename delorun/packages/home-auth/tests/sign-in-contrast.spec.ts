/** The sign-in page takes every colour from the brand tokens and the Soft surfaces and keeps each text pair at WCAG AA in both schemes. */
import { readFileSync } from 'node:fs'
import { SOFT_SURFACES } from '@delorun/brand/soft-surfaces'
import { describe, expect, it } from 'vitest'

const css = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8')
const PAGE = css('../assets/sign-in.css')
const TOKENS = css('../../brand/src/tokens.css')

/**
 * The light and dark colour of a `--dl-*` token declared with `light-dark()`, as one value, or as a studio role with a
 * brand fallback. The page has no studio, so a role is undefined and the fallback is the colour it draws.
 */
function token(name: string, scheme: 'light' | 'dark'): string {
  const line = new RegExp(`--${name}:\\s*([^;]+);`).exec(TOKENS)?.[1] ?? ''
  const pair = /light-dark\((#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\)/.exec(line)
  if (pair !== null) return (scheme === 'light' ? pair[1] : pair[2]) as string
  const direct = /^(#[0-9A-Fa-f]{6})$/.exec(line.trim())
  if (direct !== null) return direct[1] as string
  const fallback = /var\(--[\w-]+,\s*(#[0-9A-Fa-f]{6})\)/.exec(line)
  if (fallback !== null) return fallback[1] as string
  const peach = /var\(--dl-peach\)\)?$/.test(line.trim()) || line.includes('var(--dl-peach)') ? token('dl-peach', scheme) : ''
  return peach
}

/** The WCAG relative luminance of a six-digit hex colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}

function ratio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05)
}

/** Mix `fraction` of the first colour into the second, as `color-mix(in srgb)` does. */
function mix(a: string, b: string, fraction: number): string {
  const channel = (index: number): string => Math.round(Number.parseInt(a.slice(index, index + 2), 16) * fraction + Number.parseInt(b.slice(index, index + 2), 16) * (1 - fraction)).toString(16).padStart(2, '0')
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

describe('the sign-in page colours', () => {
  it('declare no colour of their own: no hex literal in the page stylesheet', () => {
    expect(PAGE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it.each(['light', 'dark'] as const)('keep every text pair at 4.5:1 and the field border at 3:1 in the %s scheme', scheme => {
    const { page, card, well, text, textMuted: quiet, accentText } = SOFT_SURFACES[scheme]
    const accent = token('dl-accent', scheme) || token('dl-peach', scheme)
    const tint = mix(accent, card, 0.1)
    for (const [foreground, background] of [[text, page], [text, card], [text, well], [quiet, page], [quiet, card], [quiet, well], [accentText, card], [token('dl-on-accent', scheme), accent], [token('dl-error', scheme), card]] as const) {
      expect(ratio(foreground, background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(ratio(quiet, card)).toBeGreaterThanOrEqual(3)
    // The tinted badge holds a 22px icon, a graphical object, which WCAG 1.4.11 holds to 3:1.
    expect(ratio(accentText, tint)).toBeGreaterThanOrEqual(3)
  })
})
