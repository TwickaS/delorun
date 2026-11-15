/**
 * Builds the problem report the person reviews: its text, and the link to the issue form with its `version` and `logs` fields filled in (the field ids of `.github/ISSUE_TEMPLATE/bug_report.yml`). Pure: it reads no
 * page, sends nothing and redacts nothing; the home has already put the excerpt through the log redactor.
 * @module @delorun/bundle-local/client/report-url
 */
import type { ReportDetails } from './report-api.ts'

/** The longest address the link may have, in characters; GitHub refuses addresses of about 8,000 characters. */
export const MAX_REPORT_URL_LENGTH = 7000

/** Where the studio runs: on the home's own computer, or on an approved device. */
export type StudioSurface = 'computer' | 'approved device'

/** The report in both forms. */
export interface Report {
  /** The complete text, which Copy details copies. */
  readonly details: string
  /** The issue form's Version field as the link fills it. */
  readonly version: string
  /** The issue form's Logs field as the link fills it; shorter than the excerpt when the excerpt was cut. */
  readonly logs: string
  /** The link that opens the issue form with the two fields filled in. */
  readonly url: string
  /** Whether `logs` is shorter than the excerpt. */
  readonly truncated: boolean
}

/**
 * The Version field: both versions, the system and the studio surface on one line.
 * @param details - what the home reported.
 * @param surface - where the studio runs.
 * @returns the line.
 */
function versionLine(details: ReportDetails, surface: StudioSurface): string {
  return `Delorun ${details.delorun ?? 'unknown'}; DeepSeek Harness ${details.dsh ?? 'unknown'}; ${details.os} (${details.platform}); studio on ${surface}`
}

/**
 * The link to the issue form with the fields filled in.
 * @param details - supplies the form's address and template.
 * @param version - the Version field.
 * @param logs - the Logs field, or empty to leave it out.
 * @returns the link.
 */
function link(details: ReportDetails, version: string, logs: string): string {
  const url = new URL(details.issueUrl)
  url.searchParams.set('template', details.template)
  url.searchParams.set('version', version)
  if (logs !== '') url.searchParams.set('logs', logs)
  return url.toString()
}

/** Added to the Logs field when the excerpt was cut. */
export const TRUNCATION_NOTE = '[Earlier lines cut to fit the link; the full excerpt is in Copy details.]'

/**
 * Build the report. When the link would pass {@link MAX_REPORT_URL_LENGTH}, the excerpt is cut from its start (the newest
 * lines are kept) and the Logs field says so.
 * @param details - what the home reported.
 * @param surface - where the studio runs.
 * @returns the report.
 * @throws {TypeError} when `details.issueUrl` is not an absolute URL.
 */
export function buildReport(details: ReportDetails, surface: StudioSurface): Report {
  const version = versionLine(details, surface)
  const text = [`Version: ${version}`, '', 'Recent errors:', details.excerpt === '' ? 'None recorded.' : details.excerpt].join('\n')
  const whole = link(details, version, details.excerpt)
  if (whole.length <= MAX_REPORT_URL_LENGTH) return { details: text, version, logs: details.excerpt, url: whole, truncated: false }
  const cut = (kept: number): string => `${TRUNCATION_NOTE}\n${details.excerpt.slice(details.excerpt.length - kept)}`
  let low = 0
  let high = details.excerpt.length
  // The largest tail of the excerpt whose link fits; the note alone always fits, as the version line is short.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (link(details, version, cut(middle)).length <= MAX_REPORT_URL_LENGTH) low = middle
    else high = middle - 1
  }
  const logs = cut(low)
  return { details: text, version, logs, url: link(details, version, logs), truncated: true }
}
