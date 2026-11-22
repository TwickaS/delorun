/**
 * `delorun update --from` ([from](../../src/update/from.ts)): a folder or address that holds a release installs through
 * the channel's checks. Each refusal here leaves the store untouched: a wrong-key manifest, a release below the floor,
 * a missing file (named), an `http:` address, `--yes` or no terminal when the timestamp is stale, and a person who
 * declines. A stale timestamp installs only after the person agrees, and is never stored.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { ensureHomeTree } from '@delorun/home'
import { CliError } from '../../src/exit.ts'
import { installFrom, type InstallFromOptions } from '../../src/update/from.ts'
import { fixtureRelease, NOW, type Fixture } from '../../../install/tests/support.ts'

const FOUR_DAYS_MS = 4 * 24 * 3600 * 1000
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** The files of a release page, written as a person downloaded them. */
async function releaseFolder(fixture: Fixture, leave: readonly string[] = []): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'delorun-from-folder-'))
  directories.push(folder)
  await mkdir(join(folder, 'root'))
  const name = String(fixture.manifest.version)
  const files: Record<string, Buffer> = {
    'timestamp.json': fixture.timestampBytes,
    'root/1.root.json': Buffer.from(fixture.roots[0]!),
    [`delorun-${name}.manifest.json`]: fixture.manifestBytes,
    [`delorun-${name}.manifest.log.json`]: fixture.bundleBytes,
    [`delorun-${name}-${fixture.platform}.tar.gz`]: fixture.archive,
    [`delorun-${name}-${fixture.platform}.files.json`]: fixture.filesBytes,
  }
  for (const [file, bytes] of Object.entries(files)) if (!leave.includes(file)) await writeFile(join(folder, file), bytes)
  return folder
}

/**
 * A store that implements only the members {@link installFrom} reads in these specs.
 * @param members - those members.
 * @returns the store.
 */
function standIn(members: Partial<Record<keyof InstallFromOptions['store'], unknown>>): InstallFromOptions['store'] {
  return members as InstallFromOptions['store']
}

/** A run of {@link installFrom} over a stand-in store, and what it did. */
async function run(fixture: Fixture, change: { readonly from?: (folder: string) => string, readonly leave?: readonly string[], readonly current?: string, readonly yes?: boolean, readonly answer?: boolean | undefined, readonly late?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'delorun-from-home-'))
  directories.push(home)
  await ensureHomeTree(home, 'default')
  const folder = await releaseFolder(fixture, change.leave)
  const installed: string[] = []
  const questions: string[] = []
  const staging = await mkdtemp(join(tmpdir(), 'delorun-from-staging-'))
  directories.push(staging)
  const options: InstallFromOptions = {
    home,
    from: change.from?.(folder) ?? folder,
    yes: change.yes === true,
    running: '0.0.9' as RuntimeVersion,
    anchor: { shipped: async () => fixture.roots, root: async () => fixture.rootMetadata },
    store: standIn({
      paths: { platform: fixture.platform },
      pointers: async () => ({ current: (change.current ?? '0.0.9') as RuntimeVersion }),
      startCheckRuntime: async () => ({ manifest: { channel: 'stable' } }),
      install: async (request: { readonly version: string, readonly fill: (directory: string) => Promise<unknown> }) => {
        const directory = join(staging, String(installed.length))
        await mkdir(directory, { mode: 0o700 })
        await request.fill(directory)
        installed.push(request.version)
        return {}
      },
    }),
    fullCheckDays: 7,
    confirm: async (question) => { questions.push(question); return 'answer' in change ? change.answer : true },
    report: () => {},
    fetch: async () => Promise.reject(new Error('the release log is not reachable in this spec')),
    now: () => NOW * 1000 + (change.late === true ? FOUR_DAYS_MS : 0),
  }
  const outcome: { readonly version?: string, readonly error?: unknown } = await installFrom(options).then(version => ({ version }), (error: unknown) => ({ error }))
  return { outcome, installed, questions, home }
}

/** The message of a refusal. */
function refusal(outcome: { readonly error?: unknown }): string {
  expect(outcome.error).toBeInstanceOf(CliError)
  return (outcome.error as CliError).message
}

describe('delorun update --from', () => {
  it('installs a release whose timestamp is fresh without asking', async () => {
    const { outcome, installed, questions } = await run(await fixtureRelease())
    expect(outcome).toEqual({ version: '0.1.0' })
    expect(installed).toEqual(['0.1.0'])
    expect(questions).toEqual([])
  })

  it('asks before installing on a stale timestamp, installs on yes, and never stores the stale timestamp', async () => {
    const { outcome, installed, questions, home } = await run(await fixtureRelease(), { late: true })
    expect(outcome).toEqual({ version: '0.1.0' })
    expect(installed).toEqual(['0.1.0'])
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatch(/cannot confirm that 0\.1\.0 is current.*signature and release-log entry alone\?$/su)
    await expect(readFile(join(home, 'trust', 'timestamp.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not install when the person declines', async () => {
    const { outcome, installed } = await run(await fixtureRelease(), { late: true, answer: false })
    expect(refusal(outcome)).toMatch(/did not agree/u)
    expect(installed).toEqual([])
  })

  it('refuses a stale timestamp with --yes, and asks nothing', async () => {
    const { outcome, installed, questions } = await run(await fixtureRelease(), { late: true, yes: true })
    expect(refusal(outcome)).toMatch(/--yes does not agree/u)
    expect(installed).toEqual([])
    expect(questions).toEqual([])
  })

  it('refuses a stale timestamp when there is no terminal to ask', async () => {
    const { outcome, installed } = await run(await fixtureRelease(), { late: true, answer: undefined })
    expect(refusal(outcome)).toMatch(/needs a terminal/u)
    expect(installed).toEqual([])
  })

  it('accepts --yes when nothing is stale', async () => {
    const { outcome } = await run(await fixtureRelease(), { yes: true })
    expect(outcome).toEqual({ version: '0.1.0' })
  })

  it('refuses a manifest signed by a key the root does not list, even when the person would agree', async () => {
    const other = await fixtureRelease()
    const { outcome, installed, questions } = await run(await fixtureRelease({ manifestSigners: [other.keys.targets] }), { late: true })
    expect(refusal(outcome)).toMatch(/INSTALL_VERIFY_FAILED/u)
    expect(installed).toEqual([])
    expect(questions).toEqual([])
  })

  it('refuses a release below the floor, even when the timestamp is stale and the person would agree', async () => {
    const { outcome, installed, questions } = await run(await fixtureRelease(), { late: true, current: '0.2.0' })
    expect(refusal(outcome)).toMatch(/TARGET_LOWER.*delorun recover rollback/su)
    expect(installed).toEqual([])
    expect(questions).toEqual([])
  })

  it('names the file the folder lacks', async () => {
    const { outcome, installed } = await run(await fixtureRelease(), { leave: ['delorun-0.1.0-linux-x64.tar.gz'] })
    expect(refusal(outcome)).toMatch(/delorun-0\.1\.0-linux-x64\.tar\.gz|404/u)
    expect(installed).toEqual([])
    const missingBundle = await run(await fixtureRelease(), { leave: ['delorun-0.1.0.manifest.log.json'] })
    expect(refusal(missingBundle.outcome)).toMatch(/delorun-0\.1\.0\.manifest\.log\.json/u)
  })

  it('says a folder that does not exist does not exist, and a file is not a folder', async () => {
    const missing = await run(await fixtureRelease(), { from: folder => join(folder, 'no', 'such', 'folder') })
    expect(refusal(missing.outcome)).toMatch(/^delorun update --from: .*no[\\/]such[\\/]folder does not exist\. Nothing was installed\.$/u)
    expect(missing.installed).toEqual([])
    const file = await run(await fixtureRelease(), { from: folder => join(folder, 'timestamp.json') })
    expect(refusal(file.outcome)).toMatch(/timestamp\.json is not a folder\. Nothing was installed\.$/u)
  })

  it('refuses an http: address', async () => {
    const { outcome, installed } = await run(await fixtureRelease(), { from: () => 'http://mirror.example/release' })
    expect(refusal(outcome)).toMatch(/https:/u)
    expect(installed).toEqual([])
  })

  it('does nothing when the folder holds the release that runs now', async () => {
    const { outcome, installed } = await run(await fixtureRelease(), { current: '0.1.0' })
    expect(outcome).toEqual({ version: '0.1.0' })
    expect(installed).toEqual([])
  })
})
