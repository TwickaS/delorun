/**
 * The workspaces provider over the real composition: the storage hub, the JSON storage backend on disk, the storage domain,
 * upstream's workspace registry and the provider. Each spec mounts its own composition in a scratch directory, and a restart
 * is a second mount over the same storage directory. The imports clone from the local HTTPS git fixture, whose certificate
 * the spec passes as the CA bundle.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import WorkspaceRegistry, { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { workspaceLocationMessage, type WorkspaceLocationProblem } from '@delorun/home'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DelorunWorkspacesService } from '../src/index.ts'
import type { DelorunWorkspaces, ImportRow } from '../src/service.ts'
import { WorkspaceRefusedError } from '../src/service.ts'
import { startGitFixture, type GitFixture } from './fixtures/git-server.ts'

/** A chat id as the registry brands it. */
type SessionId = Workspace['sessionIds'][number]

/** A chat header the stub session persistence lists. */
interface StoredChat {
  readonly id: SessionId
  readonly cwd: string
  readonly createdAt: number
}

/** One mounted composition: its root context, its handles, the spawns of its subprocess provider, and its teardown. */
interface Mount {
  readonly ctx: Context
  readonly service: DelorunWorkspaces
  readonly registry: WorkspaceRegistry
  readonly spawns: SubprocessSpawnSpec[]
  readonly chats: StoredChat[]
  readonly dispose: () => Promise<void>
}

/** What a mount is configured with. */
interface MountOptions {
  /** The provider's configuration, which the plugin validates at load. */
  readonly config: Record<string, unknown>
  /** False makes the subprocess provider return a handle with no error pipe, which starts no process. */
  readonly errorPipe?: boolean
  /** The chat headers the stub session persistence lists. */
  readonly chats?: StoredChat[]
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The restart reason the provider writes for an import that a stopped harness left cloning. */
const RESTART_REASON = 'the harness restarted while it cloned'

/** Clone URLs the provider refuses before any process starts, each for a reason the URL parser or the query shows. */
const REFUSED_URLS = [
  `https://user:delorun-test-password-not-a-secret@127.0.0.1:1/owner/repo.git`,
  'https://user@127.0.0.1:1/owner/repo.git',
  'http://127.0.0.1:1/owner/repo.git',
  'https://127.0.0.1:1/owner/repo.git?ref=main',
  'https://127.0.0.1:1/owner/repo.git#main',
]

/** Every composition mounted by the current spec, disposed after it. */
const mounts: Mount[] = []

let fixture: GitFixture
let scratch = ''
let home = ''
let root = ''
let storage = ''
let saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  fixture = await startGitFixture()
}, 120_000)

afterAll(async () => {
  await fixture.close()
})

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-workspaces-spec-'))
  home = join(scratch, 'home')
  root = join(scratch, 'root')
  storage = join(scratch, 'storage')
  await mkdir(home)
  saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, DELORUN_HOME: process.env.DELORUN_HOME }
  process.env.HOME = fixture.home
  process.env.XDG_CONFIG_HOME = join(fixture.home, '.config')
  process.env.DELORUN_HOME = home
})

afterEach(async () => {
  for (const mounted of mounts.splice(0).reverse()) await mounted.dispose()
  restoreEnv(saved)
  vi.useRealTimers()
  await rm(scratch, { recursive: true, force: true })
})

describe('the provider over real storage', () => {
  it('mounts over the storage domain and the registry, and creates a workspace the registry lists', async () => {
    const mounted = await mount({ config: base() })
    const created = await mounted.service.create({ directory: 'alpha', title: 'Alpha' })
    const [id] = created.workspaces
    const entry = mounted.registry.list().find(workspace => workspace.id === id)
    expect(entry).toMatchObject({ title: 'Alpha', path: join(await realpath(root), 'alpha') })
    expect((await stat(join(root, 'alpha'))).isDirectory()).toBe(true)
  })

  it('makes the folder with mode 0755 less the umask', async () => {
    const mounted = await mount({ config: base() })
    await mounted.service.create({ directory: 'alpha' })
    expect((await stat(join(root, 'alpha'))).mode & 0o777).toBe(0o755 & ~process.umask())
  })

  it.each(['', '.hidden', '-leading', 'two words', 'a/b', '..', '.delorun-trash', 'x'.repeat(101)])(
    'refuses the folder name %j as invalid, and makes no folder',
    async (name) => {
      const mounted = await mount({ config: base() })
      await expect(mounted.service.create({ directory: name })).rejects.toMatchObject({ code: 'invalid' })
      expect(await readdir(root)).toEqual([])
    },
  )

  it('refuses a folder that exists already as taken, and keeps the workspace it holds', async () => {
    const mounted = await mount({ config: base() })
    await mounted.service.create({ directory: 'alpha' })
    await expect(mounted.service.create({ directory: 'alpha' })).rejects.toMatchObject({ code: 'taken' })
    expect(mounted.registry.list()).toHaveLength(1)
  })

  it('refuses an unknown workspace as not-found for each operation on it', async () => {
    const mounted = await mount({ config: base() })
    const unknown = WorkspaceId('00000000-0000-0000-0000-000000000000')
    await expect(mounted.service.instructions(unknown)).rejects.toMatchObject({ code: 'not-found' })
    await expect(mounted.service.setInstructions({ workspace: unknown, text: 'x', revision: null })).rejects.toMatchObject({ code: 'not-found' })
    await expect(mounted.service.trash({ workspace: unknown })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses a workspace outside the root as outside, and trashes nothing', async () => {
    const mounted = await mount({ config: base() })
    const elsewhere = join(scratch, 'elsewhere')
    await mkdir(elsewhere)
    const workspace = await mounted.registry.create(elsewhere, 'Elsewhere')
    await expect(mounted.service.instructions(workspace.id)).rejects.toMatchObject({ code: 'outside' })
    await expect(mounted.service.trash({ workspace: workspace.id })).rejects.toMatchObject({ code: 'outside' })
    expect((await mounted.service.list()).trash).toEqual([])
    expect(mounted.registry.get(workspace.id)).toBeDefined()
  })

  it('removes the folder it made when the registry refuses it, and answers failed with neither the path nor the registry\'s words', async () => {
    const mounted = await mount({ config: base() })
    vi.spyOn(mounted.registry, 'create').mockRejectedValueOnce(new Error(`refused at ${root}`))
    const failure: unknown = await mounted.service.create({ directory: 'gamma' }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkspaceRefusedError)
    expect(failure).toMatchObject({ code: 'failed' })
    expect(String(failure)).not.toContain(root)
    expect(await exists(join(root, 'gamma'))).toBe(false)
  })
})

describe.skipIf(process.platform !== 'linux')('AGENTS.md through the provider', () => {
  it('answers no text and no revision for a workspace without a file, with the path the file would have', async () => {
    const mounted = await mount({ config: base() })
    const [id] = (await mounted.service.create({ directory: 'alpha' })).workspaces
    expect(await mounted.service.instructions(id as WorkspaceId)).toEqual({
      path: join(await realpath(root), 'alpha', 'AGENTS.md'), text: null, revision: null, maxBytes: 65_536,
    })
  })

  it('writes new text, reads it back with the revision of its bytes, and refuses a stale revision as conflict', async () => {
    const mounted = await mount({ config: base() })
    const [id] = (await mounted.service.create({ directory: 'alpha' })).workspaces
    const workspace = id as WorkspaceId
    await mounted.service.setInstructions({ workspace, text: 'Use pnpm.', revision: null })
    const read = await mounted.service.instructions(workspace)
    expect(read).toMatchObject({ text: 'Use pnpm.', revision: sha256('Use pnpm.') })
    await expect(mounted.service.setInstructions({ workspace, text: 'Other', revision: null })).rejects.toMatchObject({ code: 'conflict' })
    await expect(mounted.service.setInstructions({ workspace, text: 'Other', revision: sha256('stale') })).rejects.toMatchObject({ code: 'conflict' })
    await mounted.service.setInstructions({ workspace, text: 'Edited.', revision: read.revision })
    expect(await readFile(join(root, 'alpha', 'AGENTS.md'), 'utf8')).toBe('Edited.')
  })

  it('renames by id or by current title with the studio\'s rules, and changes only the title', async () => {
    const mounted = await mount({ config: base() })
    const [alpha, beta] = [(await mounted.service.create({ directory: 'alpha' })).workspaces[0] as WorkspaceId, (await mounted.service.create({ directory: 'beta' })).workspaces[0] as WorkspaceId]
    const before = mounted.registry.get(alpha) as Workspace
    const path = before.path
    expect(await mounted.service.planRename({ workspace: 'alpha', name: ' Site ' })).toEqual({ workspace: alpha, from: 'alpha', to: 'Site' })
    expect(mounted.registry.get(alpha)?.title).toBe('alpha')
    expect(await mounted.service.rename({ workspace: 'alpha', name: ' Site ' })).toEqual({ workspace: alpha, from: 'alpha', to: 'Site' })
    expect(mounted.registry.get(alpha)).toMatchObject({ title: 'Site', path })
    expect(await mounted.service.rename({ workspace: beta, name: 'Docs' })).toMatchObject({ from: 'beta', to: 'Docs' })
    expect(await mounted.service.rename({ workspace: alpha, name: 'Site' })).toMatchObject({ from: 'Site', to: 'Site' })
    await expect(mounted.service.rename({ workspace: alpha, name: 'Docs' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(mounted.service.rename({ workspace: 'missing', name: 'X' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(mounted.service.rename({ workspace: alpha, name: '   ' })).rejects.toMatchObject({ code: 'invalid' })
    expect(mounted.registry.get(alpha)?.title).toBe('Site')
  })

  it('refuses a current title that several workspaces share, naming their ids', async () => {
    const mounted = await mount({ config: base() })
    const first = (await mounted.service.create({ directory: 'one', title: 'Same' })).workspaces[0] as WorkspaceId
    const second = (await mounted.service.create({ directory: 'two', title: 'Same' })).workspaces[0] as WorkspaceId
    const refused = await mounted.service.rename({ workspace: 'Same', name: 'Other' }).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'conflict' })
    expect((refused as Error).message).toContain(first)
    expect((refused as Error).message).toContain(second)
  })

  it('refuses text over the limit as too-large, and a file over the limit on read as too-large', async () => {
    const mounted = await mount({ config: { ...base(), instructionsMaxBytes: 16 } })
    const [id] = (await mounted.service.create({ directory: 'alpha' })).workspaces
    const workspace = id as WorkspaceId
    await expect(mounted.service.setInstructions({ workspace, text: '€'.repeat(6), revision: null })).rejects.toMatchObject({ code: 'too-large' })
    await writeFile(join(root, 'alpha', 'AGENTS.md'), 'x'.repeat(17))
    await expect(mounted.service.instructions(workspace)).rejects.toMatchObject({ code: 'too-large' })
  })
})

/**
 * Point the OS home at a scratch folder three levels down, with its stock home `~/.dsh`, so a folder between the scratch
 * directory and the OS home contains the stock home and not the Delorun home.
 * @returns the OS home and its stock home.
 */
async function scratchOsHome(): Promise<{ readonly person: string, readonly stock: string }> {
  const person = join(scratch, 'a', 'b', 'person')
  const stock = join(person, '.dsh')
  await mkdir(stock, { recursive: true })
  process.env.HOME = person
  return { person, stock }
}

/** The locations Delorun never adds as a workspace, each with the problem code it names, under {@link scratchOsHome}. */
const REFUSED_LOCATIONS: readonly (readonly [string, WorkspaceLocationProblem, () => string])[] = [
  ['the OS home directory', 'home-directory', () => join(scratch, 'a', 'b', 'person')],
  ['the Delorun home', 'delorun-home', () => home],
  ['a folder inside the Delorun home', 'delorun-home', () => join(home, 'workspaces')],
  ['a folder that contains the Delorun home', 'contains-delorun-home', () => scratch],
  ['the stock home', 'stock-home', () => join(scratch, 'a', 'b', 'person', '.dsh')],
  ['a folder inside the stock home', 'stock-home', () => join(scratch, 'a', 'b', 'person', '.dsh', 'inside')],
  ['a folder that contains the stock home', 'contains-stock-home', () => join(scratch, 'a', 'b')],
]

describe('the configuration at load', () => {
  it.each(REFUSED_LOCATIONS)('refuses a root that is %s, naming %s, and creates nothing in it', async (_label, problem, pick) => {
    await scratchOsHome()
    await mkdir(join(home, 'workspaces'), { recursive: true })
    const location = pick()
    // The storage backend of the composition makes its own directory in the scratch directory before the provider loads.
    const entries = async (): Promise<string[]> => (await readdir(location).catch(() => [])).filter(name => name !== 'storage')
    const before = await entries()
    await expect(mount({ config: { root: location, caFile: fixture.caFile } })).rejects.toThrow(`is refused (${problem})`)
    expect(await entries()).toEqual(before)
  })

  it('refuses the filesystem root as a root', async () => {
    await expect(mount({ config: { root: '/', caFile: fixture.caFile } })).rejects.toThrow()
  })

  it('refuses a root that is not absolute', async () => {
    await expect(mount({ config: { root: 'relative/root', caFile: fixture.caFile } })).rejects.toThrow()
  })

  it('refuses a credential file outside the home\'s secrets directory', async () => {
    const file = join(scratch, 'token')
    await writeFile(file, fixture.password, { mode: 0o600 })
    await expect(mount({ config: { ...base(), credential: { host: fixtureHost(), file } } })).rejects.toThrow(/directly in the home's secrets directory/)
  })

  it('refuses a credential file that is not private, at load', async () => {
    const file = await writeToken(fixture.password)
    await chmod(file, 0o644)
    await expect(mount({ config: { ...base(), credential: { host: fixtureHost(), file } } })).rejects.toThrow(/SECRET_FILE_MODE/)
  })
  it.each([
    ['GitHub.com', 'https://github.com/owner/repo.git', true],
    ['github.com:443', 'https://github.com/owner/repo.git', true],
    ['GitHub.com:443', 'https://github.com/owner/repo.git', true],
    ['GitHub.com:8443', 'https://github.com:8443/owner/repo.git', true],
    ['gitlab.com', 'https://github.com/owner/repo.git', false],
    ['GitHub.com:8443', 'https://github.com/owner/repo.git', false],
    ['GitHub.com:443', 'https://github.com:8443/owner/repo.git', false],
  ])('answers the credential host %s with the token for the clone URL %s: %s', async (host, url, matched) => {
    const file = await writeToken(fixture.password)
    const mounted = await mount({ config: { ...base(), credential: { host, file } }, errorPipe: false })
    await settledImport(mounted.service, (await mounted.service.startImport({ url })).import)
    expect(mounted.spawns).toHaveLength(1)
    expect(mounted.spawns[0]?.env?.DELORUN_GIT_TOKEN === undefined).toBe(!matched)
  })

  it.each([
    ['a path', 'github.com/owner'],
    ['a space', 'github.com old'],
    ['a scheme', 'https://github.com'],
    ['a user name and password', 'person:delorun-test-password-not-a-secret@github.com'],
  ])('refuses a credential host with %s at load, and its error names the option and not the value', async (_label, host) => {
    const file = await writeToken(fixture.password)
    const failure: unknown = await mount({ config: { ...base(), credential: { host, file } } }).then(() => undefined, (error: unknown) => error)
    expect(String(failure)).toContain('credential.host')
    expect(String(failure)).not.toContain(host)
  })
})

describe('locations Delorun never adds as a workspace', () => {
  /**
   * Mount over the scratch OS home and put a link in the root that leads to a location, so the folder a request names is
   * that location.
   * @param target - where the link leads.
   * @returns the mounted composition.
   */
  async function linked(target: string): Promise<Mount> {
    const mounted = await mount({ config: base() })
    await mkdir(target, { recursive: true })
    await symlink(target, join(root, 'linked'))
    return mounted
  }

  it.each(REFUSED_LOCATIONS)('refuses to create a workspace that is %s as location, and registers nothing', async (_label, problem, pick) => {
    await scratchOsHome()
    const mounted = await linked(pick())
    const refusal: unknown = await mounted.service.create({ directory: 'linked' }).then(() => undefined, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(WorkspaceRefusedError)
    expect(refusal).toMatchObject({ code: 'location' })
    expect((refusal as Error).message).toBe(workspaceLocationMessage(problem))
    expect(mounted.registry.list()).toEqual([])
  })

  it('refuses the filesystem root through a link as location, and registers nothing', async () => {
    const mounted = await mount({ config: base() })
    await symlink('/', join(root, 'linked'))
    await expect(mounted.service.create({ directory: 'linked' })).rejects.toMatchObject({ code: 'location', message: workspaceLocationMessage('filesystem-root') })
    expect(mounted.registry.list()).toEqual([])
  })

  it.each(REFUSED_LOCATIONS)('refuses to import into a folder that is %s as location, starts nothing and registers nothing', async (_label, _problem, pick) => {
    await scratchOsHome()
    const mounted = await linked(pick())
    await expect(mounted.service.startImport({ url: publicUrl(), directory: 'linked' })).rejects.toMatchObject({ code: 'location' })
    expect(mounted.spawns).toHaveLength(0)
    expect(mounted.registry.list()).toEqual([])
    expect((await mounted.service.list()).imports).toEqual([])
  })
})

describe('imports', () => {
  it('clones a repository into a folder named after it without .git, registers it, and keeps its row done', async () => {
    const mounted = await mount({ config: base() })
    const started = await mounted.service.startImport({ url: publicUrl() })
    expect(started).toEqual({ import: expect.any(String), directory: 'public' })
    const row = await settledImport(mounted.service, started.import)
    expect(row).toMatchObject({ id: started.import, directory: 'public', url: publicUrl(), state: 'done', reason: null, progress: null })
    expect(mounted.registry.list().map(workspace => workspace.path)).toEqual([join(await realpath(root), 'public')])
    expect(await exists(join(root, 'public', 'README.md'))).toBe(true)
  }, 30_000)

  it('answers invalid for a URL that names no folder, and starts nothing', async () => {
    const mounted = await mount({ config: base() })
    await expect(mounted.service.startImport({ url: `${fixture.origin}/` })).rejects.toMatchObject({ code: 'invalid' })
    expect(mounted.spawns).toHaveLength(0)
  })

  it.each(REFUSED_URLS)('refuses %s as invalid before any process starts, and makes no folder', async (url) => {
    const mounted = await mount({ config: base() })
    await expect(mounted.service.startImport({ url })).rejects.toMatchObject({ code: 'invalid' })
    expect(mounted.spawns).toHaveLength(0)
    expect(await readdir(root)).toEqual([])
  })

  it('refuses an import whose folder exists already as taken, and starts nothing', async () => {
    const mounted = await mount({ config: base() })
    await mkdir(join(root, 'public'))
    await expect(mounted.service.startImport({ url: publicUrl() })).rejects.toMatchObject({ code: 'taken' })
    expect(mounted.spawns).toHaveLength(0)
  })

  it('removes the folder of a clone that fails, and records git\'s reason', async () => {
    const mounted = await mount({ config: base() })
    const started = await mounted.service.startImport({ url: `${fixture.origin}/missing.git` })
    const row = await settledImport(mounted.service, started.import)
    expect(row.state).toBe('failed')
    expect(row.reason).toMatch(/fatal|not found|error/i)
    expect(await exists(join(root, 'missing'))).toBe(false)
    expect(mounted.registry.list()).toEqual([])
  }, 30_000)

  it('gives the CA bundle to git as its certificate authority file', async () => {
    const mounted = await mount({ config: base() })
    const started = await mounted.service.startImport({ url: publicUrl() })
    await settledImport(mounted.service, started.import)
    expect(mounted.spawns[0]?.argv).toEqual(expect.arrayContaining(['-c', `http.sslCAInfo=${fixture.caFile}`]))
  }, 30_000)

  it('removes the git trace names the process environment sets from the clone\'s spawn, through the plugin', async () => {
    const previous = { GIT_TRACE_SETUP: process.env.GIT_TRACE_SETUP }
    process.env.GIT_TRACE_SETUP = '1'
    try {
      const mounted = await mount({ config: base() })
      const started = await mounted.service.startImport({ url: publicUrl() })
      await settledImport(mounted.service, started.import)
      const env: NodeJS.ProcessEnv = mounted.spawns[0]?.env ?? {}
      expect(Object.hasOwn(env, 'GIT_TRACE_SETUP')).toBe(true)
      expect(env.GIT_TRACE_SETUP).toBeUndefined()
    } finally {
      restoreEnv(previous)
    }
  }, 30_000)

  it('reads the credential file again for each clone: a file that became lax refuses the clone, and names neither the path nor the token', async () => {
    const file = await writeToken(fixture.password)
    const mounted = await mount({ config: { ...base(), credential: { host: fixtureHost(), file } } })
    await chmod(file, 0o644)
    const refused = await settledImport(mounted.service, (await mounted.service.startImport({ url: privateUrl() })).import)
    expect(refused).toMatchObject({ state: 'failed', reason: 'the credential file is refused (SECRET_FILE_MODE)' })
    expect(refused.reason ?? '').not.toContain(file)
    expect(refused.reason ?? '').not.toContain(fixture.password)
    expect(mounted.spawns).toHaveLength(0)
    await chmod(file, 0o600)
    const restored = await settledImport(mounted.service, (await mounted.service.startImport({ url: privateUrl() })).import)
    expect(restored.state).toBe('done')
  }, 60_000)

  it('reads the credential file again for each clone: a file replaced by a symbolic link refuses the clone, and names neither the path nor the token', async () => {
    const file = await writeToken(fixture.password)
    const mounted = await mount({ config: { ...base(), credential: { host: fixtureHost(), file } } })
    const target = join(scratch, 'moved-token')
    await writeFile(target, fixture.password, { mode: 0o600 })
    await rm(file)
    await symlink(target, file)
    const refused = await settledImport(mounted.service, (await mounted.service.startImport({ url: privateUrl() })).import)
    expect(refused).toMatchObject({ state: 'failed', reason: 'the credential file is refused (SECRET_FILE_MODE)' })
    expect(refused.reason ?? '').not.toContain(file)
    expect(refused.reason ?? '').not.toContain(fixture.password)
    expect(mounted.spawns).toHaveLength(0)
  }, 30_000)

  it('sends the token only to the host of the credential, which clones the private repository', async () => {
    const file = await writeToken(fixture.password)
    const mounted = await mount({ config: { ...base(), credential: { host: fixtureHost(), file } } })
    const before = fixture.requests.length
    const started = await mounted.service.startImport({ url: privateUrl() })
    const row = await settledImport(mounted.service, started.import)
    expect(row.state).toBe('done')
    expect(fixture.requests.slice(before).some(request => request.path.startsWith('/private.git') && request.credential)).toBe(true)
  }, 30_000)

  it('sends no token to another host, so the private repository is refused', async () => {
    const file = await writeToken(fixture.password)
    const mounted = await mount({ config: { ...base(), credential: { host: 'example.invalid', file } } })
    const before = fixture.requests.length
    const started = await mounted.service.startImport({ url: privateUrl() })
    const row = await settledImport(mounted.service, started.import)
    expect(row.state).toBe('failed')
    expect(fixture.requests.slice(before).some(request => request.credential)).toBe(false)
    expect(await exists(join(root, 'private'))).toBe(false)
  }, 30_000)

  it('keeps the token out of the row, the stored URL, the log and the workspace\'s git configuration', async () => {
    const file = await writeToken(fixture.password)
    const mounted = await mount({ config: { ...base(), credential: { host: fixtureHost(), file } } })
    const logs = spyOnLog(mounted)
    const started = await mounted.service.startImport({ url: privateUrl() })
    const row = await settledImport(mounted.service, started.import)
    expect(row).toMatchObject({ state: 'done', url: privateUrl() })
    expect(await readFile(join(root, 'private', '.git', 'config'), 'utf8')).not.toContain(fixture.password)
    expect(JSON.stringify(logs.calls())).not.toContain(fixture.password)
  }, 30_000)

  it('refuses a wrong token, and the failure reason holds no token', async () => {
    const wrong = `${fixture.password}-wrong`
    const file = await writeToken(wrong)
    const mounted = await mount({ config: { ...base(), credential: { host: fixtureHost(), file } } })
    const started = await mounted.service.startImport({ url: privateUrl() })
    const row = await settledImport(mounted.service, started.import)
    expect(row.state).toBe('failed')
    expect(row.reason).not.toBeNull()
    expect(row.reason ?? '').not.toContain(wrong)
    expect(row.url).toBe(privateUrl())
    expect(await exists(join(root, 'private'))).toBe(false)
  }, 30_000)

  it('redacts the token from the reason it reports and from the log, though git\'s own failure output names it', async () => {
    // The token is the fixture's host, which git's fatal line for a missing repository echoes with the clone URL.
    const token = fixtureHost()
    const file = await writeToken(token)
    const mounted = await mount({ config: { ...base(), credential: { host: fixtureHost(), file } } })
    const logs = spyOnLog(mounted)
    const started = await mounted.service.startImport({ url: `${fixture.origin}/missing.git` })
    const row = await settledImport(mounted.service, started.import)
    expect(row.state).toBe('failed')
    expect(row.reason).toContain('[redacted]')
    expect(row.reason).not.toContain(token)
    expect(JSON.stringify(logs.calls())).not.toContain(token)
  }, 30_000)

  it('fails a clone whose provider has no error pipe with the generic reason, removes its folder, and logs why', async () => {
    const mounted = await mount({ config: base(), errorPipe: false })
    const logs = spyOnLog(mounted)
    const started = await mounted.service.startImport({ url: publicUrl() })
    const row = await settledImport(mounted.service, started.import)
    expect(row).toMatchObject({ state: 'failed', reason: 'git could not run' })
    expect(await exists(join(root, 'public'))).toBe(false)
    expect(logs.error).toHaveBeenCalled()
  }, 30_000)

  it('fails a clone that passes its time limit with the time reason, and removes its folder', async () => {
    const mounted = await mount({ config: { ...base(), importTimeoutMs: 1000 } })
    const started = await mounted.service.startImport({ url: stallUrl() })
    const row = await settledImport(mounted.service, started.import)
    expect(row.state).toBe('failed')
    expect(row.reason).toMatch(/^the clone took longer than [\d.]+ minutes$/)
    expect(await exists(join(root, 'stall'))).toBe(false)
  }, 30_000)

  it('keeps the folder of a failed import that a workspace holds by then', async () => {
    const mounted = await mount({ config: { ...base(), importTimeoutMs: 2000 } })
    const started = await mounted.service.startImport({ url: stallUrl() })
    await waitFor(() => exists(join(root, 'stall', '.git')))
    await mounted.registry.create(join(await realpath(root), 'stall'), 'stall')
    const row = await settledImport(mounted.service, started.import)
    expect(row.state).toBe('failed')
    expect(await exists(join(root, 'stall'))).toBe(true)
    expect(mounted.registry.list()).toHaveLength(1)
  }, 30_000)

  it('lists the imports newest first', async () => {
    const mounted = await mount({ config: base() })
    const first = await mounted.service.startImport({ url: publicUrl(), directory: 'first' })
    await settledImport(mounted.service, first.import)
    const second = await mounted.service.startImport({ url: publicUrl(), directory: 'second' })
    await settledImport(mounted.service, second.import)
    expect((await mounted.service.list()).imports.map(row => row.directory)).toEqual(['second', 'first'])
  }, 30_000)
})

describe('a restart', () => {
  it('settles an import a stopped harness left cloning: the row fails with the restart reason, the folder goes, and a link inside it leaves its target alone', async () => {
    const first = await mount({ config: base() })
    const started = await first.service.startImport({ url: stallUrl() })
    await waitFor(() => exists(join(root, 'stall', '.git')))
    const outside = join(scratch, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'kept')
    await symlink(outside, join(root, 'stall', 'outside-link'))
    await first.dispose()
    const second = await mount({ config: base() })
    const row = (await second.service.list()).imports.find(item => item.id === started.import)
    expect(row).toMatchObject({ state: 'failed', reason: RESTART_REASON })
    expect(await exists(join(root, 'stall'))).toBe(false)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('kept')
  }, 60_000)

  it('records an import whose workspace was registered before the stop as done, and keeps its folder', async () => {
    const first = await mount({ config: base() })
    const started = await first.service.startImport({ url: stallUrl() })
    await waitFor(() => exists(join(root, 'stall', '.git')))
    await first.registry.create(join(await realpath(root), 'stall'), 'stall')
    await first.dispose()
    const second = await mount({ config: base() })
    const row = (await second.service.list()).imports.find(item => item.id === started.import)
    expect(row).toMatchObject({ state: 'done', reason: null })
    expect(await exists(join(root, 'stall'))).toBe(true)
    expect(second.registry.list().map(workspace => workspace.path)).toEqual([join(await realpath(root), 'stall')])
  }, 60_000)

  it('shows git\'s latest progress line for an import in flight', async () => {
    const mounted = await mount({ config: base() })
    const started = await mounted.service.startImport({ url: stallUrl() })
    await waitFor(async () => (await mounted.service.list()).imports.some(row => row.id === started.import && row.progress !== null))
    const row = (await mounted.service.list()).imports.find(item => item.id === started.import)
    expect(row?.progress).toMatch(/Cloning into/)
  }, 60_000)
})

describe('the trash', () => {
  it('moves a folder with its workspace into the trash, and restores it with the workspace registered again', async () => {
    const mounted = await mount({ config: base() })
    const [id] = (await mounted.service.create({ directory: 'alpha', title: 'Alpha' })).workspaces
    const entry = await mounted.service.trash({ workspace: id as WorkspaceId })
    expect(entry).toMatchObject({ directory: 'alpha', workspaces: [{ title: 'Alpha', path: join(await realpath(root), 'alpha') }] })
    expect(entry.deleteAt - Date.now()).toBeGreaterThan(29 * DAY_MS)
    expect(await exists(join(root, 'alpha'))).toBe(false)
    expect(await exists(join(root, '.delorun-trash', entry.id))).toBe(true)
    expect(mounted.registry.get(id as WorkspaceId)).toBeUndefined()
    expect((await mounted.service.list()).trash.map(item => item.id)).toEqual([entry.id])

    const restored = await mounted.service.restore({ trash: entry.id })
    expect(restored.workspaces).toHaveLength(1)
    const [restoredId] = restored.workspaces
    expect(mounted.registry.get(restoredId as WorkspaceId)).toMatchObject({ title: 'Alpha', path: join(await realpath(root), 'alpha') })
    expect(await exists(join(root, 'alpha'))).toBe(true)
    expect(await exists(join(root, '.delorun-trash', entry.id))).toBe(false)
    expect((await mounted.service.list()).trash).toEqual([])
  })

  it('archives the chats of a trashed folder, and restore unarchives them and returns them to their workspace', async () => {
    const chats: StoredChat[] = []
    const mounted = await mount({ config: base(), chats })
    const [id] = (await mounted.service.create({ directory: 'alpha' })).workspaces
    const workspace = id as WorkspaceId
    chats.push({ id: brandString<SessionId>('chat-1'), cwd: join(await realpath(root), 'alpha'), createdAt: 1 })
    await mounted.registry.get(workspace)?.attachSession(brandString<SessionId>('chat-1'))
    const stopped = vi.fn()
    mounted.ctx.on('workspace/session-stop', stopped)
    const entry = await mounted.service.trash({ workspace })
    expect(stopped).toHaveBeenCalledWith({ sessionId: 'chat-1' })
    expect(mounted.registry.archivedSessionIds).toContain('chat-1')
    const [restoredId] = (await mounted.service.restore({ trash: entry.id })).workspaces
    expect(mounted.registry.archivedSessionIds).not.toContain('chat-1')
    expect(mounted.registry.get(restoredId as WorkspaceId)?.sessionIds).toContain('chat-1')
  })

  it('changes nothing when the trash cannot be made before the folder moves, and unarchives the chats it archived', async () => {
    const chats: StoredChat[] = []
    const mounted = await mount({ config: base(), chats })
    const [id] = (await mounted.service.create({ directory: 'alpha' })).workspaces
    const workspace = id as WorkspaceId
    chats.push({ id: brandString<SessionId>('chat-1'), cwd: join(await realpath(root), 'alpha'), createdAt: 1 })
    await mounted.registry.get(workspace)?.attachSession(brandString<SessionId>('chat-1'))
    await writeFile(join(root, '.delorun-trash'), 'a file, not a folder')
    await expect(mounted.service.trash({ workspace })).rejects.toMatchObject({ code: 'failed' })
    expect(await exists(join(root, 'alpha'))).toBe(true)
    expect(mounted.registry.get(workspace)).toBeDefined()
    expect(mounted.registry.archivedSessionIds).not.toContain('chat-1')
    expect((await mounted.service.list()).trash).toEqual([])
  })

  it('refuses a restore whose folder name exists again as taken, and keeps the entry; refuses an unknown entry as not-found', async () => {
    const mounted = await mount({ config: base() })
    const [id] = (await mounted.service.create({ directory: 'alpha' })).workspaces
    const entry = await mounted.service.trash({ workspace: id as WorkspaceId })
    await mkdir(join(root, 'alpha'))
    await expect(mounted.service.restore({ trash: entry.id })).rejects.toMatchObject({ code: 'taken' })
    expect(await exists(join(root, '.delorun-trash', entry.id))).toBe(true)
    await expect(mounted.service.restore({ trash: 'no-such-entry' })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('purges a trash entry past its time at list, and forgets a finished import older than a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const mounted = await mount({ config: { ...base(), trashDays: 1 } })
    const [id] = (await mounted.service.create({ directory: 'alpha' })).workspaces
    const entry = await mounted.service.trash({ workspace: id as WorkspaceId })
    const started = await mounted.service.startImport({ url: publicUrl() })
    await settledImport(mounted.service, started.import)
    expect((await mounted.service.list()).trash.map(item => item.id)).toEqual([entry.id])
    vi.setSystemTime(Date.now() + 2 * DAY_MS)
    const listing = await mounted.service.list()
    expect(listing.trash).toEqual([])
    expect(listing.imports).toEqual([])
    expect(await exists(join(root, '.delorun-trash', entry.id))).toBe(false)
  }, 30_000)

  it('restores the workspaces of a folder in their registry order', async () => {
    const mounted = await mount({ config: base() })
    const [id] = (await mounted.service.create({ directory: 'alpha' })).workspaces
    await mkdir(join(root, 'alpha', 'nested'))
    await mounted.registry.create(join(await realpath(root), 'alpha', 'nested'), 'Nested')
    const before = mounted.registry.list().map(workspace => workspace.path)
    const entry = await mounted.service.trash({ workspace: id as WorkspaceId })
    expect(mounted.registry.list()).toEqual([])
    const restored = await mounted.service.restore({ trash: entry.id })
    expect(mounted.registry.list().map(workspace => workspace.path)).toEqual(before)
    expect(restored.workspaces).toEqual(mounted.registry.list().map(workspace => workspace.id))
  })

  it('forgets a trash entry whose folder is gone, at list', async () => {
    const mounted = await mount({ config: base() })
    const [id] = (await mounted.service.create({ directory: 'alpha' })).workspaces
    const entry = await mounted.service.trash({ workspace: id as WorkspaceId })
    await rm(join(root, '.delorun-trash', entry.id), { recursive: true })
    expect((await mounted.service.list()).trash).toEqual([])
  })
})

/** The configuration every spec starts from: the root and the fixture's certificate authority. */
function base(): Record<string, unknown> {
  return { root, caFile: fixture.caFile }
}

/**
 * Mount the real composition over the storage directory of the current spec. The mount is disposed after the spec, or by
 * its own `dispose` call.
 * @param options - the provider's configuration and the stub's settings.
 * @returns the mounted composition.
 * @throws the failure of a plugin that does not load.
 */
async function mount(options: MountOptions): Promise<Mount> {
  const ctx = new Context()
  const spawns: SubprocessSpawnSpec[] = []
  const chats = options.chats ?? []
  const fibers: { dispose: () => Promise<void> }[] = []
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  try {
    fibers.push(await ctx.plugin(Storage))
    fibers.push(await ctx.plugin(storageJson, { root: storage }))
    fibers.push(await ctx.plugin(storageDomain, { backend: 'json' }))
    ctx.provide('sessionPersistence', { list: async () => chats.map(header => ({ header })) } as never)
    ctx.provide('subprocess', recordingRuntime(spawns, options.errorPipe !== false))
    fibers.push(await ctx.plugin(WorkspaceRegistry))
    // A partial configuration is not a Config until the plugin's schema fills its defaults at load.
    const provider = ctx.plugin(DelorunWorkspacesService, options.config as never)
    fibers.push(provider)
    await provider
  } catch (error) {
    await dispose()
    throw error
  }
  const mounted: Mount = { ctx, service: ctx.delorunWorkspaces, registry: ctx.workspaceRegistry, spawns, chats, dispose }
  mounts.push(mounted)
  return mounted
}

/**
 * A subprocess provider over node:child_process that records each spawn. Each process leads its own process group, so stopping
 * a spawn stops the helpers git starts too.
 * @param spawns - receives each spawn's specification.
 * @param errorPipe - false returns a handle with no error pipe and starts no process.
 * @returns the provider.
 */
function recordingRuntime(spawns: SubprocessSpawnSpec[], errorPipe: boolean): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      spawns.push(spec)
      if (!errorPipe) return handleOf(undefined, new Promise<SubprocessOutcome>(() => {}), () => undefined)
      const [program = '', ...args] = spec.argv
      const child = spawn(program, args, { cwd: spec.cwd, env: applyEnv(process.env, spec.env ?? {}), detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      const stop = (): void => {
        if (child.pid === undefined) return
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          // ESRCH: the process group has already exited, so there is nothing left to stop.
        }
      }
      if (spec.signal?.aborted === true) stop()
      spec.signal?.addEventListener('abort', stop, { once: true })
      const done = new Promise<SubprocessOutcome>((resolve, reject) => {
        child.once('error', (error) => { if (child.pid === undefined) reject(error) })
        child.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
      })
      return handleOf(child.stderr ?? undefined, done, stop)
    },
  } as SubprocessRuntime
}

/**
 * A subprocess handle with the given error stream and outcome; the provider reads only those.
 * @param stderr - the error stream, or undefined when none was requested.
 * @param done - the outcome.
 * @param terminate - what stops the process.
 * @returns the handle.
 */
function handleOf(stderr: Readable | undefined, done: Promise<SubprocessOutcome>, terminate: () => void): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr,
    control: undefined,
    collected: {},
    done,
    terminate,
    waitForExit: () => done.then(() => true, () => true),
  }
}

/**
 * An environment with the given entries applied; an undefined entry removes its name.
 * @param base - the environment to start from.
 * @param entries - the entries to apply.
 * @returns the environment.
 */
function applyEnv(base: NodeJS.ProcessEnv, entries: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const [name, value] of Object.entries(entries)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  return env
}

/**
 * Put back the environment values a spec changed.
 * @param previous - each name with its value before the spec; undefined when the name was absent.
 */
function restoreEnv(previous: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

/**
 * Spy on the error and warning methods of a mount's logger.
 * @param mounted - the mount whose logger is spied.
 * @returns the two spies, and a function that returns the arguments of every logged call.
 */
function spyOnLog(mounted: Mount) {
  const error = vi.spyOn(mounted.ctx.logger, 'error')
  const warn = vi.spyOn(mounted.ctx.logger, 'warn')
  return { error, warn, calls: () => [...error.mock.calls, ...warn.mock.calls] }
}

/**
 * The host and port of the fixture's HTTPS server, as a clone URL names them.
 * @returns the host, such as `127.0.0.1:44321`.
 */
function fixtureHost(): string {
  return new URL(fixture.origin).host
}

/** @returns the clone URL of the fixture's public repository. */
function publicUrl(): string {
  return `${fixture.origin}/public.git`
}

/** @returns the clone URL of the fixture's private repository. */
function privateUrl(): string {
  return `${fixture.origin}/private.git`
}

/** @returns the clone URL of the fixture's stalled repository, whose advertisement never arrives. */
function stallUrl(): string {
  return `${fixture.origin}/stall.git`
}

/**
 * Write a token file in the home's secrets directory, at mode 0600.
 * @param text - the token file's content.
 * @returns the file's absolute path.
 */
async function writeToken(text: string): Promise<string> {
  const secrets = join(home, 'secrets')
  await mkdir(secrets, { recursive: true, mode: 0o700 })
  const file = join(secrets, 'github-token')
  await writeFile(file, text, { mode: 0o600 })
  return file
}

/**
 * Wait until an import leaves the cloning state.
 * @param service - the provider.
 * @param id - the import's id.
 * @returns the import's row once it is done or failed.
 * @throws Error when the import does not end within the wait.
 */
async function settledImport(service: DelorunWorkspaces, id: string): Promise<ImportRow> {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const row = (await service.list()).imports.find(item => item.id === id)
    if (row !== undefined && row.state !== 'cloning') return row
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`import ${id} did not end`)
}

/**
 * Wait until a check passes.
 * @param check - the check.
 * @throws Error when the check does not pass within the wait.
 */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the condition did not hold')
}

/**
 * Whether a path exists, without following a link at its end.
 * @param path - the absolute path.
 * @returns true when the path exists.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * The SHA-256 of a text's UTF-8 bytes, in hexadecimal.
 * @param text - the text.
 * @returns the digest.
 */
function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}
