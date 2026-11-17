/**
 * Upstream-source import gate: no source under `delorun/` imports a file in an upstream package's `src/`. Node loads a
 * Delorun plugin from `node_modules` and runs upstream's package entry, which is built JavaScript; a `src/` file is
 * TypeScript that Node's type stripping cannot always load (parameter properties, enums, extensionless imports), so
 * the plugin fails to import in a real profile while every source-plane check passes. Upstream's `exports` map lists
 * `./src/*` for its own tooling, which is why the import type-checks. Import from the package entry, and export what is
 * missing from the entry. The gate reads the `src/` directories of Delorun's packages and apps; their specs, build
 * configuration and fixtures run under vitest and tsdown, which compile TypeScript. Run from anywhere inside the
 * repository: `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/upstream-src-imports.ts`. It prints one line per
 * violation and exits 1.
 *
 * @module @delorun/tools/checks/gates/upstream-src-imports
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { repositoryRoot } from '../../git.ts'

const SOURCE = /(?<!\.d)\.(?:ts|tsx|mts|cts)$/u

/** A bare specifier that names a file under an upstream package's `src/`. */
const UPSTREAM_SRC_SPECIFIER = /^@deepseek-ai\/[^/]+\/src(?:\/|$)/u

/** The product website's alias for upstream client source, which only the replica's browser code may use (it never runs under Node). */
const STUDIO_SPECIFIER = /^#studio\//u

/** The one directory whose sources may import `#studio/`. */
const STUDIO_ALLOWED = 'delorun/apps/website/src/replica/'

/** The top-level directories that hold upstream's packages. */
const UPSTREAM_ROOTS = ['packages', 'vendor']

/**
 * Every TypeScript source in a directory tree, skipping dependency trees, build output and hidden directories.
 * @param dir - the directory to search.
 * @returns the absolute paths of the sources.
 */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return ['node_modules', 'lib', 'dist'].includes(entry.name) || entry.name.startsWith('.') ? [] : sources(path)
    return entry.isFile() && SOURCE.test(entry.name) ? [path] : []
  })
}

/**
 * The module specifiers a source imports or re-exports, with positions.
 * @param path - the file's name, whose extension picks the language variant.
 * @param text - the file's text.
 * @returns each static, re-export, dynamic and `import()` type specifier with its `line:column`.
 */
export function specifiers(path: string, text: string): { readonly specifier: string, readonly position: string }[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: { specifier: string, position: string }[] = []
  const add = (literal: ts.Node): void => {
    if (!ts.isStringLiteralLike(literal)) return
    const { line, character } = file.getLineAndCharacterOfPosition(literal.getStart(file))
    found.push({ specifier: literal.text, position: `${String(line + 1)}:${String(character + 1)}` })
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) add(node.moduleSpecifier)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined) add(node.arguments[0])
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * Whether a specifier in a source names a file under an upstream package.
 * @param root - the repository root.
 * @param path - the importing file's absolute path.
 * @param specifier - the module specifier.
 * @returns true for `@deepseek-ai/<pkg>/src/...` and for a relative path that lands under `packages/` or `vendor/`.
 */
function reachesUpstreamSource(root: string, path: string, specifier: string): boolean {
  if (UPSTREAM_SRC_SPECIFIER.test(specifier)) return true
  if (!specifier.startsWith('.')) return false
  const target = relative(root, resolve(dirname(path), specifier)).split(sep)
  return UPSTREAM_ROOTS.includes(target[0] ?? '')
}

/**
 * The violations of a repository: every import from a Delorun `src/` file into an upstream package's source.
 * @param root - the repository root.
 * @returns one `path:line:column: message` per import; empty when none reaches upstream source.
 */
export function upstreamSourceImportErrors(root: string): string[] {
  const delorun = join(root, 'delorun')
  if (!existsSync(delorun)) return ['delorun/: no Delorun tree at the repository root, so there are no sources to check']
  const errors: string[] = []
  for (const group of ['packages', 'apps']) {
    const base = join(delorun, group)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const src = join(base, entry.name, 'src')
      if (!entry.isDirectory() || !existsSync(src)) continue
      for (const path of sources(src)) {
        for (const { specifier, position } of specifiers(path, readFileSync(path, 'utf8'))) {
          if (STUDIO_SPECIFIER.test(specifier) && !relative(root, path).split(sep).join('/').startsWith(STUDIO_ALLOWED)) {
            errors.push(`${relative(root, path)}:${position}: imports '${specifier}', the replica's alias for upstream client source; only ${STUDIO_ALLOWED} may`)
          } else if (reachesUpstreamSource(root, path, specifier)) {
            errors.push(`${relative(root, path)}:${position}: imports upstream source '${specifier}'; import the package entry and export what it lacks`)
          }
        }
      }
    }
  }
  return errors
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = upstreamSourceImportErrors(repositoryRoot(process.cwd()))
  for (const error of errors) console.error(`gates:upstream-src-imports: ${error}`)
  if (errors.length === 0) console.log('gates:upstream-src-imports: no source under delorun/ imports upstream source')
  process.exitCode = errors.length === 0 ? 0 : 1
}
