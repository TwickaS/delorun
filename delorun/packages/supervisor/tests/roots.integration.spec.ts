/**
 * C9's `supervisor-roots-refused` and the checks around a workspace container's root, over an engine in memory that
 * offers S2: the refused roots, roots of other workspaces, the re-check before every start, the comparison of a
 * created container with its body, and an existing workspace.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPERVISOR_ROOTS_FILE, type StartToken } from '@delorun/contract-home-layout'
import { LABELS, type SupervisorRequest, type WorkspaceId } from '@delorun/contract-runtime-supervisor'
import { writeProtectedFile } from '@delorun/home'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRootRules, resolveWorkspaceRoot, SupervisorError, workspaceNames, type Workspaces } from '../src/index.ts'
import { ABSENT_DIGEST, fakeWorkspaces, tempHome, type FakeEngineState, type TempHome } from './support.ts'

const REPOSITORY = fileURLToPath(new URL('../../../../', import.meta.url))
const ALIAS_PROBE = fileURLToPath(new URL('fixtures/alias-root.ts', import.meta.url))

let temp: TempHome | undefined
afterEach(() => {
  temp?.remove()
  temp = undefined
})

interface Setup {
  readonly home: string
  readonly parent: string
  readonly state: FakeEngineState
  readonly workspaces: Workspaces
}

async function setUp(options: { readonly osHome?: string, readonly parents?: boolean } = {}): Promise<Setup> {
  temp = await tempHome()
  const parent = join(temp.outside, 'projects')
  mkdirSync(parent, { mode: 0o700 })
  if (options.parents !== false) await writeProtectedFile(join(temp.home, SUPERVISOR_ROOTS_FILE), JSON.stringify({ v: 1, parents: [parent] }))
  const state: FakeEngineState = { containers: new Map(), calls: [] }
  return { home: temp.home, parent, state, workspaces: await fakeWorkspaces(temp.home, state, options.osHome) }
}

const create = (workspaceId: string, root: string, credentials: 'none' | 'token' = 'none'): Extract<SupervisorRequest, { readonly op: 'workspace.create' }> => ({
  v: 1, token: 't' as StartToken, op: 'workspace.create',
  args: { workspaceId: workspaceId as WorkspaceId, root, preset: 'small', egress: 'none', allowlistAdditions: [], credentials },
})

const start = (workspaceId: string): Extract<SupervisorRequest, { readonly op: 'workspace.start' }> => ({ v: 1, token: 't' as StartToken, op: 'workspace.start', args: { workspaceId: workspaceId as WorkspaceId } })

async function refusal(run: () => Promise<unknown>): Promise<SupervisorError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SupervisorError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

function made(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

describe('supervisor-roots-refused', () => {
  it('refuses /, the OS home directory, the Delorun home, a path containing it and a path inside it with ROOT_REFUSED', async () => {
    const { workspaces, home } = await setUp()
    const cases = [
      ['/', 'is the filesystem root'],
      [homedir(), 'is the OS home directory'],
      [home, 'is the Delorun home'],
      [join(home, '..'), 'contains the Delorun home'],
      [join(home, 'run'), 'lies inside the Delorun home'],
    ] as const
    for (const [root, reason] of cases) {
      const error = await refusal(async () => workspaces.handle(create('w', root)))
      expect(error.code, root).toBe('ROOT_REFUSED')
      expect(error.detail, root).toContain(reason)
    }
  })

  it('refuses a root that contains the OS home directory', async () => {
    temp = await tempHome()
    const osHome = made(join(temp.outside, 'projects', 'people', 'person'))
    await writeProtectedFile(join(temp.home, SUPERVISOR_ROOTS_FILE), JSON.stringify({ v: 1, parents: [join(temp.outside, 'projects')] }))
    const workspaces = await fakeWorkspaces(temp.home, { containers: new Map(), calls: [] }, osHome)
    const error = await refusal(async () => workspaces.handle(create('w', join(temp?.outside ?? '', 'projects', 'people'))))
    expect(error).toMatchObject({ code: 'ROOT_REFUSED', detail: expect.stringContaining('contains the OS home directory') })
  })

  it('refuses a symbolic link resolving outside every parent and a path outside every parent with ROOT_NOT_UNDER_PARENT', async () => {
    const { workspaces, parent } = await setUp()
    const elsewhere = made(join(temp?.outside ?? '', 'elsewhere'))
    symlinkSync(elsewhere, join(parent, 'link'))
    expect(await refusal(async () => workspaces.handle(create('w', join(parent, 'link'))))).toMatchObject({ code: 'ROOT_NOT_UNDER_PARENT', detail: expect.stringContaining(elsewhere) })
    expect((await refusal(async () => workspaces.handle(create('w', elsewhere)))).code).toBe('ROOT_NOT_UNDER_PARENT')
    expect((await refusal(async () => workspaces.handle(create('w', parent)))).code).toBe('ROOT_NOT_UNDER_PARENT')
  })

  it('refuses a symbolic link inside a parent that resolves to the Delorun home', async () => {
    const { workspaces, parent, home } = await setUp()
    symlinkSync(home, join(parent, 'home-link'))
    expect((await refusal(async () => workspaces.handle(create('w', join(parent, 'home-link'))))).code).toBe('ROOT_REFUSED')
  })

  it('refuses every root when setup chose no parent', async () => {
    const { workspaces, parent } = await setUp({ parents: false })
    expect((await refusal(async () => workspaces.handle(create('w', made(join(parent, 'w')))))).code).toBe('ROOT_NOT_UNDER_PARENT')
  })

  it('refuses a root that is not a directory, and one another user owns', async () => {
    const { workspaces, parent, home } = await setUp()
    writeFileSync(join(parent, 'file'), 'x')
    expect(await refusal(async () => workspaces.handle(create('w', join(parent, 'file'))))).toMatchObject({ code: 'ROOT_REFUSED', detail: expect.stringContaining('is not a directory') })
    const rules = await loadRootRules(home, homedir())
    const root = made(join(parent, 'w'))
    expect(await refusal(async () => resolveWorkspaceRoot(root, { ...rules, uid: (rules.uid ?? 0) + 1 }, []))).toMatchObject({ code: 'ROOT_REFUSED', detail: expect.stringContaining('belongs to another user') })
  })

  it('compares by file identity: a bind-mounted alias of the OS home inside a parent is the OS home', async (test) => {
    if (spawnSync('bwrap', ['--dev-bind', '/', '/', '--', 'true'], { stdio: 'ignore', timeout: 30_000 }).status !== 0) return test.skip('bwrap cannot create a mount namespace on this host')
    temp = await tempHome()
    const parent = made(join(temp.outside, 'projects'))
    const osHome = made(join(temp.outside, 'person'))
    const alias = made(join(parent, 'alias'))
    await writeProtectedFile(join(temp.home, SUPERVISOR_ROOTS_FILE), JSON.stringify({ v: 1, parents: [parent] }))
    const result = spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', osHome, alias, '--', process.execPath, '--import', 'tsx/esm', ALIAS_PROBE, temp.home, osHome, alias], { cwd: REPOSITORY, encoding: 'utf8', timeout: 60_000 })
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe(`ROOT_REFUSED ${alias} is the OS home directory`)
  })
})

describe('other workspaces\' roots', () => {
  it('refuses a root inside or containing the root of another workspace this supervisor manages', async () => {
    const { workspaces, parent } = await setUp()
    const a = made(join(parent, 'a'))
    await workspaces.handle(create('a', a))
    const inside = made(join(a, 'b'))
    expect(await refusal(async () => workspaces.handle(create('b', inside)))).toMatchObject({ code: 'ROOT_REFUSED', detail: expect.stringContaining('another workspace') })
    const outer = join(parent, 'outer')
    mkdirSync(outer)
    renameSync(a, join(outer, 'a'))
    symlinkSync(join(outer, 'a'), a)
    expect(await refusal(async () => workspaces.handle(create('c', outer)))).toMatchObject({ code: 'ROOT_REFUSED', detail: expect.stringContaining('another workspace') })
  })
})

describe('roots of every Delorun container on the engine', () => {
  it('refuses a root nested with another profile\'s workspace root on the same engine', async () => {
    const { workspaces, parent, state, home } = await setUp()
    const a = made(join(parent, 'a'))
    await workspaces.handle(create('a', a))
    const other = await fakeWorkspaces(home, state, homedir(), undefined, 'other')
    expect(await refusal(async () => other.handle(create('b', made(join(a, 'b')))))).toMatchObject({ code: 'ROOT_REFUSED', detail: expect.stringContaining('another workspace') })
    const outer = made(join(parent, 'outer'))
    renameSync(a, join(outer, 'a'))
    symlinkSync(join(outer, 'a'), a)
    expect(await refusal(async () => other.handle(create('a', outer)))).toMatchObject({ code: 'ROOT_REFUSED', detail: expect.stringContaining('another workspace') })
  })
})

describe('a Delorun home reached through a symbolic link', () => {
  it('creates and starts a workspace', async () => {
    temp = await tempHome()
    const link = join(temp.outside, 'home-link')
    symlinkSync(temp.home, link)
    const parent = made(join(temp.outside, 'projects'))
    await writeProtectedFile(join(temp.home, SUPERVISOR_ROOTS_FILE), JSON.stringify({ v: 1, parents: [parent] }))
    const workspaces = await fakeWorkspaces(link, { containers: new Map(), calls: [] })
    await workspaces.handle(create('w', made(join(parent, 'w'))))
    expect(await workspaces.handle(start('w'))).toMatchObject({ workspace: { state: 'running' } })
  })
})

describe('the check before every start', () => {
  it('refuses to start a workspace whose root now resolves elsewhere', async () => {
    const { workspaces, parent } = await setUp()
    const root = made(join(parent, 'w'))
    await workspaces.handle(create('w', root))
    renameSync(root, join(parent, 'moved'))
    symlinkSync(homedir(), root)
    expect(await refusal(async () => workspaces.handle(start('w')))).toMatchObject({ code: 'ROOT_REFUSED', detail: expect.stringContaining('now resolves to') })
  })

  it('refuses to start a workspace whose container no longer carries C9\'s settings', async () => {
    const { workspaces, parent, state } = await setUp()
    await workspaces.handle(create('w', made(join(parent, 'w'))))
    const name = workspaceNames('w' as WorkspaceId).container
    const record = state.containers.get(name)
    if (record === undefined) throw new Error('no container')
    state.containers.set(name, { ...record, HostConfig: { ...record.HostConfig, Privileged: true } })
    expect(await refusal(async () => workspaces.handle(start('w')))).toMatchObject({ code: 'LIMITS_MISSING', detail: expect.stringContaining('HostConfig.Privileged') })
    expect(state.calls.some(call => call.endsWith(`/containers/${name}/start`))).toBe(false)
  })

  it('starts a workspace whose root and settings are as created', async () => {
    const { workspaces, parent } = await setUp()
    await workspaces.handle(create('w', made(join(parent, 'w'))))
    expect(await workspaces.handle(start('w'))).toMatchObject({ workspace: { state: 'running' } })
  })
})

describe('the comparison after creation', () => {
  it('removes a container whose mounts differ with ROOT_REFUSED, and one missing a setting with LIMITS_MISSING', async () => {
    const { workspaces, parent, state } = await setUp()
    state.alter = (_name, record) => ({ ...record, Mounts: [...record.Mounts ?? [], { Type: 'bind', Source: '/', Destination: '/host' }] })
    expect((await refusal(async () => workspaces.handle(create('w', made(join(parent, 'w')))))).code).toBe('ROOT_REFUSED')
    expect(state.containers.size).toBe(0)
    state.alter = (_name, record) => ({ ...record, HostConfig: { ...record.HostConfig, Memory: 0 } })
    expect(await refusal(async () => workspaces.handle(create('w', join(parent, 'w'))))).toMatchObject({ code: 'LIMITS_MISSING', detail: expect.stringContaining('HostConfig.Memory') })
    expect(state.containers.size).toBe(0)
  })
})

describe('an existing workspace', () => {
  it('refuses a second create, and a container of that name another home owns, with WORKSPACE_EXISTS', async () => {
    const { workspaces, parent, state } = await setUp()
    const root = made(join(parent, 'w'))
    await workspaces.handle(create('w', root))
    expect((await refusal(async () => workspaces.handle(create('w', root)))).code).toBe('WORKSPACE_EXISTS')
    const name = workspaceNames('x' as WorkspaceId).container
    state.containers.set(name, { Id: 'f', Config: { Labels: { [LABELS.home]: 'another-home' } } })
    expect((await refusal(async () => workspaces.handle(create('x', made(join(parent, 'x')))))).code).toBe('WORKSPACE_EXISTS')
  })

  it('supervisor-image-unlisted: refuses a digest the verified manifest does not list, creating nothing', async () => {
    temp = await tempHome()
    const parent = made(join(temp.outside, 'projects'))
    await writeProtectedFile(join(temp.home, SUPERVISOR_ROOTS_FILE), JSON.stringify({ v: 1, parents: [parent] }))
    const state: FakeEngineState = { containers: new Map(), calls: [] }
    const workspaces = await fakeWorkspaces(temp.home, state, homedir(), ABSENT_DIGEST)
    expect((await refusal(async () => workspaces.handle(create('w', made(join(parent, 'w')))))).code).toBe('IMAGE_NOT_IN_MANIFEST')
    expect(state.calls.some(call => call.startsWith('POST /containers/create'))).toBe(false)
  })

  it('refuses credential forwarding before it resolves the root', async () => {
    const { workspaces } = await setUp()
    expect((await refusal(async () => workspaces.handle(create('w', '/', 'token')))).code).toBe('SHAPE_UNAVAILABLE')
  })
})
