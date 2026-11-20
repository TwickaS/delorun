import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILD_SOURCE_COMMIT_ENV, BUILD_SOURCE_TREE_ENV, BUILD_STAMP_PATH, captureBuildStart, readBuildStamp, writeBuildStamp } from './build-stamp.ts'

const directories: string[] = []
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, env: ENV, encoding: 'utf8', timeout: 30_000 }).trim()
}

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'build-stamp-'))
  directories.push(directory)
  git(directory, 'init', '-q', '-b', 'main')
  writeFileSync(join(directory, 'tracked.txt'), 'one\n')
  git(directory, 'add', '.')
  git(directory, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first')
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('build stamp', () => {
  it('records the commit the build started at', () => {
    const directory = repository()
    expect(writeBuildStamp(directory, captureBuildStart(directory))).toEqual({ commit: git(directory, 'rev-parse', 'HEAD') })
    expect(readBuildStamp(directory)?.commit).toBe(git(directory, 'rev-parse', 'HEAD'))
  })

  it('writes no stamp, and removes an older one, when the build started with edited tracked files', () => {
    const directory = repository()
    writeBuildStamp(directory, captureBuildStart(directory))
    writeFileSync(join(directory, 'tracked.txt'), 'edited\n')
    expect(captureBuildStart(directory)).toBeUndefined()
    expect(writeBuildStamp(directory, captureBuildStart(directory))).toBeUndefined()
    expect(existsSync(join(directory, BUILD_STAMP_PATH))).toBe(false)
  })

  it('writes no stamp when HEAD moved during the build', () => {
    const directory = repository()
    const start = captureBuildStart(directory)
    git(directory, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'moved')
    expect(writeBuildStamp(directory, start)).toBeUndefined()
    expect(existsSync(join(directory, BUILD_STAMP_PATH))).toBe(false)
  })

  it('writes no stamp when a tracked file was edited during the build', () => {
    const directory = repository()
    const start = captureBuildStart(directory)
    writeFileSync(join(directory, 'tracked.txt'), 'edited\n')
    expect(writeBuildStamp(directory, start)).toBeUndefined()
    expect(existsSync(join(directory, BUILD_STAMP_PATH))).toBe(false)
  })
})

describe('build stamp in an exported tree without .git', () => {
  const commit = 'abcdef0123456789abcdef0123456789abcdef01'
  const facts = { [BUILD_SOURCE_COMMIT_ENV]: commit, [BUILD_SOURCE_TREE_ENV]: 'clean' }

  function exported(): string {
    const directory = mkdtempSync(join(tmpdir(), 'build-stamp-export-'))
    directories.push(directory)
    return directory
  }

  it('stamps the commit and the clean tree the environment names', () => {
    const directory = exported()
    expect(captureBuildStart(directory, facts)).toBe(commit)
    expect(writeBuildStamp(directory, commit, facts)).toEqual({ commit })
    expect(readBuildStamp(directory)).toEqual({ commit })
    expect(readFileSync(join(directory, BUILD_STAMP_PATH), 'utf8')).not.toContain(directory)
  })

  it('fails loud, and writes no stamp, when the environment names neither the commit nor the tree', () => {
    const directory = exported()
    expect(() => captureBuildStart(directory, {})).toThrow(/no \.git.*DSH_BUILD_SOURCE_COMMIT/u)
    expect(() => captureBuildStart(directory, { [BUILD_SOURCE_COMMIT_ENV]: commit })).toThrow(/DSH_BUILD_SOURCE_TREE/u)
    expect(() => captureBuildStart(directory, { [BUILD_SOURCE_TREE_ENV]: 'clean' })).toThrow(/DSH_BUILD_SOURCE_COMMIT/u)
    expect(() => writeBuildStamp(directory, commit, {})).toThrow(/no \.git/u)
    expect(existsSync(join(directory, BUILD_STAMP_PATH))).toBe(false)
  })

  it('refuses a commit that is not a full id, and a tree that is not stated clean', () => {
    const directory = exported()
    expect(() => captureBuildStart(directory, { ...facts, [BUILD_SOURCE_COMMIT_ENV]: 'HEAD' })).toThrow(/40-character/u)
    expect(() => captureBuildStart(directory, { ...facts, [BUILD_SOURCE_TREE_ENV]: 'dirty' })).toThrow(/must be clean/u)
  })

  it('does not stamp a commit other than the one the build started with', () => {
    const directory = exported()
    expect(writeBuildStamp(directory, 'f'.repeat(40), facts)).toBeUndefined()
    expect(existsSync(join(directory, BUILD_STAMP_PATH))).toBe(false)
  })

  it('uses git, not the environment, inside a checkout', () => {
    const directory = repository()
    mkdirSync(join(directory, '.dsh-build'), { recursive: true })
    expect(captureBuildStart(directory, facts)).toBe(git(directory, 'rev-parse', 'HEAD'))
    expect(captureBuildStart(directory, {})).toBe(git(directory, 'rev-parse', 'HEAD'))
  })
})
