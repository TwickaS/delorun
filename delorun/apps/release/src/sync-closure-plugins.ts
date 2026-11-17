/**
 * Writes the closure's plugin selection into `delorun/apps/runtime-closure/package.json`, or checks it:
 *
 * `node_modules/.bin/tsx delorun/apps/release/src/sync-closure-plugins.ts [--check] [--excluded]`
 *
 * `--check` changes nothing and exits 1 when the committed dependencies differ from the selection; `--excluded` prints
 * the packages the closure leaves out with their reasons. Run `pnpm install --lockfile-only` after a write.
 *
 * @module @delorun/release/sync-closure-plugins
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { closureRootDependencies, readWorkspacePackages, selectClosurePackages } from './closure/plugin-set.ts'

const MANIFEST = 'delorun/apps/runtime-closure/package.json'

/**
 * Compute the manifest text the selection requires.
 * @param root - the repository root.
 * @returns the current text and the required text.
 */
export function requiredManifest(root: string): { current: string; required: string } {
  const path = join(root, MANIFEST)
  const current = readFileSync(path, 'utf8')
  const manifest = JSON.parse(current) as { dependencies: Record<string, string> }
  manifest.dependencies = closureRootDependencies(manifest.dependencies, selectClosurePackages(readWorkspacePackages(root)))
  return { current, required: `${JSON.stringify(manifest, undefined, 2)}\n` }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, excluded: { type: 'boolean' } } })
  const root = resolve(import.meta.dirname, '../../../..')
  if (values.excluded === true) {
    for (const each of selectClosurePackages(readWorkspacePackages(root)).excluded) console.log(`${each.dir}\t${each.reason}`)
  } else {
    const { current, required } = requiredManifest(root)
    if (current !== required) {
      if (values.check === true) {
        console.error(`${MANIFEST} differs from the closure's plugin selection; run sync-closure-plugins.ts`)
        process.exit(1)
      }
      writeFileSync(join(root, MANIFEST), required)
    }
  }
}
