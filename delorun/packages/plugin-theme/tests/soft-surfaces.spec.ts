/** The surfaces `@delorun/brand` hands to pages without the studio are the ones the Soft palette generates. */
import { describe, expect, it } from 'vitest'
import { SOFT_SURFACES, type SoftScheme } from '@delorun/brand/soft-surfaces'
import { parseRgb } from '../src/palette/color.ts'
import type { TokenModes } from '../src/palette/generate.ts'
import { themeLayers } from '../src/palette/layers.ts'
import { STOCK_TOKENS } from '../src/palette/stock.ts'
import { DEFAULT_SETTINGS } from '../src/config.ts'

const ROLES: Readonly<Record<keyof SoftScheme, string>> = {
  page: '--dsw-alias-bg-base',
  card: '--dsw-alias-bg-layer-1',
  well: '--dsw-specific-sidebar-fill',
  border: '--dsw-alias-border-l2',
  text: '--dsw-alias-label-primary',
  textMuted: '--dsw-alias-label-secondary',
  accentText: '--dsw-alias-link',
}

/** The value of a role in one scheme once the default look's layers apply, `var()` references followed. */
function resolved(scheme: 'light' | 'dark', role: string): string {
  const values: Record<string, string> = { ...STOCK_TOKENS[scheme] }
  for (const layer of Object.values(themeLayers({ ...DEFAULT_SETTINGS, studioAdditions: true }))) {
    for (const [name, modes] of Object.entries<TokenModes>(layer ?? {})) values[name] = modes[scheme]
  }
  let value = values[role] ?? ''
  for (let depth = 0; depth < 10; depth += 1) {
    const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
    if (reference === undefined) break
    value = values[reference] ?? ''
  }
  return value
}

/** A colour as the comparable `r g b a` text, whatever notation it came in. */
function channels(text: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(text)?.[1]
  const rgb = hex === undefined ? parseRgb(text) : parseRgb(`rgb(${[0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(' ')})`)
  if (rgb === undefined) throw new Error(`${text} is not a colour`)
  return [rgb.r, rgb.g, rgb.b, rgb.alpha].map(value => value.toFixed(3)).join(' ')
}

describe('the Soft surfaces in @delorun/brand', () => {
  it.each(['light', 'dark'] as const)('equal what the Soft palette generates in the %s scheme', scheme => {
    for (const [key, role] of Object.entries(ROLES)) {
      expect(channels(SOFT_SURFACES[scheme][key as keyof SoftScheme]), `${scheme} ${key}`).toBe(channels(resolved(scheme, role)))
    }
  })
})
