// Writes a changelog record that assembles the repository's unreleased fragments as a preview version, for a staging
// review of the docs site before the release assembles a version. Reads the fragments, moves none of them and writes
// only the file named. Run from the repository root:
//   node_modules/.bin/tsx delorun/apps/docs/scripts/preview-record.ts <version> <output.json>
// then build the site with `DOCS_CHANGELOG_PREVIEW=<output.json>`. Never commit the output.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { repositoryRoot } from '../../tools/src/git.ts'
import { assembleRelease } from '../../release/src/changelog/assemble.ts'

const [version, output] = process.argv.slice(2)
if (version === undefined || output === undefined) {
  console.error('usage: preview-record.ts <version> <output.json>')
  process.exit(2)
}
const { data } = assembleRelease(repositoryRoot(process.cwd()), version, { firstPublicRelease: false })
mkdirSync(dirname(resolve(output)), { recursive: true })
writeFileSync(resolve(output), `${JSON.stringify(data, undefined, 2)}\n`)
console.log(`preview-record: wrote ${resolve(output)} with ${String(data.versions.length)} version(s); not an assembled release`)
