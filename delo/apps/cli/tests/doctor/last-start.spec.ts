/**
 * The load-failure lines of `delorun doctor` ([last-start](../../src/doctor/last-start.ts)). The audit text is the
 * one upstream's `auditStartupEntries` writes, produced by calling it over Loader entries that did not activate, and
 * it reaches the home log through `@delo/logs`' own writer and standard-error capture, as a home process records it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { auditStartupEntries } from '@deepseek-ai/dsh-app-boot'
import { LineCapture, Redactor, resolveSurface, SurfaceLog } from '@delo/logs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkLastStart, parseStartupAudit, readLastStart } from '../../src/doctor/last-start.ts'

const PROFILE = 'default'
const FIRST_START = 'a'.repeat(32)
const LAST_START = 'b'.repeat(32)

let base: string
let home: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'doctor-last-start-')))
  home = join(base, '.delo')
  mkdirSync(home, { mode: 0o700 })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A Loader entry as `auditStartupEntries` reads it. */
interface AuditedEntry {
  readonly options: { readonly id: string, readonly name: string }
  readonly fiber?: { readonly state: number, readonly inject: Record<string, unknown>, readonly ctx: { get(name: string): unknown } }
  readonly parent?: { readonly tree: { import(name: string): Promise<unknown> } }
}

/**
 * The warning upstream's startup audit writes for entries that did not activate.
 * @param entries - the entries.
 * @returns the text, ending in a newline.
 */
async function auditText(entries: readonly AuditedEntry[]): Promise<string> {
  // The audit reads only `ctx.loader.entries()`; a context without its constructor carries no other state to set up.
  const ctx: Context = Object.create(Context.prototype)
  Object.defineProperty(ctx, 'loader', { value: { entries: () => entries.values() } })
  let text = ''
  await auditStartupEntries(ctx, 'dsh', (line) => { text += line })
  return text
}

/** An entry whose import failed, with an error that has a stack. */
const IMPORT_FAILED: AuditedEntry = {
  options: { id: 'acme1', name: 'acme-tools' },
  parent: { tree: { import: () => Promise.reject(new Error('Cannot find package \'acme-tools\'')) } },
}

/** An entry waiting for a service no plugin provides. */
const PENDING: AuditedEntry = {
  options: { id: 'acme2', name: '@acme/notes' },
  fiber: { state: 0, inject: { 'acme.store': {} }, ctx: { get: () => undefined } },
}

/**
 * Write a start's standard error to the home log as the home process captures it.
 * @param startId - the start's id.
 * @param text - what the start wrote to standard error.
 * @param at - the time of its records.
 */
function logStart(startId: string, text: string, at: number): void {
  const log = SurfaceLog.open({ location: resolveSurface({ kind: 'home', home, profile: PROFILE }), redactor: new Redactor(), pid: 4242, level: 'info', startId, onFailure: () => {}, now: () => at })
  log.logger('home-process').info('the home process starts')
  const capture = new LineCapture(log, 'stderr', 'warn')
  capture.write(text)
  capture.end()
  log.close()
}

describe('parseStartupAudit', () => {
  it('reads every row of the audit text upstream writes, without the stack lines', async () => {
    const text = await auditText([IMPORT_FAILED, PENDING])
    expect(text.split('\n')[0]).toBe('dsh: warning: 2 entries did not activate')
    expect(text).toContain('    at ')
    expect(parseStartupAudit(text.split('\n'))).toEqual([
      { id: 'acme1', name: 'acme-tools', detail: 'failed to import: Error: Cannot find package \'acme-tools\'' },
      { id: 'acme2', name: '@acme/notes', detail: 'pending (waiting for service: acme.store)' },
    ])
  })

  it('reads the last audit, and none when no audit is among the lines', async () => {
    const lines = [...(await auditText([IMPORT_FAILED])).split('\n'), 'unrelated', ...(await auditText([PENDING])).split('\n')]
    expect(parseStartupAudit(lines)?.map(row => row.id)).toEqual(['acme2'])
    expect(parseStartupAudit(['Error: (x): y', 'unrelated'])).toBeUndefined()
  })

  it('does not read an error line inside a row\'s stack as a row', () => {
    expect(parseStartupAudit(['dsh: warning: 1 entry did not activate', 'Error: (cause): nested', 'acme1 (acme-tools): failed'])).toEqual([{ id: 'acme1', name: 'acme-tools', detail: 'failed' }])
  })
})

describe('checkLastStart', () => {
  it('passes when no start is logged', () => {
    expect(checkLastStart(home, PROFILE)).toEqual([{ name: 'plugins', status: 'pass', message: 'no start of the profile default is logged, so no plugin is known to have failed to load.' }])
  })

  it('fails each row that did not activate at the last start, and not the rows of an earlier start', async () => {
    logStart(FIRST_START, await auditText([PENDING]), Date.parse('2026-11-09T08:00:00Z'))
    logStart(LAST_START, `starting\n${await auditText([IMPORT_FAILED])}`, Date.parse('2026-11-10T12:00:00Z'))
    expect(readLastStart(home, PROFILE)?.startId).toBe(LAST_START)
    expect(checkLastStart(home, PROFILE)).toEqual([{
      name: 'plugin',
      subject: 'acme-tools',
      status: 'fail',
      message: 'did not activate at the last start: failed to import: Error: Cannot find package \'acme-tools\' (row acme1, start at 2026-11-10T12:00:00.000Z)',
    }])
  })

  it('passes when the last start logged no audit, even after an earlier start that did', async () => {
    logStart(FIRST_START, await auditText([PENDING]), Date.parse('2026-11-09T08:00:00Z'))
    logStart(LAST_START, 'starting\n', Date.parse('2026-11-10T12:00:00Z'))
    expect(checkLastStart(home, PROFILE)).toEqual([{ name: 'plugins', status: 'pass', message: 'the last start of the profile default, at 2026-11-10T12:00:00.000Z, logged no plugin row that did not activate.' }])
  })
})
