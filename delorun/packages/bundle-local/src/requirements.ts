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
 * language: "Needs <label or names> installed", "Needs <name> set" or "Not available on this kind of computer". A need is
 * a `program` that exists and is executable on `PATH` or at one of its listed absolute `paths` (it is never run), with an
 * optional friendly `label`; an `env` variable that is set and not empty; or a `platform` the row runs on.
 *
 * A check never stops a row and never throws across bundles: a bundle whose declaration cannot be read, names a row its
 * patch does not declare, or lacks the reason in English is reported as a problem of that bundle, and every other bundle
 * answers as usual. The check reads the computer afresh on each request, so a met need clears the next time Plugins asks.
 *
 * @module @delorun/bundle-local/requirements
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join, posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
// Type-only: the ctx.pluginManager service.
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { REACH_DEVICE } from '@delorun/home-auth'
import { z } from 'zod'
import { REQUIREMENT_ROUTES, type RequirementProblem, type RequirementRow, type RequirementsAnswer } from './client/requirements-api.ts'

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
const Need = z.discriminatedUnion('kind', [Program, Env, Platform])
const Fix = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), command: z.string().min(1) }),
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

/**
 * Whether one need is met.
 * @param need - the need.
 * @param host - the computer.
 * @returns true when met.
 */
export function isMet(need: Need, host: CheckEnvironment): boolean {
  switch (need.kind) {
    case 'program': return hasProgram(need, host)
    case 'env': return (host.env[need.name] ?? '') !== ''
    case 'platform': return need.os.includes(host.platform)
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
  },
  zh: {
    program: (names: string) => `需要安装 ${names}`,
    or: ' 或 ',
    env: (name: string) => `需要设置 ${name}`,
    platform: '此类电脑不支持',
  },
} as const

/**
 * The reason a need is unmet, in the studio's language.
 * @param need - the unmet need.
 * @param language - `en` or `zh`.
 * @returns the sentence.
 */
function reasonOf(need: Need, language: string): string {
  const words = language === 'zh' ? REASONS.zh : REASONS.en
  switch (need.kind) {
    case 'program': return words.program(need.label ?? need.names.join(words.or))
    case 'env': return words.env(need.name)
    case 'platform': return words.platform
  }
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
    const unmet = requirement.needs.find(need => !isMet(need, host))
    if (unmet === undefined) return { packageName: bundle.name, rowId, state: 'ready' as const }
    return { packageName: bundle.name, rowId, state: 'needs-setup' as const, reason: reasonOf(unmet, language), fix: requirement.fix }
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
 * Mount the check route once the Connection is up.
 * @param ctx - the row's scope.
 */
export function apply(ctx: Context): void {
  ctx.inject(['connection'], (scope) => {
    scope.connection.fetch.register({
      path: REQUIREMENT_ROUTES.check, methods: ['GET'], requestBody: 'buffered',
      // A read of which programs and settings are present; a signed-in device may see it as the owner does.
      admitPeer: (_request, peer) => peer.principal.kind === REACH_DEVICE,
      fetch: async (request) => {
        const asked = new URL(request.url).searchParams.get('language') ?? 'en'
        const answer = checkRequirements(await listedBundles(scope), LANGUAGES.has(asked) ? asked : 'en')
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
      },
    })
  })
}
