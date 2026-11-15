/**
 * A picked workspace icon as one inline SVG, for pages that are not the studio: the sign-in pages and the favicon. The
 * icon is parsed with the workspace icon schema, so only a valid icon draws; a glyph comes from the shipped set by id,
 * letters and the emoji are escaped text, and a pattern is rectangles. Nothing in the result comes from the person's
 * text unescaped, and an invalid icon draws nothing, so the caller shows the Delorun mark.
 * @module @delorun/brand/picked-icon
 */
import { GLYPH_SVG } from './workspace-glyphs.ts'
import { patternCells, parseWorkspaceIcon, type WorkspaceIcon } from './workspace-icon.ts'

/** The named colours as hex; `auto` is the Delorun accent, since a page has no workspace place colour. */
const COLORS: Readonly<Record<string, string>> = {
  auto: '#d9774a', blue: '#4a7fd9', green: '#3f9f6b', amber: '#d9a03a', violet: '#8b5fd9', red: '#d94a4a', pink: '#d94a9a', teal: '#3a9fa6', slate: '#6b7685',
}

const RADIUS: Readonly<Record<WorkspaceIcon['shape'], number>> = { rounded: 3.5, circle: 8, square: 0.5, hexagon: 3.5 }

/**
 * Escape text for an SVG text node.
 * @param text - the text.
 * @returns the text with markup characters as references.
 */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Draw the picked icon.
 * @param stored - the picked icon as the branding record holds it, JSON text.
 * @param size - the drawn width and height in pixels.
 * @returns an `<svg>` element as text, or undefined when the text is not a valid workspace icon.
 */
export function pickedIconSvg(stored: string, size: number): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(stored)
  } catch (_notJson) {
    // Text that is not JSON is not a picked icon, so the caller shows the Delorun mark.
    return undefined
  }
  const icon = parseWorkspaceIcon(value)
  if (icon === undefined) return undefined
  const color = icon.color.startsWith('#') ? icon.color : COLORS[icon.color] ?? COLORS.auto as string
  const ink = icon.style === 'solid' ? '#ffffff' : color
  const fill = icon.style === 'solid' ? color : icon.style === 'soft' ? color : 'none'
  const opacity = icon.style === 'soft' ? ' fill-opacity="0.16"' : ''
  const stroke = icon.style === 'outline' ? ` stroke="${color}" stroke-width="1"` : ''
  const tile = `<rect x="0.5" y="0.5" width="15" height="15" rx="${String(RADIUS[icon.shape])}" fill="${fill}"${opacity}${stroke}/>`
  let content: string
  switch (icon.kind) {
    case 'glyph':
      content = `<g transform="translate(2.7 2.7) scale(0.66)" color="${ink}" stroke="${ink}">${GLYPH_SVG[icon.glyph].replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g>`
      break
    case 'emoji':
      content = `<text x="8" y="11.5" text-anchor="middle" font-size="9">${escapeText(icon.emoji)}</text>`
      break
    case 'pattern':
      content = `<g fill="${ink}" transform="translate(1 1) scale(2)" shape-rendering="crispEdges">${patternCells(icon.seed).map(([row, column]) => `<rect x="${String(column + 0.5)}" y="${String(row + 0.5)}" width="1" height="1"/>`).join('')}</g>`
      break
    case 'letters':
      content = `<text x="8" y="10.8" text-anchor="middle" font-size="8.25" font-weight="700" fill="${ink}" font-family="sans-serif">${escapeText(icon.letters.toLocaleUpperCase())}</text>`
      break
    default: {
      const never: never = icon.kind
      return never
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${String(size)}" height="${String(size)}" aria-hidden="true">${tile}${content}</svg>`
}
