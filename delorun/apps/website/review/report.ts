/**
 * The audit's data model and the two files made from it: `report.json` (machine-readable) and `audit.md` (for people). The
 * summary counts failures against the plan's bar.
 *
 * @module @delorun/website/review/report
 */

/** One finding. `fail` breaks the bar; `warn` is worth a look; `info` is a measurement. */
export interface Finding {
  readonly severity: 'fail' | 'warn' | 'info'
  /** The check that found it, such as `overflow` or `axe`. */
  readonly check: string
  /** Where: a width, a section or a page. */
  readonly where: string
  readonly message: string
}

/** The audit as one object. */
export interface Report {
  /** The pass number. */
  readonly pass: number
  /** The commit of the build, when known. */
  readonly commit: string
  /** Sections the page did not have, by key. A missing section is reported, not fatal. */
  readonly missingSections: readonly string[]
  readonly findings: readonly Finding[]
  /** Measurements that are not findings: paints, shifts, frame rates, the weight table. */
  readonly measurements: Readonly<Record<string, unknown>>
  /** The pictures taken, by file name. */
  readonly pictures: readonly string[]
}

/** The counts the summary prints. */
export interface Summary {
  readonly fail: number
  readonly warn: number
  readonly info: number
  readonly pictures: number
  readonly missingSections: number
  /** Fail counts by check name, sorted by name. */
  readonly failsByCheck: Readonly<Record<string, number>>
}

/**
 * Counts a report.
 * @param report - the report.
 * @returns the counts.
 */
export function summarise(report: Report): Summary {
  const failsByCheck: Record<string, number> = {}
  const count = { fail: 0, warn: 0, info: 0 }
  for (const finding of report.findings) {
    count[finding.severity] += 1
    if (finding.severity === 'fail') failsByCheck[finding.check] = (failsByCheck[finding.check] ?? 0) + 1
  }
  const sorted = Object.fromEntries(Object.entries(failsByCheck).sort(([a], [b]) => a.localeCompare(b)))
  return { ...count, pictures: report.pictures.length, missingSections: report.missingSections.length, failsByCheck: sorted }
}

/**
 * The summary as the lines the command prints.
 * @param summary - the counts.
 * @returns the lines.
 */
export function summaryLines(summary: Summary): string[] {
  const checks = Object.entries(summary.failsByCheck).map(([check, n]) => `${check} ${String(n)}`).join(', ')
  return [
    `pictures: ${String(summary.pictures)}`,
    `failures: ${String(summary.fail)}${checks === '' ? '' : ` (${checks})`}`,
    `warnings: ${String(summary.warn)}`,
    `missing sections: ${String(summary.missingSections)}`,
  ]
}

/**
 * The report as `report.json` text.
 * @param report - the report.
 * @returns JSON with the summary first, ending in a newline.
 */
export function reportJson(report: Report): string {
  return `${JSON.stringify({ summary: summarise(report), ...report }, null, 2)}\n`
}

/**
 * The report as `audit.md`.
 * @param report - the report.
 * @returns Markdown: the summary, then each check's findings, then the measurements.
 */
export function auditMarkdown(report: Report): string {
  const summary = summarise(report)
  const lines = [`# Audit, pass ${String(report.pass)}`, '', `Build ${report.commit}.`, '', ...summaryLines(summary).map(line => `- ${line}`), '']
  if (report.missingSections.length > 0) lines.push('## Missing sections', '', ...report.missingSections.map(key => `- ${key}`), '')
  const checks = [...new Set(report.findings.map(finding => finding.check))].sort()
  for (const check of checks) {
    lines.push(`## ${check}`, '')
    for (const finding of report.findings.filter(item => item.check === check)) {
      lines.push(`- **${finding.severity}** (${finding.where}): ${finding.message}`)
    }
    lines.push('')
  }
  lines.push('## Measurements', '', '```json', JSON.stringify(report.measurements, null, 2), '```', '')
  return lines.join('\n')
}

/**
 * The picture index.
 * @param pictures - the picture file names.
 * @returns `index.md` text: one line per picture, grouped by page.
 */
export function indexMarkdown(pictures: readonly string[]): string {
  const sorted = [...pictures].sort()
  const lines = ['# Pictures', '', `${String(sorted.length)} pictures. Names read as page, section, width, look and scheme, state.`, '']
  let page = ''
  for (const name of sorted) {
    const current = name.split('__')[0] ?? ''
    if (current !== page) {
      page = current
      lines.push('', `## ${page}`, '')
    }
    lines.push(`- [${name}](${name})`)
  }
  lines.push('')
  return lines.join('\n')
}
