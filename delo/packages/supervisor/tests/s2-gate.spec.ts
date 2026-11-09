/**
 * The S2 start path through the confinement gate, over an in-memory engine: a workspace whose container shows every
 * property runs, and one that fails its health or confinement check is stopped, removed and reported with C9's code, so
 * nothing starts in it again. The engine's execs are the container's own view, and what a spec makes them show is what
 * a machine that altered a running container would show.
 *
 * Each `it` names the check whose removal makes it fail.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { StartToken } from '@delo/contract-home-layout'
import { SUPERVISOR_ROOTS_FILE } from '@delo/contract-home-layout'
import { HELPER_CHANNEL_DIR, HELPER_SOCKET_DIR, PRESETS, type SupervisorRequest, type WorkspaceId } from '@delo/contract-runtime-supervisor'
import { writeProtectedFile } from '@delo/home'
import { afterEach, describe, expect, it } from 'vitest'
import { SupervisorError, EngineError, LIMITS_LABEL, workspaceNames, type WorkspaceView } from '../src/index.ts'
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
    // A retired workspace is never handed out again, and the code it was retired with is not lost.
    const again = await refusalOf(async () => workspaces.handle(start()))
    expect(again.code).toBe('LIMITS_MISSING')
    expect(again.detail).toContain('retired')
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

  it('is retired with LIMITS_MISSING when the container can write the helper\'s directory', async () => {
    // The helper's directory is mounted read-only, so a write there fails and the container cannot replace what the
    // harness connects to; a container in which that write succeeds is not one C9 allows.
    const { workspaces, root, state } = await workspace({ containers: new Map(), calls: [], exec: (_container, cmd) => cmd.join(' ').includes('! -w') ? 1 : 0 })
    await workspaces.handle(create(root))
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('LIMITS_MISSING')
    expect(refusal.detail).toContain('helper-read-only')
    expect(containers(state)).toEqual([])
    expect(await workspaces.handle(inspect())).toMatchObject({ workspace: { state: 'failed', reason: 'LIMITS_MISSING' } })
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

describe('a limit the machine changed after the container was created', () => {
  it('is refused with LIMITS_MISSING when the memory limit and its swap were raised together', async () => {
    const { workspaces, root, state } = await workspace()
    await workspaces.handle(create(root))
    // `docker update --memory 32g --memory-swap 32g` raises the record and the cgroup together, so every probe passes
    // and only the limits the container records it was created with show it is not the container that was asked for.
    for (const [name, record] of state.containers) state.containers.set(name, { ...record, HostConfig: { ...record.HostConfig, Memory: 32 * 1024 ** 3, MemorySwap: 32 * 1024 ** 3 } })
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('LIMITS_MISSING')
    expect(refusal.detail).toContain('HostConfig.Memory')
    // Refused before anything starts in it.
    expect(state.calls.filter(call => call.endsWith('/start'))).toEqual([])
  })

  it('is refused with LIMITS_MISSING when the tmpfs /tmp grew with it', async () => {
    const { workspaces, root, state } = await workspace()
    await workspaces.handle(create(root))
    for (const [name, record] of state.containers) state.containers.set(name, { ...record, HostConfig: { ...record.HostConfig, Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${String(2 * 1024 ** 3)}` } } })
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('LIMITS_MISSING')
    expect(refusal.detail).toContain('HostConfig.Tmpfs')
  })

  it('records the limits it was created with on the container itself, so they can be compared at every start', async () => {
    const { workspaces, root, state } = await workspace()
    await workspaces.handle(create(root))
    const label = [...state.containers.values()][0]?.Config?.Labels?.[LIMITS_LABEL]
    expect(label).toBeDefined()
    expect(JSON.parse(label ?? 'null')).toEqual(PRESETS.small)
  })
})

describe('a container whose probes throw', () => {
  it('is retired with the engine\'s refusal and never handed out again', async () => {
    const { workspaces, root, state } = await workspace({
      containers: new Map(),
      calls: [],
      // The engine refuses every exec, as it does once the container has died.
      exec: () => Promise.reject(new EngineError(500, 'cannot exec in a stopped container')),
    })
    await workspaces.handle(create(root))
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('ENGINE_REFUSED')
    expect(refusal.detail).toContain('cannot exec')
    // A probe that threw retired nothing without the fix: the container, its directory and a running inspect survived.
    expect(containers(state)).toEqual([])
    expect(existsSync(helperDirectory())).toBe(false)
    expect(await workspaces.handle(inspect())).toMatchObject({ workspace: { state: 'failed', reason: 'ENGINE_REFUSED' } })
    expect((await refusalOf(async () => workspaces.handle(start()))).code).toBe('ENGINE_REFUSED')
  })

  it('is retired with ENGINE_REFUSED when it stops while its probes run', async () => {
    const { workspaces, root, state } = await workspace({
      containers: new Map(),
      calls: [],
      // Every probe still answers, and only the record read after them shows the container is gone.
      exec: (_container, _cmd, current) => {
        for (const [name, record] of current.containers) current.containers.set(name, { ...record, State: { Status: 'exited', Running: false } })
        return 0
      },
    })
    await workspaces.handle(create(root))
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('ENGINE_REFUSED')
    expect(refusal.detail).toContain('not running')
    expect(containers(state)).toEqual([])
  })

  it('keeps the gate\'s verdict when its container cannot be removed, and still refuses to hand it out', async () => {
    const state: FakeEngineState = {
      containers: new Map(),
      calls: [],
      exec: (_container, cmd) => cmd.join(' ').includes('NoNewPrivs') ? 1 : 0,
      // The engine refuses the removal, as it does when a container is still in use.
      refuse: (method, path) => method === 'DELETE' && path.startsWith('/containers/') ? new EngineError(500, 'container is in use') : undefined,
    }
    const { workspaces, root } = await workspace(state)
    await workspaces.handle(create(root))
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    // The verdict is the probe's, not the failed cleanup's.
    expect(refusal.code).toBe('LIMITS_MISSING')
    expect(refusal.detail).toContain('no-new-privileges')
    // The removal failed, so the container survives; the workspace still reports failed with the verdict...
    expect(containers(state)).toHaveLength(1)
    expect(await workspaces.handle(inspect())).toMatchObject({ workspace: { state: 'failed', reason: 'LIMITS_MISSING' } })
    // ...and its container is never started again.
    const starts = state.calls.filter(call => call.endsWith('/start')).length
    expect((await refusalOf(async () => workspaces.handle(start()))).code).toBe('LIMITS_MISSING')
    expect(state.calls.filter(call => call.endsWith('/start')).length).toBe(starts)
  })
})

describe('a start on a container that already runs', () => {
  it('is refused instead of starting it a second time, which the engine answers with 304', async () => {
    const { workspaces, root, state } = await workspace()
    await workspaces.handle(create(root))
    expect(await workspaces.handle(start())).toMatchObject({ workspace: { state: 'running' } })
    const starts = state.calls.filter(call => call.endsWith('/start')).length
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('WORKSPACE_EXISTS')
    expect(refusal.detail).toContain('already running')
    // Without the check the second start reached the engine again, which answers 304 and starts nothing.
    expect(state.calls.filter(call => call.endsWith('/start')).length).toBe(starts)
  })
})

describe('the mounts and the network a workspace container is created with', () => {
  it('mounts the helper\'s directory read-only with its channel writable, and gives the network no gateway to reach', async () => {
    const state: FakeEngineState = { containers: new Map(), calls: [], networks: new Map() }
    const { workspaces, root } = await workspace(state)
    await workspaces.handle(create(root))
    const names = workspaceNames(WORKSPACE)
    // The helper's directory is read-only, so nothing the workspace runs can add to it, rename anything in it or
    // replace it; the channel below it is the one host path it may write, which is where the helper's sockets go.
    expect(state.containers.get(names.container)?.Mounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ Source: helperDirectory(), Destination: HELPER_SOCKET_DIR, ReadOnly: true }),
      expect.objectContaining({ Source: join(helperDirectory(), 'channel'), Destination: HELPER_CHANNEL_DIR, ReadOnly: false }),
    ]))
    // The bridge driver's isolated gateway mode is asked for at creation: an engine that applies it gives the internal
    // network's bridge no host address, so the container has none of the machine's services to reach.
    expect(state.networks?.get(names.network)).toMatchObject({ Internal: true, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } })
  })

  it('leaves the egress proxy\'s way out without the isolated gateway, so the proxy has a route', async () => {
    const state: FakeEngineState = { containers: new Map(), calls: [], networks: new Map() }
    const { workspaces, root } = await workspace(state)
    await workspaces.handle({ ...create(root), args: { ...create(root).args, egress: 'allowlist' } })
    const names = workspaceNames(WORKSPACE)
    expect(state.networks?.get(names.network)).toMatchObject({ Internal: true, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } })
    expect(state.networks?.get(names.outNetwork)).toMatchObject({ Internal: false, Options: {} })
  })
})

describe('the channel a workspace may write', () => {
  const channel = (): string => join(helperDirectory(), 'channel')

  it('clears a socket a previous session left, so the next helper starts with an empty channel', async () => {
    const { workspaces, root } = await workspace()
    await workspaces.handle(create(root))
    const stale = createServer()
    await new Promise<void>((resolve, reject) => {
      stale.once('error', reject)
      stale.listen(join(channel(), 'left-behind.sock'), () => { resolve() })
    })
    try {
      expect(existsSync(join(channel(), 'left-behind.sock'))).toBe(true)
      expect(await workspaces.handle(start())).toMatchObject({ workspace: { state: 'running' } })
      // A socket no live helper holds is stale: it is removed before the container starts rather than offered to the
      // harness as if it were the helper's.
      expect(existsSync(join(channel(), 'left-behind.sock'))).toBe(false)
    } finally {
      await new Promise<void>((resolve) => { stale.close(() => { resolve() }) })
    }
  })

  it('refuses the start when the channel holds a regular file, and nothing starts in the container', async () => {
    const { workspaces, root, state } = await workspace()
    await workspaces.handle(create(root))
    writeFileSync(join(channel(), 'planted'), 'not the helper\'s\n')
    const refusal = await refusalOf(async () => workspaces.handle(start()))
    expect(refusal.code).toBe('ROOT_REFUSED')
    expect(refusal.detail).toContain('a regular file')
    // The refusal comes before the container starts, so a channel the workspace could use as storage never runs.
    expect(state.calls.filter(call => call.endsWith('/start'))).toEqual([])
  })
})
