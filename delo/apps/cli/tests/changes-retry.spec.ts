/**
 * The retry of a start that left a change out: which starts may leave a change out, the words in the terminal, and the
 * background starter's second start. The profile runner and the child processes are replaced here; the whole start is
 * in `changes-left-out.integration.spec.ts`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { activeDirectory, ACTIVE_RECORD_SCHEMA, APPROVED_RECORD_SCHEMA, CHANGE_LOG_SCHEMA, readChangeLog, writeActiveRecord, writeApproved, writeChangeLog, type ChangeEntry, type ChangeId, type ContentVersion } from '@delo/changes'
import type { DeloLogger } from '@delo/logs'
import { CHANGES_RETRY_ENV, CHANGES_STARTER_ENV, retryDetached, retryForeground, SECOND_FAILURE_LINE, startRetry, type DetachedOutcome, type ForegroundRequest } from '../src/changes/retry.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { profileDirectory } from '../src/profile.ts'

const PROFILE = 'default'
const FROM = brandString<ContentVersion>('a'.repeat(64))
const TO = brandString<ContentVersion>('b'.repeat(64))
const ID = brandString<ChangeId>('c0123456789')

let home: string
let printed: string[]
let warnings: string[]
const output = { stdout: (text: string) => void printed.push(text), stderr: (text: string) => void printed.push(text) }
const logger: DeloLogger = { error: () => {}, warn: message => void warnings.push(message), info: () => {}, debug: () => {} }

beforeEach(() => {
  home = join(realpathSync(mkdtempSync(join(tmpdir(), 'delorun-retry-'))), '.delo')
  mkdirSync(home, { mode: 0o700 })
  printed = []
  warnings = []
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(join(home, '..'), { recursive: true, force: true })
})

/** The applied change of `plug` from {@link FROM} to {@link TO}. */
const APPLIED: ChangeEntry = { id: ID, kind: 'plugin-edit', state: 'applied', subject: { plugin: 'plug', source: '/src/plug' }, from: FROM, to: TO, summary: 'plug: changes in /src/plug', createdAt: '2026-11-10T10:00:00.000Z', decidedAt: '2026-11-10T11:00:00.000Z', decidedFrom: 'terminal' }

/**
 * A profile under Changes whose newest change is {@link APPLIED}, written without a start: `plug` is linked to its active
 * directory, approved and active at {@link TO}.
 */
async function profileWithAppliedChange(): Promise<void> {
  const profileDir = profileDirectory(home, PROFILE)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', dependencies: { plug: `link:${activeDirectory(home, PROFILE, 'plug')}` } })}\n`)
  await writeApproved(profileDir, { schema: APPROVED_RECORD_SCHEMA, plugins: { plug: { source: '/src/plug', version: TO, approvedAt: '2026-11-10T11:00:00.000Z' } } })
  await writeActiveRecord(home, PROFILE, { schema: ACTIVE_RECORD_SCHEMA, plugins: { plug: { version: TO, kind: 'approved' } } })
  await writeChangeLog(home, PROFILE, { schema: CHANGE_LOG_SCHEMA, entries: [APPLIED] })
}

/**
 * @param env - the start's environment.
 * @param successor - whether it is an update's successor.
 * @returns the retry part of a start of the fixture's profile.
 */
function retryOf(env: Record<string, string> = {}, successor = false): ReturnType<typeof startRetry> {
  return startRetry({ home, profile: PROFILE, env, successor, output, logger })
}

describe('which start may leave a change out', () => {
  it('a fresh start leaves out the newest change and fails with the words that name it; the second start and a successor do not', async () => {
    await profileWithAppliedChange()
    const first = retryOf()
    expect(first.role).toBe('first')
    const thrown = await first.afterFailure(new Error('SyntaxError in plug')).then(() => undefined, (error: unknown) => error)
    expect(thrown).toBeInstanceOf(CliError)
    expect(thrown).toMatchObject({ exit: EXIT.changeLeftOut, message: `Delo did not start with your latest change to plug (${ID}): SyntaxError in plug.\nIt starts without it now; your files are unchanged.\nTo try it again: delorun changes apply ${ID}. To undo it: delorun changes undo ${ID}.` })
    expect((await readChangeLog(home, PROFILE)).entries).toEqual([expect.objectContaining({ id: ID, state: 'left-out-at-start', decidedFrom: 'start', leftOut: expect.objectContaining({ failure: 'SyntaxError in plug' }) })])
    // Nothing more is left out after that.
    await expect(first.afterFailure('again')).resolves.toBeUndefined()

    await profileWithAppliedChange()
    for (const retry of [retryOf({ [CHANGES_RETRY_ENV]: '1' }), retryOf({}, true)]) {
      expect(retry.role).not.toBe('first')
      await expect(retry.afterFailure(new Error('boom'))).resolves.toBeUndefined()
      await expect(retry.checkRows([{ id: 'plug', name: 'plug', disabled: false, state: 'failed' }])).resolves.toBeUndefined()
    }
    expect((await readChangeLog(home, PROFILE)).entries).toEqual([APPLIED])
  })

  it('refuses a booted Host in which a row of the newest change\'s plugin did not activate, and no other', async () => {
    await profileWithAppliedChange()
    const first = retryOf()
    await expect(first.checkRows([
      { id: 'plug', name: 'plug', disabled: false, state: 'failed' },
      { id: 'plug-extra', name: 'plug/extra', disabled: false, state: 'not-imported' },
      { id: 'plug-off', name: 'plug/off', disabled: true, state: 'not-imported' },
      { id: 'plugin', name: 'plugin', disabled: false, state: 'failed' },
    ])).rejects.toMatchObject({ exit: EXIT.failed, message: 'plug did not load: row plug is failed, row plug-extra is not-imported' })
    await expect(first.checkRows([{ id: 'plug', name: 'plug', disabled: false, state: 'active' }, { id: 'other', name: 'other', disabled: false, state: 'failed' }])).resolves.toBeUndefined()
  })

  it('logs a failure to read or write the records and fails as before', async () => {
    // No profile: the manifest cannot be read.
    const first = retryOf()
    await expect(first.checkRows([{ id: 'plug', name: 'plug', disabled: false, state: 'failed' }])).resolves.toBeUndefined()
    await expect(first.afterFailure(new Error('boom'))).resolves.toBeUndefined()
    expect(warnings).toEqual([
      expect.stringMatching(/^Delo could not read which change it would leave out: .*package\.json/),
      expect.stringMatching(/^Delo could not leave the newest change out after the start failed: /),
    ])
    expect(printed).toEqual([])
  })

  it('prints the safe-mode line only when the second start fails, and takes both markers out of this process\'s environment', () => {
    vi.stubEnv(CHANGES_RETRY_ENV, '1')
    vi.stubEnv(CHANGES_STARTER_ENV, 'detached')
    retryOf().stopped()
    expect(process.env[CHANGES_RETRY_ENV]).toBeUndefined()
    expect(process.env[CHANGES_STARTER_ENV]).toBeUndefined()
    retryOf({}, true).stopped()
    expect(printed).toEqual([])
    retryOf({ [CHANGES_RETRY_ENV]: '1' }).stopped()
    expect(printed).toEqual([`${SECOND_FAILURE_LINE}\n`])
  })
})

describe('the second start in the terminal', () => {
  const request: ForegroundRequest = { profile: PROFILE, open: true, output, env: { HOME: '/home/person' } }

  it('prints the words, escaped, and runs the second start once', async () => {
    const relaunch = vi.fn((_request: ForegroundRequest) => Promise.resolve(undefined))
    const left = new CliError(EXIT.changeLeftOut, 'Delo did not start with your latest change to plug (c0123456789): \u001b[2Jboom.')
    expect(await retryForeground(request, () => Promise.reject(left), relaunch)).toBeUndefined()
    expect(printed).toEqual(['Delo did not start with your latest change to plug (c0123456789): \\u001b[2Jboom.\n'])
    expect(relaunch).toHaveBeenCalledExactlyOnceWith(request)
  })

  it('returns a start\'s result, rethrows any other failure, and leaves the second start to a background starter', async () => {
    const relaunch = vi.fn((_request: ForegroundRequest) => Promise.resolve(EXIT.ok))
    expect(await retryForeground(request, () => Promise.resolve(EXIT.ok), relaunch)).toBe(EXIT.ok)
    const failed = new CliError(EXIT.failed, 'boom')
    await expect(retryForeground(request, () => Promise.reject(failed), relaunch)).rejects.toBe(failed)
    const plain = new Error('boom')
    await expect(retryForeground(request, () => Promise.reject(plain), relaunch)).rejects.toBe(plain)
    const left = new CliError(EXIT.changeLeftOut, 'left out')
    await expect(retryForeground({ ...request, env: { [CHANGES_STARTER_ENV]: 'detached' } }, () => Promise.reject(left), relaunch)).rejects.toBe(left)
    expect(relaunch).not.toHaveBeenCalled()
    expect(printed).toEqual([])
  })
})

describe('the second start in the background', () => {
  /**
   * @param outcomes - each launch's outcome, in order.
   * @returns a launch that answers them and records the variables it was given.
   */
  function launching(...outcomes: DetachedOutcome[]): { readonly launch: (variables: Readonly<Record<string, string>>) => Promise<DetachedOutcome>, readonly seen: Readonly<Record<string, string>>[] } {
    const seen: Readonly<Record<string, string>>[] = []
    return { launch: (variables) => { seen.push(variables); return Promise.resolve(outcomes[seen.length - 1]!) }, seen }
  }

  it('starts once more without the change after the home process left it out, naming it', async () => {
    await writeChangeLog(home, PROFILE, { schema: CHANGE_LOG_SCHEMA, entries: [{ ...APPLIED, state: 'left-out-at-start', decidedFrom: 'start', leftOut: { at: '2026-11-10T12:00:00.000Z', failure: 'boom' } }] })
    const { launch, seen } = launching({ kind: 'exited', code: EXIT.changeLeftOut }, { kind: 'running' })
    expect(await retryDetached({ home, profile: PROFILE, output }, launch)).toBe(EXIT.ok)
    expect(seen).toEqual([{ [CHANGES_STARTER_ENV]: 'detached' }, { [CHANGES_STARTER_ENV]: 'detached', [CHANGES_RETRY_ENV]: '1' }])
    expect(printed.join('')).toBe(`Delo did not start with your latest change to plug (${ID}): boom.\nIt starts without it now; your files are unchanged.\nTo try it again: delorun changes apply ${ID}. To undo it: delorun changes undo ${ID}.\n`)
  })

  it('stops with the safe-mode line when the second start fails too, and does not start a third', async () => {
    const { launch, seen } = launching({ kind: 'exited', code: EXIT.changeLeftOut }, { kind: 'exited', code: EXIT.failed })
    expect(await retryDetached({ home, profile: PROFILE, output }, launch)).toBe(EXIT.failed)
    expect(seen).toHaveLength(2)
    expect(printed).toEqual([`${SECOND_FAILURE_LINE}\n`])
  })

  it('starts once when the home process runs, fails, or does not answer in time', async () => {
    for (const [outcome, exit] of [[{ kind: 'running' }, EXIT.ok], [{ kind: 'exited', code: EXIT.failed }, EXIT.failed], [{ kind: 'exited', code: null }, EXIT.failed], [{ kind: 'timeout' }, EXIT.failed]] as const) {
      const { launch, seen } = launching(outcome)
      expect(await retryDetached({ home, profile: PROFILE, output }, launch)).toBe(exit)
      expect(seen).toHaveLength(1)
    }
    expect(printed).toEqual([])
  })

  it('still starts once more when the change log cannot be read, saying so', async () => {
    mkdirSync(join(home, 'changes', 'profiles', PROFILE), { recursive: true, mode: 0o700 })
    writeFileSync(join(home, 'changes', 'profiles', PROFILE, 'log.json'), 'not json', { mode: 0o600 })
    const { launch, seen } = launching({ kind: 'exited', code: EXIT.changeLeftOut }, { kind: 'running' })
    expect(await retryDetached({ home, profile: PROFILE, output }, launch)).toBe(EXIT.ok)
    expect(seen).toHaveLength(2)
    expect(printed.join('')).toMatch(/^Delo left a change out but could not read which: .*log\.json is not a record Delo wrote: it is not JSON\.\n$/)
  })
})
