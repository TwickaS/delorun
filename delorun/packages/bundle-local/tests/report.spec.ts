/** The report row: its configuration, and the excerpt it reads from the home's log, which passes the log redactor. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSurface } from '@delorun/logs'
import { homedir, hostname, userInfo } from 'node:os'
import { apply, Config, detailsResponse, EXCERPT_MESSAGE_CHARS, EXCERPT_RECORDS, recentErrors, REPORT_DEFAULTS, requireGithub, scrub } from '../src/report.ts'

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

  it('refuses an address that is not https on github.com, so the row does not load', () => {
    const ctx = { inject: () => {} } as never
    for (const issueUrl of ['http://github.com/Delo-Run/delorun/issues/new', 'https://example.com/issues/new', 'https://github.com.evil.example/new', 'https://api.github.com/new', 'https://user@evil.example/', 'ftp://github.com/x']) {
      expect(() => apply(ctx, { issueUrl, template: 'a.yml' }), issueUrl).toThrow('must be an https://github.com address')
    }
    expect(() => apply(ctx, { issueUrl: 'nope', template: 'a.yml' })).toThrow('is not a URL')
    expect(() => requireGithub('https://github.com/Other/repo/issues/new')).not.toThrow()
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

describe('the scrub', () => {
  const roots = { delorunHome: '/srv/delorun-data', workingDirectory: '/srv/projects/app' }

  it('masks the Delorun home and the working directory even outside the home directory', () => {
    expect(scrub('open /srv/delorun-data/profiles/x and /srv/projects/app/src/a.ts', roots)).toBe('open <delorun-home>/profiles/x and <workspace>/src/a.ts')
  })

  it('masks the home directory, the user name and the host name', () => {
    const line = scrub(`failed in ${homedir()}/work as ${userInfo().username} on ${hostname()}`, roots)
    expect(line).not.toContain(homedir())
    expect(line).toContain('~/work')
    if (userInfo().username.length >= 3) expect(line).toContain('<user>')
    if (hostname().length >= 3) expect(line).toContain('<host>')
  })

  it('masks other users\' home paths and Tailscale host names', () => {
    expect(scrub('/home/alice/x /Users/bob/y C:\\Users\\carol\\z', roots)).toBe('~/x ~/y ~')
    expect(scrub('reach https://laptop.example.ts.net/studio', roots)).toBe('reach https://<tailnet-host>/studio')
  })

  it('shows each rule through the excerpt a log record produces', () => {
    const home = homeWith([record('error', `cannot read ${homedir()}/project/secret.ts for ${userInfo().username} at box.example.ts.net`)])
    const excerpt = recentErrors(home, 'default', undefined, { delorunHome: home, workingDirectory: '/nowhere-cwd' })
    expect(excerpt).not.toContain(homedir())
    expect(excerpt).not.toContain('box.example')
    expect(excerpt).toContain('~/project/secret.ts')
  })
})

describe('the excerpt\'s limits', () => {
  it('redacts a secret before the cut, so one that straddles the cut is not left half-shown', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    const padding = 'x'.repeat(EXCERPT_MESSAGE_CHARS - 10)
    const excerpt = recentErrors(homeWith([record('error', `${padding} ${secret} tail`)]), 'default')
    expect(excerpt).not.toContain('sk-abcdef')
    expect(excerpt).not.toContain(secret)
  })

  it('reads only the end of a large active file', () => {
    const filler = Array.from({ length: 6000 }, () => record('info', 'x'.repeat(100)))
    const home = homeWith([record('error', 'old failure beyond the read cap'), ...filler, record('error', 'newest failure')])
    const excerpt = recentErrors(home, 'default')
    expect(excerpt).toContain('newest failure')
    expect(excerpt).not.toContain('old failure beyond the read cap')
  })
})
