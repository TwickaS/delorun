/**
 * The `changes` lines of `delorun doctor` (contract C21): the protection setting, the work session, one line per plugin
 * under Changes, the cause of a failed start or load named with the change to undo, each pending change and each
 * invariant that does not hold.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeDirectory,
  attestTerminal,
  bootRecordPath,
  changesStatus,
  enforceApprovedContent,
  openWorkSession,
  readApproved,
  readChangeLog,
  setProtection,
  versionsDirectory,
  workFailurePath,
  writeBootRecord,
  writeWorkFailure,
  type BootRow,
  type ChangesStatus,
} from '@delo/changes'
import { changesLines, checkChanges } from '../../src/doctor/changes.ts'
import type { CheckResult } from '../../src/doctor/checks.ts'
import { doctorCommand } from '../../src/doctor/index.ts'
import { EXIT } from '../../src/exit.ts'

// Each case writes real git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 180_000 })

const PROFILE = 'default'
const TERMINAL = { stdin: { isTTY: true }, stdout: { isTTY: true } }
const NONE_REGISTERED = 'it registers nothing that changes a consent, a guard or the sandbox policy'

let base: string
let home: string
let profileDir: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-doctor-changes-')))
  home = join(base, '.delo')
  mkdirSync(home, { mode: 0o700 })
  profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"dsh-profile-default","private":true,"dependencies":{}}\n')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

/**
 * A plugin folder linked into the profile, as `delorun plugin add link:<folder>` leaves it.
 * @param name - the package name and folder name.
 * @param files - the folder's files besides `package.json`, and `package.json` to replace the default.
 * @returns the folder.
 */
function linkPlugin(name: string, files: Readonly<Record<string, string>> = {}): string {
  const folder = join(base, name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), `{"name":"${name}","version":"1.0.0"}\n`)
  writeFileSync(join(folder, 'index.js'), 'export default 1\n')
  for (const [path, text] of Object.entries(files)) writeFileSync(join(folder, path), text)
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies[name] = `link:${folder}`
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  symlinkSync(relative(join(profileDir, 'node_modules'), folder), join(profileDir, 'node_modules', name))
  return folder
}

/** Run Changes' part of a start. */
async function start(): Promise<void> {
  await enforceApprovedContent({ home, profile: PROFILE, profileDir })
}

/**
 * @param rows - the Loader's rows.
 * @param failure - the start's failure.
 */
async function booted(rows: readonly BootRow[], failure?: string): Promise<void> {
  await writeBootRecord({ home, profile: PROFILE, profileDir, rows, ...failure === undefined ? {} : { failure } })
}

/**
 * @returns the `changes` lines for the fixture profile.
 */
async function lines(): Promise<CheckResult[]> {
  return checkChanges({ DELO_HOME: home }, PROFILE)
}

/**
 * @param plugin - a package name.
 * @returns the id and summary of the plugin's approval at upgrade.
 */
async function upgradeOf(plugin: string): Promise<{ id: string, summary: string }> {
  const entry = (await readChangeLog(home, PROFILE)).entries.find(candidate => candidate.subject.plugin === plugin)!
  return { id: entry.id, summary: entry.summary }
}

describe('the changes lines of delorun doctor', () => {
  it('reports a plugin that loaded and runs what was approved, its requirements and what it registers', async () => {
    const plain = linkPlugin('plain')
    const guarded = linkPlugin('guarded', {
      'package.json': '{"name":"guarded","version":"1.0.0","engines":{"dsh":"^0.2.2","delo":">=0.1.0","node":">=24"}}\n',
      'index.js': 'export function apply(ctx) {\n  ctx.tools.register(tool)\n  ctx.tools.guard(rule)\n}\n',
    })
    await start()
    await booted([{ id: 'plain', name: 'plain', disabled: false, state: 'active' }, { id: 'guarded', name: 'guarded', disabled: false, state: 'active' }])
    expect(await lines()).toEqual([
      { name: 'changes', status: 'pass', message: 'protection is set to block: changes you have not approved do not run.' },
      { name: 'changes', status: 'pass', message: `guarded from ${guarded}: it loaded at the last start; it runs the content you approved; it requires dsh ^0.2.2 and delo >=0.1.0; it changes a consent, a guard or the sandbox policy (index.js:3).` },
      { name: 'changes', status: 'pass', message: `plain from ${plain}: it loaded at the last start; it runs the content you approved; it declares no dsh or delo version requirement; ${NONE_REGISTERED}.` },
    ])
  })

  it('doctor names the plugin and the change that introduced a failed load', async () => {
    const source = linkPlugin('plug')
    await start()
    await booted([{ id: 'plug', name: 'plug', disabled: false, state: 'failed' }])
    const { id, summary } = await upgradeOf('plug')
    const results = await lines()
    expect(results).toContainEqual({ name: 'changes', status: 'warn', message: `plug from ${source}: it did not load at the last start (row plug is failed); it runs the content you approved; it declares no dsh or delo version requirement; ${NONE_REGISTERED}.` })
    expect(results).toContainEqual({ name: 'changes', status: 'warn', message: `plug did not load at the last start: row plug is failed. It changed in ${id} (${summary}): delorun changes undo ${id}` })

    // A start that failed, and whose failure names the plugin.
    await booted([], 'Error: plug threw\n    at load')
    expect(await lines()).toContainEqual({ name: 'changes', status: 'warn', message: `plug did not load at the last start: Error: plug threw at load. It changed in ${id} (${summary}): delorun changes undo ${id}` })
  })

  it('names the newest change applied when a failed start names no plugin, and only the failure when none was applied', async () => {
    linkPlugin('older')
    linkPlugin('newer')
    await start()
    const log = await readChangeLog(home, PROFILE)
    const newer = log.entries.find(entry => entry.subject.plugin === 'newer')!
    const { writeChangeLog } = await import('@delo/changes')
    await writeChangeLog(home, PROFILE, { ...log, entries: log.entries.map(entry => entry.id === newer.id ? { ...entry, decidedAt: '2099-01-01T00:00:00.000Z' } : entry) })
    await booted([], 'the Host did not answer')
    const results = await lines()
    expect(results).toContainEqual({ name: 'changes', status: 'warn', message: `The last start failed: the Host did not answer. The newest change you applied is to newer. It changed in ${newer.id} (${newer.summary}): delorun changes undo ${newer.id}` })
    expect(results.filter(result => result.message.startsWith('older from'))).toEqual([expect.objectContaining({ status: 'warn', message: expect.stringContaining('the last start failed') })])

    rmSync(join(home, 'changes', 'profiles', PROFILE, 'log.json'))
    writeFileSync(join(profileDir, 'package.json'), '{"name":"dsh-profile-default","private":true,"dependencies":{}}\n')
    await booted([], 'the Host did not answer')
    expect(await lines()).toEqual([
      { name: 'changes', status: 'pass', message: 'protection is set to block: changes you have not approved do not run.' },
      { name: 'changes', status: 'warn', message: 'The last start failed: the Host did not answer.' },
    ])
  })

  it('warns about unapproved content under warn, pending changes, and a plugin waiting for review', async () => {
    const source = linkPlugin('plug')
    await start()
    await setProtection(home, 'warn', attestTerminal(TERMINAL))
    writeFileSync(join(source, 'index.js'), 'export default 2\n')
    await start()
    const waiting = linkPlugin('waiting')
    await setProtection(home, 'block', attestTerminal(TERMINAL))
    await start()
    writeFileSync(join(source, 'index.js'), 'export default 3\n')
    await booted([{ id: 'plug', name: 'plug', disabled: false, state: 'active' }])
    const results = await lines()
    expect(results[0]).toEqual({ name: 'changes', status: 'pass', message: 'protection is set to block: changes you have not approved do not run.' })
    expect(results).toContainEqual({ name: 'changes', status: 'warn', message: `plug has changes in ${source} waiting for your review: run delorun changes list` })
    expect(results).toContainEqual({ name: 'changes', status: 'pass', message: `waiting from ${waiting}: it did not load at the last start (the profile has no row for it); nothing of it runs until you review it.` })
    expect(results).toContainEqual(expect.objectContaining({ status: 'warn', message: expect.stringMatching(new RegExp(`^waiting from ${waiting} waits for your review: delorun changes show c[0-9a-f]{10}$`, 'u')) }))

    await setProtection(home, 'warn', attestTerminal(TERMINAL))
    await start()
    const warned = await lines()
    expect(warned[0]).toEqual({ name: 'changes', status: 'warn', message: 'protection is set to warn: changes you have not approved run, and every start says so. Set it back with: delorun changes protection block' })
    expect(warned).toContainEqual(expect.objectContaining({ status: 'warn', message: expect.stringMatching(/^plug from .*: it loaded at the last start; it runs content you have not approved; /u) }))
    await setProtection(home, 'off', attestTerminal(TERMINAL))
    expect((await lines())[0]).toEqual({ name: 'changes', status: 'warn', message: 'protection is set to off: changes you have not approved run without notice. Set it back with: delorun changes protection block' })
  })

  it('doctor never passes lowered protection', async () => {
    linkPlugin('plug')
    await start()
    for (const level of ['warn', 'off'] as const) {
      await setProtection(home, level, attestTerminal(TERMINAL))
      expect((await lines()).filter(result => result.message.startsWith('protection')).map(result => result.status)).toEqual(['warn'])
    }
  })

  it('escapes control and bidirectional characters in a failure a plugin wrote, and cuts it at a line\'s length', async () => {
    const source = linkPlugin('plug')
    await start()
    await booted([], `plug threw \u001b[2J\u001b]0;owned\u0007\u202e${'y'.repeat(400)}`)
    const failed = (await lines()).find(result => result.message.startsWith('plug did not load'))!
    expect(failed.message).not.toMatch(/[\u001b\u0007\u202e]/u)
    expect(failed.message).toContain('plug threw \\u001b[2J\\u001b]0;owned\\u0007\\u202e')
    expect(failed.message).toMatch(/… \(\d+ more characters\)\. It changed in /u)
    expect(source).not.toBe('')
  })

  it('reports the work session, a plugin added since the last start, and a home where no start recorded anything', async () => {
    const source = linkPlugin('plug')
    await start()
    const { version } = (await readApproved(profileDir)).plugins.plug!
    const session = await openWorkSession(home, PROFILE, { plugin: 'plug', source, from: version, minutes: 60 }, attestTerminal(TERMINAL))
    expect((await lines())[1]).toEqual({ name: 'changes', status: 'pass', message: `you are working on plug since ${session.startedAt}: edits in its folder load live until delorun changes done plug.` })
    await start()
    expect((await lines())[2]!.message).toBe(`plug from ${source}: no start has recorded what loaded yet; it runs its folder in your work session; it declares no dsh or delo version requirement; ${NONE_REGISTERED}.`)
    await booted([])
    const other = linkPlugin('other')
    await start()
    expect(await lines()).toContainEqual(expect.objectContaining({ message: expect.stringMatching(new RegExp(`^other from ${other}: it was not under Changes at the last start; `, 'u')) }))
  })

  it('warns about the last failed reload in a work session, and a record of it that cannot be read', async () => {
    const source = linkPlugin('plug')
    await start()
    const { version } = (await readApproved(profileDir)).plugins.plug!
    await openWorkSession(home, PROFILE, { plugin: 'plug', source, from: version, minutes: 60 }, attestTerminal(TERMINAL))
    await writeWorkFailure(home, PROFILE, { plugin: 'plug', at: '2026-11-10T10:00:00.000Z', error: 'SyntaxError: Unexpected token' })
    expect((await lines())[2]).toEqual({ name: 'changes', status: 'warn', message: 'the last reload of plug in a work session failed at 2026-11-10T10:00:00.000Z: SyntaxError: Unexpected token. Delo went back to the version of it that last loaded.' })
    writeFileSync(workFailurePath(home, PROFILE), '{}\n', { mode: 0o600 })
    expect(await lines()).toContainEqual({ name: 'changes', status: 'warn', message: expect.stringMatching(/^the record of the last failed reload in a work session cannot be read: .*changes-work\.json/u) })
  })

  it('fails on each invariant that does not hold, and names what cannot be read', async () => {
    const source = linkPlugin('plug')
    await start()
    writeFileSync(join(home, 'changes', 'protection.json'), '{}\n', { mode: 0o600 })
    mkdirSync(dirname(bootRecordPath(home, PROFILE)), { recursive: true, mode: 0o700 })
    writeFileSync(bootRecordPath(home, PROFILE), '{}\n', { mode: 0o600 })
    rmSync(join(activeDirectory(home, PROFILE, 'plug'), 'package.json'))
    rmSync(join(home, 'changes', 'profiles', PROFILE, 'active.json'))
    const results = await lines()
    expect(results[0]).toEqual({ name: 'changes', status: 'pass', message: `plug from ${source}: no start has recorded what loaded yet; no content of it is recorded as running.` })
    expect(results).toContainEqual(expect.objectContaining({ status: 'warn', message: expect.stringMatching(/^the record of the last start cannot be read: .*changes-boot\.json/u) }))
    expect(results.filter(result => result.status === 'fail').map(result => result.message)).toEqual([
      expect.stringMatching(/^The protection setting cannot be read: /u),
      expect.stringMatching(/^The active directory of plug holds content, and active\.json records none: /u),
    ])
  })

  it('says when an active directory\'s manifest or its content in the store cannot be read', async () => {
    linkPlugin('plug')
    await start()
    const status: ChangesStatus = await changesStatus({ home, profile: PROFILE, profileDir })
    writeFileSync(join(activeDirectory(home, PROFILE, 'plug'), 'package.json'), 'null\n')
    expect((await changesLines(home, PROFILE, status))[1]!.message).toContain('it declares no dsh or delo version requirement')
    rmSync(join(activeDirectory(home, PROFILE, 'plug'), 'package.json'))
    rmSync(versionsDirectory(home), { recursive: true })
    const message = (await changesLines(home, PROFILE, status))[1]!.message
    expect(message).toMatch(/its package\.json does not read \(.*ENOENT.*\); its content could not be read from the store \(.*\)\.$/u)
  })

  it('reports a home without the CLI profile', async () => {
    rmSync(profileDir, { recursive: true })
    expect(await lines()).toEqual([{ name: 'changes', status: 'pass', message: 'the profile default is not set up, so there are no changes to check.' }])
  })
})

describe('delorun doctor with the changes lines', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', base)
    vi.stubEnv('USERPROFILE', base)
    // The key check sets these on the process; stubbing them first restores them afterwards.
    vi.stubEnv('DSH_HOME', join(base, '.dsh'))
    vi.stubEnv('DELO_HOME', undefined)
    vi.stubEnv('DELO_PROFILE', undefined)
  })

  /**
   * Run `delorun doctor` in this process.
   * @param env - the command's environment.
   * @returns the exit code and standard error.
   */
  async function doctor(env: Record<string, string>): Promise<{ exit: number | undefined, stdout: string, stderr: string }> {
    let stdout = ''
    let stderr = ''
    const exit = await doctorCommand.run(['--port', '1'], { env: { HOME: base, PATH: join(base, 'no-bin'), ...env }, stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } })
    return { exit, stdout, stderr }
  }

  it('prints the changes lines after the four checks, and fails on an invariant that does not hold', async () => {
    linkPlugin('plug')
    await start()
    const sound = await doctor({ DELO_HOME: home })
    expect(sound.stdout).toContain('pass changes: protection is set to block')
    writeFileSync(join(home, 'changes', 'protection.json'), '{}\n', { mode: 0o600 })
    const broken = await doctor({ DELO_HOME: home })
    expect(broken.exit).toBe(EXIT.failed)
    expect(broken.stderr).toMatch(/^fail changes: The protection setting cannot be read: /mu)
  })

  it('turns a changes check that throws into one failure line', async () => {
    const run = await doctor({ DELO_HOME: 'relative/home' })
    expect(run.stderr).toMatch(/^fail changes: the check could not complete: /mu)
  })
})
