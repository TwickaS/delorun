/**
 * Delorun's application icons as SVG documents, drawn from the one mark ({@link MARK}) and the brand colours. The
 * desktop app, the studio's web app and the previews are rendered from these by `scripts/render-icon.ts`; the committed
 * SVG files are checked against these builders by `tests/icons.spec.ts`.
 * @module @delorun/brand/icons
 */
import { BRAND_COLOURS } from './tokens.ts'
import { MARK } from './mark-data.ts'

const { ink, paper, peach } = BRAND_COLOURS

/** The mark with the nut in `nut` and the plug in peach, in the 32 by 32 box, scaled and moved by `transform`. */
function mark(transform: string, nut: string): string {
  return `<g transform="${transform}"><path d="${MARK.nut}" fill="${nut}" fill-rule="evenodd"/><circle cx="${MARK.plug.cx}" cy="${MARK.plug.cy}" r="${MARK.plug.r}" fill="${peach}"/></g>`
}

/** The transform that centres the mark at (`cx`, `cy`) with an edge of `edge` units. */
function centred(cx: number, cy: number, edge: number): string {
  const scale = edge / 32
  return `translate(${(cx - edge / 2).toFixed(2)} ${(cy - edge / 2).toFixed(2)}) scale(${scale.toFixed(3)})`
}

const svg = (viewBox: string, body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`

/** The macOS icon: an ink tile 824 units wide with the 100-unit margin macOS expects, the mark at 62% of the tile. */
export const macosIcon = (): string => svg('0 0 1024 1024', `<rect x="100" y="100" width="824" height="824" rx="185" fill="${ink}"/>${mark(centred(512, 512, 824 * 0.62), paper)}`)

/** The tile-less Linux and docs icon: a full ink tile with the mark at 62%. */
export const plainIcon = (): string => svg('0 0 1024 1024', `<rect width="1024" height="1024" rx="230" fill="${ink}"/>${mark(centred(512, 512, 1024 * 0.62), paper)}`)

/**
 * The Windows icon. The tile and the mark sit in the coordinate space `apps/desktop/scripts/render-tray-icon.ts`
 * enlarges around (552, 544), and the mark is the `tray-glyph` group it scales, so the tray bitmaps show a larger hex.
 */
export const windowsIcon = (): string => svg('0 0 1024 1024', `<g transform="translate(32 32) scale(0.9375) translate(-40 -32)"><rect rx="192" width="1024" height="1024" transform="translate(40 32)" fill="${ink}"/><g id="tray-glyph">${mark(centred(552, 544, 1024 * 0.62), paper)}</g></g>`)

/** The studio's web favicon for a light or a dark browser theme: the mark alone, nut in ink or paper. */
export const faviconIcon = (scheme: 'light' | 'dark'): string => svg('0 0 32 32', mark('', scheme === 'light' ? ink : paper).replace('<g transform="">', '<g>'))

/** A square web app icon: a full-bleed ink tile with the mark at `fraction` of it; `radius` rounds the corners. */
export const webIcon = (radius: number, fraction: number): string => svg('0 0 1024 1024', `<rect width="1024" height="1024" rx="${String(radius)}" fill="${ink}"/>${mark(centred(512, 512, 1024 * fraction), paper)}`)
