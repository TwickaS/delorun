/**
 * The places and preview routes' readers: the recent workspaces and suggested folders the flow starts from, where a new
 * folder goes by default, and what one folder holds, read from top-level names and Git's HEAD only within bounds and
 * never outside the roots or in a location Delorun never adds.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewFolder, readPlaces, type PlacesDeps, type PreviewDeps } from '../src/places.ts'
import { MAX_PLACES, MAX_PREVIEW_NAMES, PlacesAnswer, PreviewAnswer } from '../src/wire.ts'

let scratch = ''
let person = ''
let delorunHome = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-new-workspace-places-'))
  person = join(scratch, 'a', 'b', 'person')
  delorunHome = join(scratch, 'delorun')
  for (const directory of [join(person, 'projects'), join(person, '.dsh'), join(delorunHome, 'inside')]) await mkdir(directory, { recursive: true })
  vi.stubEnv('HOME', person)
  vi.stubEnv('DELORUN_HOME', delorunHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

/** A workspace record as the registry lists it. */
function workspace(path: string, updatedAt: string, title = '') {
  return { id: `id-${updatedAt}`, path, title, updatedAt }
}

/** The places reader's dependencies over a list of workspaces. */
function placesDeps(workspaces: readonly ReturnType<typeof workspace>[], extra: Partial<PlacesDeps> = {}): PlacesDeps {
  return {
    registry: { list: () => workspaces } as never,
    roots: ['~'],
    suggested: [],
    firstParent: '~/Projects',
    lastParent: async () => undefined,
    env: process.env,
    warn: vi.fn(),
    ...extra,
  }
}

describe('the places the flow starts from', () => {
  it('lists the recent workspaces newest first, named by title or folder, with their kind', async () => {
    const [one, two, three] = [join(person, 'one'), join(person, 'two'), join(person, 'three')] as const
    for (const folder of [one, two, three]) await mkdir(folder)
    await writeFile(join(two, 'package.json'), '{}')
    const answer = await readPlaces(placesDeps([workspace(one, '2026-01-01T00:00:00Z'), workspace(two, '2026-03-01T00:00:00Z', 'Titled'), workspace(three, '2026-02-01T00:00:00Z')]))
    expect(PlacesAnswer.parse(answer).recent).toEqual([
      { path: two, name: 'Titled', kind: 'code', usedAt: '2026-03-01T00:00:00Z' },
      { path: three, name: 'three', kind: 'empty', usedAt: '2026-02-01T00:00:00Z' },
      { path: one, name: 'one', kind: 'empty', usedAt: '2026-01-01T00:00:00Z' },
    ])
    expect(answer.home).toBe(person)
  })

  it('leaves out a workspace whose folder is gone or is a file, and lists at most the newest few', async () => {
    const real = join(person, 'real')
    await mkdir(real)
    await writeFile(join(person, 'file'), 'x')
    const many = Array.from({ length: MAX_PLACES + 2 }, (_, index) => workspace(real, `2026-01-${String(index + 10)}T00:00:00Z`))
    expect((await readPlaces(placesDeps(many))).recent).toHaveLength(MAX_PLACES)
    const answer = await readPlaces(placesDeps([workspace(join(person, 'gone'), '2026-02-01T00:00:00Z'), workspace(join(person, 'file'), '2026-02-02T00:00:00Z'), workspace(real, '2026-01-01T00:00:00Z')]))
    expect(answer.recent.map(each => each.path)).toEqual([real])
  })

  it('suggests only configured folders that exist inside a root, once each, in order', async () => {
    const elsewhere = join(scratch, 'elsewhere')
    await mkdir(join(person, 'src'))
    await mkdir(join(person, 'Code'))
    await mkdir(elsewhere)
    const answer = await readPlaces(placesDeps([], { suggested: ['~/src', '~/missing', elsewhere, delorunHome, join(person, '.dsh'), '~/Code', '~/src'] }))
    expect(answer.suggested).toEqual([{ path: join(person, 'src'), name: 'src' }, { path: join(person, 'Code'), name: 'Code' }])
  })

  it('suggests at most the most places the answer holds', async () => {
    const names = Array.from({ length: MAX_PLACES + 3 }, (_, index) => `s${String(index)}`)
    for (const each of names) await mkdir(join(person, each))
    expect((await readPlaces(placesDeps([], { suggested: names.map(each => `~/${each}`) }))).suggested).toHaveLength(MAX_PLACES)
  })
})

describe('where a new folder goes by default', () => {
  const projects = () => join(person, 'projects')

  it('is the last parent used while it exists inside the roots', async () => {
    const answer = await readPlaces(placesDeps([], { lastParent: async () => projects() }))
    expect(answer.defaultParent).toBe(projects())
  })

  it.each<readonly [string, () => string | undefined]>([
    ['none is recorded', () => undefined],
    ['it is gone', () => join(person, 'gone')],
    ['it is a file', () => join(person, 'file')],
    ['it is outside the roots', () => join(scratch, 'elsewhere')],
    ['it is the Delorun home', () => delorunHome],
  ])('is the first parent, expanded, when %s', async (_, last) => {
    await writeFile(join(person, 'file'), 'x')
    await mkdir(join(scratch, 'elsewhere'))
    const answer = await readPlaces(placesDeps([], { lastParent: async () => last() }))
    expect(answer.defaultParent).toBe(join(person, 'Projects'))
  })

  it('keeps an absolute first parent as written', async () => {
    expect((await readPlaces(placesDeps([], { firstParent: '/srv/work' }))).defaultParent).toBe('/srv/work')
  })
})

/** The preview reader's dependencies. */
function previewDeps(extra: Partial<PreviewDeps> = {}): PreviewDeps {
  return { roots: ['~'], timeMs: 2_000, env: process.env, warn: vi.fn(), git: async () => undefined, ...extra }
}

/** Make a folder under the home directory holding the given files and folders (a name ending in `/` is a folder). */
async function folderWith(name: string, entries: readonly string[]): Promise<string> {
  const folder = join(person, name)
  await mkdir(folder)
  for (const entry of entries) await (entry.endsWith('/') ? mkdir(join(folder, entry)) : writeFile(join(folder, entry), ''))
  return folder
}

describe('previewing a folder', () => {
  it('describes what the folder holds: its kind, entries folders first then by name, and that it has no Git', async () => {
    const folder = await folderWith('p', ['zeta.txt', 'alpha.txt', 'beta/', 'Alpha/', '.hidden', '.hiddendir/'])
    const answer = PreviewAnswer.parse(await previewFolder(folder, previewDeps()))
    expect(answer).toEqual({
      result: 'folder', kind: 'files', git: false, agentsFile: false, more: false,
      entries: [{ name: 'Alpha', folder: true }, { name: 'beta', folder: true }, { name: 'alpha.txt', folder: false, size: 0 }, { name: 'zeta.txt', folder: false, size: 0 }],
    })
  })

  it('reads an empty folder as empty', async () => {
    expect(await previewFolder(await folderWith('e', []), previewDeps())).toEqual({ result: 'folder', kind: 'empty', git: false, agentsFile: false, entries: [], more: false })
  })

  it('reads the branch from .git/HEAD, hiding .git itself from the entries', async () => {
    const folder = await folderWith('repo', ['.git/', 'src/'])
    await writeFile(join(folder, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
    expect(await previewFolder(folder, previewDeps())).toEqual({ result: 'folder', kind: 'code', git: true, branch: 'feature/x', agentsFile: false, entries: [{ name: 'src', folder: true }], more: false })
  })

  it.each([
    ['a detached HEAD', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n'],
    ['a HEAD that names no branch', 'ref: refs/tags/v1\n'],
  ])('gives no branch for %s', async (_, head) => {
    const folder = await folderWith('repo', ['.git/'])
    await writeFile(join(folder, '.git', 'HEAD'), head)
    const answer = await previewFolder(folder, previewDeps())
    expect(answer).toMatchObject({ result: 'folder', git: true })
    expect(answer).not.toHaveProperty('branch')
  })

  it('gives no branch for a .git file (a worktree) or a .git without HEAD', async () => {
    const worktree = await folderWith('worktree', ['.git'])
    await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere\n')
    const bare = await folderWith('bare', ['.git/'])
    for (const folder of [worktree, bare]) {
      const answer = await previewFolder(folder, previewDeps())
      expect(answer).toMatchObject({ result: 'folder', git: true })
      expect(answer).not.toHaveProperty('branch')
    }
  })

  it('reports an AGENTS.md only when it is a regular file', async () => {
    const file = await folderWith('file', ['AGENTS.md'])
    const folderNamed = await folderWith('folder', ['AGENTS.md/'])
    const link = await folderWith('link', [])
    await writeFile(join(person, 'target.md'), '')
    await symlink(join(person, 'target.md'), join(link, 'AGENTS.md'))
    const seen = await Promise.all([file, folderNamed, link].map(async folder => (await previewFolder(folder, previewDeps()) as { agentsFile: boolean }).agentsFile))
    expect(seen).toEqual([true, false, false])
  })

  it('lists at most the most names a preview holds and says there are more', async () => {
    const exactly = await folderWith('exactly', Array.from({ length: MAX_PREVIEW_NAMES }, (_, index) => `f${String(index).padStart(2, '0')}`))
    const over = await folderWith('over', Array.from({ length: MAX_PREVIEW_NAMES + 1 }, (_, index) => `f${String(index).padStart(2, '0')}`))
    const [one, two] = await Promise.all([exactly, over].map(folder => previewFolder(folder, previewDeps()))) as { entries: unknown[]; more: boolean }[]
    expect([one?.entries.length, one?.more, two?.entries.length, two?.more]).toEqual([MAX_PREVIEW_NAMES, false, MAX_PREVIEW_NAMES, true])
  })

  it('stops reading at the time bound and says there are more', async () => {
    const folder = await folderWith('slow', ['a', 'b', 'c', 'd'])
    let calls = 0
    // The deadline is taken on the first call and the first entry is read on the second; every later call is past it.
    const now = (): number => (++calls <= 2 ? 0 : 10_000)
    const answer = await previewFolder(folder, previewDeps({ now, timeMs: 100 })) as { entries: unknown[]; more: boolean }
    expect([answer.entries.length, answer.more]).toEqual([1, true])
  })
})

describe('previewing a project folder', () => {
  it('names the stacks the marker files mark, once each, and omits the field when none is found', async () => {
    const folder = await folderWith('stacks', ['package.json', 'tsconfig.json', 'pyproject.toml', 'setup.py', 'App.csproj', 'go.mod', 'constructor'])
    expect(await previewFolder(folder, previewDeps())).toMatchObject({ stack: ['node', 'typescript', 'python', 'go', 'dotnet'] })
    expect(await previewFolder(await folderWith('plain', ['notes.txt']), previewDeps())).not.toHaveProperty('stack')
  })

  it('gives a file its size in bytes and a folder none', async () => {
    const folder = await folderWith('sized', ['dir/'])
    await writeFile(join(folder, 'five.txt'), 'hello')
    expect((await previewFolder(folder, previewDeps()) as { entries: unknown[] }).entries).toEqual([{ name: 'dir', folder: true }, { name: 'five.txt', folder: false, size: 5 }])
  })

  it('gives no size to a link', async () => {
    const folder = await folderWith('linked', [])
    await writeFile(join(person, 'target.txt'), 'hello')
    await symlink(join(person, 'target.txt'), join(folder, 'link.txt'))
    expect((await previewFolder(folder, previewDeps()) as { entries: unknown[] }).entries).toEqual([{ name: 'link.txt', folder: false }])
  })

  it('asks Git for the latest commit of a repository whose .git is a folder', async () => {
    const folder = await folderWith('repo', ['.git/'])
    const git = vi.fn(async () => `${Date.UTC(2026, 0, 2) / 1000}\tfix: the thing`)
    const answer = PreviewAnswer.parse(await previewFolder(folder, previewDeps({ git })))
    expect(answer).toMatchObject({ lastCommit: { subject: 'fix: the thing', at: '2026-01-02T00:00:00.000Z' } })
    expect(git).toHaveBeenCalledOnce()
  })

  it('does not run Git for a folder without a repository, or where .git is a file or a link', async () => {
    const git = vi.fn(async () => '0\tx')
    const none = await folderWith('none', [])
    const file = await folderWith('file', ['.git'])
    const link = await folderWith('link', [])
    await mkdir(join(person, 'elsewhere'))
    await symlink(join(person, 'elsewhere'), join(link, '.git'))
    for (const folder of [none, file, link]) expect(await previewFolder(folder, previewDeps({ git }))).not.toHaveProperty('lastCommit')
    expect(git).not.toHaveBeenCalled()
  })

  it('does not run Git for a repository that names other folders to read objects from', async () => {
    const git = vi.fn(async () => '0\tx')
    const folder = await folderWith('shared', ['.git/'])
    await mkdir(join(folder, '.git', 'objects', 'info'), { recursive: true })
    await writeFile(join(folder, '.git', 'objects', 'info', 'alternates'), '/elsewhere/objects\n')
    expect(await previewFolder(folder, previewDeps({ git }))).not.toHaveProperty('lastCommit')
    expect(git).not.toHaveBeenCalled()
  })

  it('leaves the commit out when Git gives none, as for a repository with no commits', async () => {
    const folder = await folderWith('fresh', ['.git/'])
    expect(await previewFolder(folder, previewDeps())).not.toHaveProperty('lastCommit')
  })
})

describe('refusing to preview a folder', () => {
  it.each<readonly [string, string, () => string]>([
    ['the home directory', 'home-directory', () => person],
    ['the Delorun home', 'delorun-home', () => delorunHome],
    ['a folder inside the Delorun home', 'delorun-home', () => join(delorunHome, 'inside')],
    ['the stock home', 'stock-home', () => join(person, '.dsh')],
    ['a folder outside the roots', 'outside-roots', () => join(scratch, 'elsewhere')],
    ['a relative path', 'not-absolute', () => 'projects'],
  ])('refuses %s as %s', async (_, problem, path) => {
    await mkdir(join(scratch, 'elsewhere'))
    expect(await previewFolder(path(), previewDeps())).toEqual({ result: 'refused', problem })
  })

  it('refuses a link inside the root that leaves it, as outside the roots', async () => {
    const outside = join(scratch, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), '')
    await symlink(outside, join(person, 'projects', 'out'))
    expect(await previewFolder(join(person, 'projects', 'out'), previewDeps())).toEqual({ result: 'refused', problem: 'outside-roots' })
  })

  it('refuses the folder outside an absolute root even though it is inside the home directory', async () => {
    expect(await previewFolder(join(person, 'projects'), previewDeps({ roots: [join(scratch, 'only-root')] }))).toEqual({ result: 'refused', problem: 'outside-roots' })
  })
})

describe('a folder that cannot be previewed', () => {
  it('is unreadable when it is missing or a file, logging only a code', async () => {
    await writeFile(join(person, 'file'), 'x')
    const warn = vi.fn()
    expect(await previewFolder(join(person, 'missing'), previewDeps({ warn }))).toEqual({ result: 'unreadable' })
    expect(await previewFolder(join(person, 'file'), previewDeps({ warn }))).toEqual({ result: 'unreadable' })
    expect(warn.mock.calls.map(call => call[0] as string)).toEqual(['a folder could not be previewed: ENOENT', 'a folder could not be previewed: ENOTDIR'])
  })

  it('is unreadable when the Delorun home cannot be resolved', async () => {
    vi.stubEnv('DELORUN_HOME', 'relative/home')
    expect(await previewFolder(join(person, 'projects'), previewDeps())).toEqual({ result: 'unreadable' })
  })
})
