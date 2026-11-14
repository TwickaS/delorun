/**
 * What `delorun verify` says about Changes (contract C21): after the release's check lines, the changes the person
 * approved, the changes that loaded without review while protection was off, then each pending change and each
 * invariant that does not hold. The summary line never reads as a plain pass while anything is not approved or loaded
 * without review, and the run exits 1 only while an invariant does not hold.
 */
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyChange, attestTerminal, enforceApprovedContent, listChanges, readApproved, readChangeLog, setProtection, writeApproved } from '@delorun/changes'
import { EXIT } from '../../src/exit.ts'
import { NOT_FROM_STORE } from '../../src/verify/changes.ts'
import { createVerifyCommand, runsFromStore, type VerifyEnvironment } from '../../src/verify/index.ts'
import { installedHome, makeWritable, NOW, PLATFORM, RELEASE, type InstalledHome } from './fixtures.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) {
    makeWritable(dirname(home))
    rmSync(dirname(home), { recursive: true, force: true })
  }
})

/** The summary line of a run in which every release check passed and everything present is approved. */
const PLAIN_SUMMARY = '2 checks passed, 0 failed, 0 not run; this Delorun reads unknown; this is not a full verification of this Delorun.'
const TERMINAL = attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } })
const PROTECTION_ON = 'Protection is on: changes load only after you apply them.'
const PROTECTION_OFF = 'Protection is off: changes load without your review and are recorded; turn it on with: delorun changes protection on.'

/** What one run printed and returned. */
interface Run {
  readonly exit: number | undefined
  readonly stdout: string
}

/** A fixture home with the CLI profile `default` linking `plug` from a folder, approved at the first start. */
interface ChangesHome {
  readonly fixture: InstalledHome
  readonly profileDir: string
  readonly source: string
}

/**
 * @returns a fixture home with protection on whose profile links `plug` from a folder, after its first start under
 *   Changes.
 */
async function changesHome(): Promise<ChangesHome> {
  const fixture = await installedHome()
  homes.push(fixture.home)
  await setProtection(fixture.home, 'on', TERMINAL)
  const source = join(dirname(fixture.home), 'plug')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
  writeFileSync(join(source, 'index.js'), 'export default 1\n')
  const profileDir = join(fixture.home, 'profiles', 'default')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: { plug: `link:${source}` } }, undefined, 2)}\n`)
  symlinkSync(relative(join(profileDir, 'node_modules'), source), join(profileDir, 'node_modules', 'plug'))
  await startProfile({ fixture, profileDir, source })
  return { fixture, profileDir, source }
}

/**
 * Link a plugin into the fixture profile from a folder, as `delorun plugin add link:<folder>` leaves it.
 * @param home - the fixture.
 * @param name - the package name.
 * @param folder - the folder.
 */
function linkPlugin(home: ChangesHome, name: string, folder: string): void {
  const path = join(home.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies[name] = `link:${folder}`
  writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
  rmSync(join(home.profileDir, 'node_modules', name), { force: true })
  symlinkSync(relative(join(home.profileDir, 'node_modules'), folder), join(home.profileDir, 'node_modules', name))
}

/**
 * Run Changes' part of a start for the fixture profile.
 * @param home - the fixture.
 */
async function startProfile(home: ChangesHome): Promise<void> {
  await enforceApprovedContent({ home: home.fixture.home, profile: 'default', profileDir: home.profileDir })
}

/**
 * Run `delorun verify` over a fixture home.
 * @param fixture - the home.
 * @param args - the arguments after `verify`.
 * @param environment - fields of the environment to replace.
 * @returns the exit code and the output.
 */
async function verify(fixture: InstalledHome, args: readonly string[] = [], environment: Partial<VerifyEnvironment> = {}): Promise<Run> {
  let stdout = ''
  const command = createVerifyCommand({ fetch: fixture.tiles.fetch, now: () => NOW, platform: PLATFORM, running: () => RELEASE, fromStore: () => true, ...environment })
  const exit = await command.run(args, { env: { DELORUN_HOME: fixture.home, DELORUN_LAUNCHER_ROOTS: fixture.launcherRoots }, stdout: (text) => { stdout += text }, stderr: () => {} })
  return { exit, stdout }
}

/**
 * @param run - a run.
 * @returns the lines from `Changes:` to the end.
 */
function changesBlock(run: Run): string[] {
  const lines = run.stdout.split('\n')
  return lines.slice(lines.indexOf('Changes:'), -1)
}

describe('delorun verify on a home with changes', { timeout: 180_000 }, () => {
  it('lists the changes the person approved and keeps the plain summary when nothing else is present', async () => {
    const home = await changesHome()
    const run = await verify(home.fixture)
    expect(run.exit).toBe(EXIT.ok)
    expect(changesBlock(run)).toEqual(['Changes:', PROTECTION_ON, '1 change you approved:', `  plug from ${home.source} (approved at upgrade)`, PLAIN_SUMMARY])
    expect(changesBlock(run).join('\n')).not.toMatch(/integrity|trust|drift/iu)
    // An approval the person gave after the upgrade carries no mark.
    const approved = await readApproved(home.profileDir)
    const { source, version, approvedAt } = approved.plugins.plug!
    await writeApproved(home.profileDir, { ...approved, plugins: { plug: { source, version, approvedAt } } })
    expect(changesBlock(await verify(home.fixture))[3]).toBe(`  plug from ${home.source}`)
  })

  it('verify never prints a plain pass with content that loaded without review, and exits 0', async () => {
    const home = await changesHome()
    // A second plugin the person applied after review.
    const other = join(dirname(home.fixture.home), 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'package.json'), '{"name":"other","version":"1.0.0"}\n')
    linkPlugin(home, 'other', other)
    await startProfile(home)
    const ctx = { home: home.fixture.home, profile: 'default', profileDir: home.profileDir }
    const [install] = (await listChanges(ctx)).pending
    await applyChange(ctx, install!.id, TERMINAL, { reload: () => Promise.resolve(undefined) })
    await setProtection(home.fixture.home, 'off', TERMINAL)
    writeFileSync(join(home.source, 'index.js'), 'export default 2\n')
    await startProfile(home)
    const { id } = (await readChangeLog(home.fixture.home, 'default')).entries.at(-1)!
    const off = await verify(home.fixture)
    expect(changesBlock(off)).toEqual([
      'Changes:',
      PROTECTION_OFF,
      '1 change you approved:',
      `  other from ${other}`,
      '1 change loaded without review (protection is off):',
      `  plug from ${home.source} (${id})`,
      '2 checks passed, 0 failed, 0 not run; this Delorun reads unknown; 1 change loaded without review (protection is off); this is not a full verification of this Delorun.',
    ])
    expect(off.exit).toBe(EXIT.ok)
    expect(changesBlock(off).join('\n')).not.toMatch(/integrity|trust|drift/iu)
    // Turning protection on keeps the content approved, and verify still names how it loaded.
    await setProtection(home.fixture.home, 'on', TERMINAL)
    const on = changesBlock(await verify(home.fixture))
    expect(on.slice(1, 6)).toEqual([PROTECTION_ON, '1 change you approved:', `  other from ${other}`, '1 change loaded without review (while protection was off):', `  plug from ${home.source} (${id})`])
    expect(on.at(-1)).toBe('2 checks passed, 0 failed, 0 not run; this Delorun reads unknown; 1 change loaded without review (while protection was off); this is not a full verification of this Delorun.')
  })

  it('verify never prints a plain pass with an invariant that does not hold, and exits 1', async () => {
    // The profile links the plugin from its folder again.
    const broken = await changesHome()
    linkPlugin(broken, 'plug', broken.source)
    const unsound = await verify(broken.fixture)
    expect(changesBlock(unsound).at(-1)).toBe('2 checks passed, 0 failed, 0 not run; this Delorun reads unknown; 1 part of your changes is not as Changes keeps them; this is not a full verification of this Delorun.')
    expect(changesBlock(unsound)).toContainEqual(expect.stringMatching(/^ {2}Not as Changes keeps it: plug is linked from .*, not from its active directory /u))
    expect(unsound.exit).toBe(EXIT.failed)
  })

  it('names pending changes that do not run under protection on, without failing the run', async () => {
    const home = await changesHome()
    const other = join(dirname(home.fixture.home), 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'package.json'), '{"name":"other","version":"1.0.0"}\n')
    linkPlugin(home, 'other', other)
    await startProfile(home)
    // Edited after the start, so the store does not hold this content yet.
    writeFileSync(join(home.source, 'index.js'), 'export default 2\n')
    const run = await verify(home.fixture)
    expect(run.exit).toBe(EXIT.ok)
    expect(changesBlock(run)).toEqual([
      'Changes:',
      PROTECTION_ON,
      '1 change you approved:',
      `  plug from ${home.source} (approved at upgrade)`,
      'Not approved:',
      expect.stringMatching(new RegExp(`^ {2}other from ${other} waits for your review: delorun changes show c[0-9a-f]{10}$`, 'u')),
      `  plug has changes in ${home.source} waiting for your review: run delorun changes list`,
      '2 checks passed, 0 failed, 0 not run; this Delorun reads unknown; 2 changes you have not approved are present; this is not a full verification of this Delorun.',
    ])
  })

  it('says when the person approved no change, with protection off in a home without a protection record', async () => {
    const fixture = await installedHome()
    homes.push(fixture.home)
    const profileDir = join(fixture.home, 'profiles', 'default')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{"name":"dsh-profile-default","private":true}\n')
    const run = await verify(fixture)
    expect(changesBlock(run)).toEqual(['Changes:', PROTECTION_OFF, '0 changes you approved.', PLAIN_SUMMARY])
  })

  it('protection off is no fault while nothing loaded without review, and a protection record that cannot be read is', async () => {
    const home = await changesHome()
    await setProtection(home.fixture.home, 'off', TERMINAL)
    const run = await verify(home.fixture)
    expect(changesBlock(run)[1]).toBe(PROTECTION_OFF)
    expect(changesBlock(run).at(-1)).toBe(PLAIN_SUMMARY)
    expect(run.exit).toBe(EXIT.ok)
    // A protection record that cannot be read is named as an invariant, never as a setting.
    writeFileSync(join(home.fixture.home, 'changes', 'protection.json'), '{}\n', { mode: 0o600 })
    const unreadable = changesBlock(await verify(home.fixture))
    expect(unreadable.some(line => line.startsWith('Protection is'))).toBe(false)
    expect(unreadable.at(-1)).not.toBe(PLAIN_SUMMARY)
  })

  it('escapes control and bidirectional characters in what it prints, and wraps long lines', async () => {
    const home = await changesHome()
    const approved = await readApproved(home.profileDir)
    const { version, approvedAt } = approved.plugins.plug!
    const forged = `/tmp/plug\u001b[2K\rFAKE\u202e${'x'.repeat(300)}`
    await writeApproved(home.profileDir, { ...approved, plugins: { plug: { source: forged, version, approvedAt } } })
    const block = changesBlock(await verify(home.fixture))
    expect(block.join('\n')).not.toMatch(/[\u001b\r\u202e]/u)
    expect(block[3]).toMatch(/^ {2}plug from \/tmp\/plug\\u001b\[2K\\u000dFAKE\\u202ex+$/u)
    expect(block[4]).toMatch(/^ {2}↪ x+$/u)
    expect(block.every(line => line.length <= 200)).toBe(true)
  })

  it('says a run from outside the runtime store has no signed release to compare its files with', async () => {
    const home = await changesHome()
    // These specs run from the source checkout.
    expect(runsFromStore(home.fixture.home)).toBe(false)
    const run = await verify(home.fixture, [], { fromStore: () => false })
    expect(changesBlock(run).slice(0, 2)).toEqual(['Changes:', NOT_FROM_STORE])
  })

  it('reports a home without the CLI profile, and carries Changes in --json', async () => {
    const fixture = await installedHome()
    homes.push(fixture.home)
    const run = await verify(fixture)
    expect(changesBlock(run)).toEqual(['Changes:', 'The profile default is not set up, so no changes are recorded.', PLAIN_SUMMARY])
    expect(JSON.parse((await verify(fixture, ['--json'])).stdout)).toMatchObject({ changes: { fromStore: true, profile: 'default', status: null } })
    const home = await changesHome()
    const report = JSON.parse((await verify(home.fixture, ['--json'])).stdout) as { changes: { status: { approved: { plugin: string }[] } } }
    expect(report.changes.status.approved.map(approval => approval.plugin)).toEqual(['plug'])
  })
})
