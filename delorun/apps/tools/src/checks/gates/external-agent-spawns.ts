/**
 * External-agent spawns gate: no Delorun source starts Claude Code or Codex except through the start gate of
 * `@delorun/external-agents` (T1), upstream's reviewed one-shot path, and the named exception `delorun agents login`.
 * It reads the sources under `delorun/packages/*\/src` and `delorun/apps/*\/src` and refuses, outside the files
 * {@link ALLOWED} names for each rule:
 *
 * - `sdk`: a string naming the Claude Agent SDK or its platform packages (`@anthropic-ai/claude-agent-sdk…`) or the
 *   Claude Code package (`@anthropic-ai/claude-code…`), except in a type-only import;
 * - `codex`: a string naming the Codex package or its platform packages (`@openai/codex…`);
 * - `locate`: a use of the locator functions that find those programs (`locateClaudeSdk`, `locateClaudeProgram`,
 *   `locateCodex`, `locateCodexProgram`, `loginProgramFor`);
 * - `child-process`: `child_process` imported in the gate's package or a driver package;
 * - `subprocess`: `subprocess` used in the gate's package or a driver package, other than in the gate's module;
 * - `provider`: `getProvider('claude-code')` or `getProvider('codex')` used for anything but a presence check
 *   (`=== undefined`, `!== undefined` and the `null` forms), which upstream's tool path owns;
 * - `program`: `claude`, `codex`, `claude.exe`, `codex.exe` or a path ending in one of them as a literal the process
 *   runs or passes on: the first argument of `spawn`, `spawnSync`, `execFile`, `execFileSync` or `fork`, any element
 *   of an argv array given to those calls or as an `argv` property (so `env claude` is caught), and the command word
 *   of every part of a shell command line, parts being split on `&&`, `||`, `;`, `|`, `&` and newlines, with leading
 *   `exec`, `env`, `nohup` and `NAME=value` words skipped in each part, and `env`'s own options skipped with the value
 *   of `-u`, `--unset`, `-C` and `--chdir` (so `env -i claude` and `env -u FOO claude` are caught). A shell command
 *   line is the command of `exec` or `execSync`, the element after a `-c` option (as in `sh -c` or `bash -lc`), and
 *   the first argument of `spawn`, `spawnSync`, `execFile`, `execFileSync` or `fork` when it is a literal containing
 *   a space or when an options literal sets `shell` to anything but `false`.
 *
 * Out of scope: an argv or command line held in a variable or built from non-literal parts (the gate reads literals
 * only), command substitution and subshell bodies, and wrappers other than the four skipped words (`sudo`, `time`,
 * `xargs`).
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
const SDK_NAME = /^@anthropic-ai\/claude-(?:agent-sdk|code)(?:[-/]|$)/u
const CODEX_NAME = /^@openai\/codex(?:[-/]|$)/u
const LOCATORS = new Set(['locateClaudeSdk', 'locateClaudeProgram', 'locateCodex', 'locateCodexProgram', 'loginProgramFor'])
const PROVIDERS = new Set(['claude-code', 'codex'])
const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'])
const SHELL_SPAWNERS = new Set(['exec', 'execSync'])
const SHELL_COMMAND_OPTION = /^-[a-z]*c$/u
const COMMAND_SEPARATOR = /&&|\|\||[;|&\n]/u
const COMMAND_PREFIX = /^(?:exec|env|nohup|[A-Za-z_][\w]*=.*)$/u
/** `env` options whose value is the next word, so the word after them is not the command. */
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir'])
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
 * Whether a text names Claude Code or Codex as a program.
 * @param text - a program name or path, or undefined.
 * @returns the text when it does.
 */
function programText(text: string | undefined): string | undefined {
  // A package name such as `@openai/codex` is the `sdk` or `codex` rule's, not a program path.
  return text !== undefined && !text.startsWith('@') && PROGRAM_NAME.test(text) ? text : undefined
}

/**
 * The command word of one part of a shell command line.
 * @param words - the part's words.
 * @returns the first word that is not `exec`, `env`, `nohup`, `NAME=value`, or an `env` option or its value, without
 * surrounding brackets and quotes.
 */
function commandWord(words: readonly string[]): string | undefined {
  let index = 0
  let inEnv = false
  while (index < words.length) {
    const word = words[index]!
    if (word === 'env') {
      inEnv = true
      index += 1
      continue
    }
    if (inEnv) {
      if (word === '--') {
        inEnv = false
        index += 1
        continue
      }
      if (ENV_VALUE_OPTIONS.has(word)) {
        index += 2
        continue
      }
      if (word.startsWith('-') && word.length > 1) {
        index += 1
        continue
      }
      inEnv = false
    }
    if (COMMAND_PREFIX.test(word)) {
      index += 1
      continue
    }
    return word.replace(/^[({"']+|["')}]+$/gu, '')
  }
  return undefined
}

/**
 * The command word of every part of a shell command line.
 * @param line - the command line.
 * @returns each part's command word.
 */
function commandWords(line: string): string[] {
  return line.split(COMMAND_SEPARATOR).flatMap((part) => {
    const word = commandWord(part.trim().split(/\s+/u))
    return word === undefined ? [] : [word]
  })
}

/**
 * Whether a program position names Claude Code or Codex.
 * @param node - the expression in the position.
 * @param shell - whether it is a shell command line, whose command words are the programs.
 * @returns the literal found, or undefined.
 */
function namesAgentProgram(node: ts.Node | undefined, shell = false): string | undefined {
  if (shell && node !== undefined && ts.isStringLiteralLike(node)) return commandWords(node.text).map(programText).find(found => found !== undefined)
  return programText(literalEnding(node))
}

/**
 * Whether an options literal makes a spawn run its command through a shell.
 * @param node - an argument of the call.
 * @returns true for an object literal whose `shell` property is not the literal `false`.
 */
function setsShell(node: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false
  return node.properties.some(property => (ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property))
    && ts.isIdentifier(property.name) && property.name.text === 'shell'
    && !(ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword))
}

/**
 * The literals of an argv array that name Claude Code or Codex: any element, and the first command word of the element
 * after a `-c` shell option.
 * @param node - the expression that may be the array.
 * @returns each element found with the text it names.
 */
function argvPrograms(node: ts.Node | undefined): Array<{ readonly at: ts.Node, readonly found: string }> {
  if (node === undefined || !ts.isArrayLiteralExpression(node)) return []
  return node.elements.flatMap((element, index) => {
    const previous = node.elements[index - 1]
    const shell = previous !== undefined && ts.isStringLiteralLike(previous) && SHELL_COMMAND_OPTION.test(previous.text)
    const found = namesAgentProgram(element, shell)
    return found === undefined ? [] : [{ at: element, found }]
  })
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
      for (const { at, found } of argvPrograms(node.initializer)) report(at, 'program', found)
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined
      const first = node.arguments[0]
      if (name !== undefined && first !== undefined && SPAWNERS.has(name)) {
        const shell = node.arguments.some(setsShell) || (ts.isStringLiteralLike(first) && /\s/u.test(first.text.trim()))
        const found = namesAgentProgram(first) ?? (shell ? namesAgentProgram(first, true) : undefined)
        if (found !== undefined) report(first, 'program', found)
        for (const argv of node.arguments.slice(0, 2)) for (const { at, found: named } of argvPrograms(argv)) report(at, 'program', named)
      }
      if (name !== undefined && first !== undefined && SHELL_SPAWNERS.has(name)) {
        const found = namesAgentProgram(first, true)
        if (found !== undefined) report(first, 'program', found)
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
