// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { CLONE_POLL_MS, createChosen, setUpWorkspace, type SetupPlan } from '../src/client/create.ts'
import { failure, fakeApi, fakeFullAccess, ok } from './fixtures.client.ts'

/** A wait that returns at once and records the delays asked. */
const instant = () => vi.fn(async (_ms: number) => {})

describe('adding a folder that exists', () => {
  it('reports the workspace the registry made', async () => {
    const { api, add } = fakeApi()
    expect(await createChosen(api, { kind: 'existing', path: '/home/person/src/site' }, vi.fn())).toEqual({ ok: true, workspaceId: 'workspace-1', path: '/home/person/src/site' })
    expect(add).toHaveBeenCalledExactlyOnceWith('/home/person/src/site')
  })

  it('carries the Host\'s reason for refusing the folder', async () => {
    const { api } = fakeApi({ add: async () => ok({ result: 'refused', problem: 'home-directory' }) })
    expect(await createChosen(api, { kind: 'existing', path: '/home/person' }, vi.fn())).toEqual({ ok: false, problem: { kind: 'place', problem: 'home-directory' } })
  })

  it('reports a registry failure and a locked device as such', async () => {
    const failed = fakeApi({ add: async () => ok({ result: 'failed' }) })
    expect(await createChosen(failed.api, { kind: 'existing', path: '/x' }, vi.fn())).toEqual({ ok: false, problem: { kind: 'failed' } })
    const locked = fakeApi({ add: async () => failure('locked') })
    expect(await createChosen(locked.api, { kind: 'existing', path: '/x' }, vi.fn())).toEqual({ ok: false, problem: { kind: 'locked' } })
  })
})

describe('making a new folder', () => {
  it('asks for the folder with the parent, name and Git choice', async () => {
    const { api, create } = fakeApi()
    const result = await createChosen(api, { kind: 'new', parent: '/home/person/Projects', name: 'my-project', git: false }, vi.fn())
    expect(result).toEqual({ ok: true, workspaceId: 'workspace-2', path: '/home/person/Projects/my-project' })
    expect(create).toHaveBeenCalledExactlyOnceWith({ parent: '/home/person/Projects', name: 'my-project', git: false })
  })

  it('carries the Host\'s reason when the name is taken', async () => {
    const { api } = fakeApi({ create: async () => ok({ result: 'refused', problem: 'exists' }) })
    expect(await createChosen(api, { kind: 'new', parent: '/p', name: 'a', git: true }, vi.fn())).toEqual({ ok: false, problem: { kind: 'create', problem: 'exists' } })
  })
})

describe('following a clone', () => {
  const started = { kind: 'clone', url: 'https://example.com/site.git', branch: '', parent: '/home/person/Projects', name: 'site', job: 'job-1' } as const

  it('asks once a second, reports the percent, and ends with the workspace when the Host has added it', async () => {
    const statuses = [{ state: 'running' as const }, { state: 'running' as const, percent: 42 }, { state: 'done' as const, workspaceId: 'workspace-3', path: '/home/person/Projects/site', kind: 'code' as const }]
    const { api, cloneStatus } = fakeApi({ cloneStatus: async () => ok(statuses.shift() ?? { state: 'unknown' as const }) })
    const progress = vi.fn()
    const wait = instant()
    const result = await createChosen(api, started, progress, { wait })
    expect(result).toEqual({ ok: true, workspaceId: 'workspace-3', path: '/home/person/Projects/site' })
    expect(progress.mock.calls).toEqual([[undefined], [42]])
    expect(wait.mock.calls).toEqual([[CLONE_POLL_MS], [CLONE_POLL_MS]])
    expect(CLONE_POLL_MS).toBe(1000)
    expect(cloneStatus).toHaveBeenCalledWith('job-1')
  })

  it('ends with the failure Git gave, to be shown on the clone screen', async () => {
    const { api } = fakeApi({ cloneStatus: async () => ok({ state: 'failed', failure: 'sign-in' }) })
    expect(await createChosen(api, started, vi.fn(), { wait: instant() })).toEqual({ ok: false, problem: { kind: 'clone-failed', failure: 'sign-in' } })
  })

  it('ends when the Host no longer knows the job', async () => {
    const { api } = fakeApi({ cloneStatus: async () => ok({ state: 'unknown' }) })
    expect(await createChosen(api, started, vi.fn(), { wait: instant() })).toEqual({ ok: false, problem: { kind: 'clone-lost' } })
  })

  it('gives up after three reads in a row fail, but not after one', async () => {
    const answers = [failure('failed'), ok({ state: 'running' as const }), failure('failed'), failure('failed'), failure('failed')]
    const { api, cloneStatus } = fakeApi({ cloneStatus: async () => answers.shift() ?? failure('failed') })
    const result = await createChosen(api, started, vi.fn(), { wait: instant() })
    expect(result).toEqual({ ok: false, problem: { kind: 'failed' } })
    expect(cloneStatus).toHaveBeenCalledTimes(5)
  })

  it('stops at a locked device instead of asking again', async () => {
    const { api, cloneStatus } = fakeApi({ cloneStatus: async () => failure('locked') })
    expect(await createChosen(api, started, vi.fn(), { wait: instant() })).toEqual({ ok: false, problem: { kind: 'locked' } })
    expect(cloneStatus).toHaveBeenCalledOnce()
  })

  it('stops following when the dialog closes, and leaves the clone to the Host', async () => {
    const controller = new AbortController()
    const { api, cloneStatus } = fakeApi({ cloneStatus: async () => ok({ state: 'running' as const }) })
    const wait = vi.fn(async (_ms: number) => { controller.abort() })
    expect(await createChosen(api, started, vi.fn(), { wait, signal: controller.signal })).toEqual({ ok: false, cancelled: true })
    expect(cloneStatus).toHaveBeenCalledOnce()
  })

  it('has nothing to follow without a job', async () => {
    const { api } = fakeApi()
    const { job: _none, ...unstarted } = started
    expect(await createChosen(api, unstarted, vi.fn())).toEqual({ ok: false, problem: { kind: 'failed' } })
  })
})

describe('setting up a workspace that exists', () => {
  const PLAN: SetupPlan = { model: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' }, permission: 'files', network: { access: 'open', hosts: [] } }
  const PATH = '/home/person/Projects/site'

  it('stores the model and asks for nothing else under the safe choices', async () => {
    const { api, setDefaults, setNetwork } = fakeApi()
    const { fullAccess, ask } = fakeFullAccess()
    expect(await setUpWorkspace(api, PATH, PLAN, fullAccess)).toEqual([])
    expect(setDefaults).toHaveBeenCalledExactlyOnceWith(PATH, { model: PLAN.model })
    expect(setNetwork).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('stores the browser choice with the model when there is one, and stores nothing when there is neither', async () => {
    const { api, setDefaults } = fakeApi()
    const { fullAccess } = fakeFullAccess()
    await setUpWorkspace(api, PATH, { ...PLAN, browser: 'none' }, fullAccess)
    expect(setDefaults).toHaveBeenLastCalledWith(PATH, { model: PLAN.model, browser: 'none' })
    setDefaults.mockClear()
    await setUpWorkspace(api, PATH, { ...PLAN, model: undefined }, fullAccess)
    expect(setDefaults).not.toHaveBeenCalled()
  })

  it('goes on to the network and Full access after defaults fail, naming each step that failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api, setNetwork } = fakeApi({ setDefaults: async () => failure('failed'), setNetwork: async () => ok({ network: { access: 'off', hosts: [] } }) })
    const { fullAccess, ask } = fakeFullAccess(false)
    const notes = await setUpWorkspace(api, PATH, { ...PLAN, permission: 'full', network: { access: 'off', hosts: [] } }, fullAccess)
    expect(notes).toEqual(['defaults'])
    expect(setNetwork).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledExactlyOnceWith(PATH)
  })

  it('reports a Host answer that is not the defaults as a failure', async () => {
    const { api } = fakeApi({ setDefaults: async () => ok({ result: 'refused', problem: 'home-directory' }) })
    expect(await setUpWorkspace(api, PATH, PLAN, fakeFullAccess().fullAccess)).toEqual(['defaults'])
  })

  it('reports a network that was not saved, and an absent or failing consent service', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api } = fakeApi({ setNetwork: async () => failure('locked') })
    const plan: SetupPlan = { ...PLAN, permission: 'full', network: { access: 'allowlist', hosts: ['pypi.org'] } }
    expect(await setUpWorkspace(api, PATH, plan, fakeFullAccess(true, false).fullAccess)).toEqual(['network', 'full-access-later'])
    const refusing = fakeFullAccess()
    refusing.ask.mockRejectedValue(new Error('no prompt'))
    expect(await setUpWorkspace(api, PATH, plan, refusing.fullAccess)).toEqual(['network', 'full-access-later'])
  })
})
