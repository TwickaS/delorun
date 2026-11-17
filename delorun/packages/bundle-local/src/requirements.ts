/**
 * The Host half of "Needs setup": what an optional bundle's rows need from this computer, read from the bundle's own
 * package and answered to Plugins as `GET /api/delorunRequirements.check`. A bundle declares a row's needs in its
 * `package.json` under `delorun.requires`, keyed by the row id its patch declares:
 *
 * ```json
 * "delorun": { "requires": { "lsp-stdio": {
 *   "needs": [{ "kind": "program", "names": ["typescript-language-server"], "label": "typescript-language-server" }],
 *   "fix": { "kind": "command", "command": "npm install -g typescript-language-server typescript" }
 * } } }
 * ```
 *
 * The sentence a person reads is derived from the first unmet need and this module's dictionary, in the studio's
 * language: "Needs <label or names> installed", "Needs <name> set", "Not available on this kind of computer" or
 * "<Browser> download". A need is a `program` that exists and is executable on `PATH` or at one of its listed absolute
 * `paths` (it is never run), with an optional friendly `label`; an `env` variable that is set and not empty; a `platform`
 * the row runs on; or a `playwright-browser`, the exact browser build a Playwright MCP package expects, downloaded into
 * Playwright's browser cache. That need names the packages that lead from the bundle to the Playwright MCP package
 * (`via`, the last is the MCP package) and the browser; the check reads the revision from the `browsers.json` of the
 * `playwright-core` that package resolves, and the build counts as downloaded when its folder holds Playwright's
 * `INSTALLATION_COMPLETE` marker, for the browser and its headless shell where Playwright lists one. Its fix,
 * `playwright-install`, answers as the command that runs that exact MCP package version's own installer:
 * `npx -y <package>@<version> install-browser <browser>`.
 *
 * A `browse-paired` need is met when browse's program for this computer is in the bundle's packages (`via` leads from
 * the bundle to `@opencode/browse`, whose platform package holds the program) and browse's `browsers.json` lists at
 * least one browser. browse writes that file when a paired browser connects; it holds each browser's id and name and
 * no secret. The check never reads browse's `relay-token` or `browser-tokens.json`, which hold the secrets. Its fix,
 * `browse-pair`, answers as the pairing steps Plugins shows, with the extension's store page; on a computer browse
 * has no program for (Windows on Arm, for one), the reason says so and the fix links the guide instead.
 *
 * A check never stops a row and never throws across bundles: a bundle whose declaration cannot be read, names a row its
 * patch does not declare, or lacks the reason in English is reported as a problem of that bundle, and every other bundle
 * answers as usual. The check reads the computer afresh on each request, so a met need clears the next time Plugins asks.
 *
 * @module @delorun/bundle-local/requirements
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
// Type-only: the ctx.pluginManager service.
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { admitApprovedDevice } from '@delorun/home-auth'
import { z } from 'zod'
import { registerBrowsePairing } from './browse-pairing.ts'
import { REQUIREMENT_ROUTES, type RequirementFix, type RequirementProblem, type RequirementRow, type RequirementsAnswer } from './client/requirements-api.ts'

/** The plugin's name in the loader's diagnostics. */
export const name = 'delorun-requirements'

const Program = z.strictObject({
  kind: z.literal('program'),
  names: z.array(z.string().min(1)).min(1),
  label: z.string().min(1).optional(),
  paths: z.array(z.string().refine(path => posix.isAbsolute(path) || win32.isAbsolute(path), 'a program path must be absolute')).optional(),
})
const Env = z.strictObject({ kind: z.literal('env'), name: z.string().min(1) })
const Platform = z.strictObject({ kind: z.literal('platform'), os: z.array(z.string().min(1)).min(1) })
const PlaywrightBrowser = z.strictObject({
  kind: z.literal('playwright-browser'),
  via: z.array(z.string().min(1)).min(1),
  browser: z.enum(['chromium', 'firefox', 'webkit']),
})
const BrowsePaired = z.strictObject({ kind: z.literal('browse-paired'), via: z.array(z.string().min(1)).min(1) })
const Need = z.discriminatedUnion('kind', [Program, Env, Platform, PlaywrightBrowser, BrowsePaired])
const HttpsUrl = z.url().refine(url => url.startsWith('https://'), 'a link must be https')
const Fix = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), command: z.string().min(1) }),
  z.strictObject({ kind: z.literal('playwright-install') }),
  z.strictObject({ kind: z.literal('browse-pair'), extension: HttpsUrl, guide: HttpsUrl }),
  z.strictObject({ kind: z.literal('settings'), section: z.string().min(1) }),
  z.strictObject({ kind: z.literal('docs'), url: z.url().refine(url => url.startsWith('https://'), 'a docs link must be https') }),
])
const RowRequirement = z.strictObject({ needs: z.array(Need).min(1), fix: Fix })
const Declaration = z.record(z.string().min(1), RowRequirement)

/** One thing a row needs from the computer. */
export type Need = z.infer<typeof Need>
/** The action that meets a need. */
export type Fix = z.infer<typeof Fix>
/** One row's declaration. */
export type RowRequirement = z.infer<typeof RowRequirement>

/** The computer a check reads; a spec supplies another. */
export interface CheckEnvironment {
  /** The operating system, as `process.platform`. */
  readonly platform: NodeJS.Platform
  /** The processor, as `process.arch`. */
  readonly arch: string
  /** The C library on Linux: `musl` when the Node build reports no glibc; `glibc` elsewhere, where it does not apply. */
  readonly libc: 'glibc' | 'musl'
  /** The environment variables. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The user's home directory. */
  readonly home: string
  /**
   * Whether a file or folder exists.
   * @param path - an absolute path.
   * @returns true when it exists.
   */
  exists(path: string): boolean
  /**
   * Read a JSON file.
   * @param path - an absolute path.
   * @returns the parsed value.
   * @throws when the file cannot be read or parsed.
   */
  readJson(path: string): unknown
  /**
   * Resolve a package's `package.json` as the package whose `package.json` is given would import it.
   * @param from - the importing package's `package.json`.
   * @param name - the package to resolve.
   * @returns the absolute path of the resolved `package.json`.
   * @throws when the package cannot be resolved.
   */
  resolvePackage(from: string, name: string): string
  /**
   * Whether an executable regular file exists; nothing is run.
   * @param path - an absolute path.
   * @returns true when the path is a file the user may execute (any file on Windows).
   */
  isExecutable(path: string): boolean
}

/**
 * The computer this process runs on.
 * @returns its platform, environment and file system.
 */
export function hostEnvironment(): CheckEnvironment {
  const report = process.platform === 'linux' ? process.report.getReport() as { header?: { glibcVersionRuntime?: string } } : undefined
  return {
    platform: process.platform,
    arch: process.arch,
    libc: report !== undefined && report.header?.glibcVersionRuntime === undefined ? 'musl' : 'glibc',
    env: process.env,
    home: homedir(),
    exists: existsSync,
    readJson: path => JSON.parse(readFileSync(path, 'utf8')) as unknown,
    resolvePackage: (from, name) => createRequire(from).resolve(`${name}/package.json`),
    isExecutable: (path) => {
      if (!existsSync(path) || !statSync(path).isFile()) return false
      if (process.platform === 'win32') return true
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch (error) {
        // Not executable by this user (EACCES) is the answer "no"; any other failure is the same answer for a lookup.
        return (error as NodeJS.ErrnoException).code === undefined
      }
    },
  }
}

/** The executable suffixes a Windows `PATH` lookup tries; elsewhere a program has none. */
const WINDOWS_SUFFIXES: readonly string[] = ['.exe', '.cmd', '.bat', '']

/**
 * Whether a program exists on `PATH` or at one of the listed absolute paths.
 * @param need - the program need.
 * @param host - the computer.
 * @returns true when found.
 */
function hasProgram(need: Extract<Need, { kind: 'program' }>, host: CheckEnvironment): boolean {
  const suffixes = host.platform === 'win32' ? WINDOWS_SUFFIXES : ['']
  const dirs = (host.env.PATH ?? '').split(delimiter).filter(dir => dir !== '')
  const onPath = dirs.some(dir => need.names.some(program => suffixes.some(suffix => host.isExecutable(join(dir, program + suffix)))))
  return onPath || (need.paths ?? []).some(path => host.isExecutable(path))
}

const PackageManifest = z.object({ name: z.string().min(1), version: z.string().min(1) })
const BrowsersManifest = z.object({ browsers: z.array(z.object({ name: z.string().min(1), revision: z.string().regex(/^\d+$/u) })) })

/** The browser build a Playwright MCP package expects. */
export interface PlaywrightBuild {
  /** The Playwright MCP package's name and exact version, whose installer downloads the build. */
  readonly installer: string
  /** The folders, in Playwright's browser cache, the build's browser and headless shell are downloaded to. */
  readonly folders: readonly string[]
}

/**
 * Playwright's browser cache: `PLAYWRIGHT_BROWSERS_PATH`, `0` for the `playwright-core` package's own folder, or the
 * operating system's cache folder.
 * @param host - the computer.
 * @param core - the `playwright-core` package folder.
 * @returns the absolute folder.
 */
function playwrightCache(host: CheckEnvironment, core: string): string {
  const set = host.env.PLAYWRIGHT_BROWSERS_PATH ?? ''
  if (set === '0') return join(core, '.local-browsers')
  if (set !== '') return isAbsolute(set) ? set : resolve(set)
  switch (host.platform) {
    case 'darwin': return join(host.home, 'Library', 'Caches', 'ms-playwright')
    case 'win32': return join(host.env.LOCALAPPDATA ?? join(host.home, 'AppData', 'Local'), 'ms-playwright')
    default: return join(host.env.XDG_CACHE_HOME ?? join(host.home, '.cache'), 'ms-playwright')
  }
}

/**
 * The build a `playwright-browser` need names, read from the packages its bundle resolves.
 * @param need - the need.
 * @param bundleDir - the bundle's folder, from which `via` is resolved.
 * @param host - the computer.
 * @returns the installer and the folders.
 * @throws when a package cannot be resolved or read, or its `playwright-core` lists no such browser.
 */
export function playwrightBuild(need: Extract<Need, { kind: 'playwright-browser' }>, bundleDir: string, host: CheckEnvironment): PlaywrightBuild {
  let manifest = join(bundleDir, 'package.json')
  for (const name of need.via) manifest = host.resolvePackage(manifest, name)
  const mcp = PackageManifest.parse(host.readJson(manifest))
  const core = dirname(host.resolvePackage(manifest, 'playwright-core'))
  const { browsers } = BrowsersManifest.parse(host.readJson(join(core, 'browsers.json')))
  const builds = browsers.filter(entry => entry.name === need.browser || entry.name === `${need.browser}-headless-shell`)
  if (!builds.some(entry => entry.name === need.browser)) throw new Error(`the playwright-core of ${mcp.name} lists no browser "${need.browser}"`)
  const cache = playwrightCache(host, core)
  return { installer: `${mcp.name}@${mcp.version}`, folders: builds.map(entry => join(cache, `${entry.name.replaceAll('-', '_')}-${entry.revision}`)) }
}

/** browse's platform packages (`@opencode/browse-<suffix>`), by operating system, processor and, on Linux, C library. */
const BROWSE_BUILDS: Readonly<Record<string, string>> = {
  'linux-x64-glibc': 'linux-x64',
  'linux-x64-musl': 'linux-x64-musl',
  'linux-arm64-glibc': 'linux-arm64',
  'linux-arm64-musl': 'linux-arm64-musl',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'windows-x64',
}

/**
 * The absolute path of browse's program for this computer, from the packages a `browse-paired` need names.
 * @param need - the need.
 * @param bundleDir - the bundle's folder, from which `via` is resolved.
 * @param host - the computer.
 * @returns the program's path, or undefined when browse publishes no program for this computer.
 * @throws when a package cannot be resolved, which a pack carrying its program for this computer never meets.
 */
export function browseProgram(need: Extract<Need, { kind: 'browse-paired' }>, bundleDir: string, host: CheckEnvironment): string | undefined {
  const build = BROWSE_BUILDS[host.platform === 'linux' ? `linux-${host.arch}-${host.libc}` : `${host.platform}-${host.arch}`]
  if (build === undefined) return undefined
  let manifest = join(bundleDir, 'package.json')
  for (const name of need.via) manifest = host.resolvePackage(manifest, name)
  const program = join(dirname(host.resolvePackage(manifest, `@opencode/browse-${build}`)), 'bin', host.platform === 'win32' ? 'browse.exe' : 'browse')
  if (!host.isExecutable(program)) throw new Error(`browse's program ${program} is missing or not executable`)
  return program
}

/**
 * browse's data folder as the browse Delorun starts sees it: `browse` in an absolute `XDG_DATA_HOME`, else
 * `.local/share/browse` in the home folder (`HOME`, then `USERPROFILE`), on every operating system. Delorun starts
 * browse with every `OPENCODE_BROWSER_*` variable unset, so `OPENCODE_BROWSER_HOME` from Delorun's environment does
 * not move it.
 * @param host - the computer.
 * @returns the absolute folder.
 */
export function browseDataDir(host: CheckEnvironment): string {
  const data = host.env.XDG_DATA_HOME ?? ''
  if (data !== '' && isAbsolute(data)) return join(data, 'browse')
  const home = [host.env.HOME, host.env.USERPROFILE].find(value => value !== undefined && value !== '') ?? host.home
  return join(home, '.local', 'share', 'browse')
}

/** browse's `browsers.json`: each connected browser profile's id and display name, keyed by profile. */
const KnownBrowsers = z.record(z.string(), z.object({ id: z.string().min(1), name: z.string() }))

/**
 * How many browsers browse has paired and seen connect, from `browsers.json` alone; the token files are never read.
 * @param host - the computer.
 * @returns the count; 0 when the file is absent or unreadable.
 */
export function pairedBrowsers(host: CheckEnvironment): number {
  const path = join(browseDataDir(host), 'browsers.json')
  if (!host.exists(path)) return 0
  try {
    return Object.keys(KnownBrowsers.parse(host.readJson(path))).length
  } catch (_unreadable) {
    // `_unreadable`: a file browse is rewriting, or one another browse version writes differently, reads as "not
    // paired"; the row keeps showing the pairing steps, and pairing again is safe.
    return 0
  }
}

/**
 * Whether one need is met.
 * @param need - the need.
 * @param host - the computer.
 * @param bundleDir - the declaring bundle's folder, which a `playwright-browser` need resolves its packages from.
 * @returns true when met.
 * @throws when a `playwright-browser` need's packages cannot be read.
 */
export function isMet(need: Need, host: CheckEnvironment, bundleDir: string): boolean {
  switch (need.kind) {
    case 'program': return hasProgram(need, host)
    case 'env': return (host.env[need.name] ?? '') !== ''
    case 'platform': return need.os.includes(host.platform)
    case 'playwright-browser':
      return playwrightBuild(need, bundleDir, host).folders.every(folder => host.exists(join(folder, 'INSTALLATION_COMPLETE')))
    case 'browse-paired':
      return browseProgram(need, bundleDir, host) !== undefined && pairedBrowsers(host) > 0
  }
}

/** A bundle the check reads: its package, and the rows its patch declares. */
export interface BundleToCheck {
  readonly name: string
  readonly dir: string
  readonly rowIds: readonly string[]
}

/** The sentences of the reasons, by studio language. */
const REASONS = {
  en: {
    program: (names: string) => `Needs ${names} installed`,
    or: ' or ',
    env: (name: string) => `Needs ${name} set`,
    platform: 'Not available on this kind of computer',
    download: (browser: string) => `${browser} download`,
    pair: 'Connect Chrome',
    windowsArm: 'Not available on Windows on Arm',
  },
  zh: {
    program: (names: string) => `需要安装 ${names}`,
    or: ' 或 ',
    env: (name: string) => `需要设置 ${name}`,
    platform: '此类电脑不支持',
    download: (browser: string) => `需要下载 ${browser}`,
    pair: '需要连接 Chrome',
    windowsArm: 'Windows on Arm 不支持',
  },
} as const

/**
 * The reason a need is unmet, in the studio's language.
 * @param need - the unmet need.
 * @param language - `en` or `zh`.
 * @param supported - for a `browse-paired` need, whether browse has a program for this computer.
 * @param host - the computer.
 * @returns the sentence.
 */
function reasonOf(need: Need, language: string, supported: boolean, host: CheckEnvironment): string {
  const words = language === 'zh' ? REASONS.zh : REASONS.en
  switch (need.kind) {
    case 'program': return words.program(need.label ?? need.names.join(words.or))
    case 'env': return words.env(need.name)
    case 'platform': return words.platform
    case 'playwright-browser': return words.download(BROWSER_NAMES[need.browser])
    case 'browse-paired':
      if (supported) return words.pair
      return host.platform === 'win32' && host.arch === 'arm64' ? words.windowsArm : words.platform
  }
}

/** The browsers' names in a reason. */
const BROWSER_NAMES = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' } as const

/**
 * The fix as Plugins shows it: a `playwright-install` fix becomes the command that runs the installer of the exact
 * Playwright MCP version the row's `playwright-browser` need resolves.
 * @param requirement - the row's declaration.
 * @param bundle - the bundle.
 * @param host - the computer.
 * @returns the fix to show.
 * @throws when a `playwright-install` fix has no `playwright-browser` need beside it, or a `browse-pair` fix no
 * `browse-paired` need.
 */
function shownFix(requirement: RowRequirement, bundle: BundleToCheck, host: CheckEnvironment): RequirementFix {
  if (requirement.fix.kind === 'browse-pair') {
    const need = requirement.needs.find(entry => entry.kind === 'browse-paired')
    if (need === undefined) throw new Error('a "browse-pair" fix needs a "browse-paired" need in the same row')
    // No program for this computer: nothing to pair, so the guide explains what works instead.
    if (browseProgram(need, bundle.dir, host) === undefined) return { kind: 'docs', url: requirement.fix.guide }
    return { kind: 'browse-pair', extension: requirement.fix.extension }
  }
  if (requirement.fix.kind !== 'playwright-install') return requirement.fix
  const need = requirement.needs.find(entry => entry.kind === 'playwright-browser')
  if (need === undefined) throw new Error('a "playwright-install" fix needs a "playwright-browser" need in the same row')
  return { kind: 'command', command: `npx -y ${playwrightBuild(need, bundle.dir, host).installer} install-browser ${need.browser}` }
}

/**
 * A bundle's declaration, read from its `package.json`.
 * @param bundle - the bundle.
 * @returns each declared row's needs and fix, or null for a bundle that declares none.
 * @throws {Error} when the package cannot be read or the declaration is not valid.
 */
export function declarationOf(bundle: BundleToCheck): Readonly<Record<string, RowRequirement>> | null {
  const manifest = z.object({ delorun: z.object({ requires: z.unknown().optional() }).optional() })
    .parse(JSON.parse(readFileSync(join(bundle.dir, 'package.json'), 'utf8')))
  const raw = manifest.delorun?.requires
  return raw === undefined ? null : Declaration.parse(raw)
}

/**
 * Check one bundle's rows.
 * @param bundle - the bundle.
 * @param language - the studio's language; English answers where it has no entry.
 * @param host - the computer.
 * @returns the rows it declares needs for, or null for a bundle that declares none.
 * @throws {Error} when the declaration cannot be read or names a row the patch does not declare.
 */
function checkBundle(bundle: BundleToCheck, language: string, host: CheckEnvironment): RequirementRow[] | null {
  const declared = declarationOf(bundle)
  if (declared === null) return null
  return Object.entries(declared).map(([rowId, requirement]) => {
    if (!bundle.rowIds.includes(rowId)) throw new Error(`"requires" names the row "${rowId}", which the patch does not declare`)
    const fix = shownFix(requirement, bundle, host)
    const unmet = requirement.needs.find(need => !isMet(need, host, bundle.dir))
    if (unmet === undefined) return { packageName: bundle.name, rowId, state: 'ready' as const }
    const supported = unmet.kind !== 'browse-paired' || browseProgram(unmet, bundle.dir, host) !== undefined
    return { packageName: bundle.name, rowId, state: 'needs-setup' as const, reason: reasonOf(unmet, language, supported, host), fix }
  })
}

/**
 * Check every bundle; one bundle's problem never stops another's answer.
 * @param bundles - the bundles to read.
 * @param language - the studio's language.
 * @param host - the computer.
 * @returns each row's state and each bundle's problem.
 */
export function checkRequirements(bundles: readonly BundleToCheck[], language: string, host: CheckEnvironment = hostEnvironment()): RequirementsAnswer {
  const rows: RequirementRow[] = []
  const problems: RequirementProblem[] = []
  for (const bundle of bundles) {
    try {
      rows.push(...checkBundle(bundle, language, host) ?? [])
    } catch (error) {
      problems.push({ packageName: bundle.name, message: error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message })
    }
  }
  return { rows, problems }
}

/** The languages a locale file can answer; anything else is read as English. */
const LANGUAGES: ReadonlySet<string> = new Set(['en', 'zh'])

/**
 * The bundles the plugin manager lists whose files can be read.
 * @param ctx - the scope that holds the plugin manager and the profile.
 * @returns the bundles to check.
 */
export async function listedBundles(ctx: Context): Promise<BundleToCheck[]> {
  const manager = ctx.get('pluginManager')
  const profile = ctx.get('profileContext') as ProfileContext | undefined
  if (manager === undefined || profile === undefined) return []
  const listed = await manager.listBundles()
  return listed.filter(bundle => bundle.availability !== 'missing').flatMap((bundle) => {
    try {
      return [{ name: bundle.name, dir: resolveBundleDir('dsh', bundle.name, profile.installAnchor, profile.dir), rowIds: bundle.rows.map(row => row.rowId) }]
    } catch (error) {
      // The directory cannot be resolved: the plugin manager reports that bundle's own error, and it declares no needs here.
      ctx.logger('delorun-requirements').warn(`${bundle.name}: ${(error as Error).message}`)
      return []
    }
  })
}

/**
 * Mount the check route, and the pairing route of rows that need a browse pairing, once the Connection is up.
 * @param ctx - the row's scope.
 */
export function apply(ctx: Context): void {
  ctx.inject(['connection'], (scope) => {
    registerBrowsePairing(scope, async (request) => {
      const bundle = (await listedBundles(scope)).find(each => each.name === request.packageName)
      const need = bundle === undefined ? undefined : declarationOf(bundle)?.[request.rowId]?.needs.find(each => each.kind === 'browse-paired')
      if (bundle === undefined || need?.kind !== 'browse-paired') return { kind: 'unknown-row' }
      const path = browseProgram(need, bundle.dir, hostEnvironment())
      return path === undefined ? { kind: 'unsupported' } : { kind: 'program', path }
    })
    scope.connection.fetch.register({
      path: REQUIREMENT_ROUTES.check, methods: ['GET'], requestBody: 'buffered',
      // A read of which programs and settings are present; a signed-in device may see it as the owner does.
      admitPeer: admitApprovedDevice(),
      fetch: async (request) => {
        const asked = new URL(request.url).searchParams.get('language') ?? 'en'
        const answer = checkRequirements(await listedBundles(scope), LANGUAGES.has(asked) ? asked : 'en')
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      },
    })
  })
}
