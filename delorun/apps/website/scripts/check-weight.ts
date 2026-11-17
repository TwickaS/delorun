/**
 * Prints the product site's weights from a built directory and exits 1 over a limit. Part of `pnpm build`.
 *
 * Usage: `node scripts/check-weight.ts [out-dir]`
 *
 * @module @delorun/website/scripts/check-weight
 */
import { failures, LIMITS, measure } from './weight.ts'

const weights = measure(process.argv[2] ?? 'out')
const kb = (bytes: number): string => `${(bytes / 1000).toFixed(1)} KB`
console.log(`weight: first screen ${kb(weights.firstScreen)} of ${kb(LIMITS.firstScreen)}; ${String(weights.preloadedFonts)} font preload(s)`)
console.log(`weight: interactive script ${kb(weights.interactiveScript)} of ${kb(LIMITS.interactiveScript)}`)
for (const chunk of weights.lazy) console.log(`weight: ${chunk.kind} chunk ${chunk.file} ${kb(chunk.bytes)}`)
console.log(`weight: whole page ${kb(weights.wholePage)} of ${kb(LIMITS.wholePage)}`)
const broken = failures(weights)
for (const message of broken) console.error(`weight: ${message}`)
process.exitCode = broken.length === 0 ? 0 : 1
