/**
 * The completeness spec of contract C1's home tree (`delo/docs/contracts/c01-home-layout.md`, "The home tree"): every
 * top-level entry that Delo's code builds under the Delo home is either one of `DELO_HOME_ENTRIES` or one of upstream's
 * entries listed in {@link UPSTREAM_ENTRIES}. A change that adds a top-level entry adds it to the contract package and
 * the contract page in the same change, or this spec fails and names the file.
 *
 * The scan reads source text, not a syntax tree:
 *
 * - Files: every `.ts`, `.tsx`, `.mts` and `.mjs` file under `delo/apps/<app>/src/` and `delo/packages/<package>/src/`,
 *   and every `.yml` file at the top of a package or under an app's `src/`, where Cordis patches name paths.
 * - Calls: `join(<home>, <segment>` and `resolve(<home>, <segment>` (with or without a `path.` prefix), where `<home>` is
 *   an identifier or member chain ending in `home`, `homeDir`, `deloHome` or `dshHome`, optionally followed by `.path`;
 *   and, in YAML, `dshHomePath('<segment>'`, upstream's helper that joins its arguments under the harness home.
 * - Segments: a string literal or a template literal, whose first `/`-separated part is the entry; `DELO_HOME_ENTRIES.<key>`,
 *   which must name a key; and an upper-case constant `NAME`, `NAME.key` or `NAME['key']` that some scanned file
 *   initializes to a string literal, a template literal, another such constant, or an object literal holding
 *   `key: '<value>'`.
 *
 * Limits: a home held in a variable of another name (`root`, `base`), a path built by concatenation or by a helper
 * such as `runDirectory(home, profile)`, and a constant defined outside the scanned files are not seen. A segment the
 * scan cannot resolve, such as a variable or a call, must appear in {@link REVIEWED} with the entry it reaches; a new
 * unresolved segment fails until someone reviews it, and a reviewed one that no longer occurs fails as stale.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DELO_HOME_ENTRIES, DELO_HOME_FILES } from '../src/index.ts'

/** The `delo/` directory: three levels above this file (file → tests → package → packages → delo). */
const DELO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')

/** Upstream's top-level entries that Delo's code reaches; C1's tree leaves their layout to upstream. */
const UPSTREAM_ENTRIES: ReadonlySet<string> = new Set([
  '.credentials.yaml', '.env', 'cordis.patch.yml', 'AGENTS.md', 'skills', 'profiles', 'sessions', 'attachments', 'cache', 'storages', 'dsh-runtimes', 'logs', 'spill',
])

/**
 * Segments the scan cannot resolve, by `<file relative to delo/>: <segment expression>`, each with the entries it
 * reaches. Each was read by hand.
 */
const REVIEWED: Readonly<Record<string, string>> = {
  'packages/home/src/tree.ts: entry': 'each value of DELO_HOME_ENTRIES, which the loop iterates',
  'packages/logs/src/files.ts: SURFACE_FILES[kind].replace': 'logs/, the home and supervisor log directories of C20',
  'packages/archive/src/dsh-import/apply.ts: item.path': 'the stock-home import\'s paths under the Delo home: the upstream entries its plan carries (sessions/, attachments/, storages/, profiles/, skills/, .credentials.yaml, cordis.patch.yml, settings.yaml, AGENTS.md; DSH_HOME_ROOT_ENTRIES) and archive/ with archive/stock-import/',
  'packages/archive/src/dsh-import/apply.ts: directory': 'the stock-home import\'s paths under the Delo home: the upstream entries its plan carries (sessions/, attachments/, storages/, profiles/, skills/, .credentials.yaml, cordis.patch.yml, settings.yaml, AGENTS.md; DSH_HOME_ROOT_ENTRIES) and archive/ with archive/stock-import/',
  'packages/archive/src/dsh-import/apply.ts: path': 'the stock-home import\'s paths under the Delo home: the upstream entries its plan carries (sessions/, attachments/, storages/, profiles/, skills/, .credentials.yaml, cordis.patch.yml, settings.yaml, AGENTS.md; DSH_HOME_ROOT_ENTRIES) and archive/ with archive/stock-import/',
  'packages/plugin-instruction-consent/src/classify.ts: HOME_SKILL_DIR': 'skills/, upstream\'s home skills directory',
  'packages/plugin-instruction-consent/src/classify.ts: name': 'AGENTS.md and the other instruction file names upstream loads from the harness home',
  'packages/update/src/data-copy.ts: entry': 'entries of data-copies/ and data-set-aside/, which listKeptData reads',
  'packages/update/src/data-copy.ts: directory': 'sessions/ and storages/ (SESSION_DATA_DIRECTORIES), and data-copies/ and data-set-aside/ where kept data is listed',
  'packages/update/src/data-copy.ts: path': 'data-copies/<version> or data-set-aside/<name>, a kept-data path that listKeptData gave',
  'packages/update/src/data-copy.ts: step.directory': 'sessions/ and storages/, the directories a restore step names',
}

/**
 * Names built from a fixed prefix and a stamp or random suffix, by `<file relative to delo/>: <segment expression>`:
 * the entries of a repair that sets a store aside and the temporary file of an atomic write. Each was read by hand.
 */
const TRANSIENT: Readonly<Record<string, string>> = {
  'apps/npm-launcher/src/repair.ts: `trust.set-aside-${stampNow}`': 'trust/ set aside by the launcher\'s repair',
  'apps/npm-launcher/src/repair.ts: `${RUNTIMES_SET_ASIDE_PREFIX}${stampNow}`': 'runtimes/ set aside by the launcher\'s repair',
  'packages/update/src/home-data-format.ts: `.${HOME_DATA_FORMAT_FILE}.tmp-${randomBytes(8).toString(\'hex\')}`': 'the temporary file that replaces data-format.json atomically',
}

/**
 * Joins the scan reads as under the home whose base is another directory with a home-like name, by
 * `<file relative to delo/>: <segment expression>`, each with the directory it is. Each was read by hand.
 */
const NOT_THE_HOME: Readonly<Record<string, string>> = {
  'apps/benchmarks/src/fixtures/home.ts: entry': 'the OS home of a throwaway benchmark root: its entries other than the Delo home, which the copy reads',
  'apps/benchmarks/src/fixtures/home.ts: \'.delo\'': 'the OS home of a throwaway benchmark root: the Delo home itself',
  'apps/benchmarks/src/harness/roots.ts: data': 'the person\'s OS home: its .delo and .dsh, which the benchmark refuses to use and never writes',
  'apps/benchmarks/src/harness/roots.ts: \'.delo\'': 'the OS home of a throwaway benchmark root: the Delo home itself',
  'apps/benchmarks/src/suites/studio/index.ts: \'workspaces\'': 'the OS home of a throwaway benchmark root: the folders its workspaces point at',
  'apps/benchmarks/src/suites/turn/index.ts: PROJECT_DIRECTORY': 'the OS home of a throwaway benchmark root: the project folder a measured turn reads and writes',
  'apps/cli/src/import-home/index.ts: UPSTREAM_HOME_DIR_NAME': 'the person\'s OS home: the stock DeepSeek Harness home ~/.dsh, which the import reads',
  'apps/tools/src/checks/shared-cache.ts: \'.cache\'': 'the OS home of a developer machine: the check runner\'s shared cache',
  'packages/archive/src/dsh-import/profiles.ts: \'profile\'': 'a scratch directory under the system\'s temporary directory',
  'packages/plugin-onboarding/src/readiness.ts: \'.claude\'': 'the person\'s OS home: Claude Code\'s sign-in file, whose existence onboarding checks without opening it',
  'packages/plugin-onboarding/src/readiness.ts: \'.claude.json\'': 'the person\'s OS home: Claude Code\'s settings file on macOS, whose existence onboarding checks without opening it',
  'packages/plugin-onboarding/src/readiness.ts: \'.codex\'': 'the person\'s OS home: Codex\'s home, where onboarding checks whether auth.json exists without opening it',
}

/** A path join under the home whose segment the scan read. */
interface Use {
  /** The file, relative to `delo/`. */
  readonly file: string
  /** The segment's source text. */
  readonly expression: string
  /** The top-level entry, or `undefined` when the scan could not resolve it. */
  readonly entry: string | undefined
}

/** A home expression: an identifier or member chain ending in a home variable's name, optionally with `.path`. */
const HOME = String.raw`(?:[A-Za-z_$][\w$]*\.)*(?:home|homeDir|deloHome|dshHome)(?:\.path)?`

/** A segment expression: a string or template literal, or an identifier with member accesses, optionally called. */
const SEGMENT = String.raw`'[^'\n]*'|"[^"\n]*"|\x60[^\x60]*\x60|[A-Za-z_$][\w$]*(?:\.[\w$]+|\[[^\]\n]*\])*\(?`

/** A join or resolve call whose first argument is a home expression. */
const CALL = new RegExp(String.raw`\b(?:join|resolve)\(\s*${HOME}\s*,\s*(${SEGMENT})`, 'g')

/** Upstream's `dshHomePath('<segment>'` in a Cordis YAML file. */
const YAML_CALL = /dshHomePath\(\s*'([^'\n]*)'/g

/** An upper-case constant initialized to a string or template literal, or to another upper-case constant or its member. */
const STRING_CONSTANT = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*('[^'\n]*'|"[^"\n]*"|`[^`\n]*`|[A-Z][A-Z0-9_]*(?:\.[\w$]+)?(?=\s*$))/gm

/** An upper-case constant initialized to an object literal; the body runs to the first line that starts with `}`. */
const OBJECT_CONSTANT = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*\{([\s\S]*?)\n\}/g

/**
 * The files under one directory, recursively, without `node_modules`.
 * @param directory - the absolute directory.
 * @returns absolute file paths.
 */
function walk(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/**
 * The scanned files: sources under each workspace's `src/`, and its Cordis YAML.
 * @returns absolute file paths.
 */
function scannedFiles(): string[] {
  const files: string[] = []
  for (const group of ['apps', 'packages']) {
    for (const workspace of readdirSync(join(DELO_ROOT, group), { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      const root = join(DELO_ROOT, group, workspace.name)
      let entries: string[]
      try {
        entries = readdirSync(root)
      } catch (error) {
        // A workspace directory that vanished between the two reads holds nothing to scan.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (entries.includes('src')) files.push(...walk(join(root, 'src')).filter(file => /\.(?:tsx?|mts|mjs|ya?ml)$/.test(file) && !file.endsWith('.d.ts')))
      files.push(...entries.filter(name => name.endsWith('.yml')).map(name => join(root, name)))
    }
  }
  return files
}

/** The constants the scanned sources define: string values, and each object's members. */
interface Constants {
  /** Upper-case constants initialized to a string or template literal, or to another constant, by name. */
  readonly strings: ReadonlyMap<string, string>
  /** Upper-case constants initialized to an object literal: their `key: '<value>'` members, by name. */
  readonly objects: ReadonlyMap<string, ReadonlyMap<string, string>>
}

/**
 * Collect the constants of the given sources.
 * @param sources - source texts.
 * @returns the constants; a later definition of a name replaces an earlier one only when it is not already known.
 */
function collectConstants(sources: readonly string[]): Constants {
  const strings = new Map<string, string>()
  const objects = new Map<string, Map<string, string>>()
  for (const text of sources) {
    for (const [, name, literal] of text.matchAll(STRING_CONSTANT)) if (!strings.has(name!)) strings.set(name!, literal!)
    for (const [, name, body] of text.matchAll(OBJECT_CONSTANT)) {
      const members = new Map<string, string>()
      for (const [, key, value] of body!.matchAll(/^\s*'?([\w$-]+)'?\s*:\s*('[^'\n]*'|"[^"\n]*")/gm)) members.set(key!, value!)
      if (!objects.has(name!)) objects.set(name!, members)
    }
  }
  return { strings, objects }
}

/**
 * The first path part of a literal's value.
 * @param value - the value, without quotes.
 * @returns the part before the first `/`.
 */
function firstPart(value: string): string {
  return value.split('/')[0]!
}

/**
 * The top-level entry a segment expression names.
 * @param expression - the segment's source text.
 * @param constants - the scanned constants.
 * @returns the entry, or `undefined` when the expression is not a literal or a constant the scan can read.
 */
function resolveSegment(expression: string, constants: Constants): string | undefined {
  if (/^['"]/.test(expression)) return firstPart(expression.slice(1, -1))
  if (expression.startsWith('`')) {
    const body = expression.slice(1, -1)
    const leading = /^\$\{([^}]+)\}/.exec(body)
    return leading === null ? firstPart(body.split('${')[0]!) : resolveSegment(leading[1]!.trim(), constants)
  }
  if (expression.endsWith('(')) return undefined
  const member = /^([A-Z][A-Z0-9_]*)(?:\.([\w$]+)|\[\s*['"]([^'"]+)['"]\s*\])?$/.exec(expression)
  if (member === null) return undefined
  const [, name, dotted, bracketed] = member
  const key = dotted ?? bracketed
  if (name === 'DELO_HOME_ENTRIES') {
    // A key outside the contract resolves to a name no list holds, so the use fails.
    return key !== undefined && Object.hasOwn(DELO_HOME_ENTRIES, key) ? DELO_HOME_ENTRIES[key as keyof typeof DELO_HOME_ENTRIES] : `DELO_HOME_ENTRIES.${String(key)}`
  }
  if (key === undefined) {
    const literal = constants.strings.get(name!)
    return literal === undefined ? undefined : resolveSegment(literal, constants)
  }
  const literal = constants.objects.get(name!)?.get(key)
  return literal === undefined ? undefined : resolveSegment(literal, constants)
}

/**
 * Every path join under the home in the given files.
 * @param files - file paths relative to `delo/`, with their text.
 * @returns the uses, in file order.
 */
function scan(files: ReadonlyMap<string, string>): Use[] {
  const constants = collectConstants([...files.values()])
  const uses: Use[] = []
  for (const [file, text] of files) {
    if (/\.ya?ml$/.test(file)) {
      for (const [, segment] of text.matchAll(YAML_CALL)) uses.push({ file, expression: `'${segment!}'`, entry: firstPart(segment!) })
      continue
    }
    for (const [, segment] of text.matchAll(CALL)) uses.push({ file, expression: segment!.replace(/\($/, ''), entry: resolveSegment(segment!, constants) })
  }
  return uses
}

/**
 * The problems of a scan: entries no list holds, unresolved segments nobody reviewed, and reviewed ones that are gone.
 * @param uses - the scan's uses.
 * @returns one line per problem; empty when the tree is complete.
 */
function problems(uses: readonly Use[]): string[] {
  const allowed = new Set<string>([...Object.values(DELO_HOME_ENTRIES), ...Object.values(DELO_HOME_FILES), ...UPSTREAM_ENTRIES])
  const lines: string[] = []
  const unresolved = new Set<string>()
  const elsewhere = new Set<string>()
  const transient = new Set<string>()
  for (const use of uses) {
    const id = `${use.file}: ${use.expression}`
    if (NOT_THE_HOME[id] !== undefined) {
      elsewhere.add(id)
      continue
    }
    if (TRANSIENT[id] !== undefined) {
      transient.add(id)
      continue
    }
    if (use.entry === undefined) {
      unresolved.add(id)
      if (REVIEWED[id] === undefined) lines.push(`${id} is a home path segment the scan cannot resolve; add it to REVIEWED with the entry it reaches`)
    } else if (!allowed.has(use.entry)) {
      lines.push(`${use.file}: ${use.expression} builds the top-level home entry "${use.entry}", which neither DELO_HOME_ENTRIES nor upstream's entries list`)
    }
  }
  return lines.concat(
    Object.keys(REVIEWED).filter(id => !unresolved.has(id)).map(id => `${id} is reviewed but no longer occurs; remove it from REVIEWED`),
    Object.keys(TRANSIENT).filter(id => !transient.has(id)).map(id => `${id} is listed as a transient name but no longer occurs; remove it from TRANSIENT`),
    Object.keys(NOT_THE_HOME).filter(id => !elsewhere.has(id)).map(id => `${id} is listed as another directory but no longer occurs; remove it from NOT_THE_HOME`),
  )
}

describe('the Delo home tree (contract C1)', () => {
  it('lists every top-level entry that Delo code builds under the home', () => {
    const files = new Map(scannedFiles().map(file => [relative(DELO_ROOT, file).split('\\').join('/'), readFileSync(file, 'utf8')]))
    const uses = scan(files)
    expect(problems(uses)).toEqual([])
    // The scan reaches the entries this change made it find, so a broken pattern cannot pass by finding nothing.
    const found = new Set(uses.map(use => use.entry))
    for (const entry of [DELO_HOME_ENTRIES.trust, DELO_HOME_ENTRIES.trash, DELO_HOME_ENTRIES.archive, DELO_HOME_ENTRIES.dataCopies, DELO_HOME_ENTRIES.dataSetAside, 'sessions']) {
      expect(found).toContain(entry)
    }
  })

  it('fails on a literal, a constant or a contract key that names an entry the lists lack, and on an unreviewed segment', () => {
    const files = new Map([
      ['apps/x/src/a.ts', [
        'const BOGUS_DIRECTORY = \'bogus-constant\'',
        'join(home, \'bogus\', \'x\')',
        'join(this.options.home, BOGUS_DIRECTORY)',
        'path.join(io.home, DELO_HOME_ENTRIES.nothing)',
        'join(home.path, `bogus-template/${x}`)',
        'resolve(deloHome, someVariable)',
        'join(home, DELO_HOME_ENTRIES.trust, \'root.json\')',
        'join(osHome, \'.docker\')',
      ].join('\n')],
      ['packages/y/cordis.patch.yml', 'root: !!js dshHomePath(\'bogus-yaml\')\nother: !!js dshHomePath(\'sessions\')\n'],
    ])
    const lines = problems(scan(files)).filter(line => !line.includes('no longer occurs'))
    expect(lines).toEqual([
      'apps/x/src/a.ts: \'bogus\' builds the top-level home entry "bogus", which neither DELO_HOME_ENTRIES nor upstream\'s entries list',
      'apps/x/src/a.ts: BOGUS_DIRECTORY builds the top-level home entry "bogus-constant", which neither DELO_HOME_ENTRIES nor upstream\'s entries list',
      'apps/x/src/a.ts: DELO_HOME_ENTRIES.nothing builds the top-level home entry "DELO_HOME_ENTRIES.nothing", which neither DELO_HOME_ENTRIES nor upstream\'s entries list',
      'apps/x/src/a.ts: `bogus-template/${x}` builds the top-level home entry "bogus-template", which neither DELO_HOME_ENTRIES nor upstream\'s entries list',
      'apps/x/src/a.ts: someVariable is a home path segment the scan cannot resolve; add it to REVIEWED with the entry it reaches',
      'packages/y/cordis.patch.yml: \'bogus-yaml\' builds the top-level home entry "bogus-yaml", which neither DELO_HOME_ENTRIES nor upstream\'s entries list',
    ])
  })
})
