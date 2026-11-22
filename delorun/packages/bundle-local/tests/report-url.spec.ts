/** The report builder: the form's fields, the encoding, and the cut that keeps the link under GitHub's limit. */
import { describe, expect, it } from 'vitest'
import type { ReportDetails } from '../src/client/report-api.ts'
import { buildReport, MAX_REPORT_URL_LENGTH, TRUNCATION_NOTE } from '../src/client/report-url.ts'

const DETAILS: ReportDetails = {
  delorun: '0.1.0-rc.1', dsh: '0.2.2', os: 'Linux 6.6', platform: 'linux x64', excerpt: '2026-11-15T10:00:00.000Z home: failed & "quoted" <b>\nsecond line',
  issueUrl: 'https://github.com/twickas/delorun/issues/new', template: 'bug_report.yml',
}

describe('buildReport', () => {
  it('fills the form\'s version and logs fields and names the template, encoding what needs it', () => {
    const report = buildReport(DETAILS, 'computer')
    const url = new URL(report.url)
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/twickas/delorun/issues/new')
    expect(url.searchParams.get('template')).toBe('bug_report.yml')
    expect(url.searchParams.get('version')).toBe('Delorun 0.1.0-rc.1; DeepSeek Harness 0.2.2; Linux 6.6 (linux x64); studio on computer')
    expect(url.searchParams.get('logs')).toBe(DETAILS.excerpt)
    expect(report.url).not.toContain('<b>')
    expect(report.url).not.toContain('"quoted"')
    expect(report.truncated).toBe(false)
  })

  it('names an approved device as the surface and says unknown for a missing version', () => {
    const { delorun: _delorun, dsh: _dsh, ...bare } = DETAILS
    expect(buildReport(bare, 'approved device').version).toBe('Delorun unknown; DeepSeek Harness unknown; Linux 6.6 (linux x64); studio on approved device')
  })

  it('leaves the logs field out when there are no errors, and the copy says none were recorded', () => {
    const report = buildReport({ ...DETAILS, excerpt: '' }, 'computer')
    expect(new URL(report.url).searchParams.has('logs')).toBe(false)
    expect(report.details).toContain('None recorded.')
  })

  it('cuts the oldest lines of a long excerpt to stay under the limit, says so, and keeps the full text for Copy details', () => {
    const excerpt = Array.from({ length: 400 }, (_, index) => `line ${String(index)} with some words & symbols`).join('\n')
    const report = buildReport({ ...DETAILS, excerpt }, 'computer')
    expect(report.url.length).toBeLessThanOrEqual(MAX_REPORT_URL_LENGTH)
    expect(report.truncated).toBe(true)
    expect(report.logs.startsWith(TRUNCATION_NOTE)).toBe(true)
    expect(report.logs.endsWith('line 399 with some words & symbols')).toBe(true)
    expect(report.logs).not.toContain('line 0 ')
    expect(report.details).toContain('line 0 ')
    expect(report.details).toContain(excerpt)
    expect(new URL(report.url).searchParams.get('logs')).toBe(report.logs)
  })

  it('refuses an issue address that is not a URL', () => {
    expect(() => buildReport({ ...DETAILS, issueUrl: 'not a url' }, 'computer')).toThrow(TypeError)
  })

  it('leaves the recent errors out of the link and the copy when they are not included', () => {
    const report = buildReport(DETAILS, 'computer', false)
    expect(new URL(report.url).searchParams.has('logs')).toBe(false)
    expect(report.details).not.toContain(DETAILS.excerpt)
    expect(report.details).toContain('Left out.')
  })
})
