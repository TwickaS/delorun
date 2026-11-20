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
  it('reads the first line of the latest commit, and the repository\'s own configuration runs nothing', async () => {
    const home = join(scratch, 'home')
    const folder = join(home, 'real')
    await mkdir(folder, { recursive: true })
    vi.stubEnv('HOME', home)
    const env = { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: join(scratch, 'none') }
    const run = (...args: string[]) => promisify(execFile)('git', args, { cwd: folder, env })
    await run('init', '-q')
    await run('commit', '-q', '--allow-empty', '-m', 'first line\n\nbody')
    // A monitor that would write a marker if the preview's Git run started it.
    await run('config', 'core.fsmonitor', `touch ${join(scratch, 'ran')}`)
    expect(await lastCommitOf(folder, runGit, env)).toMatchObject({ subject: 'first line' })
    const answer = await previewFolder(folder, { roots: ['~'], timeMs: 2000, env, warn: vi.fn() })
    expect(answer).toMatchObject({ result: 'folder', git: true, lastCommit: { subject: 'first line' } })
    await expect(stat(join(scratch, 'ran'))).rejects.toThrow()
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
