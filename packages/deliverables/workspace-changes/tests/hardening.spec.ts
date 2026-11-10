/**
 * Host git commands over repository state a confined command can write: every program that state names stays
 * unstarted while the snapshot, diff, gitlink and ignore operations still complete. Each mechanism plants a program
 * that would create a marker file.
 */
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  GitRunner, blobText, diffTrees, gitlinkPaths, ignoredPaths, locateGitWorkspace, repositoryDrivers, snapshotTree, treeBlob,
} from '../src/git.ts'
import { PrivateTree } from '../src/files.ts'
import { FIXED_GIT_OVERRIDES, driverOverrides, gitVersionProblem, hardenedGitEnvironment } from '../src/hardening.ts'
import { git, scratchDir } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const signal = new AbortController().signal

async function runner(): Promise<GitRunner> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return new GitRunner(ctx.subprocess, await ctx.subprocess.resolveExecutable('git'), { timeoutMs: 30_000, outputMaxBytes: 1024 * 1024 })
}

/** A committed repository with one tracked file, and a directory whose marker files record any planted program that ran. */
async function fixture(): Promise<{ cwd: string; markers: string; plant: (name: string) => string }> {
  const cwd = await scratchDir('dsh-git-hardening-', cleanups)
  const markers = await scratchDir('dsh-git-markers-', cleanups)
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'one\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  // A shell command a configuration value or hook would run; it leaves the named marker and passes content through.
  const plant = (name: string): string => `touch '${join(markers, name)}'; cat`
  return { cwd, markers, plant }
}

/** A hook script that leaves the named marker. */
async function hook(directory: string, markers: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const event of ['post-index-change', 'pre-commit', 'post-checkout', 'reference-transaction']) {
    await writeFile(join(directory, event), `#!/bin/sh\ntouch '${join(markers, name)}'\n`)
    await chmod(join(directory, event), 0o755)
  }
}

/**
 * Every operation a recorded turn runs: locate, both snapshots, the tree diff, the gitlink and ignore checks, and
 * both sides of one comparison.
 */
async function everyOperation(cwd: string, change: () => Promise<void>): Promise<string[]> {
  const command = await runner()
  const privateTree = PrivateTree.create(await scratchDir('dsh-git-store-', cleanups))
  const workspace = await locateGitWorkspace(command, cwd, () => privateTree, signal)
  expect(workspace).not.toBeNull()
  const before = await snapshotTree(command, workspace!, signal)
  await change()
  const after = await snapshotTree(command, workspace!, signal)
  const changed = await diffTrees(command, workspace!, before, after, signal)
  await gitlinkPaths(command, workspace!, signal)
  await ignoredPaths(command, workspace!, changed.map(entry => entry.path), signal)
  for (const tree of [before, after]) {
    const blob = await treeBlob(command, workspace!, tree, 'a.txt', signal)
    if (blob !== null) await blobText(command, workspace!, blob.oid, 1024, signal)
  }
  return changed.map(entry => entry.path)
}

const edit = (cwd: string) => () => writeFile(join(cwd, 'a.txt'), 'one\ntwo\n')

/**
 * The positive control: plain git, as the person runs it, with no hardening and the given environment, so a case
 * shows its planted program does run when nothing switches it off. Its exit status is irrelevant; the marker is the
 * evidence.
 */
function plainGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  spawnSync('git', args, { cwd, env, stdio: 'ignore', timeout: 30_000 })
}

// The planted programs are POSIX shell commands and executable hook scripts. Each case runs about a dozen git commands.
describe.skipIf(process.platform === 'win32')('Host git commands over repository state a confined command can write', { timeout: 60_000 }, () => {
  it('the snapshot ignores a configured file-system monitor', async () => {
    const { cwd, markers, plant } = await fixture()
    git(cwd, 'config', 'core.fsmonitor', plant('fsmonitor'))
    expect(await everyOperation(cwd, edit(cwd))).toEqual(['a.txt'])
    expect(await readdir(markers)).toEqual([])
    plainGit(cwd, ['status'])
    expect(await readdir(markers)).toContain('fsmonitor')
  })

  it('the snapshot runs no clean filter that a .gitattributes entry selects', async () => {
    const { cwd, markers, plant } = await fixture()
    git(cwd, 'config', 'filter.planted.clean', plant('clean'))
    git(cwd, 'config', 'filter.planted.smudge', plant('smudge'))
    await writeFile(join(cwd, '.gitattributes'), '* filter=planted\n')
    expect(await everyOperation(cwd, edit(cwd))).toEqual(['a.txt'])
    expect(await readdir(markers)).toEqual([])
    plainGit(cwd, ['add', 'a.txt'])
    expect(await readdir(markers)).toContain('clean')
  })

  it('the snapshot runs no long-running filter process and completes for a required filter', async () => {
    const { cwd, markers, plant } = await fixture()
    git(cwd, 'config', 'filter.planted.process', plant('process'))
    git(cwd, 'config', 'filter.planted.required', 'true')
    await writeFile(join(cwd, '.git', 'info', 'attributes'), '*.txt filter=planted\n')
    expect(await everyOperation(cwd, edit(cwd))).toEqual(['a.txt'])
    expect(await readdir(markers)).toEqual([])
    plainGit(cwd, ['add', 'a.txt'])
    expect(await readdir(markers)).toContain('process')
  })

  it('the snapshot runs no repository hook, wherever core.hooksPath points', async () => {
    const { cwd, markers } = await fixture()
    await hook(join(cwd, '.git', 'hooks'), markers, 'default-hooks')
    expect(await everyOperation(cwd, edit(cwd))).toEqual(['a.txt'])
    const planted = join(cwd, 'planted-hooks')
    await hook(planted, markers, 'hooks-path')
    git(cwd, 'config', 'core.hooksPath', planted)
    await everyOperation(cwd, () => writeFile(join(cwd, 'a.txt'), 'three\n'))
    expect(await readdir(markers)).toEqual([])
    plainGit(cwd, ['add', 'a.txt'])
    expect(await readdir(markers)).toContain('hooks-path')
  })

  it('keeps a filter defined through an included file switched off, even under a name holding "="', async () => {
    const { cwd, markers, plant } = await fixture()
    const included = join(await scratchDir('dsh-git-include-', cleanups), 'included.config')
    await writeFile(included, `[filter "a=b"]\n\tclean = "${plant('included-clean')}"\n`)
    git(cwd, 'config', 'include.path', included)
    await writeFile(join(cwd, '.gitattributes'), '*.txt filter=a=b\n')
    expect(await everyOperation(cwd, edit(cwd))).toEqual(['a.txt'])
    expect(await readdir(markers)).toEqual([])
    plainGit(cwd, ['add', 'a.txt'])
    expect(await readdir(markers)).toContain('included-clean')
  })

  it('a .git file naming another git directory brings none of its programs', async () => {
    const { cwd, markers, plant } = await fixture()
    const other = await scratchDir('dsh-git-other-', cleanups)
    git(other, 'init', '-q', '-b', 'main')
    const planted = join(other, '.git')
    git(other, 'config', 'core.fsmonitor', plant('gitfile-fsmonitor'))
    git(other, 'config', 'filter.planted.clean', plant('gitfile-clean'))
    git(other, 'config', 'core.worktree', cwd)
    await hook(join(planted, 'hooks'), markers, 'gitfile-hook')
    await writeFile(join(planted, 'info', 'attributes'), '* filter=planted\n')
    await rm(join(cwd, '.git'), { recursive: true, force: true })
    await writeFile(join(cwd, '.git'), `gitdir: ${planted}\n`)
    expect(await everyOperation(cwd, edit(cwd))).toEqual(['a.txt'])
    expect(await readdir(markers)).toEqual([])
    plainGit(cwd, ['add', 'a.txt'])
    expect(await readdir(markers)).toEqual(expect.arrayContaining(['gitfile-fsmonitor', 'gitfile-clean', 'gitfile-hook']))
  })

  it('no git command takes configuration or programs from inherited GIT_* variables', async () => {
    const { cwd, markers, plant } = await fixture()
    vi.stubEnv('GIT_CONFIG_PARAMETERS', `'core.fsmonitor'='${plant('parameters').replaceAll('\'', '\'\\\'\'')}'`)
    vi.stubEnv('GIT_EXTERNAL_DIFF', join(markers, 'missing-program'))
    vi.stubEnv('GIT_DIR', join(markers, 'elsewhere'))
    expect(await everyOperation(cwd, edit(cwd))).toEqual(['a.txt'])
    expect(await readdir(markers)).toEqual([])
    plainGit(cwd, ['status'], { ...process.env, GIT_DIR: undefined })
    expect(await readdir(markers)).toContain('parameters')
  })

  it('the diff runs no external diff or textconv driver', async () => {
    const { cwd, markers, plant } = await fixture()
    git(cwd, 'config', 'diff.external', join(markers, 'missing-program'))
    git(cwd, 'config', 'diff.planted.textconv', plant('textconv'))
    git(cwd, 'config', 'diff.planted.command', plant('command'))
    await writeFile(join(cwd, '.gitattributes'), '* diff=planted\n')
    expect(await everyOperation(cwd, edit(cwd))).toEqual(['a.txt'])
    expect(await readdir(markers)).toEqual([])
    plainGit(cwd, ['diff', '--no-ext-diff', 'a.txt'])
    expect(await readdir(markers)).toContain('textconv')
  })
})

describe.skipIf(process.platform === 'win32')('the driver listing', () => {
  it('refuses to snapshot when the configuration cannot be listed completely', async () => {
    const { cwd } = await fixture()
    const privateTree = PrivateTree.create(await scratchDir('dsh-git-store-', cleanups))
    const workspace = (await locateGitWorkspace(await runner(), cwd, () => privateTree, signal))!
    for (let index = 0; index < 50; index += 1) git(cwd, 'config', `filter.f${index}.clean`, 'cat')
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LocalSubprocessRuntime)
    const tiny = new GitRunner(ctx.subprocess, await ctx.subprocess.resolveExecutable('git'), { timeoutMs: 30_000, outputMaxBytes: 64 })
    await expect(repositoryDrivers(tiny, workspace, signal)).rejects.toThrow('git config listing exceeded')
    expect(await repositoryDrivers(await runner(), workspace, signal)).toHaveLength(200)
    await writeFile(join(cwd, '.git', 'config'), '[broken\n')
    await expect(snapshotTree(await runner(), workspace, signal)).rejects.toThrow('git config failed')
  })

  it('switches nothing off when the listing matches no key', async () => {
    const { cwd } = await fixture()
    const privateTree = PrivateTree.create(await scratchDir('dsh-git-store-', cleanups))
    const workspace = (await locateGitWorkspace(await runner(), cwd, () => privateTree, signal))!
    // The command-scope overrides always match the listing, so only a listing git reports as empty takes this path.
    const empty = (await runner()).confinedBy(() => Promise.resolve({ argv: ['/bin/sh', '-c', 'exit 1'], mode: 'read-only', runnerFailureRules: [] }))
    expect(await repositoryDrivers(empty, workspace, signal)).toEqual([])
  })
})

describe('hardened git environment', () => {
  it('removes every inherited GIT_* name and SSH_ASKPASS, then carries the overrides and the command\'s own entries', () => {
    const env = hardenedGitEnvironment(
      { PATH: '/bin', GIT_DIR: '/x', git_exec_path: '/y', SSH_ASKPASS: '/z', GITHUB_TOKEN: 't' },
      [['core.fsmonitor', 'false'], ['filter.a=b.clean', '']],
      { GIT_INDEX_FILE: '/index' },
    )
    expect(env).toStrictEqual({
      GIT_DIR: undefined, git_exec_path: undefined, SSH_ASKPASS: undefined,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'filter.a=b.clean', GIT_CONFIG_VALUE_1: '',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C',
      GIT_INDEX_FILE: '/index',
    })
    expect(hardenedGitEnvironment({}, []).GIT_CONFIG_COUNT).toBe('0')
  })

  it('switches off every program-starting setting the snapshot commands could reach', () => {
    const keys = new Map(FIXED_GIT_OVERRIDES)
    expect(keys.get('core.fsmonitor')).toBe('false')
    expect(keys.get('core.hooksPath')).toBe('/dev/null')
    for (const key of ['diff.external', 'credential.helper', 'core.askPass', 'core.gitProxy', 'core.alternateRefsCommand', 'uploadpack.packObjectsHook']) {
      expect(keys.get(key)).toBe('')
    }
    expect(keys.get('protocol.allow')).toBe('never')
  })

  it('switches off each listed filter and diff driver once and ignores other keys', () => {
    const listing = ['filter.lfs.clean', 'filter.lfs.smudge', 'filter.a=b.process', 'diff.x.y.textconv', 'diff.external', 'core.fsmonitor', ''].join('\0')
    expect(driverOverrides(listing)).toEqual([
      ['filter.lfs.clean', ''], ['filter.lfs.smudge', ''], ['filter.lfs.process', ''], ['filter.lfs.required', 'false'],
      ['filter.a=b.clean', ''], ['filter.a=b.smudge', ''], ['filter.a=b.process', ''], ['filter.a=b.required', 'false'],
      ['diff.x.y.textconv', ''], ['diff.x.y.command', ''],
    ])
    expect(driverOverrides('')).toEqual([])
  })

  it('refuses a git that would ignore command-scope configuration variables', () => {
    expect(gitVersionProblem('git version 2.43.0\n')).toBeUndefined()
    expect(gitVersionProblem('git version 2.31.0.windows.1')).toBeUndefined()
    expect(gitVersionProblem('git version 3.0.0')).toBeUndefined()
    expect(gitVersionProblem('git version 2.30.9')).toContain('older than 2.31')
    expect(gitVersionProblem('git version 1.99.0')).toContain('older than 2.31')
    expect(gitVersionProblem('something else')).toContain('cannot read the git version')
  })
})
