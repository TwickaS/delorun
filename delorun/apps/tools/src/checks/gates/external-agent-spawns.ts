/**
 * External-agent spawns gate: no Delorun source starts Claude Code or Codex except through the start gate of
 * `@delorun/external-agents` (T1), upstream's reviewed one-shot path, and the named exception `delorun agents login`.
 * It reads the sources under `delorun/packages/*\/src` and `delorun/apps/*\/src` and refuses, outside the files
 * {@link ALLOWED} names for each rule:
 *
 * - `sdk`: a string naming the Claude Agent SDK or its platform packages (`@anthropic-ai/claude-agent-sdk…`), except in
 *   a type-only import;
 * - `codex`: a string naming the Codex package or its platform packages (`@openai/codex…`);
 * - `locate`: a use of the locator functions that find those programs (`locateClaudeSdk`, `locateClaudeProgram`,
 *   `locateCodex`, `locateCodexProgram`, `loginProgramFor`);
 * - `child-process`: `child_process` imported in the gate's package or a driver package;
 * - `subprocess`: `subprocess` used in the gate's package or a driver package, other than in the gate's module;
 * - `provider`: `getProvider('claude-code')` or `getProvider('codex')` used for anything but a presence check
 *   (`=== undefined`, `!== undefined` and the `null` forms), which upstream's tool path owns;
 * - `program`: `claude`, `codex`, `claude.exe`, `codex.exe` or a path ending in one of them as the program a process
 *   runs: the first argument of `spawn`, `spawnSync`, `execFile`, `execFileSync` or `fork`, the first word of the
 *   command of `exec` or `execSync`, or the first element of an argv array given to those calls or as an `argv`
 *   property.
 *
 * A name built at run time escapes the `sdk`, `codex` and `provider` rules; the `locate` rule covers how a Delorun
 * module finds the pinned programs. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/external-agent-spawns.ts`. It prints one line per violation
 * and exits 1.
 *
 * @module @delorun/tools/checks/gates/external-agent-spawns
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { repositoryRoot } from '../../git.ts'

/** The rules of the gate. */
export type SpawnRule = 'sdk' | 'codex' | 'locate' | 'child-process' | 'subprocess' | 'provider' | 'program'

/** The files each rule allows, as repository-relative paths; a path ending in `/` allows the folder. */
export const ALLOWED: Readonly<Record<SpawnRule, readonly string[]>> = {
  sdk: ['delorun/packages/external-agents/src/locate.ts', 'delorun/packages/agent-claude-code/src/sdk.ts', 'delorun/apps/cli/src/agents/'],
  codex: ['delorun/packages/external-agents/src/locate.ts', 'delorun/packages/agent-codex/src/driver.ts', 'delorun/apps/cli/src/agents/'],
  locate: [
    'delorun/packages/external-agents/src/locate.ts', 'delorun/packages/agent-claude-code/src/sdk.ts',
    'delorun/packages/agent-codex/src/driver.ts', 'delorun/apps/cli/src/agents/',
  ],
  'child-process': ['delorun/packages/agent-claude-code/src/watcher.mjs'],
  subprocess: ['delorun/packages/external-agents/src/gate.ts'],
  provider: [],
  program: ['delorun/packages/external-agents/src/locate.ts', 'delorun/apps/cli/src/agents/'],
}

/** The packages whose sources the `child-process` and `subprocess` rules read. */
export const GATED_PACKAGES = ['delorun/packages/external-agents/', 'delorun/packages/agent-claude-code/', 'delorun/packages/agent-codex/']

const SOURCE = /(?<!\.d)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u
const SDK_NAME = /^@anthropic-ai\/claude-agent-sdk(?:[-/]|$)/u
const CODEX_NAME = /^@openai\/codex(?:[-/]|$)/u
const LOCATORS = new Set(['locateClaudeSdk', 'locateClaudeProgram', 'locateCodex', 'locateCodexProgram', 'loginProgramFor'])
const PROVIDERS = new Set(['claude-code', 'codex'])
const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'])
const SHELL_SPAWNERS = new Set(['exec', 'execSync'])
const PROGRAM_NAME = /(?:^|[\\/])(?:claude|codex)(?:\.exe)?$/iu
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])

/** One violation. */
export interface SpawnViolation {
  /** The repository-relative path. */
  readonly path: string
  /** `line:column`, one-based. */
  readonly position: string
  /** The rule broken. */
  readonly rule: SpawnRule
  /** What was found. */
  readonly found: string
}

/**
 * Whether a rule allows a file.
 * @param rule - the rule.
 * @param path - the repository-relative path, with `/` separators.
 * @returns true when the rule names the file or a folder holding it.
 */
function allowed(rule: SpawnRule, path: string): boolean {
  return ALLOWED[rule].some(entry => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))
}

/**
 * Whether a node sits in a type-only import or export, or an `import()` type.
 * @param node - the node.
 * @returns true for a type-only position.
 */
function typeOnly(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isImportDeclaration(at)) return at.importClause?.isTypeOnly === true
    if (ts.isExportDeclaration(at)) return at.isTypeOnly
    if (ts.isImportTypeNode(at) || ts.isTypeNode(at)) return true
  }
  return false
}

/**
 * Whether a `getProvider(…)` call is only compared with `undefined` or `null`.
 * @param call - the call.
 * @returns true for a presence check.
 */
function presenceCheck(call: ts.Node): boolean {
  let at: ts.Node = call
  while (ts.isNonNullExpression(at.parent) || ts.isParenthesizedExpression(at.parent)) at = at.parent
  const parent = at.parent
  if (!ts.isBinaryExpression(parent) || !EQUALITY.has(parent.operatorToken.kind)) return false
  const other = parent.left === at ? parent.right : parent.left
  return other.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(other) && other.text === 'undefined')
}

/**
 * The text a program position ends with: a string literal's text, or the last literal part of a template.
 * @param node - the expression in the position.
 * @returns the text, or undefined for an expression with no literal ending.
 */
function literalEnding(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.templateSpans.at(-1)?.literal.text
  return undefined
}

/**
 * The program an argv array runs, when its first element is a literal naming one.
 * @param node - the expression that may be the array.
 * @returns the first element, or undefined.
 */
function argvProgram(node: ts.Node | undefined): ts.Node | undefined {
  return node !== undefined && ts.isArrayLiteralExpression(node) ? node.elements[0] : undefined
}

/**
 * Whether a program position names Claude Code or Codex.
 * @param node - the expression in the position.
 * @param shell - whether it is a shell command line, whose first word is the program.
 * @returns the literal found, or undefined.
 */
function namesAgentProgram(node: ts.Node | undefined, shell = false): string | undefined {
  const text = shell && node !== undefined && ts.isStringLiteralLike(node) ? node.text.trim().split(/\s+/u)[0] : literalEnding(node)
  return text !== undefined && PROGRAM_NAME.test(text) ? text : undefined
}

/**
 * The violations in one source.
 * @param path - the repository-relative path, with `/` separators.
 * @param text - the source text.
 * @returns the violations, in source order.
 */
export function sourceViolations(path: string, text: string): SpawnViolation[] {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : /\.[mc]?js$/u.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const gated = GATED_PACKAGES.some(prefix => path.startsWith(prefix))
  const found: SpawnViolation[] = []
  const report = (node: ts.Node, rule: SpawnRule, what: string): void => {
    if (allowed(rule, path)) return
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file))
    found.push({ path, position: `${String(line + 1)}:${String(character + 1)}`, rule, found: what })
  }
  const visit = (node: ts.Node): void => {
    const literal = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : undefined
    if (literal !== undefined) {
      if (SDK_NAME.test(literal) && !typeOnly(node)) report(node, 'sdk', literal)
      if (CODEX_NAME.test(literal) && !typeOnly(node)) report(node, 'codex', literal)
      if (gated && (literal === 'child_process' || literal === 'node:child_process')) report(node, 'child-process', literal)
    }
    if (ts.isIdentifier(node) && LOCATORS.has(node.text)) report(node, 'locate', node.text)
    if (gated && ts.isPropertyAccessExpression(node) && node.name.text === 'subprocess') report(node.name, 'subprocess', 'subprocess')
    if (gated && ts.isStringLiteral(node) && node.text === 'subprocess' && ts.isCallExpression(node.parent)) report(node, 'subprocess', 'subprocess')
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'argv') {
      const program = argvProgram(node.initializer)
      const found = namesAgentProgram(program)
      if (program !== undefined && found !== undefined) report(program, 'program', found)
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined
      const first = node.arguments[0]
      if (name !== undefined && first !== undefined && (SPAWNERS.has(name) || SHELL_SPAWNERS.has(name))) {
        const program = argvProgram(first) ?? first
        const found = namesAgentProgram(program, SHELL_SPAWNERS.has(name) && program === first)
        if (found !== undefined) report(program, 'program', found)
      }
      if (name === 'getProvider' && first !== undefined && ts.isStringLiteralLike(first) && PROVIDERS.has(first.text) && !presenceCheck(node)) {
        report(node, 'provider', `getProvider('${first.text}')`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * Every source in a directory tree, skipping dependency trees, build output and hidden directories.
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
 * The violations of a repository.
 * @param root - the repository root.
 * @returns one `path:line:column: message` per violation; empty when none.
 */
export function externalAgentSpawnErrors(root: string): string[] {
  const delorun = join(root, 'delorun')
  if (!existsSync(delorun)) return ['delorun/: no Delorun tree at the repository root, so there are no sources to check']
  const errors: string[] = []
  for (const group of ['packages', 'apps']) {
    const base = join(delorun, group)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const src = join(base, entry.name, 'src')
      if (!entry.isDirectory() || !existsSync(src)) continue
      for (const absolute of sources(src)) {
        const path = relative(root, absolute).split(sep).join('/')
        for (const violation of sourceViolations(path, readFileSync(absolute, 'utf8'))) {
          errors.push(`${violation.path}:${violation.position}: ${violation.rule}: ${violation.found} outside the files the rule allows; only the start gate of @delorun/external-agents starts Claude Code or Codex`)
        }
      }
    }
  }
  return errors
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = externalAgentSpawnErrors(repositoryRoot(process.cwd()))
  for (const error of errors) console.error(`gates:external-agent-spawns: ${error}`)
  if (errors.length === 0) console.log('gates:external-agent-spawns: no Delorun source starts Claude Code or Codex outside the start gate')
  process.exitCode = errors.length === 0 ? 0 : 1
}
