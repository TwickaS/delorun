/**
 * `delorun update` (`delo/apps/cli/src/update/command.ts`) against a stand-in home process: a small server on the
 * profile's update socket answers `status`, `update.prepare` and `update.apply` with canned lines, so each decision the
 * command makes (what it prints, what it asks, what it sends, how it exits) is observed without a runtime store. Also
 * the report's text, and the terminal prompts with `@clack/prompts` replaced by scripted answers.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReleaseChannel, SemanticVersion, Sha256Hex, UtcTimestamp } from '@delo/contract-release-manifest'
import { UPDATE_REPORT_SCHEMA, type DataCopySize, type InstallationStatus, type ItemVerification, type ReportItem, type ReportVersions, type UpdateReport } from '@delo/contract-update-report'
import { ensureHomeTree, writeNewStartToken } from '@delo/home'
import { updateSocketPath } from '@delo/home-process'
import { CliError, EXIT } from '../../src/exit.ts'
import { reportLines, runUpdate, TERMINAL_PROMPTS, updateCommand, type UpdatePrompts } from '../../src/update/command.ts'

const clack = vi.hoisted(() => ({ cancelled: Symbol('cancelled'), confirm: vi.fn(), select: vi.fn() }))

vi.mock('@clack/prompts', () => ({
  confirm: clack.confirm,
  select: clack.select,
  isCancel: (value: unknown): boolean => value === clack.cancelled,
}))

const PROFILE = 'default'
const MEBIBYTE = 1_048_576
const REPORT_ID = 'a'.repeat(32)
const savedEnvironment = { ...process.env }

const semantic = (text: string): SemanticVersion => brandString<SemanticVersion>(text)
const versions = (delo: string): ReportVersions => ({ delo: semantic(delo), dsh: semantic('0.2.2'), channel: 'stable' as ReleaseChannel })

/**
 * A report from one Delo version to another.
 * @param change - fields to replace.
 * @returns the report.
 */
function report(change: Partial<UpdateReport> = {}): UpdateReport {
  const installations: InstallationStatus[] = [
    { id: 'cli-home', delo: semantic('1.0.0'), dsh: semantic('0.2.2'), state: 'current' },
    { id: 'desktop-host', state: 'unknown' },
  ]
  return {
    schema: UPDATE_REPORT_SCHEMA,
    installation: 'cli-home',
    from: versions('1.0.0'),
    to: versions('1.1.0'),
    release: { manifest: brandString<Sha256Hex>('c'.repeat(64)), signature: 'passed', freshness: 'passed', log: 'passed' },
    generated: brandString<UtcTimestamp>('2026-11-10T00:00:00Z'),
    installations,
    items: [],
    notChecked: [],
    counts: { disabled: 0, removed: 0, changed: 0, unverified: 0, data: 0 },
    ...change,
  }
}

/** A bundle row the update only changes. */
const CHANGED_BUNDLE: ReportItem = { kind: 'bundle', subject: { package: '@delo/bundle-a' }, reason: 'bundle-template-normalised', effect: 'changed', verification: 'verified', detail: {}, actions: [] }

/** A plugin the update disables. */
const DISABLED_PLUGIN: ReportItem = { kind: 'plugin', subject: { name: 'plugin-a', version: semantic('1.0.0') }, reason: 'dsh-requirement-unmet', effect: 'disabled', verification: 'verified', detail: { axis: 'dsh', requirement: '^9.0.0' }, actions: ['keep-disabled'] }

/** A plugin whose manifest Delo could not read. */
const UNVERIFIED_PLUGIN: ReportItem = { kind: 'plugin', subject: { name: 'plugin-b', version: semantic('2.0.0') }, reason: 'manifest-unreadable', effect: 'kept', verification: 'unverified', detail: {}, actions: [] }

/**
 * The chat-data item.
 * @param copy - the size of the copy, when the report states one.
 * @param verification - whether the prediction rests on read facts.
 * @returns the item.
 */
function dataItem(copy?: DataCopySize, verification: ItemVerification = 'verified'): ReportItem {
  return { kind: 'data', subject: { directories: ['sessions', 'storages'] }, reason: verification === 'verified' ? 'data-format-changed' : 'data-format-unknown', effect: 'changed', verification, detail: { differs: ['persistence'], ...copy === undefined ? {} : { copy } }, actions: ['copy-session-data', 'continue-without-copy'] }
}

describe('reportLines', () => {
  it('states the versions, the release checks and both installations, and that no row changes', () => {
    expect(reportLines(report())).toEqual([
      'Update from Delo 1.0.0 (DSH 0.2.2) to Delo 1.1.0 (DSH 0.2.2) on the stable channel.',
      'Release checks: signature passed, freshness passed, log passed.',
      'Installations: cli-home 1.0.0 current; desktop-host unknown.',
      'No plugin, bundle or profile row changes.',
    ])
  })

  it('lists each change with its effect and reason, and marks an item Delo cannot predict', () => {
    const lines = reportLines(report({ items: [CHANGED_BUNDLE, DISABLED_PLUGIN, UNVERIFIED_PLUGIN] }))

    expect(lines.slice(3)).toEqual([
      'Changes (3):',
      '  - changed: The bundle list matches an installation-owned list that DSH 0.2.2 replaces with its template.',
      '  - disabled: plugin-a requires DSH ^9.0.0; Delo 1.1.0 runs DSH 0.2.2.',
      '  - kept: Delo could not read plugin-b\'s package.json; it cannot predict what the update does to it. Delo cannot predict this item.',
    ])
  })

  it('describes the chat data apart from the changes, with the size of the copy and what declining costs', () => {
    const lines = reportLines(report({ items: [dataItem({ files: 12, bytes: 3 * MEBIBYTE, free: 512 * MEBIBYTE })] }))

    expect(lines.slice(3)).toEqual([
      'No plugin, bundle or profile row changes.',
      'Chat data: Delo 1.1.0 keeps chat data in a format Delo 1.0.0 may not read.',
      '  A copy holds 12 file(s), 3.0 MiB; 512.0 MiB is free.',
      '  Without the copy, Delo cannot go back to 1.0.0 after 1.1.0 first starts.',
    ])
  })

  it('names the revocation list when the report did not read one, and nothing when it read every source', () => {
    const lines = reportLines(report({ notChecked: ['revocations'] }))

    expect(lines).toContain('Not checked: revocations. This release publishes no revocation list; the health check after the switch holds what one would show.')
    expect(reportLines(report()).filter(line => line.startsWith('Not checked'))).toEqual([])
  })

  it('omits the size line when the report states no copy, and marks unverified chat data', () => {
    const lines = reportLines(report({ items: [dataItem(undefined, 'unverified')] }))

    expect(lines.slice(4)).toEqual([
      'Chat data: Delo cannot tell whether Delo 1.0.0 reads the chat data Delo 1.1.0 writes. Delo cannot predict this item.',
      '  Without the copy, Delo cannot go back to 1.0.0 after 1.1.0 first starts.',
    ])
  })
})

describe('runUpdate', () => {
  let base: string
  let home: string
  let osHome: string
  let server: Server | undefined
  let requests: { readonly op: string, readonly args?: Record<string, unknown> }[]
  let output: { stdout: string, stderr: string }

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'dcu-')))
    osHome = join(base, 'o')
    home = join(base, 'h')
    await ensureHomeTree(home, PROFILE)
    requests = []
    output = { stdout: '', stderr: '' }
  })

  afterEach(async () => {
    if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
    server = undefined
    rmSync(base, { recursive: true, force: true })
  })

  afterAll(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key]
    Object.assign(process.env, savedEnvironment)
  })

  /**
   * Start a stand-in home process that answers `status` with one line and the other requests with the given lines.
   * @param answers - the lines each operation sends back, in order.
   */
  async function homeAnswering(answers: { readonly prepare?: readonly object[], readonly apply?: readonly object[] }): Promise<void> {
    await writeNewStartToken(home, PROFILE)
    server = createServer((socket) => {
      let buffered = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffered += chunk
        const newline = buffered.indexOf('\n')
        if (newline === -1) return
        const request = JSON.parse(buffered.slice(0, newline)) as { op: string, args?: Record<string, unknown> }
        requests.push(request)
        const lines = request.op === 'status' ? [{ ok: true, status: {} }] : request.op === 'update.prepare' ? answers.prepare ?? [] : answers.apply ?? []
        socket.end(lines.map(line => `${JSON.stringify(line)}\n`).join(''))
      })
    })
    await new Promise<void>((resolve) => { server?.listen(updateSocketPath(home, PROFILE), resolve) })
  }

  /** @returns the `update.prepare` answer for a report. */
  const prepared = (update: UpdateReport): readonly object[] => [{ ok: true, phase: 'fetching' }, { ok: true, note: 'a progress line with no phase' }, { ok: true, report: update, reportId: REPORT_ID }]

  /** @returns the requests of one operation. */
  const sent = (op: string): readonly { readonly args?: Record<string, unknown> }[] => requests.filter(request => request.op === op)

  /**
   * Run `delorun update` against the temporary home.
   * @param args - the arguments after `update`.
   * @param prompts - the person's answers.
   * @returns the exit code.
   */
  async function update(args: readonly string[], prompts: Partial<UpdatePrompts> = {}): Promise<number | undefined> {
    const context = { env: { ...process.env, HOME: osHome, USERPROFILE: osHome, DELO_HOME: home }, stdout: (text: string) => { output.stdout += text }, stderr: (text: string) => { output.stderr += text } }
    const answers: UpdatePrompts = { confirm: async () => Promise.reject(new Error('the command asked to confirm')), copy: async () => Promise.reject(new Error('the command asked about the copy')), ...prompts }
    return runUpdate(args, context, answers)
  }

  it('exits 3 and says to run delorun start when no home process answers', async () => {
    expect(await update([])).toBe(EXIT.notRunning)
    expect(output.stderr).toBe(`delorun update: Delo is not running for the profile ${PROFILE}; run delorun start, then delorun update.\n`)
    expect(output.stdout).toBe('')
  })

  it('exits 3 through the registered command too, which asks on the terminal', async () => {
    const context = { env: { ...process.env, HOME: osHome, USERPROFILE: osHome, DELO_HOME: home }, stdout: () => {}, stderr: () => {} }

    expect(updateCommand.name).toBe('update')
    expect(await updateCommand.run([], context)).toBe(EXIT.notRunning)
  })

  it('refuses before it asks the home process for anything when git cannot run, which the profile history needs', async () => {
    await homeAnswering({ prepare: prepared(report()) })
    const path = process.env.PATH
    process.env.PATH = mkdtempSync(join(tmpdir(), 'delo-no-git-'))
    try {
      await expect(update([])).rejects.toMatchObject({
        exit: EXIT.failed,
        message: 'delorun update: Delo saves the profile\'s history with git before it updates, so it can go back, and git cannot run here: no git command is on PATH. Install git, then run delorun update again. Nothing was fetched or changed.',
      })
    } finally {
      rmSync(process.env.PATH, { recursive: true, force: true })
      process.env.PATH = path
    }
    expect(sent('update.prepare')).toHaveLength(0)
  })

  it('reports a usage error for an option it does not take', async () => {
    await expect(update(['--force'])).rejects.toMatchObject({ exit: EXIT.usage })
  })

  it('says the newest release is running, and applies nothing, when the target is the running version', async () => {
    await homeAnswering({ prepare: prepared(report({ to: versions('1.0.0') })) })

    expect(await update(['--yes'])).toBe(EXIT.ok)

    expect(output.stdout).toBe('… fetching\nDelo 1.0.0 is the newest release on the stable channel.\n')
    expect(sent('update.apply')).toHaveLength(0)
  })

  it('an update to a lower version is refused: a report whose target is lower than the running version applies nothing, even with --yes', async () => {
    await homeAnswering({ prepare: prepared(report({ to: versions('0.9.0') })) })

    await expect(update(['--yes'])).rejects.toMatchObject({ exit: EXIT.failed, message: expect.stringContaining('an update never goes to a lower version') })

    expect(output.stdout).not.toContain('Update from Delo')
    expect(sent('update.apply')).toHaveLength(0)
  })

  it('prints the report and the phases it passed through, and changes nothing, when the person declines', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [CHANGED_BUNDLE] })) })

    expect(await update([], { confirm: async () => Promise.resolve(false) })).toBe(EXIT.ok)

    expect(output.stdout).toContain('… fetching\n')
    expect(output.stdout).toContain('Update from Delo 1.0.0 (DSH 0.2.2) to Delo 1.1.0 (DSH 0.2.2) on the stable channel.\n')
    expect(output.stdout).toContain('Changes (1):\n')
    expect(sent('update.apply')).toHaveLength(0)
  })

  it('update-report-applies-nothing: --report prints the report and applies nothing, without asking', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [DISABLED_PLUGIN] })) })

    expect(await update(['--report'], { confirm: async () => Promise.reject(new Error('asked')) })).toBe(EXIT.ok)

    expect(output.stdout).toContain('Update from Delo 1.0.0 (DSH 0.2.2) to Delo 1.1.0 (DSH 0.2.2) on the stable channel.\n')
    expect(output.stdout.endsWith('Nothing changed. Run delorun update to apply it.\n')).toBe(true)
    expect(sent('update.apply')).toHaveLength(0)
  })

  it('refuses --report with --check, --yes or a copy option as a usage error', async () => {
    await homeAnswering({ prepare: prepared(report()) })

    await expect(update(['--report', '--check'])).rejects.toMatchObject({ exit: EXIT.usage, message: 'delorun update: choose --check or --report, not both' })
    for (const option of ['--yes', '--data-copy', '--no-data-copy']) {
      await expect(update(['--report', option])).rejects.toMatchObject({ exit: EXIT.usage, message: 'delorun update: --report applies nothing, so it takes no --yes, --data-copy or --no-data-copy' })
    }
    expect(sent('update.prepare')).toHaveLength(0)
  })

  it('refuses --data-copy together with --no-data-copy as a usage error, before applying anything', async () => {
    await homeAnswering({ prepare: prepared(report()) })

    const failure = await update(['--data-copy', '--no-data-copy']).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CliError)
    expect(failure).toMatchObject({ exit: EXIT.usage, message: 'delorun update: choose --data-copy or --no-data-copy, not both' })
    expect(sent('update.apply')).toHaveLength(0)
  })

  it('refuses --yes when the report disables or removes something, naming how to decide', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [DISABLED_PLUGIN] })) })

    const failure = await update(['--yes']).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CliError)
    expect(failure).toMatchObject({ exit: EXIT.failed })
    expect((failure as CliError).message).toContain('so --yes does not confirm it; run delorun update without --yes to decide')
    expect(sent('update.apply')).toHaveLength(0)
  })

  it('refuses --yes when the report holds an item Delo cannot predict', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [UNVERIFIED_PLUGIN] })) })

    await expect(update(['--yes'])).rejects.toMatchObject({ exit: EXIT.failed })
    expect(sent('update.apply')).toHaveLength(0)
  })

  it('asks before applying, and prints that nothing changed when the person declines', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [DISABLED_PLUGIN] })) })
    const confirm = vi.fn(async (_message: string) => Promise.resolve(false))

    expect(await update([], { confirm })).toBe(EXIT.ok)

    expect(confirm).toHaveBeenCalledWith('Apply the update to Delo 1.1.0?')
    expect(output.stdout.endsWith('Nothing changed.\n')).toBe(true)
    expect(sent('update.apply')).toHaveLength(0)
  })

  it('applies a confirmed report that holds no chat data without a copy and without asking about one', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [DISABLED_PLUGIN] })), apply: [{ ok: true, phase: 'draining' }, { ok: true, outcome: 'committed' }] })

    expect(await update([], { confirm: async () => Promise.resolve(true) })).toBe(EXIT.ok)

    expect(sent('update.apply')[0]?.args).toEqual({ reportId: REPORT_ID, wait: 'drain', dataCopy: false })
    expect(output.stdout).toContain('… draining\n')
    expect(output.stdout.endsWith('Delo 1.1.0 runs now.\n')).toBe(true)
  })

  it('takes the copy the person chooses, and says where the chat data from before is copied', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [dataItem({ files: 2, bytes: MEBIBYTE, free: 8 * MEBIBYTE })] })), apply: [{ ok: true, outcome: 'committed' }] })
    const copy = vi.fn(async (_note: string) => Promise.resolve(true))

    expect(await update([], { confirm: async () => Promise.resolve(true), copy })).toBe(EXIT.ok)

    expect(copy).toHaveBeenCalledWith('Without the copy, Delo cannot go back to 1.0.0 after 1.1.0 first starts.')
    expect(sent('update.apply')[0]?.args).toEqual({ reportId: REPORT_ID, wait: 'drain', dataCopy: true })
    expect(output.stdout.endsWith('Delo 1.1.0 runs now. The chat data from before is copied in data-copies/1.1.0.\n')).toBe(true)
  })

  it('continues without the copy, and says what that costs, when the person declines it', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [dataItem({ files: 2, bytes: MEBIBYTE, free: 8 * MEBIBYTE })] })), apply: [{ ok: true, outcome: 'committed' }] })

    expect(await update([], { confirm: async () => Promise.resolve(true), copy: async () => Promise.resolve(false) })).toBe(EXIT.ok)

    expect(sent('update.apply')[0]?.args).toEqual({ reportId: REPORT_ID, wait: 'drain', dataCopy: false })
    expect(output.stdout).toContain('Continuing without the copy. Without the copy, Delo cannot go back to 1.0.0 after 1.1.0 first starts.\n')
    expect(output.stdout.endsWith('Delo 1.1.0 runs now.\n')).toBe(true)
  })

  it('takes the copy with --yes when the chat data differs, and declines it with --no-data-copy', async () => {
    const item = dataItem({ files: 2, bytes: MEBIBYTE, free: 8 * MEBIBYTE })
    await homeAnswering({ prepare: prepared(report({ items: [item] })), apply: [{ ok: true, outcome: 'committed' }] })

    expect(await update(['--yes'])).toBe(EXIT.ok)
    expect(await update(['--yes', '--no-data-copy'])).toBe(EXIT.ok)

    expect(sent('update.apply').map(request => request.args?.['dataCopy'])).toEqual([true, false])
  })

  it('takes a copy on request with --data-copy and never asks about it', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [dataItem({ files: 2, bytes: MEBIBYTE, free: 8 * MEBIBYTE })] })), apply: [{ ok: true, outcome: 'committed' }] })

    expect(await update(['--data-copy'], { confirm: async () => Promise.resolve(true) })).toBe(EXIT.ok)

    expect(sent('update.apply')[0]?.args?.['dataCopy']).toBe(true)
  })

  it('says --no-data-copy needs no notice when the report holds no chat data', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [CHANGED_BUNDLE] })), apply: [{ ok: true, outcome: 'committed' }] })

    expect(await update(['--yes', '--no-data-copy'])).toBe(EXIT.ok)

    expect(output.stdout).not.toContain('Continuing without the copy')
  })

  it('refuses a copy that does not fit before applying, naming the sizes and the way out', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [dataItem({ files: 9, bytes: 3 * MEBIBYTE, free: MEBIBYTE })] })) })

    const failure = await update(['--yes']).catch((error: unknown) => error)

    expect(failure).toMatchObject({ exit: EXIT.failed, message: 'delorun update: DATA_COPY_NO_SPACE: the copy needs 3.0 MiB and 1.0 MiB is free; free space, or run delorun update --no-data-copy' })
    expect(sent('update.apply')).toHaveLength(0)
  })

  it('applies without the copy when it does not fit but the person asks for none', async () => {
    await homeAnswering({ prepare: prepared(report({ items: [dataItem({ files: 9, bytes: 3 * MEBIBYTE, free: MEBIBYTE })] })), apply: [{ ok: true, outcome: 'committed' }] })

    expect(await update(['--yes', '--no-data-copy'])).toBe(EXIT.ok)
  })

  it('exits 1 and names the reason when the new release failed its health check and the old one runs again', async () => {
    await homeAnswering({ prepare: prepared(report()), apply: [{ ok: true, outcome: 'rolled-back', reason: 'H2-host-ready' }] })

    expect(await update(['--yes'])).toBe(EXIT.failed)

    expect(output.stderr).toBe('delorun update: Delo 1.1.0 failed its health check (H2-host-ready); Delo 1.0.0 runs again with the profile from before. See delorun logs.\n')
  })

  it('names the health criterion the new release failed, when the rollback reports one', async () => {
    await homeAnswering({ prepare: prepared(report()), apply: [{ ok: true, outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED', criterion: 'H2-host-ready' }] })

    expect(await update(['--yes'])).toBe(EXIT.failed)

    expect(output.stderr).toContain('Delo 1.1.0 failed its health check (H2-host-ready); Delo 1.0.0 runs again')
  })

  it('exits 1 with "no reason" when a rollback reports none', async () => {
    await homeAnswering({ prepare: prepared(report()), apply: [{ ok: true, outcome: 'rolled-back' }] })

    expect(await update(['--yes'])).toBe(EXIT.failed)

    expect(output.stderr).toContain('failed its health check (no reason)')
  })

  it('exits 1 and points at the recovery commands when going back needed a copy that was not taken', async () => {
    await homeAnswering({ prepare: prepared(report()), apply: [{ ok: true, outcome: 'failed' }] })

    expect(await update(['--yes'])).toBe(EXIT.failed)

    expect(output.stderr).toBe('delorun update: Delo 1.1.0 failed its health check, and going back needs the chat-data copy that was not taken. Run delorun recover rollback --profile-only, or delorun recover safe-mode.\n')
  })

  it('exits 1 and says nothing changed when the update was aborted, with the reason when there is one', async () => {
    await homeAnswering({ prepare: prepared(report()), apply: [{ ok: true, outcome: 'aborted', reason: 'chats are running' }] })
    expect(await update(['--yes'])).toBe(EXIT.failed)
    expect(output.stderr).toBe('delorun update: the update ended aborted (chats are running); nothing changed.\n')
  })

  it('exits 1 without a reason when an unknown outcome carries none', async () => {
    await homeAnswering({ prepare: prepared(report()), apply: [{ ok: true, outcome: 'cancelled' }] })

    expect(await update(['--yes'])).toBe(EXIT.failed)

    expect(output.stderr).toBe('delorun update: the update ended cancelled; nothing changed.\n')
  })

  it('reports the home process\'s refusal of the report, with its detail when it gives one', async () => {
    await homeAnswering({ prepare: [{ ok: false, error: 'UPDATE_PENDING', detail: 'an update is already running' }] })

    const failure = await update([]).catch((error: unknown) => error)

    expect(failure).toMatchObject({ exit: EXIT.failed, message: 'delorun update: the home process refused to prepare the update: UPDATE_PENDING\nan update is already running' })
  })

  it('reports a refusal without a detail by its code alone', async () => {
    await homeAnswering({ prepare: [{ ok: false, error: 'SCHEMA_VIOLATION' }] })
    await expect(update([])).rejects.toMatchObject({ message: 'delorun update: the home process refused to prepare the update: SCHEMA_VIOLATION' })
  })

  it('reports an answer with no lines as no answer, and says nothing was applied', async () => {
    await homeAnswering({ prepare: [] })

    await expect(update([])).rejects.toMatchObject({ exit: EXIT.failed, message: 'delorun update: the home process ended the request to prepare the update without an answer. Nothing was applied. Its log records why: delorun logs home' })
  })

  it('takes no progress line for the final answer of a prepare that ended without one', async () => {
    await homeAnswering({ prepare: [{ ok: true, phase: 'checking' }, { ok: true, phase: 'reporting' }] })

    await expect(update([])).rejects.toMatchObject({ exit: EXIT.failed, message: 'delorun update: the home process ended the request to prepare the update without an answer. Nothing was applied. Its log records why: delorun logs home' })
  })

  it('says the outcome is unknown when an apply ends after its progress lines', async () => {
    await homeAnswering({ prepare: prepared(report()), apply: [{ ok: true, phase: 'switching' }] })

    await expect(update(['--yes'])).rejects.toMatchObject({ exit: EXIT.failed, message: 'delorun update: the home process ended the request to apply the update without an answer. Whether the update applied is unknown; delorun status shows which version runs. Its log records why: delorun logs home' })
  })

  it('shows a VERIFY_FAILED refusal\'s whole explanation, remedies included', async () => {
    await homeAnswering({ prepare: [{ ok: true, phase: 'checking' }, { ok: false, error: 'VERIFY_FAILED', detail: 'Delo refused release x, which did not verify: y. Nothing was installed.\n  Run the same command again.' }] })

    await expect(update([])).rejects.toMatchObject({ message: 'delorun update: the home process refused to prepare the update: VERIFY_FAILED\nDelo refused release x, which did not verify: y. Nothing was installed.\n  Run the same command again.' })
  })

  it('reports the home process\'s refusal to apply', async () => {
    await homeAnswering({ prepare: prepared(report()), apply: [{ ok: false, error: 'REPORT_STALE', detail: 'the release changed' }] })

    await expect(update(['--yes'])).rejects.toMatchObject({ message: 'delorun update: the home process refused to apply the update: REPORT_STALE\nthe release changed' })
  })
})

describe('TERMINAL_PROMPTS', () => {
  const stdin = process.stdin as { isTTY?: boolean }
  const original = Object.getOwnPropertyDescriptor(stdin, 'isTTY')

  /**
   * Make the process's standard input a terminal, or not.
   * @param value - whether it is one.
   */
  function terminal(value: boolean): void {
    Object.defineProperty(stdin, 'isTTY', { value, configurable: true })
  }

  afterEach(() => {
    if (original === undefined) delete stdin.isTTY
    else Object.defineProperty(stdin, 'isTTY', original)
    clack.confirm.mockReset()
    clack.select.mockReset()
  })

  it('confirms nothing, and takes the copy, when no terminal can ask', async () => {
    terminal(false)

    expect(await TERMINAL_PROMPTS.confirm('Apply?')).toBe(false)
    expect(await TERMINAL_PROMPTS.copy('costs')).toBe(true)
    expect(clack.confirm).not.toHaveBeenCalled()
    expect(clack.select).not.toHaveBeenCalled()
  })

  it('confirms with the person\'s answer, defaulting to no, and treats a cancelled question as no', async () => {
    terminal(true)

    clack.confirm.mockResolvedValueOnce(true)
    expect(await TERMINAL_PROMPTS.confirm('Apply?')).toBe(true)
    expect(clack.confirm).toHaveBeenCalledWith({ message: 'Apply?', initialValue: false })

    clack.confirm.mockResolvedValueOnce(false)
    expect(await TERMINAL_PROMPTS.confirm('Apply?')).toBe(false)

    clack.confirm.mockResolvedValueOnce(clack.cancelled)
    expect(await TERMINAL_PROMPTS.confirm('Apply?')).toBe(false)
  })

  it('offers the copy first, with what declining costs on the other choice, and takes it when the question is cancelled', async () => {
    terminal(true)

    clack.select.mockResolvedValueOnce(false)
    expect(await TERMINAL_PROMPTS.copy('Without the copy, no way back.')).toBe(false)
    expect(clack.select).toHaveBeenCalledWith(expect.objectContaining({
      options: [{ value: true, label: 'Copy the chat data (recommended)' }, { value: false, label: 'Continue without the copy', hint: 'Without the copy, no way back.' }],
      initialValue: true,
    }))

    clack.select.mockResolvedValueOnce(true)
    expect(await TERMINAL_PROMPTS.copy('costs')).toBe(true)

    clack.select.mockResolvedValueOnce(clack.cancelled)
    expect(await TERMINAL_PROMPTS.copy('costs')).toBe(true)
  })
})
