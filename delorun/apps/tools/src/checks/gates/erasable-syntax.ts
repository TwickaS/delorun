/**
 * Erasable-syntax gate: every TypeScript source under `delorun/` uses only syntax that Node's type stripping removes by
 * erasing text. Node loads these sources natively in a source checkout and in the Web specs, and fails the import of a
 * file with a constructor parameter property, an `enum`, a `namespace` that holds values, an `import x = ...`, an
 * `export =` or an angle-bracket assertion, so a plugin that holds one never loads. The release transpiles Delorun's
 * packages and is not affected, which is why only this gate and the load itself notice. TypeScript's own
 * `erasableSyntaxOnly` option cannot replace it here: the Delorun programs also read upstream's sources through
 * `paths`, and upstream uses parameter properties. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/erasable-syntax.ts`. It prints one line per violation and
 * exits 1.
 *
 * @module @delorun/tools/checks/gates/erasable-syntax
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { repositoryRoot } from '../../git.ts'

/** The TypeScript source extensions the gate reads; declaration files hold no runtime syntax. */
const SOURCE = /(?<!\.d)\.(?:ts|tsx|mts|cts)$/u

/** Modifiers that turn a constructor parameter into a property. */
const PARAMETER_PROPERTY_MODIFIERS = new Set([
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.ReadonlyKeyword,
  ts.SyntaxKind.OverrideKeyword,
])

/**
 * Every TypeScript source under a directory, skipping dependency trees, build output and hidden directories.
 * @param dir - the directory to search.
 * @returns the absolute paths of the sources, in directory order.
 */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return ['node_modules', 'lib', 'dist'].includes(entry.name) || entry.name.startsWith('.') ? [] : sources(path)
    return entry.isFile() && SOURCE.test(entry.name) ? [path] : []
  })
}

/**
 * Whether a namespace body holds a value, which Node's stripping cannot erase.
 * @param node - the namespace declaration.
 * @returns true when the body has a statement other than a type, an interface or a nested type-only namespace.
 */
function holdsValues(node: ts.ModuleDeclaration): boolean {
  const body = node.body
  if (body === undefined) return false
  if (ts.isModuleDeclaration(body)) return holdsValues(body)
  /* v8 ignore next -- the other body kind is a JSDoc namespace, which a source file's syntax tree never holds. */
  if (!ts.isModuleBlock(body)) return false
  return body.statements.some(statement =>
    !(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || (ts.isModuleDeclaration(statement) && !holdsValues(statement))))
}

/**
 * The forms in one source that Node's type stripping rejects.
 * @param path - the file's name, whose extension picks the language variant.
 * @param text - the file's text.
 * @returns one `line:column: form` message per occurrence, in source order.
 */
export function unerasableForms(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  const report = (node: ts.Node, form: string): void => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file))
    found.push(`${String(line + 1)}:${String(character + 1)}: ${form}`)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) && node.modifiers?.some(modifier => PARAMETER_PROPERTY_MODIFIERS.has(modifier.kind))) {
      report(node, 'a constructor parameter property; declare the field and assign it in the constructor')
    } else if (ts.isEnumDeclaration(node) && !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
      report(node, 'an enum; use a union of literals or an object with `as const`')
    } else if (ts.isModuleDeclaration(node) && !ts.isModuleDeclaration(node.parent) && !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword) && holdsValues(node)) {
      report(node, 'a namespace that holds values; use a module of its own')
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      report(node, 'an `import x = ...`; use an `import` or a `const`')
    } else if (ts.isExportAssignment(node) && node.isExportEquals === true) {
      report(node, 'an `export =`; use `export default` or named exports')
    } else if (ts.isTypeAssertionExpression(node)) {
      report(node, 'an angle-bracket assertion; use `as`')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * The violations of a repository: every unerasable form in a source under `delorun/`.
 * @param root - the repository root.
 * @returns one `path:line:column: form` message per occurrence; empty when every source is erasable.
 */
export function erasableSyntaxErrors(root: string): string[] {
  const directory = join(root, 'delorun')
  if (!existsSync(directory)) return ['delorun/: no Delorun tree at the repository root, so there are no sources to check']
  return sources(directory).flatMap(path =>
    unerasableForms(path, readFileSync(path, 'utf8')).map(message => `${relative(root, path)}:${message}`))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = erasableSyntaxErrors(repositoryRoot(process.cwd()))
  for (const error of errors) console.error(`gates:erasable-syntax: ${error}`)
  if (errors.length === 0) console.log('gates:erasable-syntax: every source under delorun/ uses only syntax that Node strips')
  process.exitCode = errors.length === 0 ? 0 : 1
}
