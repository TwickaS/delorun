/** Localizable rejections shared by profile management operations. */
import type { PluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import type { IncompatiblePlugin, ManagementError, PluginAuditResult } from './types.ts'

/** Expected management rejection; presentation belongs to the caller's locale. */
export class ManagementFailure extends Error {
  /** Code rendered by the caller's locale dictionary. */
  readonly code: ManagementError['code']
  /** The packages an `incompatible-version` rejection names. */
  readonly incompatible: IncompatiblePlugin[] | undefined
  /** What the rejection's cause reported, for a code whose sentence names no particulars, such as `history-unavailable`. */
  readonly diagnostic: string | undefined
  /** What the plugin audit found, for `audit-findings` and `audit-refused`. */
  readonly audit: PluginAuditResult | undefined
  /**
   * @param code Localizable management rejection.
   * @param incompatible Packages the running DSH version rejects, for `incompatible-version`.
   * @param diagnostic What the cause reported.
   * @param audit What the plugin audit found, for `audit-findings` and `audit-refused`.
   */
  constructor(code: ManagementError['code'], incompatible?: IncompatiblePlugin[], diagnostic?: string, audit?: PluginAuditResult) {
    super(code)
    this.code = code
    this.incompatible = incompatible
    this.diagnostic = diagnostic
    this.audit = audit
  }
}

/**
 * Drop the exemption status from an unexempted compatibility result.
 * @param issue Result whose exemption is not active.
 * @returns The package, runtime, and unmet DSH requirements.
 */
export function incompatiblePlugin(issue: PluginCompatibility): IncompatiblePlugin {
  return { name: issue.name, version: issue.version, runtimeVersion: issue.runtimeVersion, requirements: issue.requirements }
}
