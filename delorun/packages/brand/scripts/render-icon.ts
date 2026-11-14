/**
 * Render Delorun's application icons from `src/icons.ts`.
 *
 * `node --experimental-strip-types delorun/packages/brand/scripts/render-icon.ts --write` rewrites the desktop and web icon
 * files in the repository: `apps/desktop/resources/icon*.svg|png`, the tray icon (through
 * `apps/desktop/scripts/render-tray-icon.ts`) and the web app's favicons and PNG icons.
 * `... --previews <dir>` writes `icon-<size>-<light|dark>.png` previews at 16, 32, 256 and 1024 px, where 16 and 32 show
 * the enlarged tray hex. Needs `sharp` from `apps/desktop`.
 *
 * @module @delorun/brand/scripts/render-icon
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { faviconIcon, macosIcon, plainIcon, webIcon, windowsIcon } from '../src/icons.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const sharp = createRequire(join(root, 'apps/desktop/package.json'))('sharp') as typeof import('sharp')
const args = process.argv.slice(2)

/** Rasterize an SVG document to a square PNG of `size` pixels. */
async function png(svg: string, size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg.replace('<svg ', `<svg width="${String(size)}" height="${String(size)}" `))).png().toBuffer()
}

/** The Windows icon with the tray glyph enlarged, as the tray bitmaps show it. */
const trayView = (): string => windowsIcon().replace('<g id="tray-glyph"', '<g id="tray-glyph" transform="translate(552 544) scale(1.2) translate(-552 -544)"')

if (args.includes('--write')) {
  const desktop = join(root, 'apps/desktop/resources')
  const web = join(root, 'apps/web/public')
  const files: [string, string, number | undefined][] = [
    [join(desktop, 'icon-macos'), macosIcon(), 1024], [join(desktop, 'icon-windows'), windowsIcon(), 1024], [join(desktop, 'icon'), plainIcon(), 1104],
    [join(web, 'icon-512'), webIcon(230, 0.62), 512], [join(web, 'icon-192'), webIcon(230, 0.62), 192],
    [join(web, 'apple-touch-icon'), webIcon(0, 0.62), 180], [join(web, 'icon-maskable-512'), webIcon(0, 0.5), 512],
  ]
  for (const [base, svg, size] of files) {
    if (!base.includes('/web/')) writeFileSync(`${base}.svg`, svg)
    if (size !== undefined) writeFileSync(`${base}.png`, await png(svg, size))
  }
  writeFileSync(join(web, 'favicon.svg'), faviconIcon('light'))
  writeFileSync(join(web, 'favicon-dark.svg'), faviconIcon('dark'))
  execFileSync('node_modules/.bin/tsx', ['scripts/render-tray-icon.ts'], { cwd: join(root, 'apps/desktop'), stdio: 'inherit' })
}

const previews = args[args.indexOf('--previews') + 1]
if (args.includes('--previews') && previews !== undefined) {
  mkdirSync(previews, { recursive: true })
  writeFileSync(join(previews, 'icon.svg'), plainIcon())
  for (const [name, background] of [['light', '#FFFFFF'], ['dark', '#1E1E1E']] as const) {
    for (const size of [16, 32, 256, 1024]) {
      const tile = await png(size <= 32 ? trayView() : plainIcon(), size)
      const pad = Math.round(size * 0.25)
      await sharp({ create: { width: size + 2 * pad, height: size + 2 * pad, channels: 4, background } }).composite([{ input: tile, left: pad, top: pad }]).png().toFile(join(previews, `icon-${String(size)}-${name}.png`))
    }
  }
}
