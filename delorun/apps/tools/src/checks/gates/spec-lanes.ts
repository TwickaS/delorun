/**
 * Spec-lanes gate: the placement and process rules of Delorun's test lanes (`delorun/vitest.config.ts`). A spec in a unit
 * project (`*.spec.ts` and `*.spec.tsx` that are neither `*.integration.spec.ts` nor `*.docker.spec.ts`) runs at the
 * unit timeout among many workers, so it must not start a process: it may not import `child_process`, call a `git`
 * helper, name `tsx` as a program, or import a local test helper that does. Such a spec is named
 * `*.integration.spec.ts` and runs in the `fork-integration` project. Every synchronous process call
 * (`spawnSync`, `execFileSync`, `execSync`) in any file under a `tests/` directory passes a literal options object with
 * a `timeout`, so a child that hangs fails its test instead of stalling the worker. A line, or the line below a
 * comment, that carries `spec-lanes-allow: <reason>` is exempt. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/spec-lanes.ts`. It prints one line per violation and exits 1.
 *
 * @module @delorun/tools/checks/gates/spec-lanes
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { repositoryRoot } from '../../git.ts'

/** The comment that exempts its own line and the line below it, followed by the reason. */
export const ALLOW_MARKER = 'spec-lanes-allow:'

/** The synchronous process calls that must carry a timeout. */
const SYNC_CALLS = new Set(['spawnSync', 'execFileSync', 'execSync'])

/** The modules whose import starts processes. */
const PROCESS_MODULES = new Set(['child_process', 'node:child_process'])

/** One rule broken at one line. */
export interface Violation {
  /** The repository-relative path. */
  readonly path: string
  /** The 1-based line. */
  readonly line: number
  /** What is wrong and how to fix it. */
  readonly message: string
}

/**
 * Whether a spec path belongs to a unit project of the fork's Vitest configuration.
 * @param path - a path ending in the file name.
 * @returns true for `*.spec.ts` and `*.spec.tsx` that are neither integration nor Docker specs.
 */
export function isUnitSpec(path: string): boolean {
  return /\.spec\.tsx?$/.test(path) && !/\.(?:integration|docker)\.spec\.ts$/.test(path)
}

/** What one source file does that the rules read. */
interface Findings {
  /** Lines that start a process or import a module that does. */
  readonly spawns: { readonly line: number, readonly what: string }[]
  /** Lines of synchronous process calls without a literal `timeout` option. */
  readonly untimed: { readonly line: number, readonly call: string }[]
  /** Relative modules the file imports at run time, other than for constants alone; exempt lines are left out. */
  readonly imports: { readonly line: number, readonly specifier: string }[]
}

/** A binding named in capitals, such as `REPO`: a constant, which starts no process when a spec reads it. */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/

/**
 * Whether an import brings in only types and constants, which cannot start a process.
 * @param node - the import.
 * @returns true for a type-only import and for named imports that are each a type or a constant.
 */
function importsOnlyConstants(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (clause === undefined) return false
  if (clause.isTypeOnly) return true
  if (clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return false
  return clause.namedBindings.elements.every(element => element.isTypeOnly || CONSTANT_NAME.test(element.name.text))
}

/**
 * The lines a file exempts: each line carrying the allow marker with a reason, and the line after it.
 * @param lines - the file's lines.
 * @returns the exempt 1-based line numbers.
 */
function exemptLines(lines: readonly string[]): Set<number> {
  const exempt = new Set<number>()
  lines.forEach((text, index) => {
    const at = text.indexOf(ALLOW_MARKER)
    if (at >= 0 && text.slice(at + ALLOW_MARKER.length).trim() !== '') {
      exempt.add(index + 1)
      exempt.add(index + 2)
    }
  })
  return exempt
}

/**
 * Whether a call's arguments include a literal options object with a `timeout` property.
 * @param call - the call.
 * @returns true when one argument is such an object.
 */
function hasTimeout(call: ts.CallExpression): boolean {
  return call.arguments.some(argument => ts.isObjectLiteralExpression(argument) && argument.properties.some(property =>
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText() === 'timeout'))
}

/**
 * The name a call's callee ends in: `spawnSync` for both `spawnSync(…)` and `childProcess.spawnSync(…)`.
 * @param call - the call.
 * @returns the name, or undefined for any other callee.
 */
function calleeName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text
  return undefined
}

/**
 * Read what a source file does that the rules check.
 * @param path - the file's path, for its script kind.
 * @param text - its source.
 * @returns its findings, exempt lines removed.
 */
function inspect(path: string, text: string): Findings {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const exempt = exemptLines(text.split('\n'))
  const findings: Findings = { spawns: [], untimed: [], imports: [] }
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const spawn = (node: ts.Node, what: string): void => {
    const line = lineOf(node)
    if (!exempt.has(line)) findings.spawns.push({ line, what })
  }
  const module = (node: ts.Node, specifier: string, constantsOnly: boolean): void => {
    if (PROCESS_MODULES.has(specifier)) spawn(node, `imports ${specifier}`)
    else if (specifier.startsWith('.') && !constantsOnly && !exempt.has(lineOf(node))) findings.imports.push({ line: lineOf(node), specifier })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      module(node, node.moduleSpecifier.text, importsOnlyConstants(node))
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      module(node, node.moduleSpecifier.text, node.isTypeOnly)
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && first !== undefined && ts.isStringLiteralLike(first)) module(node, first.text, false)
      const name = calleeName(node)
      if (name === 'git' && ts.isIdentifier(node.expression)) spawn(node, 'runs git')
      if (name !== undefined && SYNC_CALLS.has(name) && !hasTimeout(node)) {
        const line = lineOf(node)
        if (!exempt.has(line)) findings.untimed.push({ line, call: name })
      }
    } else if (ts.isStringLiteralLike(node) && /^tsx\/(?:esm|cjs)$/.test(node.text)) {
      // The loader a spec passes to `node --import` to run TypeScript in a child; as data, a command naming the `tsx` binary is not flagged.
      spawn(node, `loads TypeScript in a child process (${node.text})`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

/**
 * The test helper a relative import names, as a file path. Product modules under `src/` are not helpers: a spec
 * exercises them, with their process seams injected where it stays a unit spec.
 * @param from - the importing file.
 * @param specifier - the relative specifier.
 * @returns the helper's path when it is a TypeScript file under a `tests/` directory and not a spec, else undefined.
 */
function helperPath(from: string, specifier: string): string | undefined {
  const path = resolve(dirname(from), specifier)
  if (!/[/\\]tests[/\\]/.test(path) || /\.spec\.tsx?$/.test(path)) return undefined
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Every TypeScript file under each `tests/` directory of Delorun's apps and packages.
 * @param root - the repository root.
 * @returns absolute paths, sorted.
 */
function testFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path)
    }
  }
  for (const group of ['apps', 'packages']) {
    const base = join(root, 'delorun', group)
    if (!existsSync(base)) continue
    for (const pkg of readdirSync(base, { withFileTypes: true })) {
      const tests = join(base, pkg.name, 'tests')
      if (pkg.isDirectory() && existsSync(tests)) walk(tests)
    }
  }
  return files.sort()
}

/**
 * The spec-lanes violations of a repository.
 * @param root - the repository root.
 * @returns one violation per broken rule and line, in path order.
 */
export function specLaneViolations(root: string): Violation[] {
  const files = testFiles(root)
  const findings = new Map(files.map(path => [path, inspect(path, readFileSync(path, 'utf8'))]))
  // Whether a helper starts a process itself or through a helper it imports; a cycle counts as not spawning.
  const spawning = new Map<string, boolean>()
  const spawns = (path: string): boolean => {
    const known = spawning.get(path)
    if (known !== undefined) return known
    spawning.set(path, false)
    const found = findings.get(path) ?? inspect(path, readFileSync(path, 'utf8'))
    const result = found.spawns.length > 0 || found.imports.some(({ specifier }) => {
      const helper = helperPath(path, specifier)
      return helper !== undefined && spawns(helper)
    })
    spawning.set(path, result)
    return result
  }
  const violations: Violation[] = []
  for (const [path, found] of findings) {
    const shown = relative(root, path)
    for (const { line, call } of found.untimed) {
      violations.push({ path: shown, line, message: `${call} without a literal \`timeout\` option; give it one so a hung child fails the test, or add \`// ${ALLOW_MARKER} <reason>\`` })
    }
    if (!isUnitSpec(path)) continue
    const fix = `rename the spec to *.integration.spec.ts, which runs in the fork-integration project, or add \`// ${ALLOW_MARKER} <reason>\``
    for (const { line, what } of found.spawns) violations.push({ path: shown, line, message: `a unit spec ${what}; ${fix}` })
    for (const { line, specifier } of found.imports) {
      const helper = helperPath(path, specifier)
      if (helper === undefined || !spawns(helper)) continue
      violations.push({ path: shown, line, message: `a unit spec imports ${specifier}, which starts processes; ${fix}` })
    }
  }
  return violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = specLaneViolations(repositoryRoot(process.cwd()))
  for (const { path, line, message } of violations) console.error(`gates:spec-lanes: ${path}:${String(line)}: ${message}`)
  if (violations.length === 0) console.log('gates:spec-lanes: no unit spec starts a process, and every synchronous process call in a spec has a timeout')
  process.exitCode = violations.length === 0 ? 0 : 1
}
