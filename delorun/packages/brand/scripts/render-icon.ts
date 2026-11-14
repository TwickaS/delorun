/**
 * Draw the Delorun desktop icon from the brand tokens and render PNG previews: the icon at 16, 32, 256 and 1024 px on a
 * light and a dark background. It writes `icon.svg` and the previews to the directory in argument 1 and replaces no
 * release file.
 *
 * `node --experimental-strip-types delorun/packages/brand/scripts/render-icon.ts <outDir>`
 *
 * @module @delorun/brand/scripts/render-icon
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { BRAND_COLOURS } from '../src/tokens.ts'

const outDir = process.argv[2]
if (outDir === undefined) throw new Error('usage: render-icon.ts <outDir>')
const NUT = 'M16 2.5L27.7 9.25V22.75L16 29.5L4.3 22.75V9.25Z M22.6 16A6.6 6.6 0 1 0 9.4 16A6.6 6.6 0 1 0 22.6 16Z'

/** The icon: an ink tile with the mark centred at 62% of the tile, the nut in paper and the plug in peach. */
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="230" fill="${BRAND_COLOURS.ink}"/><g transform="translate(194 194) scale(19.9)"><path d="${NUT}" fill="${BRAND_COLOURS.paper}" fill-rule="evenodd"/><circle cx="16" cy="16" r="3.6" fill="${BRAND_COLOURS.peach}"/></g></svg>`

const require = createRequire(import.meta.url)
const sharp = require(process.env['SHARP_PATH'] ?? 'sharp') as typeof import('sharp')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'icon.svg'), `${icon}\n`)
for (const [name, background] of [['light', '#FFFFFF'], ['dark', '#1E1E1E']] as const) {
  for (const size of [16, 32, 256, 1024]) {
    const tile = await sharp(Buffer.from(icon.replace('viewBox="0 0 1024 1024"', `width="${String(size)}" height="${String(size)}" viewBox="0 0 1024 1024"`))).png().toBuffer()
    const pad = Math.round(size * 0.25)
    await sharp({ create: { width: size + 2 * pad, height: size + 2 * pad, channels: 4, background } }).composite([{ input: tile, left: pad, top: pad }]).png().toFile(join(outDir, `icon-${String(size)}-${name}.png`))
  }
}
