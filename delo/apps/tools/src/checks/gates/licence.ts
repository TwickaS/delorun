/**
 * Licence gate: every package manifest under `delo/` declares `"license": "MIT"`, and the repository's root
 * `LICENSE` is the MIT licence. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/licence.ts`. It prints one line per violation and exits 1.
 *
 * @module @delo/tools/checks/gates/licence
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { repositoryRoot } from '../../git.ts'

/** The licence every Delo package and the root `LICENSE` must carry. */
const LICENCE = 'MIT'

/** The first line and the grant sentence of the MIT licence text. */
const MIT_FIRST_LINE = 'MIT License'
const MIT_GRANT = 'Permission is hereby granted, free of charge'

const manifestFields = z.looseObject({ license: z.string().optional() })

/**
 * Every `package.json` under a directory, skipping dependency trees and hidden directories.
 * @param dir - the directory to search.
 * @returns the absolute paths of the manifests, in directory order.
 */
function packageManifests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : packageManifests(path)
    return entry.isFile() && entry.name === 'package.json' ? [path] : []
  })
}

/**
 * The licence violations of a repository: each package manifest under `delo/` that does not declare MIT, and a
 * root `LICENSE` that is not the MIT licence text.
 * @param root - the repository root.
 * @returns one message per violation; empty when every package and the root licence are MIT.
 */
export function licenceErrors(root: string): string[] {
  const errors: string[] = []
  if (!existsSync(join(root, 'delo'))) errors.push('delo/: no Delo tree at the repository root, so there are no packages to check')
  for (const manifest of existsSync(join(root, 'delo')) ? packageManifests(join(root, 'delo')) : []) {
    const fields = manifestFields.parse(JSON.parse(readFileSync(manifest, 'utf8')))
    if (fields.license !== LICENCE) {
      errors.push(`${relative(root, manifest)}: declares ${fields.license ?? 'no licence'}, not ${LICENCE}`)
    }
  }
  const text = readFileSync(join(root, 'LICENSE'), 'utf8')
  if (text.split('\n')[0]?.trim() !== MIT_FIRST_LINE || !text.includes(MIT_GRANT)) {
    errors.push('LICENSE: the root licence is not the MIT licence text')
  }
  return errors
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = licenceErrors(repositoryRoot(process.cwd()))
  for (const error of errors) console.error(`gates:licence: ${error}`)
  if (errors.length === 0) console.log('gates:licence: every package under delo/ and the root LICENSE are MIT')
  process.exitCode = errors.length === 0 ? 0 : 1
}
