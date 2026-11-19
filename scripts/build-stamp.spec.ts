import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILD_STAMP_PATH, captureBuildStart, readBuildStamp, writeBuildStamp } from './build-stamp.ts'

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
