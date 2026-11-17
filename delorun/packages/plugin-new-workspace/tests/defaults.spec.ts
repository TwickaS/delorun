/**
 * The per-workspace defaults: the routes that read and record them in a protected file under the Delorun home, the last
 * folder a new folder went in, and the seed that starts a new top-level chat on its workspace's model. A store that is
 * not in the expected mode or format is never read or overwritten.
 */
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lastParent, readDefaultsRoute, rememberParent, seedWorkspaceModel, setDefaultsRoute, type SeededAgent } from '../src/defaults.ts'
import { DefaultsAnswer, type WorkspaceDefaults } from '../src/wire.ts'

let scratch = ''
let person = ''
let delorunHome = ''
let project = ''

/** The store file under the Delorun home. */
const storeFile = (): string => join(delorunHome, 'secrets', 'new-workspace', 'defaults.json')

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-new-workspace-defaults-'))
  person = join(scratch, 'a', 'b', 'person')
  delorunHome = join(scratch, 'delorun')
  project = join(person, 'projects')
  for (const directory of [project, join(person, '.dsh'), delorunHome]) await mkdir(directory, { recursive: true })
  vi.stubEnv('HOME', person)
  vi.stubEnv('DELORUN_HOME', delorunHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

/** The environment and log the defaults need. */
function deps() {
  return { env: process.env, warn: vi.fn() }
}

/** Ask a route and read its status and body. */
async function ask(route: typeof readDefaultsRoute, body: unknown, harness = deps()) {
  const response = await route(new Request('http://harness.test/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), harness)
  const answer: unknown = await response.json()
  return { status: response.status, body: answer, warn: harness.warn }
}

const MODEL: WorkspaceDefaults = { model: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' }, browser: 'none' }

/** Write a store file at the given mode, creating its directory. */
async function plantStore(text: string, mode: number): Promise<void> {
  await mkdir(join(delorunHome, 'secrets', 'new-workspace'), { recursive: true })
  await writeFile(storeFile(), text, { mode })
  await chmod(storeFile(), mode)
}

describe('recording and reading a workspace\'s defaults', () => {
  it('answers empty defaults for a workspace without any, and creates no file', async () => {
    const answer = await ask(readDefaultsRoute, { path: project })
    expect(answer).toMatchObject({ status: 200, body: { result: 'defaults', defaults: {} } })
    await expect(stat(storeFile())).rejects.toThrow()
  })

  it('creates the store under the Delorun home at mode 0600 and answers what it now holds', async () => {
    const answer = await ask(setDefaultsRoute, { path: project, defaults: MODEL })
    expect(DefaultsAnswer.parse(answer.body)).toEqual({ result: 'defaults', defaults: MODEL })
    if (process.platform !== 'win32') expect((await stat(storeFile())).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(storeFile(), 'utf8'))).toEqual({ v: 1, workspaces: { [await realpath(project)]: MODEL } })
  })

  it('reads back what was recorded, and a later record replaces it whole', async () => {
    await ask(setDefaultsRoute, { path: project, defaults: MODEL })
    expect((await ask(readDefaultsRoute, { path: project })).body).toEqual({ result: 'defaults', defaults: MODEL })
    await ask(setDefaultsRoute, { path: project, defaults: { browser: 'isolated' } })
    expect((await ask(readDefaultsRoute, { path: project })).body).toEqual({ result: 'defaults', defaults: { browser: 'isolated' } })
  })

  it('keys the defaults by the canonical path, so a symlinked spelling reads the same entry', async () => {
    const link = join(scratch, 'link')
    await symlink(project, link)
    await ask(setDefaultsRoute, { path: link, defaults: MODEL })
    expect(Object.keys(JSON.parse(await readFile(storeFile(), 'utf8')).workspaces as object)).toEqual([await realpath(project)])
    expect((await ask(readDefaultsRoute, { path: project })).body).toEqual({ result: 'defaults', defaults: MODEL })
    expect((await ask(readDefaultsRoute, { path: link })).body).toEqual({ result: 'defaults', defaults: MODEL })
  })

  it('keeps other workspaces\' defaults when one changes', async () => {
    const other = join(person, 'other')
    await mkdir(other)
    await ask(setDefaultsRoute, { path: project, defaults: MODEL })
    await ask(setDefaultsRoute, { path: other, defaults: { browser: 'none' } })
    expect((await ask(readDefaultsRoute, { path: project })).body).toEqual({ result: 'defaults', defaults: MODEL })
  })
})

describe('the folders whose defaults are never read or kept', () => {
  it.each<readonly [string, string, () => string]>([
    ['the home directory', 'home-directory', () => person],
    ['the Delorun home', 'delorun-home', () => delorunHome],
    ['a folder in the Delorun home', 'delorun-home', () => join(delorunHome, 'secrets')],
    ['a relative path', 'not-absolute', () => 'projects'],
  ])('refuses %s with 422 and writes nothing', async (_, problem, path) => {
    await mkdir(join(delorunHome, 'secrets'), { recursive: true })
    expect(await ask(readDefaultsRoute, { path: path() })).toMatchObject({ status: 422, body: { result: 'refused', problem } })
    expect(await ask(setDefaultsRoute, { path: path(), defaults: MODEL })).toMatchObject({ status: 422, body: { result: 'refused', problem } })
    await expect(stat(storeFile())).rejects.toThrow()
  })

  it('answers 500 and writes nothing when the Delorun home cannot be resolved', async () => {
    vi.stubEnv('DELORUN_HOME', 'relative/home')
    expect((await ask(readDefaultsRoute, { path: project })).status).toBe(500)
    expect((await ask(setDefaultsRoute, { path: project, defaults: MODEL })).status).toBe(500)
  })
})

describe('a request that cannot be read', () => {
  it.each([
    ['not JSON', '{'],
    ['an extra field', { path: project, more: 1 }],
    ['no path', {}],
  ])('answers 400 to a read with %s', async (_, body) => {
    expect((await ask(readDefaultsRoute, body)).status).toBe(400)
  })

  it.each([
    ['not JSON', '{'],
    ['no defaults', { path: '/x' }],
    ['an unknown browser choice', { path: '/x', defaults: { browser: 'shared' } }],
    ['a model without a model id', { path: '/x', defaults: { model: { provider: 'p' } } }],
    ['an extra defaults field', { path: '/x', defaults: { theme: 'dark' } }],
  ])('answers 400 to a record with %s and writes nothing', async (_, body) => {
    expect((await ask(setDefaultsRoute, body)).status).toBe(400)
    await expect(stat(storeFile())).rejects.toThrow()
  })
})

describe('a store that is not what this version writes', () => {
  const valid = JSON.stringify({ v: 1, workspaces: {} })

  it.skipIf(process.platform === 'win32')('is refused with a laxer mode, and left as it was', async () => {
    await plantStore(valid, 0o644)
    const read = await ask(readDefaultsRoute, { path: project })
    expect([read.status, read.body]).toEqual([500, { result: 'failed' }])
    const set = await ask(setDefaultsRoute, { path: project, defaults: MODEL })
    expect([set.status, set.body]).toEqual([500, { result: 'failed' }])
    expect(await readFile(storeFile(), 'utf8')).toBe(valid)
    expect((await stat(storeFile())).mode & 0o777).toBe(0o644)
    expect(set.warn).toHaveBeenCalledWith('the workspace defaults were not kept: DefaultsStoreError')
  })

  it.each([
    ['another version', JSON.stringify({ v: 2, workspaces: {} })],
    ['an unknown field', JSON.stringify({ v: 1, workspaces: {}, extra: true })],
    ['no JSON', 'not json'],
  ])('is refused with %s, and left as it was', async (_, text) => {
    await plantStore(text, 0o600)
    expect((await ask(readDefaultsRoute, { path: project })).status).toBe(500)
    expect((await ask(setDefaultsRoute, { path: project, defaults: MODEL })).status).toBe(500)
    expect(await readFile(storeFile(), 'utf8')).toBe(text)
  })
})

describe('the last folder a new folder went in', () => {
  it('is nothing while none is recorded', async () => {
    expect(await lastParent(deps())).toBeUndefined()
  })

  it('is what was recorded last, and recording keeps the workspaces\' defaults', async () => {
    await ask(setDefaultsRoute, { path: project, defaults: MODEL })
    await rememberParent(join(person, 'first'), deps())
    await rememberParent(project, deps())
    expect(await lastParent(deps())).toBe(project)
    expect((await ask(readDefaultsRoute, { path: project })).body).toEqual({ result: 'defaults', defaults: MODEL })
  })

  it('survives a later change of a workspace\'s defaults', async () => {
    await rememberParent(project, deps())
    await ask(setDefaultsRoute, { path: project, defaults: MODEL })
    expect(await lastParent(deps())).toBe(project)
  })

  it('logs a code and changes nothing when the store is refused', async () => {
    await plantStore('not json', 0o600)
    const harness = deps()
    await rememberParent(project, harness)
    expect(await lastParent(harness)).toBeUndefined()
    expect(harness.warn.mock.calls.map(call => call[0] as string)).toEqual(['the last folder used was not kept: DefaultsStoreError', 'the last folder used was not read: DefaultsStoreError'])
    expect(await readFile(storeFile(), 'utf8')).toBe('not json')
  })

  it('reads and keeps nothing, logging once each, when the Delorun home cannot be resolved', async () => {
    vi.stubEnv('DELORUN_HOME', 'relative/home')
    const harness = deps()
    await rememberParent(project, harness)
    expect(await lastParent(harness)).toBeUndefined()
    expect(harness.warn).toHaveBeenCalledTimes(2)
  })
})

describe('starting a new chat on its workspace\'s model', () => {
  type Header = Partial<Record<'cwd' | 'isSeeded' | 'origin' | 'parentSession', unknown>>

  /** A new agent in `cwd` whose log holds the given event types. */
  function agentFake(header: Header = { cwd: project }, events: readonly string[] = []) {
    const select = vi.fn()
    const agent: SeededAgent = { session: { header, ownEvents: () => events.map(type => ({ type })) }, model: { select } } as never
    return { agent, select }
  }

  const providers = () => ['deepseek', 'other']

  /** The seed's dependencies, with the store holding `defaults` for the project. */
  async function seedDeps(defaults: WorkspaceDefaults | null = MODEL, available: () => readonly string[] = providers) {
    if (defaults !== null) await ask(setDefaultsRoute, { path: project, defaults })
    return { ...deps(), providers: available }
  }

  it('selects the workspace\'s model and thinking level on a new top-level chat', async () => {
    const { agent, select } = agentFake()
    expect(await seedWorkspaceModel(agent, 'startup', await seedDeps())).toEqual(MODEL.model)
    expect(select).toHaveBeenCalledExactlyOnceWith({ provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' })
  })

  it('selects the model alone when no thinking level is stored', async () => {
    const { agent, select } = agentFake()
    await seedWorkspaceModel(agent, 'startup', await seedDeps({ model: { provider: 'other', model: 'm' } }))
    expect(select).toHaveBeenCalledExactlyOnceWith({ provider: 'other', model: 'm' })
  })

  it('finds the workspace through a link spelling of the chat\'s folder', async () => {
    const link = join(scratch, 'link')
    await symlink(project, link)
    const { agent, select } = agentFake({ cwd: link })
    await seedWorkspaceModel(agent, 'startup', await seedDeps())
    expect(select).toHaveBeenCalledOnce()
  })

  it.each<readonly [string, () => ReturnType<typeof agentFake>, 'startup' | 'resume' | 'clear' | 'compact']>([
    ['a resumed chat', () => agentFake(), 'resume'],
    ['a cleared chat', () => agentFake(), 'clear'],
    ['a compacted chat', () => agentFake(), 'compact'],
    ['a seeded chat', () => agentFake({ cwd: project, isSeeded: true }), 'startup'],
    ['a delegated chat', () => agentFake({ cwd: project, origin: 'subagent' }), 'startup'],
    ['a forked chat', () => agentFake({ cwd: project, parentSession: 'parent-1' }), 'startup'],
    ['a chat without a folder', () => agentFake({}), 'startup'],
    ['a chat with a blank folder', () => agentFake({ cwd: '  ' }), 'startup'],
    ['a chat whose log records a model', () => agentFake({ cwd: project }, ['model/selection']), 'startup'],
    ['a chat whose log has a request header', () => agentFake({ cwd: project }, ['request/header']), 'startup'],
  ])('leaves %s alone', async (_, make, source) => {
    const { agent, select } = make()
    expect(await seedWorkspaceModel(agent, source, await seedDeps())).toBeUndefined()
    expect(select).not.toHaveBeenCalled()
  })

  it('leaves a chat alone in a workspace without a model, or without any defaults', async () => {
    const { agent, select } = agentFake()
    expect(await seedWorkspaceModel(agent, 'startup', await seedDeps(null))).toBeUndefined()
    expect(await seedWorkspaceModel(agent, 'startup', await seedDeps({ browser: 'none' }))).toBeUndefined()
    expect(select).not.toHaveBeenCalled()
  })

  it('leaves a chat alone, and warns without naming the route, when the model\'s provider is not available', async () => {
    const { agent, select } = agentFake()
    const harness = await seedDeps(MODEL, () => ['other'])
    expect(await seedWorkspaceModel(agent, 'startup', harness)).toBeUndefined()
    expect(select).not.toHaveBeenCalled()
    expect(harness.warn).toHaveBeenCalledExactlyOnceWith('a new chat starts on the home\'s model, because its workspace\'s model route is not available')
  })

  it('opens the chat on the home\'s model, logging a code, when the store is refused or the home is unresolved', async () => {
    const { agent, select } = agentFake()
    await plantStore('not json', 0o600)
    const harness = deps()
    expect(await seedWorkspaceModel(agent, 'startup', { ...harness, providers })).toBeUndefined()
    expect(harness.warn).toHaveBeenCalledExactlyOnceWith('a new chat starts on the home\'s model, because the workspace defaults were not read: DefaultsStoreError')
    vi.stubEnv('DELORUN_HOME', 'relative/home')
    expect(await seedWorkspaceModel(agent, 'startup', { ...deps(), providers })).toBeUndefined()
    expect(select).not.toHaveBeenCalled()
  })
})
