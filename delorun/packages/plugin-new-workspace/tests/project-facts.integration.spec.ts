/** The latest commit read by the installed `git`: from a real repository, a non-repository and a missing `git`. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewFolder } from '../src/places.ts'
import { lastCommitOf, runGit } from '../src/project-facts.ts'

let scratch = ''

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'delorun-new-workspace-facts-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(scratch, { recursive: true, force: true })
})

describe('the latest commit from the installed git', () => {
  /** A repository in `home/<name>` with one commit, made with Git's identity set and no user configuration. */
  const repo = async (name: string) => {
    const home = join(scratch, 'home')
    const folder = join(home, name)
    await mkdir(folder, { recursive: true })
    vi.stubEnv('HOME', home)
    const env = { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: join(scratch, 'none') }
    const run = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: folder, env })).stdout.trim()
    await run('init', '-q')
    await run('commit', '-q', '--allow-empty', '-m', 'first line\n\nbody')
    return { home, folder, env, run }
  }

  it('reads the first line of the latest commit', async () => {
    const { folder, env } = await repo('real')
    expect(await lastCommitOf(folder, runGit, env)).toMatchObject({ subject: 'first line' })
    expect(await previewFolder(folder, { roots: ['~'], timeMs: 2000, env, warn: vi.fn() })).toMatchObject({ result: 'folder', git: true, lastCommit: { subject: 'first line' } })
  })

  it('starts no program when HEAD\'s commit is missing from a partial clone whose remote and ssh command the repository names', async () => {
    const { folder, env, run } = await repo('hostile')
    const marker = join(scratch, 'ran')
    const head = await run('rev-parse', 'HEAD')
    await run('config', 'core.repositoryformatversion', '1')
    await run('config', 'extensions.partialClone', 'origin')
    await run('config', 'remote.origin.promisor', 'true')
    await run('config', 'remote.origin.url', 'ssh://example.invalid/project.git')
    await run('config', 'core.sshCommand', `touch ${marker}; false`)
    await rm(join(folder, '.git', 'objects', head.slice(0, 2), head.slice(2)))
    expect(await lastCommitOf(folder, runGit, env)).toBeUndefined()
    expect(await previewFolder(folder, { roots: ['~'], timeMs: 2000, env, warn: vi.fn() })).toMatchObject({ result: 'folder', git: true })
    expect(await previewFolder(folder, { roots: ['~'], timeMs: 2000, env, warn: vi.fn() })).not.toHaveProperty('lastCommit')
    await expect(stat(marker)).rejects.toThrow()
  })

  it('does not read a repository above a folder whose own .git is empty, or treat the folder as a bare repository', async () => {
    const { home, folder } = await repo('parent')
    const child = join(folder, 'child')
    await mkdir(join(child, '.git'), { recursive: true })
    expect(await lastCommitOf(child, runGit, { ...process.env, HOME: home })).toBeUndefined()
    const answer = await previewFolder(child, { roots: ['~'], timeMs: 2000, env: { ...process.env, HOME: home }, warn: vi.fn() })
    expect(answer).toMatchObject({ result: 'folder', git: true })
    expect(answer).not.toHaveProperty('lastCommit')
  })

  it('does not treat a folder with a bare repository\'s files and an empty .git as a bare repository', async () => {
    const { home, folder, run } = await repo('source')
    const bare = join(home, 'planted')
    await run('clone', '-q', '--bare', folder, bare)
    await mkdir(join(bare, '.git'))
    expect(await lastCommitOf(bare, runGit, { ...process.env, HOME: home })).toBeUndefined()
  })

  it('ignores the user\'s own Git configuration and replacement refs', async () => {
    const home = join(scratch, 'home2')
    const folder = join(home, 'repo')
    await mkdir(folder, { recursive: true })
    const env = { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: join(scratch, 'none') }
    const run = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: folder, env })).stdout.trim()
    await run('init', '-q')
    await run('commit', '-q', '--allow-empty', '-m', 'real subject')
    const real = await run('rev-parse', 'HEAD')
    await run('commit', '-q', '--allow-empty', '-m', 'fake subject')
    const fake = await run('rev-parse', 'HEAD')
    await run('replace', real, fake)
    // The user's configuration would re-encode what Git prints into something the parser cannot read.
    await writeFile(join(home, '.gitconfig'), '[i18n]\n\tlogOutputEncoding = UTF-16LE\n')
    await run('reset', '-q', '--hard', real)
    expect(await lastCommitOf(folder, runGit, { ...process.env, HOME: home })).toMatchObject({ subject: 'real subject' })
  })

  it('gives nothing for a folder that is not a repository, and for a missing git', async () => {
    await writeFile(join(scratch, 'f'), '')
    expect(await lastCommitOf(scratch, runGit)).toBeUndefined()
    expect(await runGit(['--version'], { PATH: '/nonexistent' })).toBeUndefined()
  })
})
