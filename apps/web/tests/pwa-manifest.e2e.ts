import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { chromium, type Page } from 'playwright'
import { MASKABLE_SAFE_RADIUS_RATIO } from '../scripts/render-app-icons.ts'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))
// The build names the product from DSH_CLIENT_TITLE; Delorun's mark is a full-bleed tile with the hex drawn in paper.
const CLIENT_TITLE = process.env.DSH_CLIENT_TITLE ?? 'Delorun'

async function pixels(page: Page, url: string, size: number, light = false) {
  return page.evaluate(async ({ url, size, light }) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0, size, size)
    const { data } = context.getImageData(0, 0, size, size)
    let radius = 0
    let ink = 0
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const at = (y * size + x) * 4
        const bright = data[at]! + data[at + 1]! + data[at + 2]! >= 384
        if (data[at + 3] === 0 || bright !== light) continue
        ink += 1
        radius = Math.max(radius, Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2))
      }
    }
    return {
      width: image.naturalWidth, height: image.naturalHeight, radius, ink,
      corners: [0, size - 1, (size - 1) * size, size * size - 1].map(index => data[index * 4 + 3]),
    }
  }, { url, size, light })
}

function pngUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')
  expect(index).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />')
  expect(index).toContain('<meta name="mobile-web-app-capable" content="yes" />')
  expect(index).toContain(`<meta name="apple-mobile-web-app-title" content="${CLIENT_TITLE}" />`)
  // No `theme-color` here: `ThemePresenter` owns the single metadata node and
  // follows the resolved in-application theme, which a static media query
  // cannot. The manifest's `theme_color` covers the surrounding chrome before
  // the presenter runs, and `settings-chrome.e2e.ts` pins the live contract.

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    // The source manifest names the product Delorun whatever the page title is.
    name: 'Delorun',
    short_name: 'Delorun',
    start_url: './',
    scope: './',
    // `standalone` keeps the phone's status bar; `fullscreen` hides it and the
    // navigation bar, which strands a chat surface with no clock or battery.
    display: 'standalone',
    // The dark theme's base surface, so the launch screen and the surrounding chrome are the studio's own colour
    // rather than a white flash before the first paint.
    background_color: '#151517',
    theme_color: '#151517',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
})

it('decodes every shipped icon at its declared edge with the Delorun tile and corners', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const manifest = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8')) as {
      icons: readonly { src: string; sizes: string; purpose: string }[]
    }
    const declared = [...manifest.icons.map(icon => ({ ...icon, size: Number.parseInt(icon.sizes, 10) })),
      { src: 'apple-touch-icon.png', size: 180, purpose: 'apple' }]
    for (const icon of declared) {
      const image = await pixels(page, pngUrl(await readFile(join(DIST_ROOT, icon.src))), icon.size)
      expect([image.width, image.height], icon.src).toEqual([icon.size, icon.size])
      expect(image.ink, icon.src).toBeGreaterThan(0)
      // Rounded `any` icons keep transparent corners; the Apple and maskable tiles are full-bleed for the platform mask.
      expect(image.corners, icon.src).toEqual(icon.purpose === 'any' ? [0, 0, 0, 0] : [255, 255, 255, 255])
    }
  } finally { await browser.close() }
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  expect(light).toContain('fill="#111110"')
  expect(dark).toContain('fill="#EBEBEB"')
  expect(dark.replace('fill="#EBEBEB"', 'fill="#111110"')).toBe(light)
})

it('keeps the shipped maskable mark inside its opaque platform safe zone', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const maskable = await readFile(join(DIST_ROOT, 'icon-maskable-512.png'))
    const mark = await pixels(page, pngUrl(maskable), 512, true)
    expect(mark.radius).toBeGreaterThan(0)
    expect(mark.radius).toBeLessThanOrEqual(MASKABLE_SAFE_RADIUS_RATIO * 512)
    expect(mark.corners).toEqual([255, 255, 255, 255])
  } finally {
    await browser.close()
  }
})
