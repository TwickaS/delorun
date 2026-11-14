/**
 * Re-records the bilingual pairs of a checkout of `HEAD` with that checkout's own pairing modules, for the baseline
 * of {@link ./pairing-staged.ts}. Usage: `tsx pairing-rerecord.ts <tree> <record>...`. It prints, one per line, the
 * records whose pair has all three files in the tree and is in the tree's pairing scope; a pair whose record cannot be
 * computed (for example its heading counts differ) keeps its own record.
 *
 * @module @delorun/tools/pairing-rerecord
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [tree, ...records] = process.argv.slice(2)
if (tree === undefined) {
  console.error('usage: pairing-rerecord.ts <tree> <record>...')
  process.exit(2)
}

/**
 * Load a module of the checkout.
 * @param name - the file name under `scripts/`.
 * @returns the module's exports.
 */
const load = async (name: string): Promise<Record<string, any>> => import(pathToFileURL(join(tree, 'scripts', name)).href)
const record = await load('translation-pairing-record.ts')
const pairing = await load('translation-pairing.ts')
const manifest = pairing.parseTranslationPairingManifest(readFileSync(join(tree, 'scripts/translation-pairing.manifest.json'), 'utf8'))
const context = {
  repoRoot: tree,
  isTranslationPairSource: pairing.translationPairSourcePredicate(manifest),
  repositoryFileExists: (file: string) => existsSync(join(tree, file)),
}

for (const anchor of records) {
  const source = `${anchor.slice(0, -'.i18n.yaml'.length)}.md`
  if (!pairing.isTranslationScopeFile(source) || pairing.isTranslationPairingManifestExcluded(source, manifest)) continue
  const paths = record.translationPairPaths(source)
  if (![paths.source, paths.zh, paths.meta].some(context.repositoryFileExists)) continue
  if (![paths.source, paths.zh].every(context.repositoryFileExists)) {
    console.log(anchor)
    continue
  }
  try {
    const text = record.renderTranslationPairingRecord(paths, record.computeTranslationPairingRecord(
      paths, readFileSync(join(tree, paths.source), 'utf8'), readFileSync(join(tree, paths.zh), 'utf8'), context,
    ))
    writeFileSync(join(tree, paths.meta), text)
  } catch (error) {
    void error // the pair cannot be recorded; HEAD's own record and the checker's report for it stay
  }
  console.log(anchor)
}
