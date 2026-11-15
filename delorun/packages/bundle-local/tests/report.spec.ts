/** The report row: its configuration, and the excerpt it reads from the home's log, which passes the log redactor. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSurface } from '@delorun/logs'
import { Config, detailsResponse, EXCERPT_RECORDS, recentErrors, REPORT_DEFAULTS } from '../src/report.ts'
import { apply } from '../src/report.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/**
 * A temporary home whose home-process log holds the given records.
 * @param records - the records, oldest first.
 * @returns the home.
 */
function homeWith(records: readonly object[]): string {
  const home = mkdtempSync(join(tmpdir(), 'delorun-report-'))
  roots.push(home)
  const { dir, file } = resolveSurface({ kind: 'home', home, profile: 'default' })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 })
  return home
}

const record = (level: string, msg: string, extra: object = {}): object => ({
  ts: '2026-11-15T10:00:00.000Z', level, surface: 'home-default', pid: 1, logger: 'app', source: 'delorun', msg, ...extra,
})

describe('the report row\'s configuration', () => {
  it('defaults to the project\'s issue form and its bug template, and accepts another from cordis.yml', () => {
    expect(Config({})).toEqual(REPORT_DEFAULTS)
    expect(Config({ issueUrl: 'https://example.com/issues/new', template: 'other.yml' })).toEqual({ issueUrl: 'https://example.com/issues/new', template: 'other.yml' })
  })

  it('refuses an address that is not https, so the row does not load', () => {
    const ctx = { inject: () => {} } as never
    expect(() => apply(ctx, { issueUrl: 'http://example.com/new', template: 'a.yml' })).toThrow('must start with https://')
    expect(() => apply(ctx, { issueUrl: 'nope', template: 'a.yml' })).toThrow('is not a URL')
  })
})

describe('the excerpt', () => {
  it('holds only error records, the newest few, each through the log redactor', () => {
    const records = [
      record('info', 'started'),
      ...Array.from({ length: EXCERPT_RECORDS + 2 }, (_, index) => record('error', `failure ${String(index)} with Authorization: Bearer abcdefghijklmnop0123456789`)),
      record('warn', 'slow'),
    ]
    const excerpt = recentErrors(homeWith(records), 'default')
    const lines = excerpt.split('\n')
    expect(lines).toHaveLength(EXCERPT_RECORDS)
    expect(lines.at(-1)).toContain(`failure ${String(EXCERPT_RECORDS + 1)}`)
    expect(excerpt).not.toContain('abcdefghijklmnop0123456789')
    expect(excerpt).toContain('[redacted:')
    expect(excerpt).not.toContain('started')
    expect(excerpt).not.toContain('slow')
  })

  it('redacts a secret a stored record still carries', () => {
    const excerpt = recentErrors(homeWith([record('error', 'call failed', { err: { name: 'Error', message: 'token sk-abcdefghijklmnopqrstuvwxyz012345 was refused' } })]), 'default')
    expect(excerpt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  it('is empty for a home with no log, and the route still answers the versions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'delorun-report-'))
    roots.push(home)
    expect(recentErrors(home, 'default')).toBe('')
    const answer = await detailsResponse(Config({}), { home, name: 'default' }).json() as Record<string, unknown>
    expect(answer).toMatchObject({ excerpt: '', issueUrl: REPORT_DEFAULTS.issueUrl, template: REPORT_DEFAULTS.template })
    expect(typeof answer['os']).toBe('string')
    expect(typeof answer['platform']).toBe('string')
  })
})
