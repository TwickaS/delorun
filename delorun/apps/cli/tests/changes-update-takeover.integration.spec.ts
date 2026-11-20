/**
 * The update baseline through the real start: `startForeground` reads a handover line and `HomeProcess.takeOver` boots
 * the successor's Host, whose boot re-points its plugin copies. The pack's change waiting from the previous release is
 * closed there, and only there: a fresh `HomeProcess.start` applies nothing. The signed pack files are a stand-in for
 * `openSignedPacks`, which `packs-client` specs verify.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunProfileOptions } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { attestTerminal, listChanges, readActiveRecord, readApproved, readChangeLog, setProtection, type SignedPackFiles } from '@delorun/changes'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { acquireHomeLock, runDirectory } from '@delorun/home'
import type { HandoverMessage } from '@delorun/contract-home-process'
import type { HandoverLine, HandoverPipe } from '@delorun/home-process'
import { parseRuntimeVersion } from '@delorun/runtime-store'
import { changesApprovedContent, repointForSuccessor, startChanges } from '../src/changes/start.ts'
import type { CommandContext } from '../src/command.ts'
import { NO_APPROVED_CONTENT } from '../src/compose.ts'
import { NO_RELEASE_PACKS } from '../src/release-packs.ts'
import { main } from '../src/main.ts'
import { EXIT } from '../src/exit.ts'
import { requestStudioLink } from '../src/open/studio.ts'
import { realPreStartSteps, startForeground, upstreamDependencies, type StartDependencies } from '../src/start.ts'
import { runtimeOfFile } from '../src/update/runtime.ts'
import { composedBootRows, composedProviders } from './fixtures/composed-rows.ts'

const hooks = vi.hoisted(() => ({ signed: new Map<string, import('@delorun/changes').SignedPackFiles[]>(), asked: [] as string[] }))

// The real `updateBaselineOf` runs, with its newer-release guard and its two packs-file reads; the signature checks of
// `openSignedPacks` are the `packs-client` specs'.
vi.mock('@delorun/runtime-store', async importOriginal => {
  const actual = await importOriginal<typeof import('@delorun/runtime-store')>()
  return {
    ...actual,
    openSignedPacks: (release: { readonly version: string }) => {
      const packs = hooks.signed.get(release.version)
      return Promise.resolve(packs === undefined ? undefined : { files: (name: string) => Promise.resolve(packs.find(pack => pack.name === name)) })
    },
  }
})

vi.mock('@delorun/plugin-packs/environment', () => ({
  hostPacksEnvironment: () => Promise.resolve({
    release: (other?: string) => {
      if (other !== undefined) hooks.asked.push(other)
      return Promise.resolve({ version: other ?? '2.0.0' })
    },
    files: undefined,
  }),
}))

let osHome: string
let home: string
let context: CommandContext
const exits: (() => void)[] = []
/** A loopback listener standing in for the Host's studio, whose health route answers 204 unless `studioStatus` says otherwise. */
let studio: Server
let studioStatus = 204

beforeEach(async () => {
  studio = createServer((_request, response) => { response.writeHead(studioStatus).end() })
  await new Promise<void>(resolve => studio.listen(0, '127.0.0.1', resolve))
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-takeover-')))
  home = join(osHome, '.delorun')
  vi.stubEnv('HOME', osHome)
  vi.stubEnv('USERPROFILE', osHome)
  vi.stubEnv('DSH_HOME', join(osHome, '.dsh'))
  vi.stubEnv('DELORUN_HOME', undefined)
  vi.stubEnv('DELORUN_PROFILE', undefined)
  hooks.asked = []
  hooks.signed.clear()
  studioStatus = 204
  disabledRows.length = 0
  context = { env: { HOME: osHome, DSH_HOME: join(osHome, '.dsh'), DEEPSEEK_API_KEY: 'fixture-key' }, stdout: () => undefined, stderr: () => undefined }
})

afterEach(async () => {
  for (const exit of exits.splice(0)) exit()
  await new Promise(resolve => studio.close(resolve))
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

const PROFILE = 'default'
const profileDir = (): string => join(home, 'profiles', PROFILE)
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const v = (text: string): RuntimeVersion => parseRuntimeVersion(text)!

const oldFiles = { 'package.json': '{"name":"pkg","version":"1"}\n', 'index.js': 'export default "one"\n' }
const newFiles = { 'package.json': '{"name":"pkg","version":"2"}\n', 'index.js': 'export default "two"\n' }

function signed(release: string, files: Readonly<Record<string, string>>): SignedPackFiles {
  return { name: 'pkg', release: v(release), files: new Map(Object.entries(files).map(([path, body]) => [path, { sha256: sha(body), executable: false }])), peers: [], texts: new Map(Object.entries(files).filter(([path]) => path === 'package.json')) }
}

/** Both releases' stored packs files, as `openSignedPacks` reads them. */
function publishPacks(): void {
  hooks.signed.set('1.0.0', [signed('1.0.0', oldFiles)])
  hooks.signed.set('2.0.0', [signed('2.0.0', newFiles)])
}

function writePack(release: string, files: Readonly<Record<string, string>>): void {
  const folder = join(home, 'packs', release, 'pkg', 'package')
  mkdirSync(folder, { recursive: true })
  for (const [path, body] of Object.entries(files)) writeFileSync(join(folder, path), body)
}

/** A set-up home whose profile approved the pack of release 1.0.0, then an update that moved `packs/current` to 2.0.0. */
async function updatedHome(): Promise<void> {
  expect(await main(['setup', '--yes'], context)).toBe(EXIT.ok)
  writePack('1.0.0', oldFiles)
  symlinkSync('1.0.0', join(home, 'packs', 'current'))
  const source = join(home, 'packs', 'current', 'pkg', 'package')
  const path = join(profileDir(), 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> }
  writeFileSync(path, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, pkg: `link:${source}` } }))
  const link = join(profileDir(), 'node_modules', 'pkg')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(relative(dirname(link), source), link)
  await setProtection(home, 'on', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
  await startChanges({ home, profile: PROFILE, terminal: false }, () => undefined)
  writePack('2.0.0', newFiles)
  rmSync(join(home, 'packs', 'current'))
  symlinkSync('2.0.0', join(home, 'packs', 'current'))
}

/** The ids of the rows the profile composes disabled, which the handover's health expectations name. */
const disabledRows: string[] = []

/** A handover line of an update from release 1.0.0 to 2.0.0, and the successor's end of its pipe. */
function updatePipe(messages: HandoverMessage[], purpose: HandoverLine['purpose'] = 'update'): HandoverPipe {
  const handover: HandoverLine = {
    type: 'handover', purpose, v: 1, home, profile: PROFILE, from: v('1.0.0'), to: v('2.0.0'),
    startId: 'a'.repeat(32) as HandoverLine['startId'], health: { disabledPlugins: [], namedRows: disabledRows, previousFailures: [], previousRows: [] }, startedAt: new Date().toISOString(),
  }
  return { handover, send: message => void messages.push(message), committed: Promise.resolve(true), close: () => undefined }
}

/** Start dependencies whose Host reports no rows of its own, over a real home; `handover` reads the given pipe. */
function dependencies(pipe: HandoverPipe | undefined): StartDependencies {
  return {
    approvedPluginContent: NO_APPROVED_CONTENT,
    releasePacks: NO_RELEASE_PACKS,
    preStartSteps: realPreStartSteps(() => Promise.resolve(false), () => Promise.resolve(false)),
    fatalRelease: () => () => undefined,
    prepareProfile: upstreamDependencies().prepareProfile,
    runProfile: (options: RunProfileOptions) => {
      const booted = (): ReturnType<typeof composedBootRows> => composedBootRows(home, options, [])
      // The profile composes some rows disabled; the predecessor's report names them, as H3 requires.
      for (const row of booted()) if (row.disabled) disabledRows.push(row.id)
      return Promise.resolve({ configSchemas: () => [], settleSecretValues: () => Promise.resolve({ moved: [], notices: [] }), rows: booted, providerOf: composedProviders(booted), releaseTurns: () => {}, shutdown: () => Promise.resolve(), dispose: () => Promise.resolve(), watchChats: () => {}, watchUpdates: () => Promise.resolve(), studio: () => ({ host: '127.0.0.1', port: (studio.address() as AddressInfo).port }), studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }), reload: () => Promise.resolve({ ok: true }) })
    },
    loadEnvironment: () => createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
    probe: () => () => Promise.resolve('answered'),
    onSignal: () => () => undefined,
    onExit: listener => void exits.push(listener),
    exit: () => undefined,
    captureOutput: () => () => undefined,
    runtime: root => runtimeOfFile(root, join(root, 'not-a-runtime')),
    updates: () => { throw new Error('a start outside the store has no update support') },
    checkRuntime: () => Promise.reject(new Error('a start outside the store checks no stored runtime')),
    successorStartCheck: () => Promise.reject(new Error('a start outside the store has no successor')),
    handover: () => Promise.resolve(pipe),
    handOff: () => Promise.resolve(undefined),
    opener: { canOpen: () => true, link: requestStudioLink, open: () => Promise.reject(new Error('no link reaches the browser here')) },
    relaunch: () => Promise.reject(new Error('no second start here')),
  }
}

const replaced = async (): Promise<readonly { readonly summary: string, readonly historyVersion?: string | undefined }[]> =>
  (await readChangeLog(home, PROFILE)).entries.filter(entry => entry.decidedFrom === 'update')
const approvedVersion = async (): Promise<string | undefined> => (await readApproved(profileDir())).plugins.pkg?.version
const waiting = async (): Promise<number> => (await listChanges({ home, profile: PROFILE, profileDir: profileDir() })).pending.length

describe('the update baseline in a start of the real home process', { timeout: 120_000 }, () => {
  it('closes the pack\'s waiting change when the update\'s successor takes over, and logs it in the history', async () => {
    await updatedHome()
    const before = await approvedVersion()
    expect(await waiting()).toBe(1)
    publishPacks()
    const messages: HandoverMessage[] = []
    mkdirSync(runDirectory(home, PROFILE), { recursive: true, mode: 0o700 })
    const pipe = updatePipe(messages)
    acquireHomeLock({ runDirectory: runDirectory(home, PROFILE), runtime: v('1.0.0'), probe: () => Promise.resolve('answered'), startId: pipe.handover.startId })

    await startForeground({ home, profile: PROFILE, open: false, output: context, env: context.env }, dependencies(pipe))

    expect(messages.map(message => message.type)).toEqual(['ready'])
    expect(hooks.asked).toEqual(['1.0.0'])
    const [entry] = await replaced()
    expect(entry?.summary).toBe('Replaced by the update to 2.0.0: pkg')
    expect(entry?.historyVersion).toBeDefined()
    expect(await approvedVersion()).not.toBe(before)
    expect(await waiting()).toBe(0)
  })

  it('applies nothing in a fresh start of the home process', async () => {
    await updatedHome()
    const before = await approvedVersion()
    publishPacks()
    await startForeground({ home, profile: PROFILE, open: false, output: context, env: context.env }, dependencies(undefined))
    expect(hooks.asked).toEqual([])
    expect(await replaced()).toEqual([])
    expect(await approvedVersion()).toBe(before)
    expect(await waiting()).toBe(1)
  })

  it('applies nothing in the takeover of a rollback, whose signed packs files would both verify', async () => {
    await updatedHome()
    const before = await approvedVersion()
    publishPacks()
    const messages: HandoverMessage[] = []
    mkdirSync(runDirectory(home, PROFILE), { recursive: true, mode: 0o700 })
    const pipe = updatePipe(messages, 'rollback')
    acquireHomeLock({ runDirectory: runDirectory(home, PROFILE), runtime: v('1.0.0'), probe: () => Promise.resolve('answered'), startId: pipe.handover.startId })

    await startForeground({ home, profile: PROFILE, open: false, output: context, env: context.env }, dependencies(pipe))

    expect(messages.map(message => message.type)).toEqual(['ready'])
    expect(hooks.asked).toEqual([])
    expect(await replaced()).toEqual([])
    expect(await approvedVersion()).toBe(before)
    expect(await waiting()).toBe(1)
  })

  it('leaves the records as the predecessor left them when the successor fails its health check, so a release without followApprovedContent resumes', async () => {
    await updatedHome()
    const approvedBefore = await readApproved(profileDir())
    const activeBefore = await readActiveRecord(home, PROFILE)
    publishPacks()
    studioStatus = 500
    const messages: HandoverMessage[] = []
    mkdirSync(runDirectory(home, PROFILE), { recursive: true, mode: 0o700 })
    const pipe = updatePipe(messages)
    acquireHomeLock({ runDirectory: runDirectory(home, PROFILE), runtime: v('1.0.0'), probe: () => Promise.resolve('answered'), startId: pipe.handover.startId })

    await expect(startForeground({ home, profile: PROFILE, open: false, output: context, env: context.env }, dependencies(pipe))).rejects.toThrow(/health check/)

    expect(messages.map(message => message.type)).toEqual(['failed'])
    expect(hooks.asked).toEqual(['1.0.0'])
    // The baseline applied before the health check failed, so the equal records below are a revert, not nothing done.
    expect(await replaced()).toHaveLength(1)
    expect(await readApproved(profileDir())).toEqual(approvedBefore)
    expect(await readActiveRecord(home, PROFILE)).toEqual(activeBefore)
    // The predecessor re-points its copies and checks the invariants, as a 2.1 release does.
    await repointForSuccessor({ home, profile: PROFILE })
    await expect(changesApprovedContent({ request: { home, profile: PROFILE, kind: 'cli', output: context, env: context.env } })).resolves.toEqual([])
  })
})
