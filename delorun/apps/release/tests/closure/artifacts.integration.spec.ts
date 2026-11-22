/**
 * Building a closure from the worktree's own artifacts: the build refuses a worktree that is not at the commit, has
 * edited tracked files, lacks the `lib/` a package's `main` names or has sources newer than their `lib/`, and finds the
 * directories the artifact build wrote.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildClosures } from '../../src/build-closure.ts'
import { readRecipe } from '../../src/closure/config.ts'
import { artifactDirectories, artifactProblems, isArtifactSource } from '../../src/closure/artifacts.ts'
import { BUILD_STAMP_PATH, captureBuildStart, writeBuildStamp } from '../../../../../scripts/build-stamp.ts'
import { scratch, writeTree } from '../support.ts'

const NO_STAMP = 'no build stamp: the artifacts were not written by a clean `pnpm run build:artifacts`; run it, or cut with `--artifacts build`'

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }

/**
 * A repository with one built package, one package with no build output expected, and a scoped vendor package.
 * @param directory - where to create it.
 * @returns the commit.
 */
function repository(directory: string): string {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: directory, env: ENV, encoding: 'utf8', timeout: 30_000 }).trim()
  git('init', '-q', '-b', 'main')
  writeTree(directory, {
    '.gitignore': 'lib/\nnode_modules/\ndist/\n',
    'packages/group/built/package.json': '{"name":"@x/built","main":"lib/index.js"}\n',
    'packages/group/built/src/index.ts': 'export {}\n',
    'packages/group/built/src/nested/deep.ts': 'export {}\n',
    'packages/group/untyped/package.json': '{"name":"@x/untyped","main":"src/index.ts"}\n',
    'packages/group/untyped/src/index.ts': 'export {}\n',
    'packages/group/nameless/package.json': '{"main":"lib/index.js"}\n',
    'packages/group/nameless/src/index.ts': 'export {}\n',
    'packages/group/nosrc/package.json': '{"name":"@x/nosrc","main":"lib/index.js"}\n',
    'packages/plain.txt': 'a file beside the groups\n',
    'apps/web/package.json': '{"name":"@x/web","main":"lib/index.js"}\n',
    'apps/web/src/index.ts': 'export {}\n',
    'vendor/tool/package.json': '{"name":"@x/tool","main":"lib/index.js"}\n',
    'vendor/tool/src/index.ts': 'export {}\n',
    'vendor/stray.txt': 'not a package\n',
  })
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  return git('rev-parse', 'HEAD')
}

/**
 * Write a package's build output newer than its sources.
 * @param directory - the repository.
 * @param path - the package's path.
 */
function build(directory: string, path: string): void {
  mkdirSync(join(directory, path, 'lib'), { recursive: true })
  writeFileSync(join(directory, path, 'lib', 'index.js'), 'export {}\n')
  const later = new Date(Date.now() + 60_000)
  utimesSync(join(directory, path, 'lib', 'index.js'), later, later)
}

describe('artifactProblems', () => {
  it('names every package whose lib/ its main needs and lacks', (test) => {
    const directory = scratch(test)
    const commit = repository(directory)
    expect(artifactProblems(directory, commit)).toEqual([
      NO_STAMP,
      '@x/web has no lib/index.js; run the artifact build',
      '@x/built has no lib/index.js; run the artifact build',
      'packages/group/nameless has no lib/index.js; run the artifact build',
      '@x/tool has no lib/index.js; run the artifact build',
    ])
  })

  it('accepts a worktree at the commit whose packages are built after their sources', (test) => {
    const directory = scratch(test)
    const commit = repository(directory)
    for (const path of ['packages/group/built', 'packages/group/nameless', 'apps/web', 'vendor/tool']) build(directory, path)
    writeBuildStamp(directory, captureBuildStart(directory))
    expect(artifactProblems(directory, commit)).toEqual([])
  })

  it('refuses artifacts whose stamp names another commit', (test) => {
    const directory = scratch(test)
    const commit = repository(directory)
    for (const path of ['packages/group/built', 'packages/group/nameless', 'apps/web', 'vendor/tool']) build(directory, path)
    writeBuildStamp(directory, captureBuildStart(directory))
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'next'], { cwd: directory, env: ENV, timeout: 30_000 })
    const next = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, env: ENV, encoding: 'utf8', timeout: 30_000 }).trim()
    expect(artifactProblems(directory, next)).toEqual([`the artifacts were built at ${commit}, not at ${next}; run \`pnpm run build:artifacts\` again, or cut with \`--artifacts build\``])
  })

  it('refuses artifacts without a stamp or with a truncated one', (test) => {
    const directory = scratch(test)
    const commit = repository(directory)
    for (const path of ['packages/group/built', 'packages/group/nameless', 'apps/web', 'vendor/tool']) build(directory, path)
    expect(artifactProblems(directory, commit)).toEqual([NO_STAMP])
    mkdirSync(join(directory, '.dsh-build'), { recursive: true })
    writeFileSync(join(directory, BUILD_STAMP_PATH), '{"commit":')
    expect(artifactProblems(directory, commit)).toEqual([NO_STAMP])
    writeFileSync(join(directory, BUILD_STAMP_PATH), '{"commit":7}')
    expect(artifactProblems(directory, commit)).toEqual([NO_STAMP])
  })

  it('writes no stamp when tracked files differ from HEAD, and clears an older one', (test) => {
    const directory = scratch(test)
    const commit = repository(directory)
    expect(writeBuildStamp(directory, captureBuildStart(directory))?.commit).toBe(commit)
    writeFileSync(join(directory, 'vendor/stray.txt'), 'edited\n')
    expect(captureBuildStart(directory)).toBeUndefined()
    expect(writeBuildStamp(directory, captureBuildStart(directory))).toBeUndefined()
    expect(artifactProblems(directory, commit)[0]).toBe(NO_STAMP)
  })

  it('refuses a package whose sources are newer than its lib/', (test) => {
    const directory = scratch(test)
    const commit = repository(directory)
    for (const path of ['packages/group/built', 'packages/group/nameless', 'apps/web', 'vendor/tool']) build(directory, path)
    writeBuildStamp(directory, captureBuildStart(directory))
    const later = new Date(Date.now() + 3_600_000)
    utimesSync(join(directory, 'packages/group/built/src/index.ts'), later, later)
    expect(artifactProblems(directory, commit)).toEqual(['@x/built\'s sources are newer than its lib/; run the artifact build again'])
  })

  it('refuses a worktree that is not at the commit or has edited tracked files', (test) => {
    const directory = scratch(test)
    const commit = repository(directory)
    for (const path of ['packages/group/built', 'packages/group/nameless', 'apps/web', 'vendor/tool']) build(directory, path)
    writeBuildStamp(directory, captureBuildStart(directory))
    writeFileSync(join(directory, 'vendor/stray.txt'), 'edited\n')
    expect(artifactProblems(directory, commit)).toEqual(['tracked files differ from the commit; commit or restore them before building from existing artifacts'])
    expect(artifactProblems(directory, 'b'.repeat(40))[0]).toContain(`the worktree is at ${commit}, not at ${'b'.repeat(40)}`)
  })
})

describe('a repository without every package group', () => {
  it('has the groups it holds checked and the others skipped', (test) => {
    const directory = scratch(test)
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: directory, env: ENV, encoding: 'utf8', timeout: 30_000 }).trim()
    git('init', '-q', '-b', 'main')
    writeTree(directory, { 'packages/g/a/package.json': '{"name":"@x/a","main":"lib/index.js"}\n', 'packages/g/a/src/index.ts': 'export {}\n' })
    git('add', '-A')
    git('commit', '-q', '-m', 'fixture')
    expect(artifactProblems(directory, git('rev-parse', 'HEAD'))).toEqual([NO_STAMP, '@x/a has no lib/index.js; run the artifact build'])
  })
})

describe('artifactDirectories', () => {
  it('lists the ignored build directories, and not dependencies, caches or the documentation site', (test) => {
    const directory = scratch(test)
    repository(directory)
    writeTree(directory, {
      'packages/group/built/lib/index.js': 'x\n',
      'apps/web/dist/index.html': 'x\n',
      'packages/group/built/node_modules/dep/index.js': 'x\n',
      'delorun/apps/docs/lib/x.js': 'x\n',
      'delorun/apps/kept.txt': 'tracked beside the documentation site\n',
      'coverage/lcov.info': 'x\n',
    })
    execFileSync('git', ['add', 'delorun/apps/kept.txt'], { cwd: directory, env: ENV, timeout: 30_000 })
    writeFileSync(join(directory, '.git', 'info', 'exclude'), 'node_modules/\ndelorun/apps/docs/lib/\ncoverage/\n')
    expect(artifactDirectories(directory)).toEqual(['apps/web/dist', 'packages/group/built/lib'])
  })
})

describe('artifact sources', () => {
  it('are build and existing', () => {
    expect(isArtifactSource('build')).toBe(true)
    expect(isArtifactSource('existing')).toBe(true)
    expect(isArtifactSource('cached')).toBe(false)
  })
})

describe('a build from existing artifacts', () => {
  it('stops before it exports the tree when the worktree lacks the artifacts', async (test) => {
    const directory = scratch(test)
    const commit = repository(directory)
    await expect(buildClosures(directory, readRecipe(), { version: '0.1.0', commit, out: join(directory, 'out'), platforms: ['linux-x64'], cache: join(directory, 'cache'), writePins: false, artifacts: 'existing' }))
      .rejects.toThrow(`the worktree's artifacts cannot be used:\n${NO_STAMP}\n@x/web has no lib/index.js; run the artifact build`)
  })
})
