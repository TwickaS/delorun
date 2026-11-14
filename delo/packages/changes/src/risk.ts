/**
 * The nine built-in risk checks, one per {@link RiskKind}. Each is a pure function of a {@link ReviewInput}: it reads the
 * lines a change adds or alters in the files it can read as text, and the plugin's `package.json` on both sides. The
 * line checks are heuristics that help a person read a change; they are not a protection, since plugin code can reach
 * what they look for in ways no line pattern sees. `not-shown` reports the new content the diff does not show, so
 * applying it asks the second confirmation: a binary file Node can load, a file too large for the diff or past where
 * it was cut short, and, once per package, a dependency's files inside the folder.
 *
 * Line checks read files whose name ends in `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.json`,
 * `.yaml` or `.yml`, and skip files below `node_modules`, which `dependency-or-build` reports once per package. A line
 * is new when the file's text before the change holds fewer copies of it than the text after does.
 *
 * @module @delo/changes/risk
 */
import type { NotShownReason, ReviewedFile, ReviewInput, RiskCheck, RiskFinding, RiskKind } from './types.ts'

/** The longest excerpt a finding carries, in characters. */
export const EXCERPT_LIMIT = 160

/** File name endings the line checks read. */
export const SCANNED_EXTENSIONS: readonly string[] = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.yaml', '.yml']

/**
 * File name endings Node loads as code or data: JavaScript, TypeScript under a type-stripping loader, JSON, native
 * addons and WebAssembly. A binary file with one of them is a `not-shown` finding.
 */
export const LOADABLE_EXTENSIONS: readonly string[] = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.node', '.wasm']

/** `package.json` sections whose added or changed entries `dependency-or-build` reports. */
export const DEPENDENCY_SECTIONS: readonly string[] = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']

/** `package.json` scripts that run at install, publish or build, whose addition or change `dependency-or-build` reports. */
export const INSTALL_AND_BUILD_SCRIPTS: readonly string[] = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'build']

/** One line a change adds or alters. */
interface NewLine {
  /** 1-based, in the text after the change. */
  readonly line: number
  readonly text: string
}

/**
 * @param text - a line as it matched.
 * @returns the line trimmed and bounded to {@link EXCERPT_LIMIT} characters.
 */
export function excerptOf(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= EXCERPT_LIMIT ? trimmed : `${trimmed.slice(0, EXCERPT_LIMIT - 1)}…`
}

/**
 * The lines of `after` that `before` does not account for: each line of `before` cancels one equal line of `after`.
 * @param file - a changed file.
 * @returns the new lines, in order.
 */
export function newLines(file: ReviewedFile): readonly NewLine[] {
  if (file.after === undefined) return []
  const remaining = new Map<string, number>()
  for (const text of file.before === undefined ? [] : file.before.split(/\r?\n/)) remaining.set(text, (remaining.get(text) ?? 0) + 1)
  const found: NewLine[] = []
  file.after.split(/\r?\n/).forEach((text, index) => {
    const count = remaining.get(text) ?? 0
    if (count > 0) remaining.set(text, count - 1)
    else found.push({ line: index + 1, text })
  })
  return found
}

/**
 * @param path - a file's path relative to the plugin folder.
 * @returns whether the line checks read it.
 */
function scanned(path: string): boolean {
  return SCANNED_EXTENSIONS.some(extension => path.endsWith(extension))
}

/**
 * @param path - a file's path relative to the plugin folder.
 * @returns whether it is a YAML file.
 */
function isYaml(path: string): boolean {
  return path.endsWith('.yaml') || path.endsWith('.yml')
}

/** Whether one new line of one file matches a line check. */
type LineMatcher = (text: string, path: string) => boolean

/**
 * @param patterns - the line patterns.
 * @returns a matcher true when any pattern matches the line.
 */
function anyOf(patterns: readonly RegExp[]): LineMatcher {
  return text => patterns.some(pattern => pattern.test(text))
}

/**
 * A check that reports every new line of every read file that `matches` accepts, one finding per line.
 * @param kind - the kind it reports.
 * @param matches - the line test.
 * @returns the check.
 */
function lineCheck(kind: RiskKind, matches: LineMatcher): RiskCheck {
  const id = checkId(kind)
  return {
    id,
    check: input => input.files.flatMap(file => {
      if (file.dependency || !scanned(file.path)) return []
      return newLines(file)
        .filter(({ text }) => matches(text, file.path))
        .map(({ line, text }): RiskFinding => ({ kind, check: id, file: file.path, line, excerpt: excerptOf(text) }))
    }),
  }
}

/**
 * @param kind - a built-in kind.
 * @returns the id of its built-in check.
 */
function checkId(kind: RiskKind): string {
  return `built-in:${kind}`
}

/**
 * @param names - module names as a regular expression alternation.
 * @param nodePrefix - whether the `node:` prefix may precede them.
 * @returns a pattern for one of them quoted, with an optional subpath.
 */
function moduleLiteral(names: string, nodePrefix: boolean): RegExp {
  return new RegExp(`['"\`]${nodePrefix ? '(?:node:)?' : ''}(?:${names})(?:/[^'"\`]*)?['"\`]`)
}

/** Words that name a consent, a guard or the sandbox in a plugin or row name. */
const GUARD_WORDS = '(?:sandbox|approval|consent|guard|permission)'

const consentGuardSandboxLine = anyOf([
  /\.tools\??\.(?:guard|restrict)\s*\(/,
  /\.approval\??\.(?:setPolicy|overrideOf)\s*\(/,
  /\.approval\.\w+\s*=(?!=)/,
  /\.permissionPresets\??\.(?:set|registerAuto|unset)\s*\(/,
  /\.sandbox(?:Policy)?(?:\.\w+)?\s*=(?!=)/,
  /(?:\.provide|\.set|\bsuper)\s*\((?:[^)'"`]*,)?\s*['"`](?:sandbox|sandboxPolicy|approval|permissionPresets)['"`]/,
  new RegExp(`\\.plugin\\s*\\([^)]*${GUARD_WORDS}`, 'i'),
])

const yamlGuardRow = new RegExp(`^\\s*(?:-\\s*)?(?:id|name)\\s*:.*${GUARD_WORDS}`, 'i')

/**
 * @param text - a line.
 * @returns whether it starts a comment, where a name is mentioned and nothing runs.
 */
function commentLine(text: string): boolean {
  return /^\s*(?:\/\/|\/\*|\*|#)/.test(text)
}

/** A listener on upstream's `approval/request` waterfall, whose return value answers the prompt. */
const answersApprovalsLine: LineMatcher = text =>
  !commentLine(text) && /\.(?:on|once|before|prependListener)\s*\(\s*['"`]approval\/request['"`]/.test(text)

/**
 * A command line that runs another program's plugin management: `dsh plugin add`, `delorun plugin remove`, with
 * options such as `--profile <name>` before the subcommand. The program and the word `plugin` are whitespace-separated,
 * so a package name such as `dsh-plugin-sdk` does not match.
 */
const pluginCommand = /\b(?:dsh|delorun)\s+plugins?(?:\s+(?:-{1,2}[\w-]+|\$\{[^}\n]*\}))*\s+(?:add|remove|install|uninstall|enable|disable|update)\b/
/** An argument list that runs plugin management: `['plugin', 'remove', name]`. */
const pluginArguments = /['"`]plugins?['"`]\s*,[^\]\n]*['"`](?:add|remove|install|uninstall|update)['"`]/
const configFileWrite = /\bcordis(?:\.patch)?\.ya?ml\b[^\n]*\b(?:write\w*|append\w*|rename|copyFile|outputFile|createWriteStream)\b|\b(?:write\w*|append\w*|rename|copyFile|outputFile|createWriteStream)\b[^\n]*\bcordis(?:\.patch)?\.ya?ml\b/

/**
 * A `ctx.plugin` call whose plugin comes from a dynamic `import()`, or from a module namespace's `.default` (a plugin
 * that an earlier `import()` loaded). A statically imported or locally declared plugin is ordinary composition.
 */
const dynamicPluginLoad = /\bctx\??\.plugin\s*\(\s*(?:\(*\s*(?:await\s+)?import\s*\(|[\w$.]+\.default\b)/

/** A call on the `pluginManager` service, which installs, removes or changes plugins. */
const pluginManagerCall = /\bpluginManager\??\.\w+\s*\(/

const managesPluginsLine: LineMatcher = text =>
  !commentLine(text)
  && (pluginCommand.test(text) || pluginArguments.test(text) || configFileWrite.test(text) || dynamicPluginLoad.test(text) || pluginManagerCall.test(text))

const modelToolLine = anyOf([
  /\.tools\??\.(?:register|setExecutor)\s*\(/,
  /\.commands\??\.register\s*\(/,
  /\.skills\??\.registerProvider\s*\(/,
])

const commandsLine = anyOf([
  moduleLiteral('child_process|worker_threads', true),
  moduleLiteral('execa|cross-spawn', false),
  /(?<![\w$.])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/,
  /\.(?:spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(/,
  /\bctx\??\.(?:shell|subprocess)\b/,
  /\.subprocess\??\./,
  /\bprocess\.dlopen\b/,
])

const networkLine = anyOf([
  /\bfetch\s*\(/,
  moduleLiteral('http|https|http2|net|tls|dgram', true),
  moduleLiteral('undici|axios|got', false),
  /\b(?:WebSocket|XMLHttpRequest|EventSource)\b/,
])

const homeReadLine: LineMatcher = text =>
  /(?<![\w$])\.delo\b/.test(text)
  || /\b(?:DELO_HOME|DSH_HOME|resolveDshHome|resolveDeloHome)\b/.test(text)
  || (/\bhomedir\s*\(\s*\)/.test(text) && /(?<![\w$])\.dsh\b/.test(text))
  || /\/profiles\//.test(text)
  || /\bsecrets\//.test(text)
  || /['"`]secrets['"`]/.test(text)

/**
 * @param value - a parsed `package.json` or anything else.
 * @returns its fields when it is a JSON object.
 */
function objectOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * The 1-based line of `"key":` below the line of `"section":` in the new `package.json`, when the change carries it.
 * @param input - the change.
 * @param section - the top-level key.
 * @param key - the key inside it.
 * @returns the line, or undefined.
 */
function manifestLine(input: ReviewInput, section: string, key: string): number | undefined {
  const lines = input.files.find(file => file.path === 'package.json')?.after?.split(/\r?\n/) ?? []
  const start = lines.findIndex(text => text.trimStart().startsWith(`${JSON.stringify(section)}:`))
  if (start < 0) return undefined
  const offset = lines.slice(start + 1).findIndex(text => text.trimStart().startsWith(`${JSON.stringify(key)}:`))
  return offset < 0 ? undefined : start + offset + 2
}

/**
 * @param value - a section of a `package.json`.
 * @returns its entries, by name; a `bundleDependencies` list is read as names with the value `true`.
 */
function entriesOf(value: unknown): ReadonlyMap<string, string> {
  if (Array.isArray(value)) {
    const names: readonly unknown[] = value
    return new Map(names.filter(name => typeof name === 'string').map(name => [name, 'true']))
  }
  return new Map(Object.entries(objectOf(value)).map(([name, range]) => [name, JSON.stringify(range)]))
}

/**
 * The entries of `section` that the new manifest adds or changes.
 * @param input - the change.
 * @param section - a top-level key of `package.json`.
 * @param keep - which entry names count.
 * @returns one finding per entry.
 */
function manifestFindings(input: ReviewInput, section: string, keep: (name: string) => boolean): RiskFinding[] {
  const kind: RiskKind = 'dependency-or-build'
  const before = entriesOf(objectOf(input.manifestBefore)[section])
  const after = objectOf(input.manifestAfter)[section]
  if (typeof after === 'boolean') {
    // `bundleDependencies: true` bundles every dependency.
    return after && objectOf(input.manifestBefore)[section] !== true ? [{ kind, check: checkId(kind), file: 'package.json', excerpt: `${section}: true` }] : []
  }
  return [...entriesOf(after)].filter(([name, value]) => keep(name) && before.get(name) !== value).map(([name, value]): RiskFinding => {
    const line = manifestLine(input, section, name)
    const previous = before.get(name)
    const excerpt = excerptOf(`${section}.${name}: ${value}${previous === undefined ? '' : ` (was ${previous})`}`)
    return { kind, check: checkId(kind), file: 'package.json', ...line === undefined ? {} : { line }, excerpt }
  })
}

/**
 * @param path - a changed file's path.
 * @returns `node_modules/<package>` for the top-level dependency the file belongs to, or the path when it names none.
 */
function dependencyPackage(path: string): string {
  const segments = path.split('/')
  const at = segments.indexOf('node_modules')
  const [first, second] = at < 0 ? [] : segments.slice(at + 1)
  if (first === undefined) return path
  const name = first.startsWith('@') && second !== undefined ? `${first}/${second}` : first
  return [...segments.slice(0, at + 1), name].join('/')
}

const dependencyOrBuild: RiskCheck = {
  id: checkId('dependency-or-build'),
  check: input => {
    const kind: RiskKind = 'dependency-or-build'
    const manifest = [
      ...DEPENDENCY_SECTIONS.flatMap(section => manifestFindings(input, section, () => true)),
      ...manifestFindings(input, 'scripts', name => INSTALL_AND_BUILD_SCRIPTS.includes(name)),
    ]
    const packages = new Map<string, number>()
    for (const file of input.files) {
      if (!file.dependency) continue
      const name = dependencyPackage(file.path)
      packages.set(name, (packages.get(name) ?? 0) + 1)
    }
    const dependencies = [...packages].map(([name, count]): RiskFinding => ({
      kind,
      check: checkId(kind),
      file: name,
      excerpt: excerptOf(`${name}: ${String(count)} ${count === 1 ? 'file' : 'files'} changed`),
    }))
    return [...manifest, ...dependencies]
  },
}

/** What a `not-shown` finding says about a file, by why the diff does not show it. */
const NOT_SHOWN_WORDS: Readonly<Record<Exclude<NotShownReason, 'dependency'>, string>> = {
  binary: 'not text, and Node can load it',
  'too-large': 'too large for the diff',
  'cut-short': 'past where the diff was cut short',
}

/**
 * @param path - a file's path relative to the plugin folder.
 * @returns whether Node can load it as code or data: a name ending in one of {@link LOADABLE_EXTENSIONS}.
 */
function loadable(path: string): boolean {
  return LOADABLE_EXTENSIONS.some(extension => path.endsWith(extension))
}

const notShown: RiskCheck = {
  id: checkId('not-shown'),
  check: input => {
    const kind: RiskKind = 'not-shown'
    const findings: RiskFinding[] = []
    const packages = new Map<string, number>()
    for (const file of input.files) {
      // A removed file adds nothing that could run.
      if (file.status === 'removed' || file.notShown === undefined) continue
      if (file.notShown === 'dependency') {
        const name = dependencyPackage(file.path)
        packages.set(name, (packages.get(name) ?? 0) + 1)
      } else if (file.notShown !== 'binary' || loadable(file.path)) {
        findings.push({ kind, check: checkId(kind), file: file.path, excerpt: excerptOf(`${file.path}: ${NOT_SHOWN_WORDS[file.notShown]}`) })
      }
    }
    for (const [name, count] of packages) {
      findings.push({ kind, check: checkId(kind), file: name, excerpt: excerptOf(`${name}: ${String(count)} ${count === 1 ? 'file' : 'files'} inside the folder that the diff does not show`) })
    }
    return findings
  },
}

/** The built-in checks, one per {@link RiskKind}, in `RISK_KINDS` order. */
export const BUILT_IN_CHECKS: readonly RiskCheck[] = [
  lineCheck('consent-guard-sandbox', (text, path) => consentGuardSandboxLine(text, path) || (isYaml(path) && yamlGuardRow.test(text))),
  lineCheck('answers-approvals', answersApprovalsLine),
  lineCheck('manages-plugins', managesPluginsLine),
  lineCheck('model-tool', modelToolLine),
  lineCheck('commands', commandsLine),
  lineCheck('network', networkLine),
  lineCheck('home-read', homeReadLine),
  dependencyOrBuild,
  notShown,
]
