/**
 * @delo/plugin-install-check: Delo's provider of upstream's `pluginAudit` hook, which the plugin manager asks before it
 * selects, enables or restores a bundle, so before any of the bundle's plugin code loads; and the `deloPluginTrust`
 * service, which reads and refreshes the profile's trust status ([check](./check.ts)).
 *
 * The manager asks it first with `pending: 'install'`, once pnpm has resolved the installation into the lockfile and
 * before any file is fetched or script runs, which is when the check runs; and again with nothing pending once the
 * package is installed and built, which is when its files are recorded, with the findings of the first answer. A
 * restore asks with `pending: 'scripts'` before its builds and again after them. A first answer is kept for the package's
 * lockfile reference and integrity, so a later question about another resolution is checked afresh, and every kept
 * answer is dropped once a plugin-manager operation ends, so a failed or cancelled installation leaves none behind.
 *
 * Every finding is shown and none blocks, except a known critical advisory: the audit then answers
 * `needs-acceptance`, and the studio's Plugins page shows the findings with an "Install anyway" confirmation that
 * accepts exactly that set. A check that cannot run while the change has yet to install the package or run its scripts
 * answers `needs-acceptance` too, with a `delo.check-failed` finding whose digest names the package, its lockfile
 * reference and the cause; once nothing is pending, as when a bundle is enabled, it answers `clear` with that finding. A linked or local folder is never checked. With the switch off — the default and the parity
 * value — the plugin provides neither service, and the manager audits nothing, as stock does.
 *
 * @module @delo/plugin-install-check
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { PluginAudit, PluginAuditFinding, PluginAuditResult, PluginAuditTarget } from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import z from '@deepseek-ai/schemastery'
import { ADVISORY_FEED_URL } from '@delo/contract-release-manifest'
import { checkPackage, checkProfileTrust, lockedReference, readPluginTrust, recordInstalled, type InstallCheckSettings, type InstallFinding, type PackageCheck, type PluginTrustStatus } from './check.ts'

export type { InstallFinding, PluginTrustEntry, PluginTrustState, PluginTrustStatus } from './check.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'plugin-install-check'

/** The profile whose plugins are checked. */
export const inject = ['profileContext']

/** An npm scope (`@scope`) or a git owner (`<host>/<owner>`, such as `github.com/me`). */
export const TRUSTED_SOURCE = /^(?:@[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\/[A-Za-z0-9][A-Za-z0-9_.-]*)$/u

/** An https URL. */
const HTTPS_URL = /^https:\/\/\S+$/u

/** The plugin's configuration. */
export interface Config {
  /** Provide `pluginAudit` and `deloPluginTrust`; off, the parity value, the plugin provides nothing. */
  readonly enabled: boolean
  /** npm's bulk advisory endpoint, which answers from the GitHub Advisory Database. */
  readonly advisoryFeed: string
  /**
   * The primary registry, whose package documents give publish times and confirm the integrity of a package a mirror
   * resolved; a trailing `/` is added when missing.
   */
  readonly registry: string
  /** A version published less than this many hours ago is a warning. */
  readonly minimumAgeHours: number
  /** The largest edit distance between a new name and a known one that is a warning. */
  readonly similarNameDistance: number
  /** Names shorter than this are not compared. */
  readonly similarNameMinLength: number
  /** Each request's time limit in milliseconds. */
  readonly requestTimeoutMs: number
  /** How many package documents are read at once. */
  readonly requestConcurrency: number
  /** The largest package document read, in bytes. */
  readonly metadataMaxBytes: number
  /** The most files recorded per package. */
  readonly maxFiles: number
  /** npm scopes and git owners whose plugins show critical advisories only. */
  readonly trustedSources: string[]
  /**
   * Ask the npmmirror registry when the first registry fails, as upstream does by default. `delorun` passes it to the
   * plugin manager's `fallbackRegistries` at each start; Settings → Privacy and `delorun plugin mirror on|off` set it.
   */
  readonly npmMirror: boolean
}

/** The plugin's configuration schema: it takes any subset of the fields and fills the rest with their defaults, the switch's being the parity value. */
export const Config: z<Partial<Config>, Config> = z.object({
  enabled: z.boolean().default(false),
  advisoryFeed: z.string().pattern(HTTPS_URL).default(ADVISORY_FEED_URL),
  registry: z.string().pattern(HTTPS_URL).default('https://registry.npmjs.org/'),
  minimumAgeHours: z.number().min(0).default(24),
  similarNameDistance: z.natural().max(3).default(1),
  similarNameMinLength: z.natural().min(1).default(4),
  requestTimeoutMs: z.natural().min(1000).max(600_000).default(15_000),
  requestConcurrency: z.natural().min(1).max(64).default(8),
  metadataMaxBytes: z.natural().min(1024).default(64 * 1024 * 1024),
  maxFiles: z.natural().min(1).default(20_000),
  trustedSources: z.array(z.string().pattern(TRUSTED_SOURCE)).default([]),
  npmMirror: z.boolean().default(false),
})

/**
 * The check's settings from a validated configuration: the registry gains its trailing `/`.
 * @param config - the configuration, after the schema.
 * @returns the settings.
 */
export function resolveSettings(config: Config): InstallCheckSettings {
  const { enabled: _enabled, npmMirror: _npmMirror, registry, ...rest } = config
  return { ...rest, registry: registry.endsWith('/') ? registry : `${registry}/` }
}

/** The trust status of the profile's installed plugins. */
export interface PluginTrust {
  /**
   * Read the last check's result.
   * @returns the status, or `undefined` when no check has written one.
   */
  status(): Promise<PluginTrustStatus | undefined>
  /**
   * Compare the profile's installed plugins with their records now and write the result.
   * @param full - hash every file instead of only those whose identity changed.
   * @returns the status it wrote.
   */
  check(full: boolean): Promise<PluginTrustStatus>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The trust status of the profile's installed plugins, which `@delo/plugin-install-check` provides. */
    deloPluginTrust: PluginTrust
  }
}

/**
 * The names the installation carries: its own and its manifest's dependencies.
 * @param installAnchor - the installation's `package.json`.
 * @returns the names; none when the manifest does not read.
 */
export function installationNames(installAnchor: string): Set<string> {
  try {
    const manifest: unknown = JSON.parse(readFileSync(installAnchor, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null) return new Set()
    const record = manifest as Record<string, unknown>
    const deps = typeof record.dependencies === 'object' && record.dependencies !== null ? Object.keys(record.dependencies) : []
    return new Set([...typeof record.name === 'string' ? [record.name] : [], ...deps])
  } catch (_unreadable) {
    // An installation whose manifest does not read gives no names to compare with; the profile's own still count.
    return new Set()
  }
}

/**
 * The digest an acceptance of blocking findings names: their advisories, packages and versions.
 * @param pluginName - the plugin.
 * @param blocking - the blocking findings.
 * @returns the digest.
 */
export function blockingDigest(pluginName: string, blocking: readonly InstallFinding[]): string {
  const named = blocking.map(finding => `${finding.advisory ?? finding.rule} ${finding.package}@${finding.version ?? ''}`).sort()
  return `sha256:${createHash('sha256').update(JSON.stringify([pluginName, named])).digest('hex')}`
}

/**
 * A finding as the plugin manager shows it.
 * @param finding - the finding.
 * @returns the audit finding: the rule under `delo.`, the package as the excerpt.
 */
function auditFinding(finding: InstallFinding): PluginAuditFinding {
  return { rule: `delo.${finding.rule}`, title: finding.title, severity: finding.severity, path: finding.path, line: finding.line, excerpt: finding.version === undefined ? finding.package : `${finding.package} ${finding.version}` }
}

/**
 * The audit's answer for a check.
 * @param check - the check.
 * @param acceptedDigest - the digest the person accepted, when the check met one.
 * @returns the answer: `refused` for an integrity the primary registry contradicts, `needs-acceptance` while a critical
 *   finding blocks, `accepted` once the person accepted it, `clear` otherwise.
 */
export function auditResult(check: PackageCheck, acceptedDigest: string | undefined): PluginAuditResult {
  const findings = check.kind === 'skipped' ? [] : check.findings.map(auditFinding)
  if (check.kind === 'checked' && check.refused.length > 0) return { decision: 'refused', digest: blockingDigest(check.name, check.refused), findings, truncated: false }
  const blocking = check.kind === 'checked' ? check.blocking : []
  if (check.kind === 'checked' && blocking.length > 0) return { decision: 'needs-acceptance', digest: blockingDigest(check.name, blocking), findings, truncated: false }
  if (acceptedDigest !== undefined) return { decision: 'accepted', digest: acceptedDigest, findings, truncated: false }
  return { decision: 'clear', digest: `sha256:${createHash('sha256').update(JSON.stringify(findings)).digest('hex')}`, findings, truncated: false }
}

/**
 * The answer for a check that could not run: `needs-acceptance` while the change has yet to install the package or run
 * its scripts, so nothing unchecked is fetched or built without the person's acceptance of exactly this failure, and
 * `clear` with the same finding once nothing is pending.
 * @param target - what the manager asked about.
 * @param cause - why the check could not run.
 * @param reference - the package's lockfile reference, when the lockfile read.
 * @returns the answer, with one `delo.check-failed` finding.
 */
export function checkFailedResult(target: PluginAuditTarget, cause: string, reference: string | undefined): PluginAuditResult {
  const pending = target.pending !== undefined
  const findings: PluginAuditFinding[] = [{
    rule: 'delo.check-failed', title: `The install check could not run, so this package is not checked: ${cause}`,
    severity: pending ? 'critical' : 'warning', path: '', line: 0, excerpt: target.name,
  }]
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(['check-failed', target.name, reference ?? null, cause])).digest('hex')}`
  if (!pending) return { decision: 'clear', digest, findings, truncated: false }
  return { decision: target.accepted.includes(digest) ? 'accepted' : 'needs-acceptance', digest, findings, truncated: false }
}

/**
 * Whether a mirror resolved an installation: a registry after the first one it asked, or one of the plugin manager's
 * fallback registries.
 * @param asked - the registries the installation asked, the last one having resolved it; absent for any other question.
 * @param fallbacks - the plugin manager's fallback registries.
 * @returns true when the resolving registry is a fallback.
 */
export function resolvedThroughMirror(asked: readonly (string | null)[] | undefined, fallbacks: readonly string[]): boolean {
  const last = asked?.at(-1)
  if (asked === undefined || last === undefined) return false
  const comparable = (url: string): string => (url.endsWith('/') ? url : `${url}/`).toLowerCase()
  return asked.length > 1 || (last !== null && fallbacks.some(fallback => comparable(fallback) === comparable(last)))
}

/**
 * Mount the plugin. On, it provides `pluginAudit` and `deloPluginTrust` for the profile; off, nothing.
 * @param ctx - the plugin context.
 * @param config - the configuration, after the schema.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const settings = resolveSettings(config)
  const profile: ProfileContext = ctx.profileContext
  let known: Set<string> | undefined
  /**
   * Checks that passed before their installation finished, by plugin name and lockfile reference, recorded once the
   * manager asks with nothing pending.
   */
  const awaiting = new Map<string, PackageCheck>()
  // An operation that ended without its last question, failed or cancelled, leaves no answer for a later one.
  ctx.on('plugin-manager/operation', (operation) => { if (operation.phase !== 'started') awaiting.clear() })
  /** The plugin manager's registries: every URL it may ask, and its fallbacks alone. */
  const registries = async (): Promise<{ readonly urls: string[], readonly fallbacks: string[] }> => {
    const manager = ctx.get('pluginManager')
    if (manager === undefined) return { urls: [], fallbacks: [] }
    try {
      const configured = await manager.registries()
      return {
        urls: [...configured.registry === null ? configured.resolved === null ? [] : [configured.resolved] : [configured.registry], ...configured.fallbackRegistries],
        fallbacks: [...configured.fallbackRegistries],
      }
    } catch (error) {
      // pnpm's own registry could not be read; the registries the installation asked are still compared, and the check goes on.
      ctx.logger.warn('The plugin install check could not read the plugin registries', error)
      return { urls: [], fallbacks: [] }
    }
  }
  const audit: PluginAudit = {
    async audit(target: PluginAuditTarget): Promise<PluginAuditResult> {
      known ??= installationNames(profile.installAnchor)
      let met: string | undefined
      let check: PackageCheck
      try {
        const reference = await lockedReference(profile.dir, target.name)
        const key = reference === undefined ? undefined : JSON.stringify([target.name, reference])
        const earlier = target.pending === undefined && key !== undefined ? awaiting.get(key) : undefined
        const configured = earlier === undefined ? await registries() : { urls: [], fallbacks: [] }
        check = earlier ?? await checkPackage({
          profileDir: profile.dir, name: target.name, allowedAdvisories: [], knownNames: known, now: Date.now, compareFiles: target.pending === undefined,
          // The registries this installation asked, such as one named for it alone, are audited beside the configured ones.
          registries: [...configured.urls, ...(target.registries ?? []).flatMap(registry => registry === null ? [] : [registry])],
          confirmIntegrity: resolvedThroughMirror(target.registries, configured.fallbacks),
          acceptsBlocking: (blocking) => {
            const digest = blockingDigest(target.name, blocking)
            if (!target.accepted.includes(digest)) return false
            met = digest
            return true
          },
        }, settings)
        if (target.pending !== undefined && check.kind === 'unchecked') return checkFailedResult(target, check.findings[0]?.title ?? 'the lockfile does not read', undefined)
        if (target.pending !== undefined && check.kind === 'skipped' && check.reason === 'not-a-dependency') return checkFailedResult(target, 'the profile\'s lockfile does not name the package', undefined)
        if (earlier !== undefined && check.kind === 'checked' && check.findings.some(finding => finding.severity === 'critical')) {
          met = blockingDigest(target.name, check.findings.filter(finding => finding.severity === 'critical'))
        }
        if (check.kind === 'checked' && check.pending !== undefined) {
          if (target.pending === undefined) {
            if (key !== undefined) awaiting.delete(key)
            await recordInstalled(profile.dir, check.pending, { now: Date.now, maxFiles: settings.maxFiles })
          } else if (key !== undefined) {
            awaiting.set(key, check)
          }
        }
      } catch (error) {
        // While the package is still to be installed or built this refuses until accepted; once installed it is shown.
        ctx.logger.warn('The plugin install check failed', error)
        return checkFailedResult(target, error instanceof Error ? error.message : String(error), await lockedReference(profile.dir, target.name))
      }
      return auditResult(check, met)
    },
  }
  const trust: PluginTrust = {
    status: () => readPluginTrust(profile.dir),
    check: full => checkProfileTrust(profile.dir, { full, now: Date.now, maxFiles: settings.maxFiles }),
  }
  ctx.effect(() => ctx.provide('pluginAudit', audit), 'plugin-install-check: pluginAudit')
  ctx.effect(() => ctx.provide('deloPluginTrust', trust), 'plugin-install-check: deloPluginTrust')
}
