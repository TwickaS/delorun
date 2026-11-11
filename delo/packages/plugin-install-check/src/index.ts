/**
 * @delo/plugin-install-check: Delo's provider of upstream's `pluginAudit` hook, which the plugin manager asks before it
 * selects, enables or restores a bundle, so before any of the bundle's plugin code loads; and the `deloPluginTrust`
 * service, which reads and refreshes the profile's trust status ([check](./check.ts)).
 *
 * Every finding is shown and none blocks, except a known critical advisory: the audit then answers
 * `needs-acceptance`, and the studio's Plugins page shows the findings with an "Install anyway" confirmation that
 * accepts exactly that set. A linked or local folder is never checked. With the switch off — the default and the parity
 * value — the plugin provides neither service, and the manager audits nothing, as stock does.
 *
 * @module @delo/plugin-install-check
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { PluginAudit, PluginAuditFinding, PluginAuditResult, PluginAuditTarget } from '@deepseek-ai/dsh-plugin-manager'
import z from '@deepseek-ai/schemastery'
import { ADVISORY_FEED_URL } from '@delo/contract-release-manifest'
import { checkPackage, checkProfileTrust, readPluginTrust, type InstallCheckSettings, type InstallFinding, type PackageCheck, type PluginTrustStatus } from './check.ts'

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
  /** The registry whose package documents give publish times; a trailing `/` is added when missing. */
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
})

/**
 * The check's settings from a validated configuration: the registry gains its trailing `/`.
 * @param config - the configuration, after the schema.
 * @returns the settings.
 */
export function resolveSettings(config: Config): InstallCheckSettings {
  const { enabled: _enabled, registry, ...rest } = config
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
  const named = blocking.map(finding => `${finding.advisory ?? ''} ${finding.package}@${finding.version ?? ''}`).sort()
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
 * @returns the answer: `needs-acceptance` while a critical advisory blocks, `accepted` once the person accepted it,
 *   `clear` otherwise.
 */
export function auditResult(check: PackageCheck, acceptedDigest: string | undefined): PluginAuditResult {
  const findings = check.kind === 'skipped' ? [] : check.findings.map(auditFinding)
  const blocking = check.kind === 'checked' ? check.blocking : []
  if (check.kind === 'checked' && blocking.length > 0) return { decision: 'needs-acceptance', digest: blockingDigest(check.name, blocking), findings, truncated: false }
  if (acceptedDigest !== undefined) return { decision: 'accepted', digest: acceptedDigest, findings, truncated: false }
  return { decision: 'clear', digest: `sha256:${createHash('sha256').update(JSON.stringify(findings)).digest('hex')}`, findings, truncated: false }
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
  const audit: PluginAudit = {
    async audit(target: PluginAuditTarget): Promise<PluginAuditResult> {
      known ??= installationNames(profile.installAnchor)
      let met: string | undefined
      let check: PackageCheck
      try {
        check = await checkPackage({
          profileDir: profile.dir, name: target.name, allowedAdvisories: [], knownNames: known, now: Date.now,
          acceptsBlocking: (blocking) => {
            const digest = blockingDigest(target.name, blocking)
            if (!target.accepted.includes(digest)) return false
            met = digest
            return true
          },
        }, settings)
      } catch (error) {
        // The check never blocks for its own failure: the person sees that it could not run, and the change goes on.
        ctx.logger.warn('The plugin install check failed', error)
        return { decision: 'clear', digest: 'unchecked', findings: [{ rule: 'delo.check-failed', title: `The install check could not run: ${error instanceof Error ? error.message : String(error)}`, severity: 'warning', path: '', line: 0, excerpt: target.name }], truncated: false }
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
