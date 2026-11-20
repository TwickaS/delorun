/**
 * Scan directories for the building user's own paths, as the release's build and signing steps do, so the npm
 * launcher's package, which `npm-launcher/src/build.ts` writes outside them, can be checked before it is published.
 *
 * `tsx delorun/apps/release/scripts/home-path-gate.ts <directory>...`
 *
 * Each directory is scanned with `closure/home-paths.ts`: every file, and every entry of each `.tar.gz` and `.tgz`
 * inside it, for this computer user's home directory, user name as a folder and the unique build root. The command
 * names every offending file and exits 1; it exits 0 when none is found and 2 without a directory.
 *
 * @module home-path-gate
 */
import { resolve } from 'node:path'
import { homePathProblems } from '../src/closure/home-paths.ts'

const directories = process.argv.slice(2)
if (directories.length === 0) {
  console.error('home-path-gate: pass at least one directory')
  process.exit(2)
}
let found = 0
for (const directory of directories) {
  for (const problem of await homePathProblems(resolve(directory))) {
    console.error(`home-path-gate: ${directory}/${problem.file}: ${problem.found}`)
    found += 1
  }
}
console.log(`home-path-gate: ${String(found)} file${found === 1 ? '' : 's'} name the builder's paths in ${directories.join(', ')}`)
process.exitCode = found === 0 ? 0 : 1
