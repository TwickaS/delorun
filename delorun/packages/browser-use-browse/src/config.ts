/**
 * The `browser-use-browse` row's configuration: which pinned browse binary runs, and which of the person's
 * `OPENCODE_BROWSER_*` variables may reach it.
 * @module @delorun/browser-use-browse/config
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** The platform packages `@opencode/browse` publishes, one native binary each; there is no Windows-on-ARM one. */
export const BROWSE_VARIANTS = [
  'linux-x64',
  'linux-arm64',
  'linux-x64-musl',
  'linux-arm64-musl',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
] as const

/** One platform package of {@link BROWSE_VARIANTS}. */
export type BrowseVariant = (typeof BROWSE_VARIANTS)[number]

/** The prefix of every variable browse reads. */
export const BROWSE_ENV_PREFIX = 'OPENCODE_BROWSER_'

/**
 * The browse variables that never come from the person's shell: the update switches, which Delorun sets itself, and the
 * escape hatches that widen what a page or the agent may reach (every cookie, every site's storage, `file:` pages,
 * focus stealing, extra file folders), and the tool-surface switch, so the agent always gets browse's `execute`
 * tools. A row that lists one in `inheritEnv` fails to load.
 */
export const NEVER_INHERITED = [
  'AUTO_UPDATE',
  'UPDATE_CHECK',
  'ALLOW_ALL_COOKIES',
  'ALLOW_ALL_STORAGE',
  'ALLOW_FILE_URLS',
  'ALLOW_FOREGROUND',
  'FILE_ROOTS',
  'TOOLS',
] as const

/**
 * What Delorun sets for every browse it starts: no update checks or installs, so the pinned copy is the one that runs.
 * browse reads `off` and `0` as off.
 */
export const FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  [`${BROWSE_ENV_PREFIX}AUTO_UPDATE`]: 'off',
  [`${BROWSE_ENV_PREFIX}UPDATE_CHECK`]: '0',
})

/** The validated row configuration. */
export interface Config {
  /**
   * Which platform package's binary runs; `auto` picks the one for this computer. `windows-x64` on Linux runs the
   * Windows binary through WSL interop, so the relay runs beside a Chrome on the Windows side.
   */
  readonly variant: 'auto' | BrowseVariant
  /** An absolute program that replaces the pinned binary, such as a test's stand-in server; unset runs the binary. */
  readonly command?: string
  /** The arguments the program runs with. */
  readonly args: string[]
  /**
   * The names, without the `OPENCODE_BROWSER_` prefix, of the person's browse variables that reach the server; every
   * other one is blanked, which browse reads as unset.
   */
  readonly inheritEnv: string[]
  /** A per-call timeout in milliseconds for browse's tools; unset keeps the MCP client's default. */
  readonly toolCallTimeoutMs?: number
  /**
   * How many days the "also when I'm away" permission lasts once the person gives it, before runs they did not start
   * fall back to the isolated browser; giving it again renews it.
   */
  readonly awayDays: number
}

/** The away permission's bounds and default, in whole days. */
export const AWAY_DAYS = { min: 1, max: 30, default: 7 } as const

const NEVER: ReadonlySet<string> = new Set(NEVER_INHERITED)

/** The schema of {@link Config}. */
export const Config: z<Partial<Config>, Config> = z.object({
  variant: z.union(['auto', ...BROWSE_VARIANTS] as const).default('auto'),
  command: z.string().pattern(/\S/u),
  args: z.array(z.string()).default(['mcp']),
  inheritEnv: z.array(z.string().pattern(/^[A-Z0-9_]+$/u)).default([]),
  toolCallTimeoutMs: z.natural().min(1),
  awayDays: z.natural().min(AWAY_DAYS.min).max(AWAY_DAYS.max).default(AWAY_DAYS.default),
})

/**
 * Refuse a row whose settings would start something other than what the person allowed.
 * @param config - the schema-validated row configuration.
 * @throws Error naming the field, for a relative `command` or an `inheritEnv` entry Delorun never passes on.
 */
export function validateConfig(config: Config): void {
  if (config.command !== undefined && !isAbsolute(config.command)) {
    throw new Error(`browser-use-browse: command must be an absolute path, got "${config.command}"`)
  }
  const refused = config.inheritEnv.filter(name => NEVER.has(name))
  if (refused.length > 0) {
    throw new Error(`browser-use-browse: inheritEnv may not list ${refused.map(name => BROWSE_ENV_PREFIX + name).join(', ')}: Delorun never passes these on`)
  }
}

/** What {@link variantOf} reads of the running process. */
export interface HostFacts {
  readonly platform: NodeJS.Platform
  readonly arch: string
  /** Whether the C library is musl, as Alpine's is. */
  readonly musl: boolean
}

/**
 * The facts of this process.
 * @returns the platform, the architecture and whether the C library is musl.
 */
export function hostFacts(): HostFacts {
  const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header
  return { platform: process.platform, arch: process.arch, musl: process.platform === 'linux' && header?.glibcVersionRuntime === undefined }
}

/**
 * The platform package for a computer.
 * @param host - the computer's platform, architecture and C library.
 * @returns the variant, or undefined where browse publishes none (Windows on ARM, other systems).
 */
export function variantOf(host: HostFacts): BrowseVariant | undefined {
  const arch = host.arch === 'x64' || host.arch === 'arm64' ? host.arch : undefined
  if (arch === undefined) return undefined
  if (host.platform === 'linux') return host.musl ? `linux-${arch}-musl` : `linux-${arch}`
  if (host.platform === 'darwin') return `darwin-${arch}`
  if (host.platform === 'win32' && arch === 'x64') return 'windows-x64'
  return undefined
}

/**
 * The binary inside one platform package.
 * @param packageDirectory - the platform package's folder.
 * @param variant - the platform package.
 * @returns the binary's path.
 */
export function binaryIn(packageDirectory: string, variant: BrowseVariant): string {
  return join(packageDirectory, 'bin', variant === 'windows-x64' ? 'browse.exe' : 'browse')
}

/**
 * The folder of an installed platform package, found beside `@opencode/browse` as its own launcher finds it. The
 * browse pack installs both; this package does not depend on them.
 * @param variant - the platform package.
 * @returns the folder, or undefined when the package is not installed.
 */
export function installedPackageDirectory(variant: BrowseVariant): string | undefined {
  const launcher = resolvedFrom(import.meta.url, '@opencode/browse/package.json')
  if (launcher === undefined) return undefined
  const platform = resolvedFrom(launcher, `@opencode/browse-${variant}/package.json`)
  return platform === undefined ? undefined : dirname(platform)
}

/**
 * Resolve a package file as Node would from one file.
 * @param from - the file the lookup starts at, a path or a `file:` URL.
 * @param specifier - the package file.
 * @returns its path, or undefined when the package is not installed.
 */
function resolvedFrom(from: string, specifier: string): string | undefined {
  try {
    return createRequire(from).resolve(specifier)
  } catch (error) {
    // A package the pack did not install fails to resolve; the caller reports the missing variant.
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return undefined
    throw error
  }
}

/** The program and arguments the provider starts. */
export interface ResolvedCommand {
  readonly command: string
  readonly args: string[]
}

/**
 * The program a row starts: its `command`, or the pinned binary of its variant.
 * @param config - the validated row configuration.
 * @param host - the computer, for `variant: auto`.
 * @param locate - finds a platform package's folder.
 * @returns the program and its arguments.
 * @throws Error naming the variant when this computer has none or its package or binary is missing.
 */
export function resolveCommand(config: Config, host: HostFacts = hostFacts(), locate: (variant: BrowseVariant) => string | undefined = installedPackageDirectory): ResolvedCommand {
  if (config.command !== undefined) return { command: config.command, args: config.args }
  const variant = config.variant === 'auto' ? variantOf(host) : config.variant
  if (variant === undefined) {
    throw new Error(`browser-use-browse: browse has no build for ${host.platform} on ${host.arch}`)
  }
  const directory = locate(variant)
  if (directory === undefined) throw new Error(`browser-use-browse: the browse package for ${variant} is not installed`)
  const binary = binaryIn(directory, variant)
  if (!existsSync(binary)) throw new Error(`browser-use-browse: the browse binary for ${variant} is missing at ${binary}`)
  return { command: binary, args: config.args }
}

/**
 * The environment entries the provider merges over the MCP client's scrubbed environment: every browse variable in
 * `env` outside `inheritEnv` blanked, every {@link NEVER_INHERITED} name blanked whether or not it is set yet (the
 * client reads the Host's environment again at each start), and {@link FIXED_ENV}.
 * @param config - the validated row configuration.
 * @param env - the process environment.
 * @returns the entries.
 */
export function childEnv(config: Pick<Config, 'inheritEnv'>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = new Set(config.inheritEnv.filter(name => !NEVER.has(name)).map(name => BROWSE_ENV_PREFIX + name))
  const present = Object.keys(env).filter(key => key.toUpperCase().startsWith(BROWSE_ENV_PREFIX) && !allowed.has(key))
  const blanked = [...NEVER_INHERITED.map(name => BROWSE_ENV_PREFIX + name), ...present].map(key => [key, ''] as const)
  return { ...Object.fromEntries(blanked), ...FIXED_ENV }
}
