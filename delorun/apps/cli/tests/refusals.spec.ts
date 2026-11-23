/**
 * What `delorun` prints for each typed error its commands can raise, and the gate that keeps it complete: every error
 * class a fork package or app exports is either described by `delorun`'s describers or named, with the reason, as one
 * that never reaches `delorun`'s entry point.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { UpdatePendingError } from '@delorun/bundle-local/update-gate'
import { describeFailure, homeLayoutDescriber, type Refusal } from '@delorun/home'
import { installDescriber } from '@delorun/install'
import { ProfileSafetyError, type ProfileSafetyRemedy } from '@delorun/profile-safety'
import { ReachError } from '@delorun/reach'
import { LogVerificationError } from '@delorun/release-formats/log/bundle'
import { TileError } from '@delorun/release-formats/log/tiles'
import { VerificationError } from '@delorun/release-formats/sign/verify'
import { RELEASE_VERIFY_DESCRIBERS } from '@delorun/release-verify/refusal'
import { runtimeStoreDescriber } from '@delorun/runtime-store'
import { TrashError } from '@delorun/trash'
import { DataSafetyError, UpdateReportError, type DataSafetyErrorCode } from '@delorun/update'
import { describe, expect, it } from 'vitest'
import { CliError, EXIT } from '../src/exit.ts'
import { DataInUseError } from '../src/home-exclusion.ts'
import { CLI_DESCRIBERS, cliRefusal, namedProfile } from '../src/refusals.ts'
import { SetupCancelled } from '../src/setup/prompts.ts'
import { BundleReadError } from '../src/update/bundle-layers.ts'
import { DelorunVersionError } from '../src/version.ts'

/** The fork's root: `delorun/`. */
const FORK = fileURLToPath(new URL('../../../', import.meta.url))

const PLUGIN = 'raised inside a plugin of the home process and reported to the studio or the model, never to delorun'
const TOOLS = 'developer tooling under delorun/apps/tools with its own entry points'
const RELEASE_PIPELINE = 'the release pipeline\'s signing and advisory commands, which delorun does not import'
const BENCHMARKS = 'the wait-time benchmark under delorun/apps/benchmarks, which runs delorun from outside and is not imported by it'

/** The exported error classes that never reach `delorun`'s entry point, each with the reason. */
const OUTSIDE_DELORUN: Readonly<Record<string, string>> = {
  InstallRefusal: 'raised by the install queue inside the home process and reported to the studio\'s downloads panel',
  RouteRefusal: 'raised by the Changes routes of the changes plugin and answered to the studio with a status, a code and a sentence',
  LiveRefreshError: 'raised by the live asset refresh of the changes plugin and caught by the harness routes\' effect, which answers the studio',
  SetupRefusal: 'raised by the setup routes of the changes plugin and answered to the studio with a status and code',
  PacksRequestError: 'raised by the studio\'s packs client in the browser for a route answer',
  ChangesRequestError: 'the studio\'s Changes section raises it in the browser for a route answer; delorun never calls the routes',
  BrowsePairError: 'raised by the studio\'s browser-pairing client in the browser for a route answer',
  DefaultsStoreError: PLUGIN,
  FullAccessConsentRefusedError: PLUGIN,
  FullAccessChangeError: PLUGIN,
  McpReviewError: PLUGIN,
  DelegationConsentError: PLUGIN,
  PermissionStoreError: PLUGIN,
  NetworkChangeError: PLUGIN,
  NetworkStoreError: PLUGIN,
  UnsupportedHostError: PLUGIN,
  InvalidPathError: PLUGIN,
  InstructionsRefusedError: PLUGIN,
  WorkspaceRefusedError: PLUGIN,
  FetchGuardRefusedError: PLUGIN,
  ChatSwitchRefused: 'raised by the studio\'s Allow for this chat choice in the browser and shown on the card as the failure sentence',
  TrashRequestError: 'raised by the studio\'s trash client in the browser',
  ChatStateRefusedError: PLUGIN,
  SandboxUnavailableError: PLUGIN,
  ClaudeCodeDriverError: PLUGIN,
  CodexSessionClosedError: PLUGIN,
  CodexTurnRunningError: PLUGIN,
  CodexRpcError: PLUGIN,
  CodexWireError: PLUGIN,
  CodexClosedError: PLUGIN,
  ProgramOpenError: PLUGIN,
  SeatProgramMissingError: PLUGIN,
  GateRefusedError: PLUGIN,
  ChatStatesRequestError: 'raised by the studio\'s chat-states client in the browser',
  HostRequestError: 'raised by the studio\'s devices and network clients in the browser',
  TrashOperationError: PLUGIN,
  OwnerNotesError: PLUGIN,
  MainChatToolError: PLUGIN,
  RenameToolError: PLUGIN,
  CostMeterConfigError: 'raised while the cost meter loads its price table: the row does not start, and delorun reports it as an inactive Delorun row',
  ToolFailureGuardConfigError: 'raised while the tool failure guard loads its limits: the row does not start, and delorun reports it as an inactive Delorun row',
  AcceptanceStoreError: PLUGIN,
  FilePinError: PLUGIN,
  BuildRootBusyError: 'raised by the release tooling\'s closure build, which no runtime carries',
  PruneRuleError: 'raised by the release tooling\'s closure build when a foreign prebuild rule is wrong, which no runtime carries',
  HomeAuthError: 'raised by the home process\'s Web sign-in, which answers the browser over HTTP',
  TrustError: 'raised by the home process\'s trust bill routes, which answer the studio over HTTP',
  RelayError: 'raised by the relay server under delorun/apps/relay, which delorun does not run',
  UsageError: TOOLS,
  BatchError: TOOLS,
  BodyTooLarge: TOOLS,
  UpstreamUpdateError: TOOLS,
  NetworkGuardRefusal: TOOLS,
  SigningRefusal: RELEASE_PIPELINE,
  PublishRefusal: 'the release channel\'s publish command under delorun/apps/release-channel, which delorun does not import',
  VersionsError: 'raised by the studio\'s version-history routes, which answer the browser over HTTP',
  RunError: 'raised by the studio\'s How Delorun runs routes, which answer the browser over HTTP',
  CreateRefusal: 'raised by the studio\'s create-plugin routes, which answer the browser over HTTP',
  ScaffoldError: 'caught by delorun plugin new, which prints it as its own usage or failure refusal',
  FeedFailure: 'caught by the release\'s advisory check and the plugin install check, which report the feed as unreachable',
  LockfileError: 'caught by the plugin install check and delorun plugin, which report that the check could not run',
  BenchmarkUsageError: BENCHMARKS,
  IsolationRefusal: BENCHMARKS,
  RealHomeRefusal: BENCHMARKS,
}

/**
 * Every TypeScript source file under a directory.
 * @param directory - the directory.
 * @returns the files' paths.
 */
function sources(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts'))
    .map(entry => join(entry.parentPath, entry.name))
}

/** A fork package or app: its directory, its name and its `exports` map. */
interface Member {
  readonly directory: string
  readonly name: string
  readonly exports: unknown
}

/**
 * Every package and app of the fork.
 * @returns each member with its manifest's name and `exports`.
 */
function members(): Member[] {
  const found: Member[] = []
  for (const group of ['packages', 'apps']) {
    for (const entry of readdirSync(join(FORK, group), { withFileTypes: true })) {
      const directory = join(FORK, group, entry.name)
      if (!entry.isDirectory() || !existsSync(join(directory, 'package.json'))) continue
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name: string, exports?: unknown }
      found.push({ directory, name: manifest.name, exports: manifest.exports })
    }
  }
  return found
}

/**
 * The source pattern of one `exports` target: a `src/` module as it is, and a built `lib/` module or its declarations
 * as the `src/` module they are built from. Any other target, such as a YAML file or locale JSON, names no module.
 * @param target - the target, relative to the member, which may hold one `*`.
 * @returns the source pattern relative to the member, or `undefined` for a target that names no module.
 */
function sourceTarget(target: string): string | undefined {
  if (/^\.\/src\/.+\.tsx?$/u.test(target)) return target
  const built = /^\.\/lib\/(?:types\/)?(.+)\.(?:d\.ts|js)$/u.exec(target)
  return built === null ? undefined : `./src/${built[1]!}`
}

/**
 * The source files a source pattern names, `.ts` or `.tsx`; a `*` matches any run of characters, `/` included.
 * @param directory - the member's directory.
 * @param pattern - the source pattern.
 * @returns the files.
 * @throws {Error} when the pattern names no file, which leaves an entry point unread.
 */
function patternFiles(directory: string, pattern: string): string[] {
  const candidates = /\.tsx?$/u.test(pattern) ? [pattern] : [`${pattern}.ts`, `${pattern}.tsx`, `${pattern}/index.ts`]
  const files = candidates.flatMap((candidate) => {
    const absolute = join(directory, candidate)
    if (!candidate.includes('*')) return existsSync(absolute) ? [absolute] : []
    const [before, after] = absolute.split('*') as [string, string]
    return sources(join(directory, 'src')).filter(file => file.startsWith(before) && file.endsWith(after))
  })
  if (files.length === 0) throw new Error(`${relative(FORK, directory)} exports ${pattern}, which names no source file`)
  return files
}

/**
 * A member's entry points, each `exports` subpath with the source files it maps to; a conditional target's `types`
 * condition comes first.
 * @param member - the member.
 * @returns each subpath, as a package specifier, with its files.
 */
function entryPoints(member: Member): Array<{ readonly specifier: string, readonly files: readonly string[] }> {
  if (typeof member.exports !== 'object' || member.exports === null) return []
  const entries: Array<{ specifier: string, files: string[] }> = []
  for (const [subpath, value] of Object.entries(member.exports as Record<string, unknown>)) {
    const targets = typeof value === 'string' ? [value] : Object.entries(value as Record<string, string>).sort(([a], [b]) => Number(b === 'types') - Number(a === 'types')).map(([, target]) => target)
    const pattern = targets.map(sourceTarget).find(found => found !== undefined)
    if (pattern !== undefined) entries.push({ specifier: `${member.name}${subpath.slice(1)}`, files: patternFiles(member.directory, pattern) })
  }
  return entries
}

/** An exported error class: its name, as `describer.type.name` reads it, and the file that declares it. */
interface ErrorClass {
  readonly name: string
  readonly file: string
}

/**
 * Every exported error class of a set of modules, as TypeScript's checker resolves the modules' exports: `export
 * class`, `export default class`, export lists with or without `as`, and re-exports, each class once under the name
 * it declares. A class is an error class when its name ends in `Error`, or when it extends a built-in error class
 * directly or through other classes; a base class the program cannot resolve, such as one from upstream, counts when
 * its name ends in `Error`.
 * @param files - every source file of the program, the modules and what they re-export from.
 * @param modules - the modules whose exports are read.
 * @param paths - the package specifiers the files import each other by, with their source files.
 * @returns the classes.
 */
function exportedErrorClasses(files: readonly string[], modules: readonly string[], paths: Readonly<Record<string, readonly string[]>> = {}): ErrorClass[] {
  const program = ts.createProgram([...files], {
    noEmit: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
    paths: Object.fromEntries(Object.entries(paths).map(([specifier, targets]) => [specifier, [...targets]])),
  })
  const checker = program.getTypeChecker()
  const resolved = (symbol: ts.Symbol): ts.Symbol => (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)
  const classOf = (symbol: ts.Symbol): ts.ClassLikeDeclaration | undefined => {
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isClassDeclaration(declaration)) return declaration
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && ts.isClassExpression(declaration.initializer)) return declaration.initializer
    }
    return undefined
  }
  const isError = (declaration: ts.ClassLikeDeclaration, seen: Set<ts.ClassLikeDeclaration>): boolean => {
    if (seen.has(declaration)) return false
    seen.add(declaration)
    const base = declaration.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
    if (base === undefined) return false
    const at = checker.getSymbolAtLocation(base)
    const symbol = at === undefined ? undefined : resolved(at)
    const inLibrary = symbol?.declarations?.some(declared => program.isSourceFileDefaultLibrary(declared.getSourceFile())) === true
    if (inLibrary) return symbol!.name.endsWith('Error')
    const baseClass = symbol === undefined ? undefined : classOf(symbol)
    if (baseClass !== undefined) return baseClass.name?.text.endsWith('Error') === true || isError(baseClass, seen)
    return base.getText().endsWith('Error')
  }
  const found = new Map<ts.ClassLikeDeclaration, ErrorClass>()
  for (const module of modules) {
    const source = program.getSourceFile(module)
    if (source === undefined) throw new Error(`${module} is not in the program`)
    const moduleSymbol = checker.getSymbolAtLocation(source)
    // A file with no import or export is a script, which exports nothing.
    if (moduleSymbol === undefined) continue
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolved(exported)
      const declaration = classOf(symbol)
      if (declaration === undefined || found.has(declaration)) continue
      const name = declaration.name?.text ?? (ts.isVariableDeclaration(declaration.parent) ? declaration.parent.name.getText() : symbol.name)
      if (name.endsWith('Error') || isError(declaration, new Set())) found.set(declaration, { name, file: relative(FORK, declaration.getSourceFile().fileName) })
    }
  }
  return [...found.values()]
}

/**
 * Every exported error class of the fork's packages and apps: the exports of each member's entry points, the
 * `exports` subpaths mapped to their source files, and of every other module under `src/`.
 * @returns the classes.
 */
function forkErrorClasses(): ErrorClass[] {
  const all = members()
  const entries = all.flatMap(entryPoints)
  const files = [...new Set([...all.flatMap(member => existsSync(join(member.directory, 'src')) ? sources(join(member.directory, 'src')) : []), ...entries.flatMap(entry => entry.files)])]
  return exportedErrorClasses(files, files, Object.fromEntries(entries.map(entry => [entry.specifier, entry.files])))
}

/** The gate's fixture: error classes exported only through forms a line-by-line text scan does not read. */
const FIXTURE = fileURLToPath(new URL('fixtures/error-exports/', import.meta.url))

describe('the gate\'s enumeration of exported error classes', () => {
  it('reads export lists, renamed and default exports and re-exports through an entry point', () => {
    const files = ['index.ts', 'named.ts', 'default.ts'].map(file => join(FIXTURE, file))
    const names = exportedErrorClasses(files, [join(FIXTURE, 'index.ts')]).map(({ name }) => name).sort()
    expect(names).toEqual(['DefaultFixtureFailure', 'FixtureFailure', 'NamedFixtureError'])
  })

  it('finds classes no `export class … extends` line declares', () => {
    for (const file of ['index.ts', 'named.ts', 'default.ts']) {
      expect(readFileSync(join(FIXTURE, file), 'utf8')).not.toMatch(/^export (?:abstract )?class \w+(?:<[^>]*>)? extends \w+/mu)
    }
  })
})

describe('the error classes the fork exports', () => {
  const classes = forkErrorClasses()
  const described = new Set(CLI_DESCRIBERS.map(describer => describer.type.name))

  it('finds the fork\'s error classes, each under one name', () => {
    expect(classes.length).toBeGreaterThan(40)
    expect(classes.map(({ name }) => name)).toContain('HomeProcessError')
    const names = classes.map(({ name }) => name)
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])
  })

  it('are each described by delorun, or named as never reaching it', () => {
    const unmapped = classes.filter(({ name }) => !described.has(name) && OUTSIDE_DELORUN[name] === undefined)
    expect(unmapped.map(({ name, file }) => `${name} (${file})`)).toEqual([])
  })

  it('name no class twice and no class that no longer exists', () => {
    const names = new Set(classes.map(({ name }) => name))
    expect(Object.keys(OUTSIDE_DELORUN).filter(name => described.has(name) || !names.has(name))).toEqual([])
    expect([...described].filter(name => !names.has(name))).toEqual([])
  })

  it('include every describer the npm launcher composes, so both programs print the same refusal', () => {
    for (const describer of [homeLayoutDescriber, installDescriber, runtimeStoreDescriber, ...RELEASE_VERIFY_DESCRIBERS]) expect(CLI_DESCRIBERS).toContain(describer)
  })
})

/**
 * The refusal `delorun` prints for one error.
 * @param error - the error.
 * @param profile - the profile the command named.
 * @returns the refusal.
 */
function refusalOf(error: unknown, profile?: string): Refusal {
  return describeFailure(error, CLI_DESCRIBERS, profile === undefined ? {} : { profile })
}

describe('a delorun refusal', () => {
  it('prints a CliError as it is and exits with its code', () => {
    expect(cliRefusal(new CliError(EXIT.usage, 'delorun: unknown command "x"'), [])).toEqual({ text: 'delorun: unknown command "x"\n', exit: EXIT.usage })
    expect(cliRefusal(new SetupCancelled(), [])).toEqual({ text: 'Setup cancelled. Nothing was saved. Run delorun to start again.\n', exit: EXIT.interrupted })
    expect(cliRefusal(new Error('boom'), [])).toEqual({ text: 'Delorun stopped: boom\n', exit: EXIT.failed })
  })

  it('redacts a secret in a described error and in the message no describer knows', () => {
    // A provider key in the form `@delorun/logs`'s redactor specs use.
    const key = ['sk', '0123456789abcdef0123456789abcdef'].join('-')
    expect(cliRefusal(new Error(`the provider refused ${key}`), [])).toEqual({ text: 'Delorun stopped: the provider refused [redacted:provider-key]\n', exit: EXIT.failed })
    expect(cliRefusal(new TrashError('TRASH_RESTORE_CONFLICT', `the chat ${key} exists`), []).text).toBe('Delorun did not change the trash.\nWhy: TRASH_RESTORE_CONFLICT: the chat [redacted:provider-key] exists\n')
    expect(cliRefusal(new CliError(EXIT.usage, `delorun: unknown command "${key}"`), []).text).toBe('delorun: unknown command "[redacted:provider-key]"\n')
  })

  it('names the profile the command line named in its remedies', () => {
    expect(namedProfile(['update', '--profile', 'work'])).toBe('work')
    expect(namedProfile(['update', '--profile=work'])).toBe('work')
    expect(namedProfile(['headless', '--', '--profile', 'work'])).toBeUndefined()
    expect(namedProfile(['update'])).toBeUndefined()
    expect(cliRefusal(new TrashError('TRASH_ITEM_NOT_FOUND', 'no item x'), ['trash', 'restore', 'x', '--profile', 'work']).text).toBe('Delorun did not change the trash.\nWhy: TRASH_ITEM_NOT_FOUND: no item x\nWhat you can do:\n  See what the trash holds: delorun trash list --profile work\n')
    expect(refusalOf(new TrashError('TRASH_RESTORE_CONFLICT', 'the chat exists')).remedies).toEqual([])
  })

  it('reads delorun\'s own errors with their facts', () => {
    expect(refusalOf(new DelorunVersionError('package.json', 'package.json carries no version'))).toEqual({ lead: 'Delorun could not read its own version.', reason: 'package.json carries no version', remedies: [] })
    expect(refusalOf(new DataInUseError('process 12 (delorun import) uses the chat data'))).toEqual({ lead: 'Delorun did not go ahead: another process uses the chat data.', reason: 'process 12 (delorun import) uses the chat data', remedies: ['Wait for it to end, then run the same command again.'] })
    expect(refusalOf(new BundleReadError('BUNDLE_PATCH_UNREADABLE', '@delorun/bundle-local', 'patch.yml is not YAML'))).toEqual({ lead: 'Delorun could not read the metadata of the bundle @delorun/bundle-local.', reason: 'BUNDLE_PATCH_UNREADABLE: patch.yml is not YAML', remedies: [] })
  })

  it('offers each profile-safety remedy, and tells a refusal from a failed snapshot', () => {
    const remedies: readonly ProfileSafetyRemedy[] = ['skip-update', 'keep', 'update-plugin', 'keep-disabled', 'eject', 'restore', 'rollback', 'safe-mode', 'repair-profile']
    const refused = refusalOf(new ProfileSafetyError('ROW_NOT_CARRIED', '/h/profiles/work', 'row x is not carried', remedies), 'work')
    expect(refused.lead).toBe('Delorun refused the change and left the profile as it was.')
    expect(refused.reason).toBe('ROW_NOT_CARRIED: row x is not carried')
    expect(refused.remedies).toEqual([
      'Do not take this update.',
      'Keep what the message names in place and wait for a release that carries it.',
      'Update the plugin to a version the new release runs.',
      'Keep the plugin disabled.',
      'Eject the plugin, which keeps its rows and configuration in the profile.',
      'Restore a profile history version: delorun recover restore <version> --profile work',
      'Switch back to the previous release: delorun recover rollback --profile work',
      'Start in safe mode: delorun recover safe-mode --profile work',
      'Repair the profile file the message names, then run the same command again.',
    ])
    expect(refusalOf(new ProfileSafetyError('SNAPSHOT_FAILED', '/h/profiles/work', 'the disk is full')).lead).toBe('Delorun could not write the profile snapshot it takes before a change.')
  })

  it('reads each session-data refusal, the ones the home process shares as its own', () => {
    const leads: ReadonlyArray<readonly [DataSafetyErrorCode, string]> = [
      ['DATA_COPY_NO_SPACE', 'Delorun did not copy the chat data: the copy does not fit on the home\'s disk.'],
      ['ROLLBACK_NEEDS_DATA_COPY', 'Delorun did not roll back: going back would hand newer chat data to an older release, and no copy of the older data exists.'],
      ['DATA_RESTORE_INCONSISTENT', 'Delorun did not restore the chat data: the restore\'s journal or directories are not in a state a restore leaves.'],
      ['NOT_KEPT_DATA', 'Delorun did not remove that path: it is not a copy or set-aside directory of this home.'],
      ['DATA_NOT_A_DIRECTORY', 'Delorun did not copy the chat data: sessions/ or storages/ is a symbolic link or not a directory.'],
      ['DATA_IN_USE', 'Delorun did not remove or replace the copy: a restore or rollback runs, or an update record refers to it.'],
    ]
    for (const [code, lead] of leads) {
      const refusal = refusalOf(new DataSafetyError(code, 'the detail'))
      expect(refusal.lead, code).toBe(lead)
      expect(refusal.reason, code).toBe(`${code}: the detail`)
    }
    expect(refusalOf(new DataSafetyError('NOT_KEPT_DATA', '/etc is not kept'), 'work').remedies).toEqual(['See what Delorun keeps: delorun recover status --profile work'])
  })

  it('reads each refused update report', () => {
    expect(refusalOf(new UpdateReportError('REPORT_TARGET_UNVERIFIED', 'the signature does not verify'))).toEqual({ lead: 'Delorun made no update report: the release did not verify.', reason: 'REPORT_TARGET_UNVERIFIED: the signature does not verify', remedies: ['See every check: delorun verify'] })
    expect(refusalOf(new UpdateReportError('REPORT_VERSION_INVALID', 'x')).lead).toBe('Delorun made no update report: the version is not a semantic version.')
    expect(refusalOf(new UpdateReportError('REPORT_DISPOSED'))).toEqual({ lead: 'Delorun stopped before the update report was ready.', reason: 'REPORT_DISPOSED', remedies: [] })
  })

  it('reads a Tailscale refusal with its code and the detail that names what to do', () => {
    expect(refusalOf(new ReachError('TAILSCALE_NOT_LOGGED_IN', 'Sign in to Tailscale, then run delorun reach on tailscale again'))).toEqual({ lead: 'Delorun could not read or change what Tailscale serves for remote access.', reason: 'TAILSCALE_NOT_LOGGED_IN: Sign in to Tailscale, then run delorun reach on tailscale again', remedies: [] })
  })

  it('reads a held turn and the release package\'s verification failures', () => {
    expect(refusalOf(new UpdatePendingError()).reason).toContain('UPDATE_PENDING: ')
    expect(refusalOf(new VerificationError('root 2 names key k without listing it'))).toEqual({ lead: 'Delorun refused a release file that did not verify.', reason: 'root 2 names key k without listing it', remedies: ['See every check: delorun verify'] })
    expect(refusalOf(new LogVerificationError('inclusion-proof-invalid', 'the proof does not reproduce the root')).reason).toBe('inclusion-proof-invalid: the proof does not reproduce the root')
    expect(refusalOf(new TileError('a tile of 31 bytes'))).toEqual({ lead: 'The release log served a tile that does not hold together.', reason: 'a tile of 31 bytes', remedies: ['Report this if it repeats.'] })
  })
})
