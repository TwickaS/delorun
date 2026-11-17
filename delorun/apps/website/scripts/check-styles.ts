/**
 * Fails when a prerendered page uses a class that no stylesheet it links has a rule for, which is how a page shown with
 * scripts off loses its layout. Part of `pnpm build`.
 *
 * Usage: `node scripts/check-styles.ts [out-dir]`
 *
 * @module @delorun/website/scripts/check-styles
 */
import { readdirSync } from 'node:fs'
import { unstyledClasses } from './styles.ts'

const out = process.argv[2] ?? 'out'
let failed = false
for (const page of readdirSync(out).filter(file => file.endsWith('.html'))) {
  const missing = unstyledClasses(out, page)
  if (missing.length > 0) {
    failed = true
    console.error(`styles: ${page} uses classes with no rule in the stylesheets it links: ${missing.join(' ')}`)
  }
}
if (!failed) console.log('styles: every class in the prerendered pages has a rule in a linked stylesheet')
process.exitCode = failed ? 1 : 0
