/**
 * The rebuild comparison of contract C2: `node_modules/.bin/tsx delo/apps/release/src/compare-rebuild.ts <first>
 * <second>` compares two output directories of the same release. It exits 0 when they differ only in what the
 * committed `delo/apps/release/rebuild-exceptions.json` accepts, printing each accepted difference with its exception,
 * and exits 1 on any other difference, printing each one. Signing refuses without a match. It exits 2 on a usage
 * error, an exceptions file that does not validate or an output directory it cannot read.
 *
 * @module @delo/release/compare-rebuild
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { readRecipeFile, RebuildExceptions, RECIPE_DIR, Toolchain } from './closure/config.ts'
import { readImagesRecipe } from './images/build.ts'
import { compareOutputs, type Comparison } from './rebuild/compare.ts'

/**
 * The report lines of a comparison.
 * @param comparison - the result.
 * @returns one line per accepted difference and per difference, then a summary line.
 */
export function comparisonReport(comparison: Comparison): string[] {
  const lines = comparison.accepted.map(item => `accepted: ${item.file}: ${item.entry} (rebuild exception ${item.exception})`)
  for (const item of comparison.differences) lines.push(`differs: ${item.file}${item.entry === undefined ? '' : `: ${item.entry}`}: ${item.detail}`)
  lines.push(comparison.differences.length === 0
    ? `compare-rebuild: match over ${String(comparison.files.length)} files, ${String(comparison.accepted.length)} differences accepted by rebuild-exceptions.json`
    : `compare-rebuild: ${String(comparison.differences.length)} differences outside rebuild-exceptions.json; signing refuses this rebuild`)
  return lines
}

async function main(argv: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: {} })
  if (positionals.length !== 2) {
    console.error('compare-rebuild: pass the two output directories: compare-rebuild.ts <first> <second>')
    return 2
  }
  let exceptions: RebuildExceptions
  try {
    exceptions = readRecipeFile(RebuildExceptions, join(RECIPE_DIR, 'rebuild-exceptions.json'))
  } catch (error) {
    console.error(`compare-rebuild: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  let comparison: Comparison
  try {
    comparison = await compareOutputs(positionals[0]!, positionals[1]!, { exceptions, toolchain: readRecipeFile(Toolchain, join(RECIPE_DIR, 'toolchain.json')), images: readImagesRecipe() })
  } catch (error) {
    console.error(`compare-rebuild: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  for (const line of comparisonReport(comparison)) console.log(line)
  return comparison.differences.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
