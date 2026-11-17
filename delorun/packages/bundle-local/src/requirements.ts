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
 * A `chromium` need tests the browser that will launch. The row's own configuration, read from its Loader entry, names
 * a `browser` of `auto`, `chrome` or `chromium` (`auto` when the row has no entry or names none), and the same function
 * the Playwright provider builds its launch arguments with, `launchedBrowser`, answers Chrome or Chromium. When Chrome
 * launches, the need is met by Google Chrome installed where Playwright's `chrome` channel looks, with no download, and
 * an unmet one reads "Needs Google Chrome installed" with the installer's `chrome` command; when Chromium launches, the
 * exact build is needed as above. A `browser` that is none of the three is the bundle's problem.
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
import { chromeChannelExecutable, launchedBrowser, parseBrowserChoice } from '@deepseek-ai/dsh-native-command/chrome-channel'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
// Type-only: the ctx.pluginManager service.
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { admitApprovedDevice } from '@delorun/home-auth'
import { z } from 'zod'
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
const Need = z.discriminatedUnion('kind', [Program, Env, Platform, PlaywrightBrowser])
const Fix = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), command: z.string().min(1) }),
  z.strictObject({ kind: z.literal('playwright-install') }),
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
  return {
    platform: process.platform,
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

const RowBrowser = z.looseObject({ browser: z.unknown().optional() })

/**
 * Whether a `playwright-browser` need tests the installed Chrome instead of a downloaded build: a `chromium` need whose
 * row launches Chrome.
 * @param need - the need.
 * @param rowConfig - the row's Loader entry configuration, or `undefined` for a row without an entry.
 * @param host - the computer.
 * @returns true when Chrome launches.
 * @throws when the configuration names a `browser` that is not `auto`, `chrome` or `chromium`.
 */
export function launchesChrome(need: Extract<Need, { kind: 'playwright-browser' }>, rowConfig: unknown, host: CheckEnvironment): boolean {
  if (need.browser !== 'chromium') return false
  const config = RowBrowser.safeParse(rowConfig)
  return launchedBrowser(parseBrowserChoice(config.success ? config.data.browser : undefined), host) === 'chrome'
}

/**
 * Whether one need is met.
 * @param need - the need.
 * @param host - the computer.
 * @param bundleDir - the declaring bundle's folder, which a `playwright-browser` need resolves its packages from.
 * @param rowConfig - the row's Loader entry configuration, which names the browser a `playwright-browser` need tests.
 * @returns true when met.
 * @throws when a `playwright-browser` need's packages cannot be read or its row names an unknown `browser`.
 */
export function isMet(need: Need, host: CheckEnvironment, bundleDir: string, rowConfig?: unknown): boolean {
  switch (need.kind) {
    case 'program': return hasProgram(need, host)
    case 'env': return (host.env[need.name] ?? '') !== ''
    case 'platform': return need.os.includes(host.platform)
    case 'playwright-browser':
      if (launchesChrome(need, rowConfig, host)) return chromeChannelExecutable(host) !== undefined
      return playwrightBuild(need, bundleDir, host).folders.every(folder => host.exists(join(folder, 'INSTALLATION_COMPLETE')))
  }
}

/** A bundle the check reads: its package, and the rows its patch declares. */
export interface BundleToCheck {
  readonly name: string
  readonly dir: string
  readonly rowIds: readonly string[]
  /** Each row's Loader entry configuration, by row id; a row without an entry has none. */
  readonly rowConfigs?: Readonly<Record<string, unknown>>
}

/** The sentences of the reasons, by studio language. */
const REASONS = {
  en: {
    program: (names: string) => `Needs ${names} installed`,
    or: ' or ',
    env: (name: string) => `Needs ${name} set`,
    platform: 'Not available on this kind of computer',
    download: (browser: string) => `${browser} download`,
  },
  zh: {
    program: (names: string) => `需要安装 ${names}`,
    or: ' 或 ',
    env: (name: string) => `需要设置 ${name}`,
    platform: '此类电脑不支持',
    download: (browser: string) => `需要下载 ${browser}`,
  },
} as const

/**
 * The reason a need is unmet, in the studio's language.
 * @param need - the unmet need.
 * @param language - `en` or `zh`.
 * @param chrome - whether a `playwright-browser` need tests the installed Chrome.
 * @returns the sentence.
 */
function reasonOf(need: Need, language: string, chrome: boolean): string {
  const words = language === 'zh' ? REASONS.zh : REASONS.en
  switch (need.kind) {
    case 'program': return words.program(need.label ?? need.names.join(words.or))
    case 'env': return words.env(need.name)
    case 'platform': return words.platform
    case 'playwright-browser': return chrome ? words.program('Google Chrome') : words.download(BROWSER_NAMES[need.browser])
  }
}

/** The browsers' names in a reason. */
const BROWSER_NAMES = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' } as const

/**
 * The fix as Plugins shows it: a `playwright-install` fix becomes the command that runs the installer of the exact
 * Playwright MCP version the row's `playwright-browser` need resolves.
 * The installer is asked for `chrome` when the row launches Chrome.
 * @param requirement - the row's declaration.
 * @param bundle - the bundle.
 * @param host - the computer.
 * @param rowConfig - the row's Loader entry configuration.
 * @returns the fix to show.
 * @throws when a `playwright-install` fix has no `playwright-browser` need beside it.
 */
function shownFix(requirement: RowRequirement, bundle: BundleToCheck, host: CheckEnvironment, rowConfig: unknown): RequirementFix {
  if (requirement.fix.kind !== 'playwright-install') return requirement.fix
  const need = requirement.needs.find(entry => entry.kind === 'playwright-browser')
  if (need === undefined) throw new Error('a "playwright-install" fix needs a "playwright-browser" need in the same row')
  const browser = launchesChrome(need, rowConfig, host) ? 'chrome' : need.browser
  return { kind: 'command', command: `npx -y ${playwrightBuild(need, bundle.dir, host).installer} install-browser ${browser}` }
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
  const manifest = z.object({ delorun: z.object({ requires: z.unknown().optional() }).optional() })
    .parse(JSON.parse(readFileSync(join(bundle.dir, 'package.json'), 'utf8')))
  const raw = manifest.delorun?.requires
  if (raw === undefined) return null
  const declared = Declaration.parse(raw)
  return Object.entries(declared).map(([rowId, requirement]) => {
    if (!bundle.rowIds.includes(rowId)) throw new Error(`"requires" names the row "${rowId}", which the patch does not declare`)
    const rowConfig = bundle.rowConfigs?.[rowId]
    const fix = shownFix(requirement, bundle, host, rowConfig)
    const unmet = requirement.needs.find(need => !isMet(need, host, bundle.dir, rowConfig))
    if (unmet === undefined) return { packageName: bundle.name, rowId, state: 'ready' as const }
    const chrome = unmet.kind === 'playwright-browser' && launchesChrome(unmet, rowConfig, host)
    return { packageName: bundle.name, rowId, state: 'needs-setup' as const, reason: reasonOf(unmet, language, chrome), fix }
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
async function listedBundles(ctx: Context): Promise<BundleToCheck[]> {
  const manager = ctx.get('pluginManager')
  const profile = ctx.get('profileContext') as ProfileContext | undefined
  if (manager === undefined || profile === undefined) return []
  const listed = await manager.listBundles()
  // The Loader keeps one entry for a row id, switched on or off, and its configuration is what the row runs with.
  const configs: Record<string, unknown> = {}
  for (const entry of ctx.get('loader')?.entries() ?? []) {
    if (typeof entry.options.id === 'string') configs[entry.options.id] = entry.options.config
  }
  return listed.filter(bundle => bundle.availability !== 'missing').flatMap((bundle) => {
    const rowIds = bundle.rows.map(row => row.rowId)
    const rowConfigs = Object.fromEntries(rowIds.filter(rowId => Object.hasOwn(configs, rowId)).map(rowId => [rowId, configs[rowId]]))
    try {
      return [{ name: bundle.name, dir: resolveBundleDir('dsh', bundle.name, profile.installAnchor, profile.dir), rowIds, rowConfigs }]
    } catch (error) {
      // The directory cannot be resolved: the plugin manager reports that bundle's own error, and it declares no needs here.
      ctx.logger('delorun-requirements').warn(`${bundle.name}: ${(error as Error).message}`)
      return []
    }
  })
}

/**
 * Mount the check route once the Connection is up.
 * @param ctx - the row's scope.
 */
export function apply(ctx: Context): void {
  ctx.inject(['connection'], (scope) => {
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
