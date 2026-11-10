/**
 * `delorun changes` (contract C21, "Commands"): listing and showing what waits for review, the confirmations before
 * apply, discard, undo, off, on and a weaker protection setting, the refusal of every change without a terminal, the
 * running Host's reload through the update channel, and the home lock while Delo does not run.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { enforceApprovedContent, listChanges, readChangeLog, recordPluginRequest, readProtection, type ChangesContext, type ContentVersion, type ReloadHost, type ReloadOutcome } from '@delo/changes'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { ensureHomeTree, newStartId, readHomeLock, runDirectory } from '@delo/home'
import { CountingChatGate, HomeProcess, sendHomeRequest, updateChannelProbe, type RunningHost } from '@delo/home-process'
import { Redactor, type DeloLogger } from '@delo/logs'
import { NOT_AT_TERMINAL, reloadThroughChannel, runChanges, withProfileHost, type ChangesCommandDependencies } from '../src/changes/command.ts'
import type { CommandContext } from '../src/command.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { main } from '../src/main.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const PROFILE = 'default'
const SILENT: DeloLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
const OK: ReloadOutcome = { ok: true }

let base: string
let home: string
let profileDir: string
let source: string
let context: CommandContext & { readonly printed: string[], readonly errors: string[] }

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-changes-command-')))
  home = join(base, '.delo')
  vi.stubEnv('HOME', base)
  vi.stubEnv('USERPROFILE', base)
  // prepareHome sets these on the process; stubbing them first restores them afterwards.
  vi.stubEnv('DSH_HOME', join(base, '.dsh'))
  vi.stubEnv('DELO_HOME', undefined)
  vi.stubEnv('DELO_PROFILE', undefined)
  const printed: string[] = []
  const errors: string[] = []
  context = { env: { HOME: base, DSH_HOME: join(base, '.dsh'), DELO_HOME: home }, stdout: text => void printed.push(text), stderr: text => void errors.push(text), printed, errors }
  source = join(base, 'plug')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
  writeFileSync(join(source, 'index.js'), 'export default 1\n')
  profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(home, { mode: 0o700 })
  await ensureHomeTree(home, PROFILE)
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
 * @param outcomes - the Host's answers; undefined for Delo not running.
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
    expect(out()).toContain('Protection: block: changed plugins run only after you apply their changes.')
    edit('export default 2\n')
    context.printed.length = 0
    expect(await runChanges(['list'], context, driven([]))).toBe(EXIT.ok)
    const id = await pendingId()
    expect(out()).toMatch(new RegExp(`^Waiting for review:\\n  ${id}  plug from ${source} \\(1 changed file\\)\\nSee one with: delorun changes show <id>\\n`))
    expect(out()).not.toContain('Working on')
    context.printed.length = 0
    expect(await runChanges(['list', '--json'], context, driven([]))).toBe(EXIT.ok)
    expect(JSON.parse(out())).toMatchObject({ protection: 'block', pending: [{ id }] })
  })

  it('names a new plugin, two changed files, a failed apply, a gone folder and a work session in the list', async () => {
    edit('export default 2\n')
    writeFileSync(join(source, 'extra.js'), 'export {}\n')
    const id = await pendingId()
    await runChanges(['apply', id], context, driven(['y'], [{ ok: false, error: 'boom' }, OK]))
    context.printed.length = 0
    await runChanges(['list'], context, driven([]))
    expect(out()).toContain(`(2 changed files)\n    It failed to load when applied: boom`)
    const { openWorkSession, attestTerminal } = await import('@delo/changes')
    const approved = (JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { delo: { changes: { plugins: { plug: { version: string } } } } }).delo.changes.plugins.plug.version
    await openWorkSession(home, PROFILE, { plugin: 'plug', source, from: brandString<ContentVersion>(approved) }, attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
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
    expect(out()).toContain('Protection: block')
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
    expect(out()).toContain(`Applied ${id}. Delo runs it now.`)
    expect(terminal.reloads()).toBe(1)
  })

  it('asks a second confirmation naming the kinds when a check found something, and declining it writes nothing', async () => {
    edit('fetch("https://example.invalid/")\n')
    const id = await pendingId()
    const before = written()
    const declines = driven(['y', 'n'])
    expect(await runChanges(['apply', id], context, declines)).toBe(EXIT.ok)
    expect(declines.questions).toEqual([`Apply ${id}? [y/N] `, 'Apply it anyway? [y/N] '])
    expect(out()).toContain("This change opens network connections. A plugin's code can do anything Delo can.")
    expect(out()).toContain('Nothing was changed.')
    expect(written()).toBe(before)
    expect(declines.hosted()).toBe(0)
    const accepts = driven(['y', 'yes'], [undefined])
    expect(await runChanges(['apply', id], context, accepts)).toBe(EXIT.ok)
    expect(out()).toContain(`Applied ${id}. Delo is not running; the next start runs it.`)
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

  it('reports a failed reload, that Delo went back, and when going back also failed', async () => {
    edit('export default 2\n')
    const id = await pendingId()
    expect(await runChanges(['apply', id], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, { ok: false, error: 'still broken' }]))).toBe(EXIT.failed)
    expect(err()).toContain(`delorun changes: Applied ${id}, but Delo failed to load it: SyntaxError\nDelo went back to what ran before, and the change waits for your review again.\n`)
    expect(err()).toContain('Loading what ran before also failed: still broken. Restart Delo: delorun stop, then delorun start.')
    context.errors.length = 0
    expect(await runChanges(['apply', id], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, OK]))).toBe(EXIT.failed)
    expect(err()).not.toContain('also failed')
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
    expect(out()).toContain(`Applied ${request.id}. Delo runs it now.\n`)
    context.printed.length = 0
    expect(await runChanges(['show', request.id], context, driven([]))).toBe(EXIT.ok)
    expect(out()).not.toContain('Apply it:')
    expect(await runChanges(['undo', request.id], context, driven(['y']))).toBe(EXIT.failed)
    expect(err()).toContain('cannot be undone here: The agent asks to install new-plugin@2.0.0. Restore the profile version before it with delorun recover.')
  })

  it('reports an operation that failed, a Host that failed to load, Delo not running, and a folder\'s waiting content', async () => {
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
    expect(err()).toContain(`delorun changes: Applied ${remove.id}, but Delo failed to load it: boom\nThe profile keeps the change; restart Delo, or undo it with delorun recover.\n`)
    const folder = join(base, 'other')
    mkdirSync(folder)
    writeFileSync(join(folder, 'package.json'), '{"name":"other","version":"1.0.0"}\n')
    const linked = await recordPluginRequest(ctx(), { action: 'install', spec: `link:${folder}` })
    context.printed.length = 0
    const terminal = driven(['y'], [undefined])
    expect(await runChanges(['apply', linked.id], context, terminal)).toBe(EXIT.ok)
    const waiting = (await readChangeLog(home, PROFILE)).entries.find(entry => entry.kind === 'plugin-install' && entry.subject.source === folder)!
    expect(out()).toContain(`Applied ${linked.id}. Delo is not running; the next start runs it. Its folder's content waits for your review: delorun changes show ${waiting.id}\n`)
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
    expect(out()).toContain(`Undid ${id}. Delo runs it now.`)
    const again = driven(['y'])
    expect(await runChanges(['undo', id], context, again)).toBe(EXIT.failed)
    expect(again.questions).toEqual([`Undo ${id}: plug? [y/N] `])
  })

  it('turns one plugin off and on, editing only the bundle list', async () => {
    const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    const before = manifest()
    const off = driven(['y'])
    expect(await runChanges(['off', 'plug'], context, off)).toBe(EXIT.ok)
    expect(off.questions).toEqual(['Turn off plug? It stops running until you turn it on again. [y/N] '])
    expect(manifest()).toEqual({ ...before, dsh: { profile: { bundles: [] } } })
    expect(out()).toContain('Turned off plug. Delo runs it now.')
    const on = driven(['y'])
    expect(await runChanges(['on', 'plug'], context, on)).toBe(EXIT.ok)
    expect(on.questions).toEqual(['Turn on plug? [y/N] '])
    expect(manifest()).toEqual(before)
    const declined = driven(['n'])
    await runChanges(['off', 'plug'], context, declined)
    expect(manifest()).toEqual(before)
    expect(await runChanges(['off', '@delo/bundle-local'], context, driven(['y']))).toBe(EXIT.failed)
    expect(err()).toContain("Delo's own bundle")
  })
})

describe('delorun changes work and done', () => {
  it('starts a work session after asking, says where edits load from, and done makes the folder\'s content the approved version', async () => {
    const work = driven(['y'])
    expect(await runChanges(['work', 'plug'], context, work)).toBe(EXIT.ok)
    expect(work.questions).toEqual(['Work on plug? Edits in its folder will load without your review until you run delorun changes done plug. [y/N] '])
    expect(out()).toBe(`Working on plug: edits in ${source} load live until delorun changes done plug.\n`)
    expect(work.reloads()).toBe(1)
    edit('export default 2\n')
    const done = driven(['y'])
    expect(await runChanges(['done', 'plug'], context, done)).toBe(EXIT.ok)
    expect(done.questions).toEqual(['End your work session on plug? What its folder holds becomes the approved version. [y/N] '])
    const entry = (await readChangeLog(home, PROFILE)).entries.at(-1)!
    expect(entry).toMatchObject({ kind: 'plugin-edit', state: 'applied', decidedFrom: 'terminal' })
    expect(out()).toContain(`Your work session on plug ended. The folder's content is now the approved version of plug (${entry.id}).\n`)
    expect((await listChanges(ctx())).workSession).toBeUndefined()
  })

  it('declining either question changes nothing', async () => {
    const before = written()
    expect(await runChanges(['work', 'plug'], context, driven(['n']))).toBe(EXIT.ok)
    expect(await runChanges(['done', 'plug'], context, driven([]))).toBe(EXIT.ok)
    expect(out()).toBe('Nothing was changed.\nNothing was changed.\n')
    expect(written()).toBe(before)
    expect((await listChanges(ctx())).workSession).toBeUndefined()
  })

  it('reports a folder that failed to load at once, a session that stays open, and a plugin it cannot work on', async () => {
    edit('throw new Error("broken")\n')
    expect(await runChanges(['work', 'plug'], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, { ok: false, error: 'still broken' }]))).toBe(EXIT.failed)
    expect(err()).toBe('delorun changes: plug failed to load from its folder: SyntaxError\nDelo runs its approved version; your work session stays open, and the next edit in the folder loads again.\nLoading the approved version also failed: still broken. Restart Delo: delorun stop, then delorun start.\n')
    expect((await listChanges(ctx())).workSession?.plugin).toBe('plug')
    await runChanges(['done', 'plug'], context, driven(['y']))
    context.errors.length = 0
    expect(await runChanges(['work', 'plug'], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, OK]))).toBe(EXIT.failed)
    expect(err()).not.toContain('also failed')
    await runChanges(['done', 'plug'], context, driven(['y']))
    expect(await runChanges(['work', 'plug'], context, driven(['y'], [{ ok: false, error: 'SyntaxError' }, undefined]))).toBe(EXIT.failed)
    expect(err()).not.toContain('also failed')
    await runChanges(['done', 'plug'], context, driven(['y']))
    context.errors.length = 0
    expect(await runChanges(['work', 'left-pad'], context, driven(['y']))).toBe(EXIT.failed)
    expect(err()).toContain('left-pad is not a plugin of the profile default that you approved from a folder')
    expect(await runChanges(['done', 'plug'], context, driven(['y']))).toBe(EXIT.failed)
    expect(err()).toContain('No work session on plug is open in the profile default.')
    await expect(runChanges(['work'], context, driven(['y']))).rejects.toMatchObject({ exit: EXIT.usage })
  })
})

describe('delorun changes protection', () => {
  it('prints the setting without a terminal', async () => {
    expect(await runChanges(['protection'], context, driven([], [], false))).toBe(EXIT.ok)
    expect(out()).toBe('Protection: block: changed plugins run only after you apply their changes.\nChange it in a terminal: delorun changes protection block|warn|off\n')
  })

  it('states what a weaker level means and asks; declining keeps it, and raising it asks nothing', async () => {
    const declined = driven(['n'])
    await runChanges(['protection', 'warn'], context, declined)
    expect(out()).toContain('Changed plugins will run without your review. With warn, changed plugins run without your review, and every start names them.')
    expect(declined.questions).toEqual(['Set protection to warn? [y/N] '])
    expect(await readProtection(home)).toBe('block')
    expect(await runChanges(['protection', 'off'], context, driven(['y']))).toBe(EXIT.ok)
    expect(await readProtection(home)).toBe('off')
    expect(out()).toContain('Protection is off (it was block); the next start uses it.')
    const raised = driven([])
    expect(await runChanges(['protection', 'block'], context, raised)).toBe(EXIT.ok)
    expect(raised.questions).toEqual([])
    expect(await readProtection(home)).toBe('block')
  })
})

describe('every state-changing changes action refuses without a terminal', () => {
  it('refuses apply, discard, undo, off, on, protection, work and done with input or output redirected, and writes nothing', async () => {
    edit('export default 2\n')
    const id = await pendingId()
    const upgrade = (await readChangeLog(home, PROFILE)).entries[0]!
    const before = written()
    for (const args of [['apply', id], ['discard', id], ['undo', upgrade.id], ['off', 'plug'], ['on', 'left-pad'], ['protection', 'off'], ['work', 'plug'], ['done', 'plug']]) {
      const terminal = driven(['y', 'y'], [OK], false)
      await expect(runChanges(args, context, terminal)).rejects.toThrow(`delorun changes: ${NOT_AT_TERMINAL}`)
      expect(terminal.questions).toEqual([])
      expect(terminal.hosted()).toBe(0)
    }
    expect(written()).toBe(before)
    expect(await readProtection(home)).toBe('block')
  })
})

describe('the Host while delorun changes runs', () => {
  it('holds the profile home lock while Delo does not run, and reports that it does not run', async () => {
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
      chats, failedRows: () => [], rows: () => [], studio: () => undefined, studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }),
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
