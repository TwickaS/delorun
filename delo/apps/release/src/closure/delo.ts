/**
 * Delo's own packages in a staged closure. Delo's library packages and the `delorun` command export TypeScript
 * sources, which Node does not run from `node_modules`, so each `@delo/` package's `src/**\/*.ts` is transpiled to
 * JavaScript beside itself with its relative imports rewritten to `.js`, the `.ts` file is removed, and every
 * `package.json` entry point that named a removed file names the JavaScript file instead; a package's `tests`
 * directory is removed. The install anchor, the package whose `package.json` upstream's runtime resolution reads to
 * decide what a profile's plugin rows can import, then declares each Delo bundle the recipe names as a dependency at
 * its staged version. The `delorun` command package carries the release's version, which `delorun --version` reports.
 *
 * @module @delo/release/closure/delo
 */
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

/** The npm scope of Delo's packages. */
const DELO_SCOPE = '@delo'

/** The package fields whose paths name files Node loads. */
const ENTRY_FIELDS = ['main', 'exports', 'imports', 'bin'] as const

/** The transpiler's options: types removed, syntax and module format kept, relative `.ts` imports rewritten. */
const TRANSPILE_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  rewriteRelativeImportExtensions: true,
  verbatimModuleSyntax: false,
  sourceMap: false,
  inlineSourceMap: false,
}

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await filesUnder(path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

function isTranspiled(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.d.ts')
}

/**
 * Replace each entry-point path that names a transpiled file with its JavaScript file.
 * @param value - a field's value.
 * @param removed - the package-relative paths of the removed `.ts` files, as `./src/...`.
 * @returns the rewritten value.
 */
function rewriteEntries(value: unknown, removed: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return removed.has(value) ? `${value.slice(0, -'.ts'.length)}.js` : value
  if (Array.isArray(value)) return value.map(item => rewriteEntries(item, removed))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteEntries(item, removed)]))
  return value
}

/**
 * Transpile one Delo package in place.
 * @param directory - the staged package directory.
 * @returns the package-relative paths of the files transpiled.
 * @throws Error when a source does not transpile, or imports a TypeScript file by name, which the closure does not
 * ship in a form Node runs.
 */
export async function transpileDeloPackage(directory: string): Promise<string[]> {
  await rm(join(directory, 'tests'), { recursive: true, force: true })
  const removed = new Set<string>()
  for (const path of (await filesUnder(directory)).sort()) {
    const local = relative(directory, path).split(sep).join('/')
    if (!local.startsWith('src/') || !isTranspiled(path)) continue
    const output = ts.transpileModule(await readFile(path, 'utf8'), { compilerOptions: TRANSPILE_OPTIONS, fileName: local, reportDiagnostics: true })
    const problems = output.diagnostics!.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    if (problems.length > 0) throw new Error(`${join(directory, local)} does not transpile: ${problems.map(problem => ts.flattenDiagnosticMessageText(problem.messageText, ' ')).join('; ')}`)
    const sources = [...output.outputText.matchAll(/(?:from|import\()\s*['"]([^'"]+\.ts)['"]/gu)].map(match => match[1]!)
    if (sources.length > 0) throw new Error(`${join(directory, local)} imports ${sources.join(', ')}, which is TypeScript that Node does not run from node_modules; import the package's published entry point instead`)
    await writeFile(`${path.slice(0, -'.ts'.length)}.js`, output.outputText)
    await rm(path)
    removed.add(`./${local}`)
  }
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  for (const field of ENTRY_FIELDS) if (field in manifest) manifest[field] = rewriteEntries(manifest[field], removed)
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return [...removed].map(path => path.slice(2))
}

/**
 * Transpile every Delo package of a staged `node_modules`.
 * @param nodeModules - the staged closure's `app/node_modules`.
 * @returns the names of the packages transpiled.
 */
export async function transpileDeloPackages(nodeModules: string): Promise<string[]> {
  const scope = join(nodeModules, DELO_SCOPE)
  const names = (await readdir(scope, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  for (const name of names) await transpileDeloPackage(join(scope, name))
  return names.map(name => `${DELO_SCOPE}/${name}`)
}

/**
 * Declare Delo bundles as dependencies of the install anchor, at their staged versions.
 * @param nodeModules - the staged closure's `app/node_modules`.
 * @param anchor - the anchor package's name.
 * @param bundles - the bundles it must declare.
 * @throws Error when the anchor or a bundle is not staged.
 */
export async function declareAnchorBundles(nodeModules: string, anchor: string, bundles: readonly string[]): Promise<void> {
  const read = async (name: string): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(join(nodeModules, name, 'package.json'), 'utf8')) as Record<string, unknown>
    } catch (error) {
      throw new Error(`the closure does not carry ${name}, which closure.json's anchor names`, { cause: error })
    }
  }
  const manifest = await read(anchor)
  const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined) }
  for (const bundle of bundles) {
    const version = (await read(bundle)).version
    if (typeof version !== 'string') throw new Error(`${bundle}'s package.json names no version`)
    dependencies[bundle] = version
  }
  manifest.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1)))
  await writeFile(join(nodeModules, anchor, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/**
 * Stamp the release's version into the `delorun` command package, whose `package.json` `version` is the version
 * `delorun --version` reports and the plugin version checks compare against (contract C17). The workspace holds
 * `0.0.0` there, so a closure built without this step would report `0.0.0` under every release.
 * @param nodeModules - the staged closure's `app/node_modules`.
 * @param version - the release version.
 * @throws Error when the closure does not carry `@delo/cli`.
 */
export async function stampDeloVersion(nodeModules: string, version: string): Promise<void> {
  const path = join(nodeModules, DELO_SCOPE, 'cli', 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`the closure does not carry @delo/cli, which reports the release's version`, { cause: error })
  }
  manifest.version = version
  await writeFile(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
}
