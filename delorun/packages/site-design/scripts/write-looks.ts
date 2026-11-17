/**
 * Writes `src/looks.css` from the Theme plugin's palettes. Run from this package: `node scripts/write-looks.ts`.
 *
 * @module @delorun/site-design/scripts/write-looks
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildLooks } from './looks.ts'

writeFileSync(fileURLToPath(new URL('../src/looks.css', import.meta.url)), buildLooks())
