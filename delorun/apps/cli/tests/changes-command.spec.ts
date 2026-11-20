/**
 * `delorun changes` (contract C21, "Commands"): listing and showing what waits for review, the confirmations before
 * apply, discard, undo, off, on and a new protection setting, the refusal of every change without a terminal, the
 * running Host's reload through the update channel, and the home lock while Delorun does not run. The home has protection
 * on, so changes wait for review; `with protection off` covers a home without a protection record, where a start loads
 * a changed folder without review.
 */
import { readableTime } from '../src/output.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { activeDirectory, addProtectionNotice, attestTerminal, readNotices, enforceApprovedContent, listChanges, readApproved, readChangeLog, readWorkSession, recordPluginRequest, readProtection, setProtection, writeChangeLog, type ChangeId, type ChangesContext, type ContentVersion, type ReloadHost, type ReloadOutcome } from '@delorun/changes'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { ensureHomeTree, newStartId, readHomeLock, runDirectory } from '@delorun/home'
import { CountingChatGate, HomeProcess, sendHomeRequest, updateChannelProbe, type RunningHost } from '@delorun/home-process'
import { Redactor, type DelorunLogger } from '@delorun/logs'
import { NOT_AT_TERMINAL, pageLinesOf, reloadThroughChannel, runChanges, withProfileHost, type ChangesCommandDependencies } from '../src/changes/command.ts'
import { startChanges } from '../src/changes/start.ts'
import type { CommandContext } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'
import { statusCommand } from '../src/status.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const PROFILE = 'default'
const SILENT: DelorunLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
const OK: ReloadOutcome = { ok: true }
const TERMINAL = { stdin: { isTTY: true }, stdout: { isTTY: true } }
/** What `delorun changes protection` says protection on means. */
const ON_MEANING = "a changed plugin, an edit of Delorun itself and the agent's plugin installs and removals load only after you apply them, and the agent asks before it first changes an approved plugin in a chat"
/** What `delorun changes protection` says protection off means. */
const OFF_MEANING = 'changes load without your review and are still recorded: a changed plugin loads at the next start and when you save while Delorun runs, edits of Delorun itself apply at the next start, and the agent installs, removes, turns on, configures, undoes and restores plugins with the full-access approval alone; see and undo each with delorun changes list'

let base: string
let home: string
let profileDir: string
let source: string
let context: CommandContext & { readonly printed: string[], readonly errors: string[] }

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-changes-command-')))
  home = join(base, '.delorun')
  vi.stubEnv('HOME', base)
  vi.stubEnv('USERPROFILE', base)
  // prepareHome sets these on the process; stubbing them first restores them afterwards.
  vi.stubEnv('DSH_HOME', join(base, '.dsh'))
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
  const printed: string[] = []
  const errors: string[] = []
  context = { env: { HOME: base, DSH_HOME: join(base, '.dsh'), DELORUN_HOME: home }, stdout: text => void printed.push(text), stderr: text => void errors.push(text), printed, errors }
  source = join(base, 'plug')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), '{"name":"plug","version":"1.0.0","dependencies":{"dep":"1.0.0"}}\n')
  writeFileSync(join(source, 'index.js'), 'export default 1\n')
  profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(home, { mode: 0o700 })
  await ensureHomeTree(home, PROFILE)
  await setProtection(home, 'on', attestTerminal(TERMINAL))
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${PROFILE}`, private: true, dependencies: { plug: `link:${source}`, 'left-pad': '^1.3.0' }, dsh: { profile: { bundles: ['plug'] } } }, undefined, 2)}\n`)
  symlinkSync(relative(join(profileDir, 'node_modules'), source), join(profileDir, 'node_modules', 'plug'))
  await enforceApprovedContent({ home, profile: PROFILE, profileDir })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

/** What a spec's terminal and Host did. */
interface Driven extends ChangesCommandDependencies {
  /** The questions asked, in order. */
  readonly questions: string[]
  /** How often the Host was reloaded. */
  readonly reloads: () => number
  /** How often the command ran a change with the Host. */
  readonly hosted: () => number
  /** The plugin operations an applied plugin request ran, by their arguments. */
  readonly operations: (readonly string[])[]
}

/**
 * A terminal that answers the questions in order, and a Host that answers the reloads in order.
 * @param answers - the answers to the questions.
 * @param outcomes - the Host's answers; undefined for Delorun not running.
 * @param tty - whether standard input and output are terminals.
 * @returns the dependencies.
 */
function driven(answers: readonly string[], outcomes: readonly (ReloadOutcome | undefined)[] = [OK], tty = true, operationExit = 0): Driven {
  const queue = [...answers]
  const results = [...outcomes]
  const questions: string[] = []
  const operations: (readonly string[])[] = []
  let reloads = 0
  let hosted = 0
  const reload: ReloadHost = async () => {
    reloads += 1
    return Promise.resolve(results.shift())
  }
  return {
    streams: { stdin: { isTTY: tty }, stdout: { isTTY: tty } },
    ask: async (question) => {
      questions.push(question)
      return Promise.resolve(queue.shift() ?? '')
    },
    withHost: async (_home, _profile, run) => {
      hosted += 1
      return run(reload)
    },
    harness: () => undefined,
    pluginOperation: () => async (args) => {
      operations.push(args)
      return Promise.resolve({ exitCode: operationExit, logPath: '/logs/operation.log' })
    },
    questions,
    reloads: () => reloads,
    hosted: () => hosted,
    operations,
  }
}

/** @returns the context the library calls run with. */
function ctx(): ChangesContext {
  return { home, profile: PROFILE, profileDir }
}

/**
 * Edit the plugin's folder.
 * @param body - the new text of its `index.js`.
 */
function edit(body: string): void {
  writeFileSync(join(source, 'index.js'), body)
}

/** @returns the id of the only change waiting for review. */
async function pendingId(): Promise<string> {
  const { pending } = await listChanges(ctx())
  expect(pending).toHaveLength(1)
  return pending[0]!.id
}

/** @returns everything a change could write: the profile's manifest and the change log. */
function written(): string {
  const log = join(home, 'changes', 'profiles', PROFILE, 'log.json')
  return readFileSync(join(profileDir, 'package.json'), 'utf8') + (existsSync(log) ? readFileSync(log, 'utf8') : '')
}

/** @returns everything printed to standard output. */
function out(): string {
  return context.printed.join('')
}

/** @returns everything printed to standard error. */
function err(): string {
  return context.errors.join('')
}

describe('delorun changes list and show', () => {
  it('lists what waits for review first, then the recent changes, the protection setting and a work session', async () => {
    expect(await runChanges([], context, driven([]))).toBe(EXIT.ok)
    expect(out()).toContain('Nothing waits for your review.')
    expect(out()).toContain('Recent changes, newest first:')
    expect(out()).toContain('\nProtection: on: a changed plugin, an edit of Delorun itself')
    edit('export default 2\n')
    context.printed.length = 0
    expect(await runChanges(['list'], context, driven([]))).toBe(EXIT.ok)
    const id = await pendingId()
    expect(out()).toMatch(new RegExp(`^Waiting for review:\\n  ${id}  plug from ${source} \\(1 changed file\\)\\nSee one with: delorun changes show <id>\\n`))
    expect(out()).not.toContain('Working on')
    context.printed.length = 0
    expect(await runChanges(['list', '--json'], context, driven([]))).toBe(EXIT.ok)
    expect(JSON.parse(out())).toMatchObject({ protection: 'on', pending: [{ id }] })
  })

  it('lists the protection changes a phone made, and a list at a terminal dismisses them', async () => {
    await addProtectionNotice(home, 'off', { id: 'device-1', label: 'Pixel' }, '2026-11-17T10:00:00.000Z')
    expect(await runChanges(['list'], context, driven([], [], false))).toBe(EXIT.ok)
    expect(out()).toContain(`Changed from a phone:\n  ${readableTime('2026-11-17T10:00:00.000Z')}  Pixel turned protection off\n`)
    // A list piped elsewhere keeps them; one at a terminal has shown them to the person.
    expect(await readNotices(home)).toHaveLength(1)
    expect(await runChanges(['list'], context, driven([]))).toBe(EXIT.ok)
    expect(await readNotices(home)).toEqual([])
  })

  it('names a new plugin, two changed files, a failed apply, a gone folder and a work session in the list', async () => {
    edit('export default 2\n')
    writeFileSync(join(source, 'extra.js'), 'export {}\n')
    const id = await pendingId()
    await runChanges(['apply', id], context, driven(['y'], [{ ok: false, error: 'boom' }, OK]))
    context.printed.length = 0
    await runChanges(['list'], context, driven([]))
    expect(out()).toContain(`(2 changed files)\n    It failed to load when applied: boom`)
    const { openWorkSession } = await import('@delorun/changes')
    const approved = (JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { delorun: { changes: { plugins: { plug: { version: string } } } } }).delorun.changes.plugins.plug.version
    await openWorkSession(home, PROFILE, { plugin: 'plug', source, from: brandString<ContentVersion>(approved), minutes: 60 }, attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
    const other = join(base, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'package.json'), '{"name":"other"}\n')
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies.other = `link:${other}`
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    await enforceApprovedContent({ home, profile: PROFILE, profileDir })
    rmSync(source, { recursive: true })
    context.printed.length = 0
    await runChanges(['list'], context, driven([]))
    expect(out()).toContain(`other from ${other} (new plugin)`)
    expect(out()).toContain(`The folder of plug, ${source}, is gone; its approved copy still runs.`)
    expect(out()).toMatch(/Working on plug since .*: edits in its folder load live\./)
  })

  it('shows the plugin, folder, files with dependency files grouped, risk lines and with --diff the diff', async () => {
    edit('export default 2\nfetch("https://example.invalid/")\n')
    mkdirSync(join(source, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(source, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    const id = await pendingId()
    expect(await runChanges(['show', id], context, driven([]))).toBe(EXIT.ok)
    expect(out()).toContain(`Change ${id}: changes to a plugin, waiting for your review\nPlugin: plug\nFolder: ${source}\nFiles:\n  modified  index.js\nDependency files (1):\n  added     node_modules/dep/index.js\n`)
    expect(out()).toContain('Opens network connections (index.js:2)')
    expect(out()).not.toContain('@@')
    context.printed.length = 0
    expect(await runChanges(['show', id, '--diff'], context, driven([]))).toBe(EXIT.ok)
    expect(out()).toContain('+fetch("https://example.invalid/")')
    expect(out()).not.toContain('cut short')
    context.printed.length = 0
    expect(await runChanges(['show', id, '--json'], context, driven([]))).toBe(EXIT.ok)
    expect(JSON.parse(out())).toMatchObject({ kind: 'pending', change: { id } })
  })

  it('says when the diff was cut short, names skipped entries, and shows a logged change', async () => {
    edit(`export default 2\n${'x'.repeat(300_000)}\n`)
    writeFileSync(join(source, 'z.js'), 'export {}\n')
    symlinkSync(join(base, 'nowhere'), join(source, 'dangling'))
    const id = await pendingId()
    await runChanges(['show', id, '--diff'], context, driven([]))
    expect(out()).toContain('The diff was cut short at its size limit; left out: index.js')
    expect(out()).toContain('Not included: dangling')
    const upgrade = (await readChangeLog(home, PROFILE)).entries[0]!
    context.printed.length = 0
    await runChanges(['show', upgrade.id], context, driven([]))
    expect(out()).toBe(`Change ${upgrade.id}: ${upgrade.summary}\nState: applied since ${upgrade.decidedAt!}\n`)
  })

  it('reports an unknown change and refuses a malformed id, an unknown subcommand and a misplaced option', async () => {
    expect(await runChanges(['show', 'c0000000000'], context, driven([]))).toBe(EXIT.failed)
    expect(err()).toContain('No change has the id c0000000000')
    for (const args of [['show', 'nope'], ['frobnicate'], ['list', 'extra'], ['apply'], ['apply', '--json', 'c0000000000'], ['list', '--diff'], ['protection', 'maybe'], ['--bogus']]) {
      await expect(runChanges(args, context, driven([]))).rejects.toMatchObject({ exit: EXIT.usage })
    }
  })

  it('shows a new plugin waiting for review', async () => {
    const other = join(base, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'package.json'), '{"name":"other"}\n')
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies.other = `link:${other}`
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    await enforceApprovedContent({ home, profile: PROFILE, profileDir })
    await runChanges(['show', await pendingId()], context, driven([]))
    expect(out()).toMatch(/: a new plugin, waiting for your review\nPlugin: other\n/)
  })

  it('passes on a failure that is not a refusal of Changes', async () => {
    edit('export default 2\n')
    const id = await pendingId()
    const failing: ChangesCommandDependencies = { ...driven(['y']), withHost: async () => Promise.reject(new Error('the lock is held')) }
    await expect(runChanges(['apply', id], context, failing)).rejects.toThrow('the lock is held')
    const broken: ChangesCommandDependencies = { ...driven([]), streams: { stdin: { get isTTY(): boolean { throw new Error('no stdin') } }, stdout: { isTTY: true } } }
    await expect(runChanges(['apply', id], context, broken)).rejects.toThrow('no stdin')
  })

  it('refuses a profile that is not set up', async () => {
    await expect(runChanges(['list', '--profile', 'other'], context, driven([]))).rejects.toBeInstanceOf(CliError)
  })

  it('is a row of the command table', async () => {
    expect(await main(['changes', 'protection'], context)).toBe(EXIT.ok)
    expect(out()).toContain('Protection: on')
  })
})

describe('delorun changes apply', () => {
  it('prints the summary and risk lines, asks once without risk, and applies through the Host', async () => {
    edit('export default 2\n')
    const id = await pendingId()
    const terminal = driven(['y'])
    expect(await runChanges(['apply', id], context, terminal)).toBe(EXIT.ok)
    expect(terminal.questions).toEqual([`Apply ${id}? [y/N] `])
    expect(out()).toContain('Nothing in the change matched the checks.')
    expect(out()).toContain(`Applied ${id}. Delorun runs it now.`)
    expect(terminal.reloads()).toBe(1)
  })

  it('asks a second confirmation naming the kinds when a check found something, and declining it writes nothing', async () => {
    edit('fetch("https://example.invalid/")\n')
    const id = await pendingId()
    const before = written()
    const declines = driven(['y', 'n'])
    expect(await runChanges(['apply', id], context, declines)).toBe(EXIT.ok)
    expect(declines.questions).toEqual([`Apply ${id}? [y/N] `, 'Apply it anyway? [y/N] '])
    expect(out()).toContain("This change opens network connections. A plugin's code can do anything Delorun can.")
    expect(out()).toContain('Nothing was changed.')
    expect(written()).toBe(before)
    expect(declines.hosted()).toBe(0)
    const accepts = driven(['y', 'yes'], [undefined])
    expect(await runChanges(['apply', id], context, accepts)).toBe(EXIT.ok)
    expect(out()).toContain(`Applied ${id}. Delorun is not running; the next start runs it.`)
  })

  it('declining the first question writes nothing', async () => {
    edit('export default 2\n')
    const id = await pendingId()
    const before = written()
    const terminal = driven([''])
    expect(await runChanges(['apply', id], context, terminal)).toBe(EXIT.ok)
    expect(written()).toBe(before)
    expect(terminal.hosted()).toBe(0)
  })

  it('reports a failed reload, that Delorun went back, and when going back also failed', async () => {
    edit('export default 2\n')
    const id = await pendingId()
    expect(await runChanges(['apply', id], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, { ok: false, error: 'still broken' }]))).toBe(EXIT.failed)
    expect(err()).toContain(`delorun changes: Applied ${id}, but Delorun failed to load it: SyntaxError\nDelorun went back to what ran before, and the change waits for your review again.\n`)
    expect(err()).toContain('Loading what ran before also failed: still broken. Restart Delorun: delorun stop, then delorun start.')
    context.errors.length = 0
    expect(await runChanges(['apply', id], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, OK]))).toBe(EXIT.failed)
    expect(err()).not.toContain('also failed')
  })

  it('lists a change a failed start left out with the words that name it, shows it with its failure, and applies it again', async () => {
    const { leaveOutNewestChange } = await import('@delorun/changes')
    edit('export default "two"\n')
    const id = await pendingId()
    await runChanges(['apply', id], { ...context, stdout: () => {} }, driven(['y'], [undefined]))
    const left = (await leaveOutNewestChange({ ...ctx(), now: () => new Date(Date.now() + 60_000) }, 'Error: \u001b[2Jboom'))!
    await enforceApprovedContent({ home, profile: PROFILE, profileDir })
    context.printed.length = 0
    await runChanges(['list'], context, driven([]))
    expect(out()).toContain([
      'Left out because Delorun did not start with them:',
      `  Delorun did not start with your latest change to plug (${id}): Error: \\u001b[2Jboom.`,
      '  It starts without it now; your files are unchanged.',
      `  To try it again: delorun changes apply ${id}. To undo it: delorun changes undo ${id}.`,
    ].join('\n'))
    expect(out()).not.toContain(`  ${id}  left-out`)
    context.printed.length = 0
    expect(await runChanges(['apply', id], context, driven(['y']))).toBe(EXIT.ok)
    expect(out()).toContain(`State: left-out-at-start since ${left.decidedAt!}\nA start left it out at ${left.leftOut!.at} because it failed: Error: \\u001b[2Jboom\n`)
    expect((await readChangeLog(home, PROFILE)).entries.find(entry => entry.id === id)?.state).toBe('applied')
  })

  it('applies a plugin turned off that failed to load, showing its entry', async () => {
    await runChanges(['off', 'plug'], context, driven(['y'], [{ ok: false, error: 'boom' }, OK]))
    const entry = (await readChangeLog(home, PROFILE)).entries.find(candidate => candidate.kind === 'plugin-off')!
    context.printed.length = 0
    await runChanges(['list'], context, driven([]))
    expect(out()).toContain(`  ${entry.id}  pending    ${entry.createdAt}  Turned off plug (it failed to load: boom)\n`)
    context.printed.length = 0
    expect(await runChanges(['apply', entry.id], context, driven(['y']))).toBe(EXIT.ok)
    expect(out()).toContain(`Change ${entry.id}: Turned off plug\nState: pending\nIt failed to load at `)
  })
})

describe('the agent\'s plugin requests', () => {
  it('lists and shows a request waiting for review, and applies it with upstream\'s plugin operation after asking', async () => {
    const request = await recordPluginRequest(ctx(), { action: 'install', spec: 'new-plugin@2.0.0' })
    expect(await runChanges(['list'], context, driven([]))).toBe(EXIT.ok)
    expect(out()).toContain(`Waiting for review:\n  ${request.id}  The agent asks to install new-plugin@2.0.0 (asked in a chat)\nSee one with`)
    context.printed.length = 0
    expect(await runChanges(['show', request.id], context, driven([]))).toBe(EXIT.ok)
    expect(out()).toBe(`Change ${request.id}: The agent asks to install new-plugin@2.0.0\nState: pending\nAsked for in a chat. Applying it adds new-plugin@2.0.0 to the profile, as delorun plugin add does; a folder is added with nothing loaded, and its content waits for your review.\n\nApply it: delorun changes apply ${request.id}    Discard it: delorun changes discard ${request.id}\n`)
    const declines = driven(['n'])
    expect(await runChanges(['apply', request.id], context, declines)).toBe(EXIT.ok)
    expect(declines.operations).toEqual([])
    context.printed.length = 0
    const terminal = driven(['y'])
    expect(await runChanges(['apply', request.id], context, terminal)).toBe(EXIT.ok)
    expect(terminal.questions).toEqual([`Apply ${request.id}? [y/N] `])
    expect(terminal.operations).toEqual([['add', 'new-plugin@2.0.0']])
    expect(out()).toContain(`Applied ${request.id}. Delorun runs it now.\n`)
    context.printed.length = 0
    expect(await runChanges(['show', request.id], context, driven([]))).toBe(EXIT.ok)
    expect(out()).not.toContain('Apply it:')
    expect(await runChanges(['undo', request.id], context, driven(['y']))).toBe(EXIT.failed)
    expect(err()).toContain('cannot be undone here: The agent asks to install new-plugin@2.0.0. Restore the profile version before it with delorun recover.')
  })

  it('reports an operation that failed, a Host that failed to load, Delorun not running, and a folder\'s waiting content', async () => {
    const remove = await recordPluginRequest(ctx(), { action: 'remove', spec: 'left-pad' })
    context.printed.length = 0
    await runChanges(['show', remove.id], context, driven([]))
    expect(out()).toContain('Applying it removes left-pad from the profile, as delorun plugin remove does.')
    expect(await runChanges(['apply', remove.id], context, driven(['y'], [OK], true, 1))).toBe(EXIT.failed)
    expect(err()).toContain(`delorun changes: Change ${remove.id} was not applied: the plugin operation exited 1; diagnostics: /logs/operation.log`)
    context.printed.length = 0
    await runChanges(['list'], context, driven([]))
    expect(out()).toContain('    Applying it failed: the plugin operation exited 1; diagnostics: /logs/operation.log')
    expect(await runChanges(['apply', remove.id], context, driven(['y'], [{ ok: false, error: 'boom' }]))).toBe(EXIT.failed)
    expect(err()).toContain(`delorun changes: Applied ${remove.id}, but Delorun failed to load it: boom\nThe profile keeps the change; restart Delorun, or undo it with delorun recover.\n`)
    const folder = join(base, 'other')
    mkdirSync(folder)
    writeFileSync(join(folder, 'package.json'), '{"name":"other","version":"1.0.0"}\n')
    const linked = await recordPluginRequest(ctx(), { action: 'install', spec: `link:${folder}` })
    context.printed.length = 0
    const terminal = driven(['y'], [undefined])
    expect(await runChanges(['apply', linked.id], context, terminal)).toBe(EXIT.ok)
    const waiting = (await readChangeLog(home, PROFILE)).entries.find(entry => entry.kind === 'plugin-install' && entry.subject.source === folder)!
    expect(out()).toContain(`Applied ${linked.id}. Delorun is not running; the next start runs it. Its folder's content waits for your review: delorun changes show ${waiting.id}\n`)
    expect(terminal.operations).toEqual([['add', `other@link:${join(home, 'changes', 'profiles', PROFILE, 'active', 'other')}`]])
  })

  it('discards a request, which then never runs', async () => {
    const request = await recordPluginRequest(ctx(), { action: 'install', spec: 'new-plugin' })
    expect(await runChanges(['discard', request.id], context, driven(['y']))).toBe(EXIT.ok)
    expect((await readChangeLog(home, PROFILE)).entries.find(entry => entry.id === request.id)?.state).toBe('discarded')
    expect(await runChanges(['apply', request.id], context, driven(['y']))).toBe(EXIT.failed)
    expect(err()).toContain(`Change ${request.id} is discarded, so it cannot be applied.`)
  })
})

describe('delorun changes discard, undo, off and on', () => {
  it('discards after asking, and declining writes nothing', async () => {
    edit('export default 2\n')
    const id = await pendingId()
    const before = written()
    await runChanges(['discard', id], context, driven(['n']))
    expect(written()).toBe(before)
    expect(await runChanges(['discard', id], context, driven(['y']))).toBe(EXIT.ok)
    expect(out()).toContain(`Discarded ${id}; it shows again when the folder changes.`)
    expect((await listChanges(ctx())).pending).toEqual([])
    context.printed.length = 0
    expect(await runChanges(['discard', id], context, driven(['y']))).toBe(EXIT.failed)
    expect(out()).toContain('State: discarded')
  })

  it('undoes after asking, and declining writes nothing', async () => {
    edit('export default 2\n')
    const id = await pendingId()
    await runChanges(['apply', id], context, driven(['y']))
    const before = written()
    await runChanges(['undo', id], context, driven(['no']))
    expect(written()).toBe(before)
    const terminal = driven(['y'])
    expect(await runChanges(['undo', id], context, terminal)).toBe(EXIT.ok)
    expect(terminal.questions).toEqual([`Undo ${id}: plug: changes in ${source}? [y/N] `])
    expect(out()).toContain(`Undid ${id}. Delorun runs it now.`)
    expect(out()).not.toContain('delorun plugin remove')
    const again = driven(['y'])
    expect(await runChanges(['undo', id], context, again)).toBe(EXIT.failed)
    expect(again.questions).toEqual([`Undo ${id}: plug? [y/N] `])
  })

  it('says an undone install stops the plugin and names the command that removes it', async () => {
    const install = (await readChangeLog(home, PROFILE)).entries.find(entry => entry.kind === 'plugin-install' && entry.subject.plugin === 'plug')!
    expect(await runChanges(['undo', install.id], context, driven(['y']))).toBe(EXIT.ok)
    expect(out()).toContain(`Undid ${install.id}. Delorun runs it now.\nplug is stopped, not removed. To remove it fully: delorun plugin remove plug\n`)
  })

  it('turns one plugin off and on, editing only the bundle list', async () => {
    const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    const before = manifest()
    const off = driven(['y'])
    expect(await runChanges(['off', 'plug'], context, off)).toBe(EXIT.ok)
    expect(off.questions).toEqual(['Turn off plug? It stops running until you turn it on again. [y/N] '])
    expect(manifest()).toEqual({ ...before, dsh: { profile: { bundles: [] } } })
    expect(out()).toContain('Turned off plug. Delorun runs it now.')
    const on = driven(['y'])
    expect(await runChanges(['on', 'plug'], context, on)).toBe(EXIT.ok)
    expect(on.questions).toEqual(['Turn on plug? [y/N] '])
    expect(manifest()).toEqual(before)
    const declined = driven(['n'])
    await runChanges(['off', 'plug'], context, declined)
    expect(manifest()).toEqual(before)
    expect(await runChanges(['off', '@delorun/bundle-local'], context, driven(['y']))).toBe(EXIT.failed)
    expect(err()).toContain("Delorun's own bundle")
  })
})

describe('delorun changes work and done', () => {
  /** @returns the approved version of plug. */
  async function approvedNow(): Promise<string | undefined> {
    return (await readApproved(profileDir)).plugins.plug?.version
  }

  /** @returns the version plug's folder holds now, as the waiting change names it. */
  async function folderNow(): Promise<string> {
    const { pending } = await listChanges(ctx())
    return pending[0]!.to
  }

  it('starts a session for the length asked, says until when edits load, and done approves exactly the version it showed', async () => {
    const from = (await approvedNow())!
    const work = driven(['y'])
    expect(await runChanges(['work', 'plug'], context, work)).toBe(EXIT.ok)
    expect(work.questions).toEqual(['Work on plug for 120 minutes? Edits in its folder will load without your review until you run delorun changes done plug or the time is up. [y/N] '])
    const session = (await readWorkSession(home, PROFILE))!
    expect(Date.parse(session.endsAt) - Date.parse(session.startedAt)).toBe(120 * 60_000)
    expect(out()).toBe(`Working on plug: edits in ${source} load live until delorun changes done plug, at the latest until ${session.endsAt}.\n`)
    expect(work.reloads()).toBe(1)
    edit('export default 2\n')
    const shown = await folderNow()
    context.printed.length = 0
    const done = driven(['y'])
    expect(await runChanges(['done', 'plug'], context, done)).toBe(EXIT.ok)
    expect(done.questions).toEqual([`Approve version ${shown.slice(0, 7)} of plug and end your work session? [y/N] `])
    expect(done.reloads()).toBe(1)
    const entry = (await readChangeLog(home, PROFILE)).entries.at(-1)!
    expect(entry).toMatchObject({ kind: 'plugin-edit', state: 'applied', decidedFrom: 'terminal', from, to: shown })
    expect(await approvedNow()).toBe(shown)
    expect(out()).toContain(`Your work session on plug started at ${session.startedAt} and ends at ${session.endsAt}.\nVersion ${shown.slice(0, 7)} of plug, in ${source}, against the approved version ${from.slice(0, 7)}:\nFiles:\n  modified  index.js\n`)
    expect(out()).toContain('+export default 2')
    expect(out()).toContain(`Your work session on plug ended. Version ${shown.slice(0, 7)} is now the approved version of plug (${entry.id}).\n`)
    expect((await listChanges(ctx())).workSession).toBeUndefined()
  })

  it('takes --for in whole minutes up to the limit, and refuses a malformed or misplaced one, a missing plugin and an extra argument', async () => {
    expect(await runChanges(['work', 'plug', '--for', '30'], context, driven(['y']))).toBe(EXIT.ok)
    const session = (await readWorkSession(home, PROFILE))!
    expect(Date.parse(session.endsAt) - Date.parse(session.startedAt)).toBe(30 * 60_000)
    for (const args of [['work', 'plug', '--for', '0'], ['work', 'plug', '--for', '481'], ['work', 'plug', '--for', '1e2'], ['work', 'plug', '--for', '9999999999'], ['done', 'plug', '--for', '5'], ['work'], ['done'], ['work', 'plug', 'extra'], ['work', 'plug', '--json']]) {
      const terminal = driven(['y'])
      await expect(runChanges(args, context, terminal), args.join(' ')).rejects.toMatchObject({ exit: EXIT.usage })
      expect(terminal.questions).toEqual([])
    }
    await expect(runChanges(['work', 'plug', '--for', 'abc'], context, driven(['y']))).rejects.toThrow('--for takes whole minutes from 1 to 480; "abc" is not\nusage: delorun changes work <plugin> [--for <minutes>]')
    expect(await runChanges(['--profile', PROFILE, 'done', 'plug'], context, driven(['y']))).toBe(EXIT.ok)
    expect(await readWorkSession(home, PROFILE)).toBeUndefined()
  })

  it('declining either question, or the second one a risk finding asks, changes nothing', async () => {
    const before = written()
    expect(await runChanges(['work', 'plug'], context, driven(['n']))).toBe(EXIT.ok)
    expect(await readWorkSession(home, PROFILE)).toBeUndefined()
    await runChanges(['work', 'plug'], context, driven(['y']))
    edit('export default 2\nfetch("https://example.invalid/")\n')
    context.printed.length = 0
    expect(await runChanges(['done', 'plug'], context, driven([]))).toBe(EXIT.ok)
    const risky = driven(['y', 'n'])
    expect(await runChanges(['done', 'plug'], context, risky)).toBe(EXIT.ok)
    expect(risky.questions[1]).toBe('Approve it anyway? [y/N] ')
    expect(out()).toContain("This version opens network connections. A plugin's code can do anything Delorun can.\n")
    expect(out()).toContain('Opens network connections (index.js:2)')
    expect(out().match(/Nothing was changed\.\n/g)).toHaveLength(2)
    expect(written()).toBe(before)
    expect((await readWorkSession(home, PROFILE))?.plugin).toBe('plug')
    expect(await runChanges(['done', 'plug'], context, driven(['y', 'y']))).toBe(EXIT.ok)
    expect(await readWorkSession(home, PROFILE)).toBeUndefined()
  })

  it('done refuses a folder that changed after it was shown, approves nothing, and the session stays open', async () => {
    const from = await approvedNow()
    await runChanges(['work', 'plug'], context, driven(['y']))
    edit('export default 2\n')
    const terminal = driven(['y'])
    const changing: ChangesCommandDependencies = {
      ...terminal,
      ask: async (question) => {
        edit('export default 3\n')
        return terminal.ask(question)
      },
    }
    expect(await runChanges(['done', 'plug'], context, changing)).toBe(EXIT.failed)
    expect(err()).toBe('delorun changes: The folder of plug changed after it was shown, so nothing was approved and your work session stays open. Run delorun changes done plug again to see what it holds now.\n')
    expect(await approvedNow()).toBe(from)
    expect((await readChangeLog(home, PROFILE)).entries.filter(entry => entry.kind === 'plugin-edit')).toEqual([])
    expect((await readWorkSession(home, PROFILE))?.plugin).toBe('plug')
  })

  it('reports a version that fails to load at done, keeps the session open, and says when it was loaded before and failed', async () => {
    const from = await approvedNow()
    await runChanges(['work', 'plug'], context, driven(['y']))
    edit('throw new Error("broken")\n')
    const shown = (await folderNow()).slice(0, 7)
    expect(await runChanges(['done', 'plug'], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, { ok: false, error: 'still broken' }]))).toBe(EXIT.failed)
    expect(err()).toBe(`delorun changes: version ${shown} of plug failed to load: SyntaxError\nNothing was approved; Delorun runs the version that last loaded, and your work session stays open.\nLoading that version also failed: still broken. Restart Delorun: delorun stop, then delorun start.\n`)
    expect(await approvedNow()).toBe(from)
    context.errors.length = 0
    context.printed.length = 0
    expect(await runChanges(['done', 'plug'], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, OK]))).toBe(EXIT.failed)
    expect(out()).toContain('This version failed to load in your work session; approving it loads it again first.\n')
    expect(err()).not.toContain('also failed')
    expect((await readWorkSession(home, PROFILE))?.plugin).toBe('plug')
  })

  it('shows a folder that holds the approved version or is gone, dependency files, left-out paths, a cut diff, and escapes names', async () => {
    const from = (await approvedNow())!.slice(0, 7)
    await runChanges(['work', 'plug'], context, driven(['y']))
    context.printed.length = 0
    const same = driven(['y'])
    expect(await runChanges(['done', 'plug'], context, same)).toBe(EXIT.ok)
    expect(same.questions).toEqual(['End your work session on plug? [y/N] '])
    expect(out()).toContain(`The folder of plug holds its approved version (${from}); there is nothing new to approve.\n`)
    expect(out()).toContain(`Your work session on plug ended. plug keeps its approved version (${from}); its folder holds no change.\n`)
    await runChanges(['work', 'plug'], context, driven(['y']))
    mkdirSync(join(source, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(source, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    symlinkSync(join(base, 'nowhere'), join(source, 'dangling'))
    writeFileSync(join(source, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(3_000))
    writeFileSync(join(source, 'a\u001b[31m.js'), 'export {}\n')
    context.printed.length = 0
    expect(await runChanges(['done', 'plug'], context, driven(['n']))).toBe(EXIT.ok)
    expect(out()).toContain('Dependency files (1):\n')
    expect(out()).toContain('Not included: dangling')
    expect(out()).toContain('The diff was cut short at its size limit; left out: ')
    expect(out()).toContain('a\\u001b[31m.js')
    expect(out()).not.toContain('\u001b')
    rmSync(source, { recursive: true })
    context.printed.length = 0
    expect(await runChanges(['done', 'plug'], context, driven(['y']))).toBe(EXIT.ok)
    expect(out()).toContain(`The folder of plug, ${source}, is gone; ending the session keeps its approved version (${from}).\n`)
    expect(out()).toContain(`Your work session on plug ended. The folder of plug is gone; plug keeps its approved version (${from}).\n`)
  })

  it('reports a folder that failed to load at once, and a plugin or a session it cannot find', async () => {
    edit('throw new Error("broken")\n')
    expect(await runChanges(['work', 'plug'], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, { ok: false, error: 'still broken' }]))).toBe(EXIT.failed)
    expect(err()).toBe('delorun changes: plug failed to load from its folder: SyntaxError\nDelorun runs its approved version; your work session stays open, and the next edit in the folder loads again.\nLoading the approved version also failed: still broken. Restart Delorun: delorun stop, then delorun start.\n')
    expect((await listChanges(ctx())).workSession?.plugin).toBe('plug')
    edit('export default 1\n')
    await runChanges(['done', 'plug'], context, driven(['y']))
    edit('throw new Error("broken")\n')
    context.errors.length = 0
    expect(await runChanges(['work', 'plug'], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, OK]))).toBe(EXIT.failed)
    expect(err()).not.toContain('also failed')
    edit('export default 1\n')
    await runChanges(['done', 'plug'], context, driven(['y']))
    context.errors.length = 0
    expect(await runChanges(['work', 'left-pad'], context, driven(['y']))).toBe(EXIT.failed)
    expect(err()).toContain('left-pad is not a plugin of the profile default that you approved from a folder')
    expect(await runChanges(['done', 'plug'], context, driven(['y']))).toBe(EXIT.failed)
    expect(err()).toContain('No work session on plug is open in the profile default.')
  })

  it('refuses a profile that is not set up, and passes on a failure that is not one of Changes', async () => {
    await expect(runChanges(['work', 'plug', '--profile', 'other'], context, driven(['y']))).rejects.toThrow('delorun changes: the CLI profile other is not set up in')
    const lockTaken: ChangesCommandDependencies = { ...driven(['y']), withHost: async () => Promise.reject(new Error('a start took the lock')) }
    await expect(runChanges(['work', 'plug'], context, lockTaken)).rejects.toThrow('a start took the lock')
  })

  it('delorun status names the open work session, its start and its end', async () => {
    expect(await statusCommand.run([], context)).toBe(EXIT.notRunning)
    expect(out()).not.toContain('work session:')
    await runChanges(['work', 'plug'], context, driven(['y']))
    const session = (await readWorkSession(home, PROFILE))!
    context.printed.length = 0
    await statusCommand.run([], context)
    expect(out()).toContain(`work session: plug since ${readableTime(session.startedAt)}, ends at ${readableTime(session.endsAt)}\n`)
    writeFileSync(join(home, 'changes', 'profiles', PROFILE, 'work-session.json'), '{}\n', { mode: 0o600 })
    context.printed.length = 0
    await statusCommand.run([], context)
    expect(out()).toMatch(/work session: unreadable: .*work-session\.json is not a record Delorun wrote/)
  })
})

describe('delorun changes protection', () => {
  it('prints the setting with on|off without a terminal, and off for a home without a protection record', async () => {
    expect(await runChanges(['protection'], context, driven([], [], false))).toBe(EXIT.ok)
    expect(out()).toBe(`Protection: on: ${ON_MEANING}.\nChange it in a terminal: delorun changes protection on|off\n`)
    rmSync(join(home, 'changes', 'protection.json'))
    context.printed.length = 0
    expect(await runChanges(['protection'], context, driven([], [], false))).toBe(EXIT.ok)
    expect(out()).toBe(`Protection: off: ${OFF_MEANING}.\nChange it in a terminal: delorun changes protection on|off\n`)
  })

  it('protection off states what off means and asks twice; only y to both writes it, and the log records the weakening', async () => {
    const declined = driven(['n'])
    expect(await runChanges(['protection', 'off'], context, declined)).toBe(EXIT.ok)
    expect(out()).toBe(`Changes will load without your review. With protection off, ${OFF_MEANING}.\nNothing was changed.\n`)
    expect(declined.questions).toEqual(['Turn protection off? [y/N] '])
    expect(await readProtection(home)).toBe('on')
    context.printed.length = 0
    // Pins the second ask: a single y no longer turns protection off.
    edit('export default 2\n')
    const once = driven(['y', 'n'])
    expect(await runChanges(['protection', 'off'], context, once)).toBe(EXIT.ok)
    expect(once.questions).toEqual(['Turn protection off? [y/N] ', 'Turn protection off now? [y/N] '])
    expect(out()).toContain('Once protection is off, the waiting changes of plug load at once.\nNothing was changed.\n')
    expect(await readProtection(home)).toBe('on')
    context.printed.length = 0
    const accepted = driven(['y', 'y'])
    expect(await runChanges(['protection', 'off'], context, accepted)).toBe(EXIT.ok)
    expect(accepted.questions).toEqual(['Turn protection off? [y/N] ', 'Turn protection off now? [y/N] '])
    expect(await readProtection(home)).toBe('off')
    expect(out()).toContain('Protection is off (it was on). Delorun uses it from its next decision, without a restart.\n')
    expect((await readChangeLog(home, PROFILE)).entries.at(-1)).toMatchObject({ kind: 'guard-weakening', state: 'applied', summary: 'Protection turned off: changes load without review', decidedFrom: 'terminal' })
  })

  it('protection on states what on means and asks; only y writes it, and the log records no weakening', async () => {
    rmSync(join(home, 'changes', 'protection.json'))
    const entries = (await readChangeLog(home, PROFILE)).entries.length
    const declined = driven(['no'])
    expect(await runChanges(['protection', 'on'], context, declined)).toBe(EXIT.ok)
    expect(out()).toBe(`Changes will wait for your review. With protection on, ${ON_MEANING}.\nNothing was changed.\n`)
    expect(declined.questions).toEqual(['Turn protection on? [y/N] '])
    expect(existsSync(join(home, 'changes', 'protection.json'))).toBe(false)
    context.printed.length = 0
    expect(await runChanges(['protection', 'on'], context, driven(['y']))).toBe(EXIT.ok)
    expect(await readProtection(home)).toBe('on')
    expect(out()).toContain('Protection is on (it was off). Delorun uses it from its next decision, without a restart.\n')
    expect((await readChangeLog(home, PROFILE)).entries).toHaveLength(entries)
  })

  it('refuses the old settings warn and block, and anything else, as a usage error that asks nothing', async () => {
    for (const level of ['warn', 'block', 'ON']) {
      const terminal = driven(['y'])
      await expect(runChanges(['protection', level], context, terminal), level).rejects.toMatchObject({ exit: EXIT.usage, message: expect.stringContaining(`${JSON.stringify(level)} is not a protection setting; use on or off`) })
      expect(terminal.questions).toEqual([])
    }
    expect(await readProtection(home)).toBe('on')
  })
})

describe('with protection off, the default', () => {
  beforeEach(async () => {
    // A home without a protection record has protection off.
    rmSync(join(home, 'changes', 'protection.json'))
    // A start at a terminal has shown the plugins approved at upgrade, so a start names only what it loaded.
    await startChanges({ home, profile: PROFILE, terminal: true }, () => {})
  })

  /**
   * Run Changes' part of `delorun start` for the profile, as the home process's pre-start step does.
   * @returns what the start printed.
   */
  async function started(): Promise<string> {
    const printed: string[] = []
    await startChanges({ home, profile: PROFILE, terminal: false }, text => void printed.push(text))
    return printed.join('')
  }

  it('a changed plugin folder loads at the next start without review, logged as an applied change list, show and undo reach', async () => {
    const from = (await readApproved(profileDir)).plugins.plug!.version
    edit('export default 2\n')
    const printed = await started()
    const entry = (await readChangeLog(home, PROFILE)).entries.at(-1)!
    expect(entry).toMatchObject({ kind: 'plugin-edit', state: 'applied', decidedFrom: 'unreviewed', from, subject: { plugin: 'plug', source }, summary: `Loaded without review: plug: changes in ${source}` })
    expect(entry.historyVersion).toEqual(expect.any(String))
    expect(printed).toBe(`plug loaded changes without review, because protection is off: delorun changes show ${entry.id}\n`)
    expect((await readApproved(profileDir)).plugins.plug!.version).toBe(entry.to)
    expect(readFileSync(join(activeDirectory(home, PROFILE, 'plug'), 'index.js'), 'utf8')).toBe('export default 2\n')
    expect((await listChanges(ctx())).pending).toEqual([])

    expect(await runChanges(['list'], context, driven([]))).toBe(EXIT.ok)
    expect(out()).toContain('Nothing waits for your review.')
    expect(out()).toContain(`  ${entry.id}  applied    ${entry.decidedAt!}  Loaded without review: plug: changes in ${source}\n`)
    expect(out()).toContain('\nProtection: off: changes load without your review and are still recorded')
    context.printed.length = 0
    expect(await runChanges(['show', entry.id], context, driven([]))).toBe(EXIT.ok)
    expect(out()).toBe(`Change ${entry.id}: Loaded without review: plug: changes in ${source}\nState: applied since ${entry.decidedAt!}\n`)

    context.printed.length = 0
    const undo = driven(['y'], [undefined])
    expect(await runChanges(['undo', entry.id], context, undo)).toBe(EXIT.ok)
    expect(undo.questions).toEqual([`Undo ${entry.id}: Loaded without review: plug: changes in ${source}? [y/N] `])
    expect(out()).toContain(`Undid ${entry.id}. Delorun is not running; the next start runs it.`)
    expect((await readApproved(profileDir)).plugins.plug!.version).toBe(from)
    expect(readFileSync(join(activeDirectory(home, PROFILE, 'plug'), 'index.js'), 'utf8')).toBe('export default 1\n')
  })

  it('content the person undid does not load again until the folder holds something else', async () => {
    const from = (await readApproved(profileDir)).plugins.plug!.version
    edit('export default 2\n')
    await started()
    const entry = (await readChangeLog(home, PROFILE)).entries.at(-1)!
    await runChanges(['undo', entry.id], context, driven(['y'], [undefined]))
    const again = await started()
    expect(again).toMatch(/^plug has changes waiting for your review and loads without them: delorun changes show c[0-9a-f]{10}\n$/u)
    expect((await readApproved(profileDir)).plugins.plug!.version).toBe(from)
    expect(readFileSync(join(activeDirectory(home, PROFILE, 'plug'), 'index.js'), 'utf8')).toBe('export default 1\n')
    edit('export default 3\n')
    expect(await started()).toMatch(/^plug loaded changes without review, because protection is off: delorun changes show c[0-9a-f]{10}\n$/u)
    expect(readFileSync(join(activeDirectory(home, PROFILE, 'plug'), 'index.js'), 'utf8')).toBe('export default 3\n')
  })

  it('a plugin linked since the last start loads at the next start without review', async () => {
    const other = join(base, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'package.json'), '{"name":"other"}\n')
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies.other = `link:${other}`
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    symlinkSync(relative(join(profileDir, 'node_modules'), other), join(profileDir, 'node_modules', 'other'))
    const printed = await started()
    const entry = (await readChangeLog(home, PROFILE)).entries.find(candidate => candidate.subject.plugin === 'other')!
    expect(entry).toMatchObject({ kind: 'plugin-install', state: 'applied', decidedFrom: 'unreviewed', summary: `Loaded without review: other from ${other}` })
    expect(printed).toBe(`other loaded without review, because protection is off: delorun changes show ${entry.id}\n`)
    expect(readFileSync(join(activeDirectory(home, PROFILE, 'other'), 'package.json'), 'utf8')).toBe('{"name":"other"}\n')
  })
})

describe('every state-changing changes action refuses without a terminal', () => {
  it('refuses apply, discard, undo, off, on, protection, work and done with input or output redirected, and writes nothing', async () => {
    edit('export default 2\n')
    const id = await pendingId()
    const upgrade = (await readChangeLog(home, PROFILE)).entries[0]!
    const before = written()
    for (const args of [['apply', id], ['discard', id], ['undo', upgrade.id], ['off', 'plug'], ['on', 'left-pad'], ['protection', 'off'], ['protection', 'on'], ['work', 'plug'], ['done', 'plug']]) {
      const terminal = driven(['y', 'y'], [OK], false)
      await expect(runChanges(args, context, terminal)).rejects.toThrow(`delorun changes: ${NOT_AT_TERMINAL}`)
      expect(terminal.questions).toEqual([])
      expect(terminal.hosted()).toBe(0)
    }
    expect(written()).toBe(before)
    expect(await readProtection(home)).toBe('on')
  })
})

describe('the Host while delorun changes runs', () => {
  it('holds the profile home lock while Delorun does not run, and reports that it does not run', async () => {
    const seen = await withProfileHost(home, PROFILE, async (reload) => {
      expect(readHomeLock(runDirectory(home, PROFILE))?.pid).toBe(process.pid)
      return reload()
    })
    expect(seen).toBeUndefined()
    expect(readHomeLock(runDirectory(home, PROFILE))).toBeUndefined()
    expect(await reloadThroughChannel(home, PROFILE)).toMatchObject({ ok: false, error: expect.stringMatching(/^the home process did not answer: /) })
  })

  it('reloads a running Host through the update channel, and reports a refusal', async () => {
    const outcomes: ReloadOutcome[] = [OK, { ok: false, error: 'plug failed to start' }]
    const chats = new CountingChatGate()
    const host: RunningHost = {
      chats, protection: () => undefined, failedRows: () => [], rows: () => [], studio: () => undefined, studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }),
      check: async () => Promise.resolve({ passed: true }), close: async () => Promise.resolve(), suspend: async () => Promise.resolve(),
      reload: async () => Promise.resolve(outcomes.shift()!),
    }
    const listeners: (() => void)[] = []
    const running = await HomeProcess.start({
      home, profile: PROFILE, running: brandString<RuntimeVersion>('0.0.0'), startId: newStartId(), host: { boot: async () => Promise.resolve(host) },
      preStart: () => Promise.resolve(), probe: updateChannelProbe(home, PROFILE), logger: SILENT, redactor: new Redactor(), updates: undefined, supervisor: undefined,
      onSignal: () => () => undefined, onExit: (listener) => { listeners.push(listener) }, exit: () => {},
    })
    try {
      expect(await withProfileHost(home, PROFILE, async reload => reload())).toEqual(OK)
      expect(await reloadThroughChannel(home, PROFILE)).toEqual({ ok: false, error: 'plug failed to start' })
      const end = chats.begin(() => {})
      const stopping = sendHomeRequest(home, PROFILE, { op: 'stop', args: { mode: 'drain' } })
      await vi.waitFor(async () => { expect(await reloadThroughChannel(home, PROFILE)).toEqual({ ok: false, error: 'the home process refused the reload: UPDATE_IN_PROGRESS' }) })
      end()
      await stopping
    } finally {
      await running.shutdown(0)
      for (const listener of listeners) listener()
    }
  })
})

describe('what delorun changes prints is escaped for the terminal', () => {
  it('writes control and bidirectional characters in file names, diffs, summaries and failures as escapes, and wraps long lines', async () => {
    const name = 'evil\u001b[2J\u202e.js'
    writeFileSync(join(source, name), `export const title = "\u001b]0;owned\u0007\u202e${'z'.repeat(400)}"\n`)
    const id = await pendingId()
    context.printed.length = 0
    expect(await runChanges(['show', id, '--diff'], context, driven([]))).toBe(EXIT.ok)
    expect(out()).not.toMatch(/[\u001b\u0007\u202e]/u)
    expect(out()).toContain('  added     evil\\u001b[2J\\u202e.js')
    expect(out()).toContain('+++ "b/evil\\033[2J\\342\\200\\256.js"')
    expect(out().split('\n').every(line => line.length <= 200)).toBe(true)
    expect(out()).toMatch(/\n {2}↪ z+/u)
    context.printed.length = 0
    expect(await runChanges(['show', id, '--json'], context, driven([]))).toBe(EXIT.ok)
    expect(out()).not.toMatch(/[\u001b\u0007\u202e]/u)
    expect((JSON.parse(out()) as { change: { files: { path: string }[] } }).change.files[0]!.path).toBe(name)
    // A failure message that forges a line of its own stays on its line.
    context.printed.length = 0
    expect(await runChanges(['apply', id], context, driven(['y', 'y'], [{ ok: false, error: 'boom\nApplied c0000000000. Delorun runs it now.\u001b[1A' }, OK]))).toBe(EXIT.failed)
    expect(err()).toContain('failed to load it: boom\\u000aApplied c0000000000. Delorun runs it now.\\u001b[1A\n')
    context.printed.length = 0
    await runChanges(['list'], context, driven([]))
    expect(out()).toContain('    It failed to load when applied: boom\\u000aApplied c0000000000.')
    expect(out()).not.toMatch(/[\u001b]/u)
  })
})

describe('apply shows what it approves', () => {
  it('apply shows the diff a page at a time before it asks', async () => {
    edit(Array.from({ length: 30 }, (_, index) => `export const line${String(index)} = ${String(index)}`).join('\n'))
    const id = await pendingId()
    const pages = { ...driven(['', 'a', 'n']), pageLines: 10 }
    expect(await runChanges(['apply', id], context, pages)).toBe(EXIT.ok)
    expect(pages.questions).toEqual(['-- more: Enter shows the next page, a shows the rest --', '-- more: Enter shows the next page, a shows the rest --', `Apply ${id}? [y/N] `])
    for (let index = 0; index < 30; index += 1) expect(out()).toContain(`+export const line${String(index)} = ${String(index)}`)
    // Without a page size the whole diff is printed before the one question.
    context.printed.length = 0
    const plain = driven(['n'])
    expect(await runChanges(['apply', id], context, plain)).toBe(EXIT.ok)
    expect(plain.questions).toEqual([`Apply ${id}? [y/N] `])
    expect(out()).toContain('+export const line29 = 29')
    expect(pageLinesOf(undefined)).toBe(22)
    expect(pageLinesOf(5)).toBe(10)
    expect(pageLinesOf(50)).toBe(48)
  })

  it('a file Node loads that the diff does not show asks the second confirmation and is named', async () => {
    writeFileSync(join(source, 'loader.js'), Buffer.concat([Buffer.from('require("node:child_process").exec("x") // '), Buffer.from([0xff]), Buffer.from('\n')]))
    const id = await pendingId()
    const before = written()
    const declines = driven(['y', 'n'])
    expect(await runChanges(['apply', id], context, declines)).toBe(EXIT.ok)
    expect(declines.questions).toEqual([`Apply ${id}? [y/N] `, 'Apply it anyway? [y/N] '])
    expect(out()).toContain('Binary file loader.js added')
    expect(out()).not.toContain('child_process')
    expect(out()).toContain('This change has content the diff does not show.')
    expect(out()).toContain('  Not shown: loader.js: not text, and Node can load it')
    expect(written()).toBe(before)
    expect(declines.hosted()).toBe(0)
  })

  it('names a change whose diff shows no lines', async () => {
    writeFileSync(join(source, 'image.png'), Buffer.from([0, 1, 2]))
    rmSync(join(source, 'index.js'))
    writeFileSync(join(source, 'index.js'), 'export default 1\n')
    const id = await pendingId()
    expect(await runChanges(['apply', id], context, driven(['n']))).toBe(EXIT.ok)
    expect(out()).toContain('Binary file image.png added')
  })
})

describe('the plugins approved at upgrade', () => {
  it('changes list names them until a terminal showed them', async () => {
    const upgrade = 'Delorun runs the approved copy of plug, linked from'
    // An approval that names no folder is left out of the lines.
    const log = await readChangeLog(home, PROFILE)
    await writeChangeLog(home, PROFILE, { ...log, entries: [...log.entries, { ...log.entries[0]!, id: brandString<ChangeId>('c1111111111'), subject: { plugin: 'other' } }] })
    expect(await runChanges(['list'], context, driven([], [OK], false))).toBe(EXIT.ok)
    expect(out()).not.toContain('copy of other')
    expect(out()).toMatch(new RegExp(`^${upgrade} ${source}, as it was when Changes began\\. Edits in that folder wait for your review\\.\\n\\n`, 'u'))
    expect((await readChangeLog(home, PROFILE)).entries[0]!.shownAt).toBeUndefined()
    context.printed.length = 0
    expect(await runChanges(['list'], context, driven([]))).toBe(EXIT.ok)
    expect(out()).toContain(upgrade)
    expect((await readChangeLog(home, PROFILE)).entries[0]!.shownAt).toEqual(expect.any(String))
    context.printed.length = 0
    expect(await runChanges(['list'], context, driven([]))).toBe(EXIT.ok)
    expect(out()).not.toContain(upgrade)
  })
})

describe('plugin names', () => {
  it('off and on refuse a name that is not a package name before any path is built', async () => {
    const before = written()
    for (const name of ['../outside', '@scope/a/b', 'a/b']) {
      await expect(runChanges(['off', name], context, driven(['y']))).rejects.toThrow(/is not a package name/u)
    }
    expect(written()).toBe(before)
  })
})

describe('delorun status and Changes', () => {
  it('delorun status names the plugins approved at upgrade until a terminal showed them and the changes waiting, never the protection setting', async () => {
    const upgrade = `changes: Delorun runs the approved copy of plug, linked from ${source}, as it was when Changes began. Edits in that folder wait for your review.\n`
    expect(await statusCommand.run([], context)).toBe(EXIT.notRunning)
    expect(out()).toContain(upgrade)
    edit('export default 2\n')
    await runChanges(['list'], context, driven([]))
    context.printed.length = 0
    await statusCommand.run([], context)
    expect(out()).not.toContain(upgrade)
    expect(out()).toMatch(/changes: plug has changes in .* waiting for your review: delorun changes show c[0-9a-f]{10}\n/u)
    await setProtection(home, 'off', attestTerminal(TERMINAL))
    context.printed.length = 0
    await statusCommand.run([], context)
    expect(out()).not.toContain('Protection')
    context.printed.length = 0
    expect(await statusCommand.run(['--json'], context)).toBe(EXIT.notRunning)
    expect(out()).not.toContain('changes:')
  })

  it('delorun status says nothing about Changes for a home without the profile', async () => {
    rmSync(join(profileDir, 'package.json'))
    expect(await statusCommand.run([], context)).toBe(EXIT.notRunning)
    expect(out()).not.toContain('changes:')
  })
})
