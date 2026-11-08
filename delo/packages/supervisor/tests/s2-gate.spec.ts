/**
 * The S2 start path through the confinement gate, over an in-memory engine: a workspace whose container shows every
 * property runs, and one that fails its health or confinement check is stopped, removed and reported with C9's code, so
 * nothing starts in it again. The engine's execs are the container's own view, and what a spec makes them show is what
 * a machine that altered a running container would show.
 *
 * Each `it` names the check whose removal makes it fail.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { StartToken } from '@delo/contract-home-layout'
import { SUPERVISOR_ROOTS_FILE } from '@delo/contract-home-layout'
import { PRESETS, type SupervisorRequest, type WorkspaceId } from '@delo/contract-runtime-supervisor'
import { writeProtectedFile } from '@delo/home'
import { afterEach, describe, expect, it } from 'vitest'
import { SupervisorError, workspaceNames, type WorkspaceView } from '../src/index.ts'
import { FAKE_DIGEST, fakeWorkspaces, PROFILE, tempHome, type FakeEngineState, type FakeWorkspaceOptions, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  temp?.remove()
  temp = undefined
})

const WORKSPACE = 'w' as WorkspaceId

const create = (root: string): Extract<SupervisorRequest, { readonly op: 'workspace.create' }> => ({
  v: 1, token: 't' as StartToken, op: 'workspace.create', args: { workspaceId: WORKSPACE, root, preset: 'small', egress: 'none', allowlistAdditions: [], credentials: 'none' },
})
const start = (): Extract<SupervisorRequest, { readonly op: 'workspace.start' }> => ({ v: 1, token: 't' as StartToken, op: 'workspace.start', args: { workspaceId: WORKSPACE } })
const inspect = (): Extract<SupervisorRequest, { readonly op: 'workspace.inspect' }> => ({ v: 1, token: 't' as StartToken, op: 'workspace.inspect', args: { workspaceId: WORKSPACE } })
const remove = (): Extract<SupervisorRequest, { readonly op: 'workspace.remove' }> => ({ v: 1, token: 't' as StartToken, op: 'workspace.remove', args: { workspaceId: WORKSPACE } })

/** The containers the engine still holds: what a run left behind. */
const containers = (state: FakeEngineState): string[] => [...state.containers.keys()].sort()

/** The helper's socket directory of the workspace, which `workspace.create` makes and a retirement removes. */
function helperDirectory(): string {
  return join(temp?.home ?? '', 'run', 'default', 's2', workspaceNames(WORKSPACE).container.slice('delo-ws-'.length))
}

async function workspace(state: FakeEngineState = { containers: new Map(), calls: [] }, options: FakeWorkspaceOptions = {}): Promise<{ readonly workspaces: Awaited<ReturnType<typeof fakeWorkspaces>>, readonly root: string, readonly state: FakeEngineState }> {
  temp = await tempHome()
  const parent = join(temp.outside, 'projects')
  mkdirSync(parent, { mode: 0o700 })
  await writeProtectedFile(join(temp.home, SUPERVISOR_ROOTS_FILE), JSON.stringify({ v: 1, parents: [parent] }))
  const root = join(parent, 'w')
  mkdirSync(root)
  return { workspaces: await fakeWorkspaces(temp.home, state, homedir(), FAKE_DIGEST, PROFILE, options), root, state }
}

async function refusalOf(run: () => Promise<unknown>): Promise<SupervisorError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SupervisorError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

/** Every container of the engine, as the gate would read it, with one more bind mount. */
function mountInto(state: FakeEngineState, source: string, destination: string): void {
  for (const [name, record] of state.containers) state.containers.set(name, { ...record, Mounts: [...record.Mounts ?? [], { Type: 'bind', Source: source, Destination: destination }] })
}

describe('a workspace whose container holds every property', () => {
  it('starts, and reports its state and its limits', async () => {
    const { workspaces, root } = await workspace()
    expect(await workspaces.handle(create(root))).toMatchObject({ workspace: { state: 'created' } })
    const started = await workspaces.handle(start())
    expect(started).toMatchObject({ workspace: { state: 'running', limits: { memoryBytes: PRESETS.small.memoryBytes, pids: PRESETS.small.pids }, egress: 'none' } })
    // A workspace that passed carries no reason; a gate that reported every workspace failed would show one here.
    expect((started.workspace as WorkspaceView).reason).toBeUndefined()
    expect(await workspaces.handle(inspect())).toMatchObject({ workspace: { state: 'running' } })
  })

  it('reads the container from inside through the probes of C9\'s containers section', async () => {
    const seen: string[] = []
    const { workspaces, root } = await workspace({ containers: new Map(), calls: [], exec: (_container, cmd) => { seen.push(cmd.join(' ')); return 0 } })
    await workspaces.handle(create(root))
    await workspaces.handle(start())
    // Every capability, the no-new-privileges flag, seccomp, the read-only root, the root's writability, the writable
    // mounts, the Delo home, the Docker socket, /tmp, the three cgroup limits, the user and the network.
    expect(seen.length).toBeGreaterThanOrEqual(14)
    expect(new Set(seen).size).toBe(seen.length)
    for (const marker of ['CapBnd', 'NoNewPrivs', 'Seccomp', '/proc/mounts', 'memory.max', 'pids.max', 'cpu.max', 'id -u', '/proc/net/route']) {
      expect(seen.some(cmd => cmd.includes(marker)), marker).toBe(true)
    }
  })
})

describe('a container that fails the gate', () => {
  it('is stopped, removed and reported with LIMITS_MISSING naming the property, and is never started again', async () => {
    const { workspaces, root, state } = await workspace({ containers: new Map(), calls: [], exec: (_container, cmd) => cmd.join(' ').includes('CapBnd') ? 1 : 0 })
    await workspaces.handle(create(root))
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('LIMITS_MISSING')
    expect(refusal.detail).toContain('capabilities')
    // The container and the helper's directory are gone: nothing is left that could start in the altered container.
    expect(containers(state)).toEqual([])
    expect(existsSync(helperDirectory())).toBe(false)
    // The workspace is reported failed with the code, not as a runtime a caller could use.
    expect(await workspaces.handle(inspect())).toMatchObject({ workspace: { state: 'failed', reason: 'LIMITS_MISSING' } })
    // Removing the container is what makes it unreusable: a second start cannot bring it back.
    expect((await refusalOf(async () => workspaces.handle(start()))).code).toBe('NOT_FOUND')
  })

  it('is retired when a probe cannot run, because a property no probe confirmed is not one the workspace has', async () => {
    const { workspaces, root, state } = await workspace({ containers: new Map(), calls: [], exec: (_container, cmd) => cmd.join(' ').includes('id -u') ? 127 : 0 })
    await workspaces.handle(create(root))
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('LIMITS_MISSING')
    expect(refusal.detail).toContain('unconfirmed')
    expect(containers(state)).toEqual([])
  })

  it('is retired with ROOT_REFUSED when the machine mounts the Delo home after the pre-start checks', async () => {
    const { workspaces, root, state } = await workspace({
      containers: new Map(),
      calls: [],
      // Only a gate that reads the record again after the start sees this mount; without that read the workspace would
      // reach the person's home and the Delo home's secrets.
      exec: (_container, _cmd, current) => { mountInto(current, temp?.home ?? '', temp?.home ?? ''); return 0 },
    })
    await workspaces.handle(create(root))
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('ROOT_REFUSED')
    expect(refusal.detail).toContain('a path in the Delo home')
    expect(containers(state)).toEqual([])
    expect(await workspaces.handle(inspect())).toMatchObject({ workspace: { state: 'failed', reason: 'ROOT_REFUSED' } })
  })

  it('is retired with ROOT_REFUSED when the machine mounts a Docker socket', async () => {
    const { workspaces, root, state } = await workspace({
      containers: new Map(),
      calls: [],
      exec: (_container, _cmd, current) => { mountInto(current, '/var/run/docker.sock', '/var/run/docker.sock'); return 0 },
    })
    await workspaces.handle(create(root))
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('ROOT_REFUSED')
    expect(refusal.detail).toContain('a Docker socket')
    expect(containers(state)).toEqual([])
  })

  it('is retired with ROOT_REFUSED when the machine makes another host path writable', async () => {
    const { workspaces, root, state } = await workspace({
      containers: new Map(),
      calls: [],
      exec: (_container, _cmd, current) => { mountInto(current, '/opt/extra-dir', '/opt/extra-dir'); return 0 },
    })
    await workspaces.handle(create(root))
    expect((await refusalOf(async () => workspaces.handle(start()))).detail).toContain('not the workspace root')
    expect(containers(state)).toEqual([])
  })

  it('is retired with ENGINE_REFUSED when it does not stay running', async () => {
    const { workspaces, root, state } = await workspace({ containers: new Map(), calls: [], startState: { Status: 'exited', Running: false, ExitCode: 1 } })
    await workspaces.handle(create(root))
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('ENGINE_REFUSED')
    expect(refusal.detail).toContain('did not stay running')
    expect(containers(state)).toEqual([])
  })

  it('is retired with LIMITS_MISSING when a setting C9 requires did not reach the container', async () => {
    const { workspaces, root, state } = await workspace({ containers: new Map(), calls: [] })
    await workspaces.handle(create(root))
    for (const [name, record] of state.containers) state.containers.set(name, { ...record, HostConfig: { ...record.HostConfig, ReadonlyRootfs: false } })
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    // The pre-start comparison names the setting first; either way the workspace is refused, never started as it is.
    expect(refusal.code).toBe('LIMITS_MISSING')
    expect(refusal.detail).toContain('HostConfig.ReadonlyRootfs')
    expect(state.calls.filter(call => call.endsWith('/start'))).toEqual([])
  })
})

describe('a container that already carries a forbidden mount', () => {
  it('is refused before it starts, with ROOT_REFUSED and no start call', async () => {
    const { workspaces, root, state } = await workspace()
    await workspaces.handle(create(root))
    mountInto(state, '/var/run/docker.sock', '/var/run/docker.sock')
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('ROOT_REFUSED')
    expect(refusal.detail).toContain('a Docker socket')
    // Without the pre-start mount check the engine's altered container would run.
    expect(state.calls.filter(call => call.endsWith('/start'))).toEqual([])
  })

  it('is refused with LIMITS_MISSING when it joined another network besides its own', async () => {
    const { workspaces, root, state } = await workspace()
    await workspaces.handle(create(root))
    for (const [name, record] of state.containers) {
      state.containers.set(name, { ...record, NetworkSettings: { Networks: { ...record.NetworkSettings?.Networks ?? {}, bridge: {} } } })
    }
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('LIMITS_MISSING')
    expect(refusal.detail).toContain('not on its own internal network')
  })
})

describe('a retired workspace', () => {
  it('is created again from scratch, and its failure no longer stands', async () => {
    const { workspaces, root, state } = await workspace({ containers: new Map(), calls: [], exec: (_container, cmd) => cmd.join(' ').includes('NoNewPrivs') ? 1 : 0 })
    await workspaces.handle(create(root))
    expect((await refusalOf(async () => workspaces.handle(start()))).code).toBe('LIMITS_MISSING')
    expect(await workspaces.handle(inspect())).toMatchObject({ workspace: { state: 'failed', reason: 'LIMITS_MISSING' } })
    state.exec = () => 0
    expect(await workspaces.handle(create(root))).toMatchObject({ workspace: { state: 'created' } })
    const created = await workspaces.handle(inspect())
    expect(created).toMatchObject({ workspace: { state: 'created' } })
    expect((created.workspace as WorkspaceView).reason).toBeUndefined()
  })

  it('can be removed, and leaves nothing behind', async () => {
    const { workspaces, root, state } = await workspace({ containers: new Map(), calls: [], exec: (_container, cmd) => cmd.join(' ').includes('Seccomp') ? 1 : 0 })
    await workspaces.handle(create(root))
    expect((await refusalOf(async () => workspaces.handle(start()))).detail).toContain('seccomp')
    expect(existsSync(helperDirectory())).toBe(false)
    expect(await workspaces.handle(remove())).toEqual({})
    expect(containers(state)).toEqual([])
    // With its report cleared, the workspace is unknown again: a removal that left the report would hide this.
    expect((await refusalOf(async () => workspaces.handle(inspect()))).code).toBe('NOT_FOUND')
  })
})

describe('a machine where a limit S2 requires is not enforced', () => {
  it('refuses the workspace with LIMITS_MISSING rather than run it without the limit, creating nothing', async () => {
    // The probes showed the limit enforced nowhere on this engine, so no container it starts is one C9 allows.
    const { workspaces, root, state } = await workspace({ containers: new Map(), calls: [] }, { unenforced: ['memory'] })
    const refusal = await refusalOf(async () => workspaces.handle(create(root)))
    expect(refusal.code).toBe('LIMITS_MISSING')
    expect(refusal.detail).toContain('a limit S2 requires is not enforced on this machine')
    // Refused before anything was made: no network, no container and no helper's directory to clean up.
    expect(containers(state)).toEqual([])
    expect(state.calls.filter(call => call.startsWith('POST '))).toEqual([])
    expect(existsSync(helperDirectory())).toBe(false)
  })
})
