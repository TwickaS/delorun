/**
 * The update's successor makes the release's own pack files the baseline: only in its first boot, only for an
 * update to a newer release, and only with signed pack files it verified itself.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attestTerminal, baselineOfPacks, enforceApprovedContent, protectionPath, readActiveRecord, readApproved, readChangeLog, setProtection, writeApproved, type SignedPackFiles, type UpdateBaseline } from '@delorun/changes'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { parseRuntimeVersion } from '@delorun/runtime-store'
import { prepareHome, type CommandContext } from '../src/command.ts'
import { changesApprovedContent, changesPreStartStep, repointForSuccessor, repointingBoot, startChanges } from '../src/changes/start.ts'
import { updateSource } from '../src/changes/update-baseline.ts'

const hooks = vi.hoisted(() => ({ baseline: undefined as import('@delorun/changes').UpdateBaseline | undefined, asked: [] as string[], environment: 'verified' as 'verified' | 'unverifiable' | 'unsupported' | 'failing' }))

vi.mock('@delorun/changes', async importOriginal => {
  const actual = await importOriginal<typeof import('@delorun/changes')>()
  return { ...actual, enforceApprovedContent: vi.fn(actual.enforceApprovedContent) }
})

vi.mock('../src/changes/update-baseline.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/changes/update-baseline.ts')>()
  return {
    ...actual,
    updateBaselineOf: async (...args: Parameters<typeof actual.updateBaselineOf>) => {
      hooks.asked.push(args[1])
      if (hooks.environment === 'unverifiable') throw new Error('the packs file has no verified release-log record')
      return hooks.baseline
    },
  }
})

vi.mock('@delorun/plugin-packs/environment', () => ({
  hostPacksEnvironment: () => hooks.environment === 'failing' ? Promise.reject(new Error('the launcher anchor cannot be read')) : Promise.resolve(hooks.environment === 'unsupported' ? { unsupported: 'not an installed release' } : { release: () => Promise.reject(new Error('unused')), files: undefined }),
}))

let base: string
let home: string
let context: CommandContext & { printed: string[], errors: string[] }

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-update-baseline-')))
  home = join(base, '.delorun')
  vi.stubEnv('HOME', base)
  vi.stubEnv('USERPROFILE', base)
  vi.stubEnv('DSH_HOME', join(base, '.dsh'))
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
  hooks.asked = []
  hooks.environment = 'verified'
  const printed: string[] = []
  const errors: string[] = []
  context = { env: { HOME: base, DSH_HOME: join(base, '.dsh'), DELORUN_HOME: home }, stdout: text => void printed.push(text), stderr: text => void errors.push(text), printed, errors }
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const v = (text: string): RuntimeVersion => parseRuntimeVersion(text)!

const approvedFiles = { 'package.json': '{"name":"pkg","version":"1"}\n', 'index.js': 'one\n' }
const newFiles = { 'package.json': '{"name":"pkg","version":"2"}\n', 'index.js': 'two\n' }

function signed(release: string, files: Readonly<Record<string, string>>): SignedPackFiles {
  return { name: 'pkg', release: v(release), files: new Map(Object.entries(files).map(([path, body]) => [path, { sha256: sha(body), executable: false }])), peers: [], text: path => Promise.resolve(path === 'package.json' ? files[path] : undefined) }
}

const baseline: UpdateBaseline = baselineOfPacks('1.0.0', '2.0.0', [signed('1.0.0', approvedFiles), signed('2.0.0', newFiles)])

function writePack(release: string, files: Readonly<Record<string, string>>): void {
  const folder = join(home, 'packs', release, 'pkg', 'package')
  mkdirSync(folder, { recursive: true })
  for (const [path, body] of Object.entries(files)) writeFileSync(join(folder, path), body)
}

/** A profile that approved the pack of release 1.0.0, then an update that moved `packs/current` to 2.0.0. */
async function updatedHome(): Promise<void> {
  await prepareHome(context, undefined, true)
  await setProtection(home, 'on', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
  writePack('1.0.0', approvedFiles)
  symlinkSync('1.0.0', join(home, 'packs', 'current'))
  const source = join(home, 'packs', 'current', 'pkg', 'package')
  const profileDir = join(home, 'profiles', 'default')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dependencies: { pkg: `link:${source}` } }, undefined, 2)}\n`)
  symlinkSync(relative(join(profileDir, 'node_modules'), source), join(profileDir, 'node_modules', 'pkg'))
  await startChanges({ home, profile: 'default', terminal: false }, () => undefined)
  writePack('2.0.0', newFiles)
  context.printed.length = 0
  rmSync(join(home, 'packs', 'current'))
  symlinkSync('2.0.0', join(home, 'packs', 'current'))
}

const entries = async (): Promise<string[]> => (await readChangeLog(home, 'default')).entries.flatMap(entry => entry.decidedFrom === 'update' ? [entry.summary] : [])

/** The successor's first boot of an update from `updatedFrom` (none: a start that is no update), as `repointingBoot` runs it. */
function successorBoot(updatedFrom?: RuntimeVersion, afterFailedSwitch = false): ReturnType<typeof repointForSuccessor> {
  return repointForSuccessor({ home, profile: 'default', ...updatedFrom === undefined ? {} : { updatedFrom }, write: text => void context.printed.push(text) }, afterFailedSwitch)
}

const approvedVersion = async (): Promise<string | undefined> => (await readApproved(join(home, 'profiles', 'default'))).plugins.pkg?.version

describe('the first boot of an update\'s successor', () => {
  it('replaces the previous release\'s pack content', async () => {
    await updatedHome()
    const before = await approvedVersion()
    hooks.baseline = baseline
    await successorBoot(v('1.0.0'))
    expect(hooks.asked).toEqual(['1.0.0'])
    expect(await entries()).toEqual(['Replaced by the update to 2.0.0: pkg'])
    expect(await approvedVersion()).not.toBe(before)
    expect(context.printed.join('')).toContain('pkg now holds the files of the update to 2.0.0')
  })

  it('runs Changes\' start with one scan memo when an approved plugin is a pack the releases list', async () => {
    await updatedHome()
    hooks.baseline = baseline
    vi.mocked(enforceApprovedContent).mockClear()
    await successorBoot(v('1.0.0'))
    expect(enforceApprovedContent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enforceApprovedContent).mock.calls[0]![0]).toMatchObject({ updateBaseline: { from: '1.0.0', to: '2.0.0' }, scanMemo: { lookup: expect.any(Function) } })
  })

  it('reads nothing of the profile\'s plugin folders when no approved plugin is a pack either release lists', async () => {
    await updatedHome()
    const before = await approvedVersion()
    const packsFor = vi.fn(baseline.packsFor)
    hooks.baseline = { ...baseline, lists: () => false, packsFor }
    vi.mocked(enforceApprovedContent).mockClear()
    await expect(successorBoot(v('1.0.0'))).resolves.toBeUndefined()
    expect(hooks.asked).toEqual(['1.0.0'])
    expect(enforceApprovedContent).not.toHaveBeenCalled()
    expect(packsFor).not.toHaveBeenCalled()
    expect(await entries()).toEqual([])
    expect(await approvedVersion()).toBe(before)
    expect(context.printed.join('')).toBe('')
  })

  it('gives an undo, and so arms the successor\'s deadline, only when the baseline changed a record', async () => {
    await updatedHome()
    hooks.baseline = baseline
    const changed = await successorBoot(v('1.0.0'))
    expect(changed).toBeInstanceOf(Function)
    expect(await entries()).toEqual(['Replaced by the update to 2.0.0: pkg'])
  })

  it('gives no undo when the baseline ran and replaced nothing, so the predecessor\'s limit applies', async () => {
    await updatedHome()
    const before = await approvedVersion()
    // The signed files of release 1.0.0 are not what was approved, so the change keeps waiting.
    hooks.baseline = baselineOfPacks('1.0.0', '2.0.0', [signed('1.0.0', { ...approvedFiles, 'index.js': 'other\n' }), signed('2.0.0', newFiles)])
    vi.mocked(enforceApprovedContent).mockClear()
    await expect(successorBoot(v('1.0.0'))).resolves.toBeUndefined()
    expect(enforceApprovedContent).toHaveBeenCalledTimes(1)
    expect(await entries()).toEqual([])
    expect(await approvedVersion()).toBe(before)
  })

  it('tells the Host runner whether the first boot advanced any record', async () => {
    for (const [lists, advanced] of [[true, true], [false, false]] as const) {
      await updatedHome()
      hooks.baseline = { ...baseline, lists: () => lists }
      const runner = repointingBoot({ home, profile: 'default', updatedFrom: v('1.0.0') }, true, () => Promise.resolve('booted'))
      await runner.boot()
      expect(await runner.advanced()).toBe(advanced)
      rmSync(home, { recursive: true, force: true })
      await prepareHome(context, undefined, true)
    }
  })

  it('replaces nothing when no update left a release, and nothing at the pre-start step of a start, whatever it was given', async () => {
    await updatedHome()
    const before = await approvedVersion()
    hooks.baseline = baseline
    await successorBoot()
    await changesPreStartStep({ home, profile: 'default', kind: 'cli', successor: false, output: { stdout: text => void context.printed.push(text), stderr: text => void context.errors.push(text) } })
    expect(hooks.asked).toEqual([])
    expect(await entries()).toEqual([])
    expect(await approvedVersion()).toBe(before)
    expect(context.printed.join('')).toContain('pkg has changes waiting for your review')
  })

  it('applies the baseline once: a boot after a failed switch never does', async () => {
    await updatedHome()
    const before = await approvedVersion()
    hooks.baseline = baseline
    await successorBoot(v('1.0.0'), true)
    expect(hooks.asked).toEqual([])
    expect(await entries()).toEqual([])
    expect(await approvedVersion()).toBe(before)
  })

  it('leaves the changes waiting, and says so, when the signed files cannot be verified', async () => {
    await updatedHome()
    const before = await approvedVersion()
    hooks.environment = 'unverifiable'
    await successorBoot(v('1.0.0'))
    expect(await entries()).toEqual([])
    expect(await approvedVersion()).toBe(before)
    expect(context.printed.join('')).toContain('Delorun could not check the plugin packs of the update against the signed release, so changes to them wait for your review: the packs file has no verified release-log record')
  })

  it('leaves the changes waiting, and says so, when the packs environment cannot be read, and the boot goes on', async () => {
    await updatedHome()
    const before = await approvedVersion()
    hooks.environment = 'failing'
    await expect(successorBoot(v('1.0.0'))).resolves.toBeUndefined()
    expect(await entries()).toEqual([])
    expect(await approvedVersion()).toBe(before)
    expect(context.printed.join('')).toContain('so changes to them wait for your review: the launcher anchor cannot be read')
  })

  it('replaces nothing in a process that is not an installed release', async () => {
    await updatedHome()
    const before = await approvedVersion()
    hooks.environment = 'unsupported'
    await successorBoot(v('1.0.0'))
    expect(hooks.asked).toEqual([])
    expect(await entries()).toEqual([])
    expect(await approvedVersion()).toBe(before)
  })
})

describe('a rollback\'s successor', () => {
  it('never advances the baseline: a person\'s rollback from a newer release leaves the pack\'s change waiting', async () => {
    await updatedHome()
    const before = await approvedVersion()
    hooks.baseline = baseline
    const rollback = { type: 'handover', purpose: 'rollback', from: v('2.0.0') } as const
    const updatedFrom = updateSource(rollback)
    await successorBoot(updatedFrom)
    expect(hooks.asked).toEqual([])
    expect(await entries()).toEqual([])
    expect(await approvedVersion()).toBe(before)
  })
})

describe('a failed health check after the baseline advanced, with protection on', () => {
  const draft = (): Parameters<typeof changesApprovedContent>[0] => ({ request: { home, profile: 'default', kind: 'cli', output: context, env: context.env } })
  const profileDir = (): string => join(home, 'profiles', 'default')

  it('boots the predecessor again with nothing advanced and nothing lost', async () => {
    await updatedHome()
    const approvedBefore = await readApproved(profileDir())
    const activeBefore = await readActiveRecord(home, 'default')
    hooks.baseline = baseline
    await successorBoot(v('1.0.0'))
    expect(await entries()).toEqual(['Replaced by the update to 2.0.0: pkg'])
    // The rollback of the failed update restores the profile's files, the approved record included, not active.json.
    await writeApproved(profileDir(), approvedBefore)
    await expect(changesApprovedContent(draft())).rejects.toThrow(/not its approved version/)

    await repointForSuccessor({ home, profile: 'default' }, true)

    await expect(changesApprovedContent(draft())).resolves.toEqual([])
    expect(await readApproved(profileDir())).toEqual(approvedBefore)
    expect(await readActiveRecord(home, 'default')).toEqual(activeBefore)
    expect(await entries()).toEqual(['Replaced by the update to 2.0.0: pkg'])
  })

  /** The update's predecessor of the 2.1 line resumes: it re-points the copies, has no `followApprovedContent`, and checks the invariants. */
  async function resumeAsRelease21(): Promise<readonly string[]> {
    await repointForSuccessor({ home, profile: 'default' })
    return changesApprovedContent(draft())
  }

  it('resumes a predecessor that cannot follow the approved record, once the successor abandons its boot', async () => {
    await updatedHome()
    const approvedBefore = await readApproved(profileDir())
    const activeBefore = await readActiveRecord(home, 'default')
    hooks.baseline = baseline
    const abandon = await successorBoot(v('1.0.0'))
    expect(abandon).toBeDefined()
    expect((await readActiveRecord(home, 'default')).plugins.pkg).not.toEqual(activeBefore.plugins.pkg)

    await abandon!()
    await writeApproved(profileDir(), approvedBefore)

    await expect(resumeAsRelease21()).resolves.toEqual([])
    expect(await readApproved(profileDir())).toEqual(approvedBefore)
    expect(await readActiveRecord(home, 'default')).toEqual(activeBefore)
  })

  it('refuses the same predecessor when the successor did not abandon', async () => {
    await updatedHome()
    const approvedBefore = await readApproved(profileDir())
    hooks.baseline = baseline
    await successorBoot(v('1.0.0'))
    await writeApproved(profileDir(), approvedBefore)
    await expect(resumeAsRelease21()).rejects.toThrow(/not its approved version/)
  })

  it('keeps what a person changed after the baseline, and puts back only what the baseline changed', async () => {
    await updatedHome()
    const approvedBefore = await readApproved(profileDir())
    hooks.baseline = baseline
    const abandon = await successorBoot(v('1.0.0'))
    const afterBaseline = await readApproved(profileDir())
    const person = { ...approvedBefore.plugins.pkg!, source: '/somewhere/else' }
    await writeApproved(profileDir(), { ...afterBaseline, plugins: { ...afterBaseline.plugins, other: person } })

    await abandon!()

    const restored = await readApproved(profileDir())
    expect(restored.plugins.pkg).toEqual(approvedBefore.plugins.pkg)
    expect(restored.plugins.other).toEqual(person)
  })

  it('applies no baseline, so has nothing to abandon, for a rollback, a boot after a failed switch and a failed verification', async () => {
    await updatedHome()
    hooks.baseline = baseline
    expect(await successorBoot(updateSource({ type: 'handover', purpose: 'rollback', from: v('2.0.0') }))).toBeUndefined()
    expect(await successorBoot(v('1.0.0'), true)).toBeUndefined()
    hooks.environment = 'unverifiable'
    expect(await successorBoot(v('1.0.0'))).toBeUndefined()
  })

  it('leaves the records as they were, and refuses the boot, when Changes cannot prepare the profile after the baseline was asked for', async () => {
    await updatedHome()
    const approvedBefore = await readApproved(profileDir())
    const activeBefore = await readActiveRecord(home, 'default')
    hooks.baseline = baseline
    writeFileSync(protectionPath(home), '{', { mode: 0o600 })
    await expect(successorBoot(v('1.0.0'))).rejects.toThrow(/could not be prepared/)
    expect(await readApproved(profileDir())).toEqual(approvedBefore)
    expect(await readActiveRecord(home, 'default')).toEqual(activeBefore)
  })

  it('still refuses the boot of a Host that is not after a failed switch', async () => {
    await updatedHome()
    const approvedBefore = await readApproved(profileDir())
    hooks.baseline = baseline
    await successorBoot(v('1.0.0'))
    await writeApproved(profileDir(), approvedBefore)
    await repointForSuccessor({ home, profile: 'default' })
    await expect(changesApprovedContent(draft())).rejects.toThrow(/not its approved version/)
  })
})
