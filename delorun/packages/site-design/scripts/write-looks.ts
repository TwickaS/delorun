/**
 * Writes `src/looks.css` and `src/look-swatches.ts` from the Theme plugin's palettes. Run from this package:
 * `node scripts/write-looks.ts`. With `--check` it writes nothing and exits 1 when either file is out of date, which is
 * how the product site's `pnpm build` refuses a stale look.
 *
 * @module @delorun/site-design/scripts/write-looks
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildLooks, buildSwatches } from './looks.ts'

const targets = [
  { path: fileURLToPath(new URL('../src/looks.css', import.meta.url)), text: buildLooks() },
  { path: fileURLToPath(new URL('../src/look-swatches.ts', import.meta.url)), text: buildSwatches() },
]

if (process.argv.includes('--check')) {
  const stale = targets.filter(target => readFileSync(target.path, 'utf8') !== target.text)
  for (const target of stale) console.error(`looks: ${target.path} is out of date; run \`pnpm generate\` in apps/website`)
  process.exitCode = stale.length === 0 ? 0 : 1
} else {
  for (const target of targets) writeFileSync(target.path, target.text)
}
