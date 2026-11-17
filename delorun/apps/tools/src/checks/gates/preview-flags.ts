/**
 * Preview-flags gate: every Delorun package's list of preview flags equals what its plugin declares. A package that
 * declares flags (`@delorun/preview-flags`) lists their ids in its `package.json` under `delorun.previewFlags`, which
 * `delorun preview` and the Host read without running the plugin, and exports the declarations themselves as
 * `PREVIEW_FLAGS` from `src/preview-flags.ts`. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/preview-flags.ts`. It prints one line per violation and
 * exits 1 on a violation.
 *
 * The rules, over the packages under `delorun/packages`:
 *
 * 1. A package that lists flags, or has `src/preview-flags.ts`, exports `PREVIEW_FLAGS` there: a list of declarations.
 * 2. The listed ids and the declared ids are the same set.
 * 3. Each declaration names the package as its owner.
 * 4. A source that calls `previewFlags.declare(` belongs to a package with `src/preview-flags.ts`, so no flag is
 *    declared outside the list this gate reads.
 *
 * @module @delorun/tools/checks/gates/preview-flags
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { repositoryRoot } from '../../git.ts'

/** The directory whose packages the gate reads. */
const PACKAGES_DIR = 'delorun/packages'

/** The module a declaring package keeps its declarations in, relative to the package. */
export const DECLARATIONS_MODULE = 'src/preview-flags.ts'

/** The package that defines `declare`, whose own sources name it without declaring a flag. */
const DEFINING_PACKAGE = '@delorun/preview-flags'

const manifestFields = z.looseObject({
  name: z.string(),
  delorun: z.looseObject({ previewFlags: z.array(z.string()).optional() }).optional(),
})

const declarations = z.array(z.looseObject({ id: z.string(), owner: z.string() }))

/**
 * Every source file under a directory.
 * @param directory - the directory to walk.
 * @returns the `.ts` and `.tsx` paths.
 */
function sources(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(entry) ? [path] : []
  })
}

/**
 * The gate's violations.
 * @param root - the repository root.
 * @returns one sentence per broken rule, each starting with the package's directory.
 */
export async function previewFlagViolations(root: string): Promise<string[]> {
  const violations: string[] = []
  const base = join(root, PACKAGES_DIR)
  for (const entry of existsSync(base) ? readdirSync(base).sort() : []) {
    const dir = `${PACKAGES_DIR}/${entry}`
    const manifestPath = join(root, dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = manifestFields.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const listed = manifest.delorun?.previewFlags ?? []
    const modulePath = join(root, dir, DECLARATIONS_MODULE)
    if (!existsSync(modulePath)) {
      if (listed.length > 0) violations.push(`${dir}: package.json lists ${listed.join(', ')} under delorun.previewFlags, and ${DECLARATIONS_MODULE} does not exist to declare them`)
      if (manifest.name !== DEFINING_PACKAGE) {
        for (const file of sources(join(root, dir, 'src'))) {
          if (readFileSync(file, 'utf8').includes('previewFlags.declare(')) violations.push(`${dir}: ${file.slice(join(root, dir).length + 1)} declares a preview flag, and the package has no ${DECLARATIONS_MODULE} that exports PREVIEW_FLAGS`)
        }
      }
      continue
    }
    const loaded = declarations.safeParse((await import(pathToFileURL(modulePath).href) as { PREVIEW_FLAGS?: unknown }).PREVIEW_FLAGS)
    if (!loaded.success) {
      violations.push(`${dir}: ${DECLARATIONS_MODULE} does not export PREVIEW_FLAGS as a list of flag declarations`)
      continue
    }
    const declared = loaded.data.map(flag => flag.id)
    for (const id of declared.filter(each => !listed.includes(each))) violations.push(`${dir}: ${id} is declared in ${DECLARATIONS_MODULE} and not listed under delorun.previewFlags in package.json`)
    for (const id of listed.filter(each => !declared.includes(each))) violations.push(`${dir}: ${id} is listed under delorun.previewFlags in package.json and not declared in ${DECLARATIONS_MODULE}`)
    for (const flag of loaded.data.filter(each => each.owner !== manifest.name)) violations.push(`${dir}: ${flag.id} names ${flag.owner} as its owner, and the package is ${manifest.name}`)
  }
  return violations
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = await previewFlagViolations(repositoryRoot(process.cwd()))
  for (const violation of violations) console.error(`gates:preview-flags: ${violation}`)
  if (violations.length === 0) console.log('gates:preview-flags: every package\'s listed preview flags are the ones its plugin declares')
  process.exitCode = violations.length === 0 ? 0 : 1
}
