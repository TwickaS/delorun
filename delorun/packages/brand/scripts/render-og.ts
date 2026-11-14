/**
 * Writes the social card's source page, `apps/website/scripts/og.html`, from the brand package.
 * Usage: `node_modules/.bin/tsx delorun/packages/brand/scripts/render-og.ts --write`; without `--write` it prints the page.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ogHtml } from '../src/og.ts'

if (process.argv.includes('--write')) writeFileSync(fileURLToPath(new URL('../../../apps/website/scripts/og.html', import.meta.url)), ogHtml())
else process.stdout.write(ogHtml())
