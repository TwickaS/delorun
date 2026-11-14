/**
 * Copies `@delorun/brand`'s font stylesheet and woff2 files into this package's
 * client build input, `src/client/fonts.css` and `src/client/assets/fonts/`, so
 * the preset's `url()` rewrite publishes them under `lib/assets/`. The copies are
 * generated and git-ignored; `packages/brand/src` holds the committed files.
 *
 * Runs as the first step of `build`. Stale files in the target fonts directory
 * are removed, so a font dropped from brand is not published.
 *
 * Usage: `node scripts/copy-brand-fonts.ts`
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BRAND_SRC = fileURLToPath(new URL('../../brand/src/', import.meta.url))
const CLIENT = fileURLToPath(new URL('../src/client/', import.meta.url))
const TARGET_FONTS = fileURLToPath(new URL('../src/client/assets/fonts/', import.meta.url))

/** Copies brand's `fonts.css` and `assets/fonts/*.woff2` into the client build input. */
export function copyBrandFonts(): void {
  rmSync(TARGET_FONTS, { recursive: true, force: true })
  mkdirSync(TARGET_FONTS, { recursive: true })
  copyFileSync(`${BRAND_SRC}fonts.css`, `${CLIENT}fonts.css`)
  for (const name of readdirSync(`${BRAND_SRC}assets/fonts`)) {
    if (name.endsWith('.woff2')) copyFileSync(`${BRAND_SRC}assets/fonts/${name}`, `${TARGET_FONTS}${name}`)
  }
}

if (import.meta.main) copyBrandFonts()
