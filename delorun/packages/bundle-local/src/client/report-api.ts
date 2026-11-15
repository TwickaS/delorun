/**
 * The "Report a problem" route and its answer: what the home knows of this installation (versions, system and a redacted
 * excerpt of its recent errors) and where the issue form is. The Host serves it from [`../report.ts`](../report.ts); the
 * studio reads it through [`./host-api.ts`](./host-api.ts). Nothing here sends the report anywhere.
 * @module @delorun/bundle-local/client/report-api
 */
import { call, fields, isString, optional, type Check, type HostFetch } from './host-api.ts'

/** `GET`: the details, as {@link ReportDetails}; answered to the home's computer only. */
export const REPORT_ROUTE = '/api/delorunReport.details'

/** The issue form's address and template a row that sets neither uses; an approved device, which cannot read the row's configuration, uses them too. */
export const REPORT_DEFAULTS = { issueUrl: 'https://github.com/Delo-Run/delo/issues/new', template: 'bug_report.yml' } as const

/** What the home tells the studio about itself for a problem report. */
export interface ReportDetails {
  /** Delorun's version, or absent when the harness was not started by `delorun`. */
  readonly delorun?: string
  /** The DeepSeek Harness version Delorun runs on, or absent with `delorun`. */
  readonly dsh?: string
  /** The operating system and release, such as `Linux 6.6.87`. */
  readonly os: string
  /** The platform and processor architecture, such as `linux x64`. */
  readonly platform: string
  /** The newest error records of the home's log, already through the log redactor; empty when there are none. */
  readonly excerpt: string
  /** The address of the issue form, from the row's configuration. */
  readonly issueUrl: string
  /** The issue template's name, from the row's configuration. */
  readonly template: string
}

const validDetails: Check = fields({
  delorun: optional(isString), dsh: optional(isString), os: isString, platform: isString, excerpt: isString, issueUrl: isString, template: isString,
})

/**
 * Read the report details from the home.
 * @param fetchImpl - the request function; the browser's `fetch` unless a spec supplies one. The request goes to the home only.
 * @returns the details.
 * @throws {HostRequestError} when the home refuses, cannot be reached or answers something other than the details.
 */
export function loadReportDetails(fetchImpl: HostFetch = (input, init) => fetch(input, init)): Promise<ReportDetails> {
  return call<ReportDetails>(fetchImpl, REPORT_ROUTE, validDetails)
}
