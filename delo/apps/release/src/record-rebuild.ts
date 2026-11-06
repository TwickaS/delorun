/**
 * Records the targets-key holder's rebuild (contract C2, rebuild before signing). Run on the holder's own machine,
 * outside CI, after building the release's commit with `build-closure.ts` into a local directory:
 *
 * `node_modules/.bin/tsx delo/apps/release/src/record-rebuild.ts --version <version> --release <dir> --rebuild <dir>
 * --builder <name> --compared-with <workflow run URL> [--commit <rev>]`
 *
 * It compares every file of `--rebuild` with the file of the same name in `--release`, the release workflow's
 * output, under the committed `rebuild-exceptions.json`, and writes `delorun-<version>.rebuild.json` into
 * `--release` with the builder, `ci: false`, the recipe digest, the toolchain, the digest of every rebuilt file and
 * the comparison's result. It refuses to run with `CI` or `GITHUB_ACTIONS` set, and exits 1 when the comparison finds
 * a difference, after writing the record that says so.
 *
 * @module @delo/release/record-rebuild
 */
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { RELEASE_SCHEMAS, type RebuildRecord } from '@delo/contract-release-manifest'
import { repositoryRoot } from '@delo/tools/src/git.ts'
import { semanticVersion } from './brands.ts'
import { readRecipe } from './closure/config.ts'
import { comparisonReport } from './compare-rebuild.ts'
import { compareOutputs } from './rebuild/compare.ts'
import { ciMarkers, commitOf, outputRefs, rebuildRecordName, recipeDigest, REQUIRED_SOURCE } from './rebuild/record.ts'

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      version: { type: 'string' },
      release: { type: 'string' },
      rebuild: { type: 'string' },
      builder: { type: 'string' },
      'compared-with': { type: 'string' },
      commit: { type: 'string' },
    },
  })
  try {
    const markers = ciMarkers(process.env)
    if (markers.length > 0) throw new Error(`${markers.join(' and ')} is set; the rebuild record must come from ${REQUIRED_SOURCE}`)
    if (values.version === undefined || values.release === undefined || values.rebuild === undefined || values.builder === undefined || values['compared-with'] === undefined) {
      throw new Error('pass --version, --release, --rebuild, --builder and --compared-with')
    }
    const version = semanticVersion(values.version)
    const repository = repositoryRoot(process.cwd())
    const commit = commitOf(repository, values.commit ?? `v${version}`)
    const recipe = readRecipe()
    const release = resolve(values.release)
    const rebuild = resolve(values.rebuild)
    const outputs = await outputRefs(rebuild)
    if (outputs.length === 0) throw new Error(`${rebuild} holds no rebuilt files`)
    const comparison = await compareOutputs(release, rebuild, recipe.exceptions, new Set(outputs.map(output => output.name)))
    for (const line of comparisonReport(comparison)) console.log(line)
    const record: RebuildRecord = {
      schema: RELEASE_SCHEMAS.rebuild,
      version,
      commit,
      recipe: recipeDigest(repository, commit),
      builder: { name: values.builder, ci: false },
      toolchain: { node: recipe.toolchain.node.version, pnpm: recipe.toolchain.pnpm.version, compiler: recipe.toolchain.native.compiler, linker: recipe.toolchain.native.linker },
      outputs,
      comparedWith: values['compared-with'],
      comparison: comparison.differences.length === 0 ? 'match' : 'difference',
    }
    const path = join(release, rebuildRecordName(version))
    await writeFile(path, `${JSON.stringify(record, undefined, 2)}\n`, { flag: 'wx', mode: 0o644 })
    console.log(`record-rebuild: wrote ${path} (${record.comparison})`)
    return record.comparison === 'match' ? 0 : 1
  } catch (error) {
    console.error(`record-rebuild: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
