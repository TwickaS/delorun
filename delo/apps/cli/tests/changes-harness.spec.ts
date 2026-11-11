/**
 * Changes to the harness itself through `delorun` (contract C21, "Harness edits"): which installation's entry a start
 * runs, the start's hand-off to the composed tree, the runtime a composed tree's file runs, `delorun changes
 * edit-harness` and the harness decisions at a terminal, the retry that leaves a harness change out, and what `verify`
 * and `doctor` say about the composed tree.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyHarnessChange, attestTerminal, ChangesError, createHarnessCopy, harnessChanges, harnessCopyDirectory, harnessStatus, prepareComposedTree, readHarnessLog, readHarnessRecord, TREE_RETENTION_GRACE_MS, type ChangeId, type ContentVersion, type HarnessContext, type HarnessStatus, type SignedFile, type SignedRuntime } from '@delo/changes'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { ensureHomeTree } from '@delo/home'
import { RuntimeStoreError } from '@delo/runtime-store'
import { runChanges, type ChangesCommandDependencies } from '../src/changes/command.ts'
import { NOT_INSTALLED } from '../src/changes/harness-command.ts'
import { handOffToComposedTree, outputLogger, quietOutput, signedRootOf, startEntry, type HandOffDependencies } from '../src/changes/harness-start.ts'
import { startRetry } from '../src/changes/retry.ts'
import type { CommandContext } from '../src/command.ts'
import { harnessLines } from '../src/doctor/changes.ts'
import { CliError, EXIT } from '../src/exit.ts'
import { startForeground, type StartDependencies } from '../src/start.ts'
import { runtimeOfFile } from '../src/update/runtime.ts'
import { changesExit, changesLines, changesSuffix, readVerifyChanges, type VerifyChanges } from '../src/verify/changes.ts'

vi.setConfig({ testTimeout: 60_000 })

const RUNTIME = '1.2.3'
const PROFILE = 'default'
const ENTRY = 'app/node_modules/@delo/cli/src/bin.js'
const START_FILE = 'app/node_modules/@delo/cli/src/start.js'
const FILES: Readonly<Record<string, string>> = {
  'node/bin/node': '#!/bin/sh\n',
  [ENTRY]: 'import "./start.js"\n',
  [START_FILE]: 'export const start = 1\n',
  'app/package.json': '{}\n',
}

let base: string
let home: string
let signed: SignedRuntime
let context: CommandContext & { readonly printed: string[], readonly errors: string[] }

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-harness-')))
  home = join(base, '.delo')
  vi.stubEnv('HOME', base)
  vi.stubEnv('USERPROFILE', base)
  vi.stubEnv('DSH_HOME', join(base, '.dsh'))
  vi.stubEnv('DELO_HOME', undefined)
  vi.stubEnv('DELO_PROFILE', undefined)
  mkdirSync(home, { mode: 0o700 })
  await ensureHomeTree(home, PROFILE)
  mkdirSync(join(home, 'profiles', PROFILE), { recursive: true })
  writeFileSync(join(home, 'profiles', PROFILE, 'package.json'), '{"name":"dsh-profile-default","private":true}\n')
  const directory = join(home, 'runtimes', RUNTIME)
  const files: SignedFile[] = []
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), text)
    if (path === 'node/bin/node') chmodSync(join(directory, path), 0o755)
    files.push({ path, length: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), executable: path === 'node/bin/node' })
  }
  signed = { directory, files }
  const printed: string[] = []
  const errors: string[] = []
  context = { env: { HOME: base, DSH_HOME: join(base, '.dsh'), DELO_HOME: home }, stdout: text => void printed.push(text), stderr: text => void errors.push(text), printed, errors }
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const tree of [join(home, 'changes', 'harness', RUNTIME, 'run')]) if (existsSync(tree)) chmodTree(tree)
  rmSync(base, { recursive: true, force: true })
})

/**
 * Give a composed tree's directories their write permission back, so the spec's directory can be removed.
 * @param root - the tree.
 */
function chmodTree(root: string): void {
  chmodSync(root, 0o700)
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) chmodTree(join(root, entry.name))
}

/** @returns the harness of the installed runtime. */
function harness(): HarnessContext {
  return { home, runtime: RUNTIME, signed: () => Promise.resolve(signed) }
}

/** @returns a terminal proof. */
function terminal(): ReturnType<typeof attestTerminal> {
  return attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
}

/**
 * Edit the start file in the copy.
 * @param text - its new text.
 * @returns the id of the change waiting for review.
 */
async function editStart(text = 'export const start = 2\n'): Promise<ChangeId> {
  await createHarnessCopy(harness(), terminal())
  writeFileSync(join(harnessCopyDirectory(home, RUNTIME), ...START_FILE.split('/')), text)
  return (await harnessChanges(harness())).changes[0]!.id
}

/**
 * A hand-off from the signed installation whose child is recorded, not started.
 * @param overrides - what a case changes.
 * @returns the dependencies and the commands the child would have run.
 */
function handOff(overrides: Partial<HandOffDependencies> = {}): HandOffDependencies & { readonly started: { readonly node: string, readonly args: readonly string[], readonly stdio: unknown, readonly env: unknown }[] } {
  const started: { node: string, args: readonly string[], stdio: unknown, env: unknown }[] = []
  return {
    runtime: runtimeOfFile(home, join(signed.directory, ...ENTRY.split('/'))),
    running: { node: join(signed.directory, 'node', 'bin', 'node'), entry: join(signed.directory, ...ENTRY.split('/')) },
    args: ['start', '--foreground'],
    signed: () => Promise.resolve(signed),
    run: (command, env, stdio) => {
      started.push({ ...command, stdio, env })
      return Promise.resolve(EXIT.ok)
    },
    handover: () => false,
    homeProcessRuns: () => false,
    started,
    ...overrides,
  }
}

/** A terminal that answers in order, and no Host. */
function terminalAnswering(answers: readonly string[], tty = true, withHarness = true): ChangesCommandDependencies & { readonly questions: string[] } {
  const queue = [...answers]
  const questions: string[] = []
  return {
    streams: { stdin: { isTTY: tty }, stdout: { isTTY: tty } },
    ask: (question) => {
      questions.push(question)
      return Promise.resolve(queue.shift() ?? '')
    },
    withHost: (_home, _profile, run) => run(() => Promise.resolve(undefined)),
    pluginOperation: () => () => Promise.reject(new Error('no plugin operation')),
    harness: () => withHarness ? harness() : undefined,
    questions,
  }
}

describe('which entry a start runs', () => {
  it('a process in a composed tree starts the signed installation\'s entry, and the hand-off the composed tree\'s', () => {
    const tree = join(home, 'changes', 'harness', RUNTIME, 'run', 'a'.repeat(64))
    const signedEntry = { node: join(signed.directory, 'node', 'bin', 'node'), entry: join(signed.directory, ...ENTRY.split('/')) }
    const composedEntry = { node: join(tree, 'node', 'bin', 'node'), entry: join(tree, ...ENTRY.split('/')) }
    expect(startEntry(composedEntry)).toEqual(signedEntry)
    expect(startEntry(signedEntry)).toEqual(signedEntry)
    expect(startEntry(signedEntry, tree)).toEqual(composedEntry)
    expect(startEntry({ node: '/usr/bin/node', entry: composedEntry.entry })).toEqual({ node: '/usr/bin/node', entry: signedEntry.entry })
    const checkout = { node: '/usr/bin/node', entry: join(base, 'delo', 'apps', 'cli', 'src', 'bin.ts') }
    expect(startEntry(checkout, tree)).toEqual(checkout)
  })

  it('only a composed tree under changes/harness/<version>/run/<digest> maps to an installation', () => {
    expect(signedRootOf(join(home, 'changes', 'harness', RUNTIME, 'run', 'a'.repeat(64)))).toBe(signed.directory)
    for (const root of [join(home, 'changes', 'harness', 'x', 'run', 'a'.repeat(64)), join(home, 'changes', 'harness', RUNTIME, 'copy', 'a'.repeat(64)), join(home, 'changes', 'harness', RUNTIME, 'run', 'b'), join(home, 'other', 'harness', RUNTIME, 'run', 'a'.repeat(64)), join(home, 'changes', 'other', RUNTIME, 'run', 'a'.repeat(64)), signed.directory]) {
      expect(signedRootOf(root), root).toBeUndefined()
    }
  })

  it('runtimeOfFile maps a composed path to its runtime', () => {
    const tree = join(home, 'changes', 'harness', RUNTIME, 'run', 'c'.repeat(64))
    expect(runtimeOfFile(home, join(tree, ...ENTRY.split('/')))).toEqual({ version: RUNTIME, store: true, composed: tree })
    expect(runtimeOfFile(home, join(signed.directory, ...ENTRY.split('/')))).toEqual({ version: RUNTIME, store: true })
    for (const file of [join(tree), join(home, 'changes', 'harness', RUNTIME, 'run', 'short', 'x.js'), join(home, 'changes', 'harness', RUNTIME, 'copy', 'c'.repeat(64), 'x.js'), join(home, 'changes', 'harness', 'not-a-version', 'run', 'c'.repeat(64), 'x.js'), join(home, 'runtimes', 'not-a-version', 'x.js')]) {
      expect(runtimeOfFile(home, file).store, file).toBe(false)
    }
  })
})

describe('the start\'s hand-off to the composed tree', () => {
  it('a pending harness change never runs: the start runs the signed entry', async () => {
    await editStart()
    const dependencies = handOff()
    expect(await handOffToComposedTree({ home, env: context.env, output: context }, dependencies)).toBeUndefined()
    expect(dependencies.started).toEqual([])
    expect(existsSync(join(home, 'changes', 'harness', RUNTIME, 'run'))).toBe(false)
  })

  it('an applied change runs: the start hands off to the composed tree\'s entry with the same arguments', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    const dependencies = handOff({ handover: () => true })
    expect(await handOffToComposedTree({ home, env: { ...context.env, MARK: '1' }, output: context }, dependencies)).toEqual({ ran: EXIT.ok })
    const [child] = dependencies.started
    const tree = join(home, 'changes', 'harness', RUNTIME, 'run', readdirSync(join(home, 'changes', 'harness', RUNTIME, 'run'))[0]!)
    expect(child).toEqual({ node: join(tree, 'node', 'bin', 'node'), args: [join(tree, ...ENTRY.split('/')), 'start', '--foreground'], stdio: ['inherit', 'inherit', 'inherit', 3], env: { ...context.env, MARK: '1' } })
    expect(readFileSync(join(tree, START_FILE), 'utf8')).toBe('export const start = 2\n')
    expect(readFileSync(join(signed.directory, START_FILE), 'utf8')).toBe(FILES[START_FILE])
    const again = handOff()
    await handOffToComposedTree({ home, env: context.env, output: context }, again)
    expect(again.started[0]?.stdio).toBe('inherit')
  })

  it('a process already in a composed tree, or outside the store, runs the start itself', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    const tree = join(home, 'changes', 'harness', RUNTIME, 'run', 'd'.repeat(64))
    for (const runtime of [runtimeOfFile(home, join(tree, ...ENTRY.split('/'))), runtimeOfFile(home, join(base, 'checkout', 'bin.js'))]) {
      const dependencies = handOff({ runtime })
      expect(await handOffToComposedTree({ home, env: context.env, output: context }, dependencies)).toBeUndefined()
      expect(dependencies.started).toEqual([])
    }
  })

  it('discarding every harness change returns to the signed release: the start runs the signed entry', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    const answers = terminalAnswering(['y'])
    expect(await runChanges(['edit-harness', '--discard'], context, answers)).toBe(EXIT.ok)
    expect(answers.questions).toEqual([`Discard every change to Delo ${RUNTIME} itself? It returns to the signed release. [y/N] `])
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
    const dependencies = handOff()
    expect(await handOffToComposedTree({ home, env: context.env, output: context }, dependencies)).toBeUndefined()
    expect(dependencies.started).toEqual([])
  })

  it('discarding every harness change from a copy that cannot be read removes it and says why', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    chmodSync(join(harnessCopyDirectory(home, RUNTIME), 'app', 'node_modules'), 0o000)
    expect(await runChanges(['edit-harness', '--discard'], context, terminalAnswering(['y']))).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain(`Discarded 0 waiting and undid 1 applied changes to Delo ${RUNTIME}`)
    expect(context.printed.join('')).toContain(`Your copy of Delo ${RUNTIME} could not be read, so the changes waiting in it were removed with it without being listed: EACCES`)
    expect(existsSync(harnessCopyDirectory(home, RUNTIME))).toBe(false)
  })

  it('refuses the start when the signed installation or the composed tree fails its check', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    const store = handOff({ signed: () => Promise.reject(new RuntimeStoreError('RUNTIME_CHANGED', signed.directory, 'runtime 1.2.3 differs from its signed file list')) })
    await expect(handOffToComposedTree({ home, env: context.env, output: context }, store)).rejects.toThrow(new CliError(EXIT.failed, 'delorun: Delo 1.2.3 was not started, because its files differ from the signed release: runtime 1.2.3 differs from its signed file list. See what differs with: delorun verify'))
    rmSync(join(home, 'changes', 'store', 'objects'), { recursive: true })
    await expect(handOffToComposedTree({ home, env: context.env, output: context }, handOff())).rejects.toThrow(/was not started with your changes to it/u)
    await expect(handOffToComposedTree({ home, env: context.env, output: context }, handOff({ signed: () => Promise.reject(new Error('disk')) }))).rejects.toThrow('disk')
    expect(existsSync(signed.directory)).toBe(true)
  })

  it('keeps other composed trees while a home process runs, and reports a tree it could not remove', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    await handOffToComposedTree({ home, env: context.env, output: context }, handOff())
    writeFileSync(join(harnessCopyDirectory(home, RUNTIME), ...START_FILE.split('/')), 'export const start = 3\n')
    await applyHarnessChange(harness(), (await harnessChanges(harness())).changes[0]!.id, terminal())
    await handOffToComposedTree({ home, env: context.env, output: context }, handOff({ homeProcessRuns: () => true }))
    const runs = join(home, 'changes', 'harness', RUNTIME, 'run')
    expect(readdirSync(runs)).toHaveLength(2)
    const longAgo = new Date(Date.now() - TREE_RETENTION_GRACE_MS - 60_000)
    for (const name of readdirSync(runs)) utimesSync(join(runs, name), longAgo, longAgo)
    mkdirSync(join(home, 'changes', 'harness', '0.9.0'))
    chmodSync(join(home, 'changes', 'harness'), 0o500)
    try {
      await handOffToComposedTree({ home, env: context.env, output: context }, handOff())
    } finally {
      chmodSync(join(home, 'changes', 'harness'), 0o700)
    }
    expect(readdirSync(runs)).toHaveLength(1)
    expect(context.errors.join('')).toContain(`Delo could not remove ${join(home, 'changes', 'harness', '0.9.0')}`)
  })

  it('a foreground start that handed off returns what the composed tree\'s start returned and runs nothing itself', async () => {
    const unreached = (): never => { throw new Error('not reached') }
    const dependencies = { handOff: () => Promise.resolve({ ran: EXIT.changeLeftOut }), prepareProfile: unreached, runProfile: unreached, onExit: unreached, handover: unreached } as Partial<StartDependencies>
    expect(await startForeground({ home, profile: PROFILE, open: false, output: context, env: context.env }, dependencies as StartDependencies)).toBe(EXIT.changeLeftOut)
  })
})

describe('delorun changes edit-harness', () => {
  it('makes the writable copy once and names its folder', async () => {
    expect(await runChanges(['edit-harness'], context, terminalAnswering([]))).toBe(EXIT.ok)
    const copy = join(harnessCopyDirectory(home, RUNTIME), 'app')
    expect(context.printed.join('')).toContain(`Your copy of Delo ${RUNTIME} is in ${copy}.`)
    expect(readFileSync(join(copy, 'node_modules/@delo/cli/src/start.js'), 'utf8')).toBe(FILES[START_FILE])
    context.printed.length = 0
    expect(await runChanges(['edit-harness'], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(context.printed.join('')).toBe(`Your copy of Delo ${RUNTIME} is in ${copy}; nothing was changed.\n`)
  })

  it('edit-harness and every harness decision refuse without a terminal', async () => {
    const id = await editStart()
    for (const args of [['edit-harness'], ['edit-harness', '--discard'], ['apply', id], ['discard', id], ['undo', id]]) {
      await expect(runChanges(args, context, terminalAnswering(['y', 'y'], false)), args.join(' ')).rejects.toThrow('This needs you at your computer: run it in a terminal.')
    }
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
    expect((await readHarnessLog(home)).entries).toEqual([])
  })

  it('refuses in a source checkout, where there is no installed release to change', async () => {
    await expect(runChanges(['edit-harness'], context, terminalAnswering([], true, false))).rejects.toThrow(`delorun changes: ${NOT_INSTALLED}`)
    await expect(runChanges(['edit-harness', 'extra'], context, terminalAnswering([]))).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(runChanges(['edit-harness', '--force'], context, terminalAnswering([]))).rejects.toMatchObject({ exit: EXIT.usage })
  })

  it('discarding every change asks first, and a no changes nothing', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    expect(await runChanges(['edit-harness', '--discard'], context, terminalAnswering(['n']))).toBe(EXIT.ok)
    expect(Object.keys((await readHarnessRecord(home, RUNTIME)).files)).toEqual([START_FILE])
  })
})

describe('harness changes through delorun changes', () => {
  it('lists, shows, applies, discards and undoes a change to Delo itself by its id', async () => {
    const id = await editStart('import { spawn } from "node:child_process"\nexport const start = spawn\n')
    expect(await runChanges(['list'], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain(`  ${id}  Delo ${RUNTIME} itself: ${START_FILE} (modified)`)
    context.printed.length = 0
    expect(await runChanges(['show', id, '--diff'], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain('+export const start = spawn')
    const answers = terminalAnswering(['y', 'y'])
    expect(await runChanges(['apply', id], context, answers)).toBe(EXIT.ok)
    expect(answers.questions).toEqual([`Apply ${id}? [y/N] `, 'Apply it anyway? [y/N] '])
    expect(context.printed.join('')).toContain(`Applied ${id}. Delo runs it from its next start.`)
    expect((await readHarnessRecord(home, RUNTIME)).files[START_FILE]?.change).toBe(id)
    expect(await runChanges(['show', id, '--json'], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(await runChanges(['undo', id], context, terminalAnswering(['y']))).toBe(EXIT.ok)
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
    writeFileSync(join(harnessCopyDirectory(home, RUNTIME), ...START_FILE.split('/')), 'export const start = 4\n')
    const next = (await harnessChanges(harness())).changes[0]!.id
    expect(await runChanges(['discard', next], context, terminalAnswering(['y']))).toBe(EXIT.ok)
    expect(readFileSync(join(harnessCopyDirectory(home, RUNTIME), ...START_FILE.split('/')), 'utf8')).toBe(FILES[START_FILE])
    expect((await readHarnessLog(home)).entries.map(entry => entry.state)).toEqual(['undone', 'discarded'])
  })

  it('a logged harness change reads in a source checkout, and an unknown id is still unknown', async () => {
    const id = await editStart()
    await applyHarnessChange(harness(), id, terminal())
    expect(await runChanges(['show', id], context, terminalAnswering([], true, false))).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain(`Change ${id}: Delo ${RUNTIME} itself: ${START_FILE}`)
    expect(await runChanges(['show', 'c0123456789'], context, terminalAnswering([]))).toBe(EXIT.failed)
    expect(context.errors.join('')).toContain('No change has the id c0123456789')
  })
})

describe('a start that fails right after a harness change', () => {
  it('the retry leaves out a newest harness change, marks it left out and writes nothing to the profile', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    const manifest = readFileSync(join(home, 'profiles', PROFILE, 'package.json'), 'utf8')
    const warnings: string[] = []
    const retry = startRetry({ home, profile: PROFILE, env: {}, successor: false, output: context, logger: { error: () => {}, warn: message => void warnings.push(message), info: () => {}, debug: () => {} }, runtime: RUNTIME })
    await retry.checkRows([])
    const thrown = await retry.afterFailure(new Error('SyntaxError: Unexpected token')).then(() => undefined, (error: unknown) => error)
    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).exit).toBe(EXIT.changeLeftOut)
    expect((thrown as CliError).message).toContain(`Delo did not start with your latest change to Delo itself (${START_FILE})`)
    expect((await readHarnessLog(home)).entries[0]).toMatchObject({ state: 'left-out-at-start', decidedFrom: 'start', leftOut: { failure: 'SyntaxError: Unexpected token' } })
    expect(readFileSync(join(home, 'profiles', PROFILE, 'package.json'), 'utf8')).toBe(manifest)
    expect(existsSync(join(home, 'changes', 'profiles', PROFILE, 'log.json'))).toBe(false)
    expect(warnings).toEqual([])
  })
})

describe('verify and doctor', () => {
  /**
   * The harness's report with its composed tree built and then changed.
   * @returns the report.
   */
  async function tampered(): Promise<HarnessStatus> {
    await applyHarnessChange(harness(), await editStart(), terminal())
    const tree = (await prepareComposedTree(home, RUNTIME, signed))!.directory
    chmodSync(join(tree, 'app'), 0o755)
    writeFileSync(join(tree, 'app', 'extra.js'), 'extra\n')
    return harnessStatus(home, RUNTIME, signed)
  }

  it('verify never prints a plain pass when the composed tree fails its check', async () => {
    const changes = await readVerifyChanges(home, PROFILE, true, { runtime: RUNTIME, signed })
    expect(changes.harness?.tree.kind).toBe('signed')
    const failed: VerifyChanges = { ...changes, harness: await tampered() }
    expect(changesLines(failed)).toContain(`  Delo ${RUNTIME} itself: ${START_FILE}`)
    expect(changesLines(failed)).toContain('Not as Changes keeps it:')
    expect(changesSuffix(failed)).toContain('1 part of your changes is not as Changes keeps them')
    expect(changesExit(failed)).toBe(EXIT.failed)
    expect(changesExit({ ...failed, harness: { ...failed.harness!, tree: { kind: 'passed', directory: 'x' } } })).toBe(EXIT.ok)
  })

  it('verify counts approved harness files and names the ones waiting for review, also without a profile', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    writeFileSync(join(harnessCopyDirectory(home, RUNTIME), 'app', 'added.js'), 'export {}\n')
    const changes = await readVerifyChanges(home, PROFILE, true, { runtime: RUNTIME, signed })
    expect(changesLines(changes)).toContain('1 change you approved:')
    expect(changesLines(changes)).toContain(`Your approved changes to Delo ${RUNTIME} itself run from its next start.`)
    expect(changesLines(changes)).toContain(`Delo ${RUNTIME} itself: app/added.js waits for your review`)
    expect(changesSuffix(changes)).toContain('1 change you have not approved is present')
    const unset = { ...changes, status: null }
    expect(changesLines(unset)).toContain('1 change you approved:')
    expect(changesLines(unset)).toContain('Not approved:')
    expect(changesLines({ ...unset, harness: { ...changes.harness!, approved: [], pending: [], tree: { kind: 'not-checked', directory: 'x' } } })).toContain('was not checked, because the signed release did not verify')
  })

  it('doctor reports the approved files, the copy, the changes waiting and the composed tree', async () => {
    const status = await tampered()
    const lines = harnessLines(status)
    expect(lines.map(line => line.status)).toEqual(['pass', 'pass', 'fail'])
    expect(lines[0]!.message).toContain(START_FILE)
    const states: HarnessStatus['tree'][] = [{ kind: 'signed' }, { kind: 'not-built', directory: 'x' }, { kind: 'passed', directory: 'x' }, { kind: 'not-checked', directory: 'x' }]
    expect(states.map(tree => harnessLines({ ...status, approved: [], tree }).at(-1)?.status)).toEqual(['pass', 'pass', 'pass', 'warn'])
  })
})

describe('every path of the harness commands', () => {
  it('declining a question changes nothing, and each refusal of Changes is printed', async () => {
    const id = await editStart()
    for (const args of [['apply', id], ['discard', id], ['undo', id]]) {
      expect(await runChanges(args, context, terminalAnswering(['n'])), args.join(' ')).toBe(EXIT.ok)
    }
    expect(context.printed.join('')).toContain('Nothing was changed.')
    expect(await runChanges(['undo', id], context, terminalAnswering(['y']))).toBe(EXIT.failed)
    expect(context.errors.join('')).toContain(`No applied change has the id ${id}`)
    writeFileSync(join(harnessCopyDirectory(home, RUNTIME), ...START_FILE.split('/')), 'import { spawn } from "node:child_process"\nspawn("x")\n')
    const risky = (await harnessChanges(harness())).changes[0]!.id
    expect(await runChanges(['apply', risky], context, terminalAnswering(['y', 'n']))).toBe(EXIT.ok)
    expect((await readHarnessRecord(home, RUNTIME)).files).toEqual({})
    writeFileSync(join(home, 'changes', 'harness', RUNTIME, 'approved.json'), '{}\n', { mode: 0o600 })
    expect(await runChanges(['edit-harness', '--discard'], context, terminalAnswering(['y']))).toBe(EXIT.failed)
    expect(context.errors.join('')).toContain('approved.json')
    rmSync(join(home, 'changes', 'harness', RUNTIME, 'approved.json'))
    rmSync(signed.directory, { recursive: true })
    rmSync(harnessCopyDirectory(home, RUNTIME), { recursive: true })
    expect(await runChanges(['edit-harness'], context, terminalAnswering([]))).toBe(EXIT.failed)
    expect(context.errors.join('')).toContain('cannot be read as the signed release\'s file')
  })

  it('a change left out at start is shown, applied again, discarded only while waiting, and undone by its id', async () => {
    let now = Date.parse('2026-11-11T10:00:00.000Z')
    const clocked: HarnessContext = { ...harness(), now: () => new Date(now) }
    const id = await editStart()
    await applyHarnessChange(clocked, id, terminal())
    now += 1000
    const retry = startRetry({ home, profile: PROFILE, env: {}, successor: false, output: context, logger: outputLogger(quietOutput()), runtime: RUNTIME })
    await retry.afterFailure(new Error('boom')).catch(() => undefined)
    expect(await runChanges(['list'], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain('Left out because Delo did not start with them:')
    expect(await runChanges(['show', id], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain('A start left it out at')
    expect(await runChanges(['discard', id], context, terminalAnswering(['y']))).toBe(EXIT.failed)
    expect(await runChanges(['apply', id], context, terminalAnswering(['n']))).toBe(EXIT.ok)
    expect(await runChanges(['apply', id], context, terminalAnswering(['y']))).toBe(EXIT.ok)
    expect((await readHarnessLog(home)).entries.find(entry => entry.id === id)?.state).toBe('applied')
    expect(await runChanges(['undo', id], context, terminalAnswering(['y']))).toBe(EXIT.ok)
  })

  it('show and apply of a change whose copy changes while it is read are refused, and JSON shows a waiting change', async () => {
    const id = await editStart()
    expect(await runChanges(['show', id, '--json'], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(JSON.parse(context.printed.at(-1)!)).toMatchObject({ kind: 'harness', change: { id, file: START_FILE } })
    const target = { kind: 'pending' as const, change: (await harnessChanges(harness())).changes[0]! }
    writeFileSync(join(harnessCopyDirectory(home, RUNTIME), ...START_FILE.split('/')), 'moved on\n')
    const { showHarness } = await import('../src/changes/harness-command.ts')
    await expect(showHarness(harness(), target, false, false, context)).rejects.toThrow('changed in your copy of Delo while it was read')
  })

  it('list names a copy it cannot read, the copy\'s folder, its skipped entries and the files kept beside', async () => {
    await editStart()
    const copy = harnessCopyDirectory(home, RUNTIME)
    writeFileSync(join(copy, 'outside.txt'), 'x\n')
    writeFileSync(join(copy, 'app', 'start.js.mine'), 'mine\n')
    expect(await runChanges(['list'], context, terminalAnswering([]))).toBe(EXIT.ok)
    const listed = context.printed.join('')
    expect(listed).toContain(`Your copy of Delo ${RUNTIME} is in ${join(copy, 'app')}`)
    expect(listed).toContain('Not changes, because they are not regular files under app/: outside.txt')
    expect(listed).toContain('Kept beside a file an update could not merge: app/start.js.mine')
    expect(await runChanges(['list', '--json'], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(JSON.parse(context.printed.at(-1)!).harness.changes).toHaveLength(1)
    const broken: HarnessContext = { ...harness(), signed: () => Promise.reject(new ChangesError('RUNTIME_CHANGED', signed.directory, 'the installation differs')) }
    context.printed.length = 0
    expect(await runChanges(['list'], context, { ...terminalAnswering([]), harness: () => broken })).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain('Your copy of Delo could not be read: the installation differs')
    expect(await runChanges(['list', '--json'], context, { ...terminalAnswering([]), harness: () => broken })).toBe(EXIT.ok)
    expect(JSON.parse(context.printed.at(-1)!).harness.problem).toBe('the installation differs')
    await expect(runChanges(['list'], context, { ...terminalAnswering([]), harness: () => ({ ...harness(), signed: () => Promise.reject(new Error('disk')) }) })).rejects.toThrow('disk')
  })

  it('a start\'s runtime check that refuses its composed tree stops the start with the reason', async () => {
    const { startChanges } = await import('../src/changes/start.ts')
    const refused = startChanges({ home, profile: PROFILE, runtime: { version: brandString<RuntimeVersion>(RUNTIME), check: () => Promise.reject(new ChangesError('HARNESS_CHANGED', 'x', 'x is a file Delo did not put there')) } }, () => {})
    await expect(refused).rejects.toThrow(new CliError(EXIT.failed, `delorun: Delo ${RUNTIME} was not started with your changes to it: x is a file Delo did not put there`))
  })

  it('a hand-off whose records change while it checks the installation runs the start itself', async () => {
    await applyHarnessChange(harness(), await editStart(), terminal())
    const { discardAllHarnessChanges } = await import('@delo/changes')
    const dependencies = handOff({ signed: async () => {
      await discardAllHarnessChanges(harness(), terminal())
      return signed
    } })
    expect(await handOffToComposedTree({ home, env: context.env, output: context }, dependencies)).toBeUndefined()
    expect(dependencies.started).toEqual([])
  })

  it('doctor names each change waiting, each change left out and how many files were approved', async () => {
    const status: HarnessStatus = {
      runtime: RUNTIME,
      approved: [{ file: 'app/a.js', change: 'c0000000001' as ChangeId }, { file: 'app/b.js', change: 'c0000000002' as ChangeId }],
      pending: [{ id: 'c0000000003' as ChangeId, kind: 'harness-edit', runtime: RUNTIME, file: 'app/c.js', status: 'added', from: 'a'.repeat(64) as ContentVersion, to: 'b'.repeat(64) as ContentVersion }],
      leftOut: [{ id: 'c0000000004' as ChangeId, kind: 'harness-edit', state: 'left-out-at-start', subject: { file: 'app/a.js', runtime: RUNTIME }, summary: 'x', createdAt: '2026-11-11T10:00:00.000Z', decidedAt: '2026-11-11T10:00:00.000Z', leftOut: { at: '2026-11-11T10:00:00.000Z', failure: 'boom' } }],
      tree: { kind: 'signed' },
    }
    const lines = harnessLines(status)
    expect(lines.map(line => line.status)).toEqual(['pass', 'warn', 'warn'])
    expect(lines[0]!.message).toContain('2 files')
    expect(lines[2]!.message).toContain('Delo itself (app/a.js) runs without change c0000000004')
    const { checkChanges } = await import('../src/doctor/changes.ts')
    expect((await checkChanges(context.env, PROFILE, () => Promise.resolve(status))).slice(-3)).toEqual(lines)
    expect((await checkChanges(context.env, 'missing', () => Promise.resolve(status))).slice(-3)).toEqual(lines)
  })
})

describe('the rest of the harness commands\' paths', () => {
  it('a binary file Node loads asks the second confirmation naming it, and a logged change without a decision time reads', async () => {
    await createHarnessCopy(harness(), terminal())
    writeFileSync(join(harnessCopyDirectory(home, RUNTIME), 'app', 'native.js'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    const id = (await harnessChanges(harness())).changes[0]!.id
    expect(await runChanges(['apply', id], context, terminalAnswering(['y', 'y']))).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain('Not shown: app/native.js')
    const log = await readHarnessLog(home)
    const { decidedAt: _decidedAt, ...undecided } = log.entries[0]!
    const { writeHarnessLog } = await import('@delo/changes')
    await writeHarnessLog(home, { ...log, entries: [{ ...undecided, id: 'c00000000b1' as ChangeId, state: 'undone' }, ...log.entries] })
    expect(await runChanges(['show', 'c00000000b1'], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain('State: undone\n')
    expect(await runChanges(['list'], context, terminalAnswering([]))).toBe(EXIT.ok)
    expect(context.printed.join('')).toContain('Changes to Delo itself, newest first:')
  })

  it('a profile record Delo cannot read is reported before any harness change is looked up, and an unexpected failure is thrown', async () => {
    const id = await editStart()
    mkdirSync(join(home, 'changes', 'profiles', PROFILE), { recursive: true, mode: 0o700 })
    writeFileSync(join(home, 'changes', 'profiles', PROFILE, 'log.json'), 'not json', { mode: 0o600 })
    expect(await runChanges(['show', id], context, terminalAnswering([]))).toBe(EXIT.failed)
    rmSync(join(home, 'changes', 'profiles', PROFILE, 'log.json'))
    rmSync(harnessCopyDirectory(home, RUNTIME), { recursive: true })
    await expect(runChanges(['edit-harness'], context, { ...terminalAnswering([]), harness: () => ({ ...harness(), signed: () => Promise.reject(new Error('disk')) }) })).rejects.toThrow('disk')
  })

  it('a home process of any profile keeps the other composed trees, and a closed descriptor is no handover', async () => {
    const { registerDataUser } = await import('../src/home-exclusion.ts')
    const { processHandOff, isOpen } = await import('../src/changes/harness-start.ts')
    const unregister = registerDataUser(home, 'shared', 'start', process.ppid, PROFILE)
    try {
      expect(processHandOff(runtimeOfFile(home, join(signed.directory, ...ENTRY.split('/'))), context).homeProcessRuns(home)).toBe(true)
    } finally {
      unregister()
    }
    expect(isOpen(1023)).toBe(false)
  })
})
