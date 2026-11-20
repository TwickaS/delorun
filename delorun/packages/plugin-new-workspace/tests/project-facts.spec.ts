/** Project facts: stacks from marker names, and the latest commit parsed from one bounded Git run. */
import { devNull } from 'node:os'
import { delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { lastCommitOf, limitGit, stacksOf, type GitReader } from '../src/project-facts.ts'
import { MAX_COMMIT_SUBJECT } from '../src/wire.ts'

describe('the stacks of a folder', () => {
  it('maps each marker to one stack and ignores other names, including inherited property names', () => {
    expect(stacksOf(['Cargo.toml', 'README.md', 'pom.xml', 'build.gradle.kts', 'toString', 'a.sln', 'mix.exs', 'Package.swift', 'Gemfile', 'composer.json', 'CMakeLists.txt', 'deno.jsonc']))
      .toEqual(['deno', 'rust', 'java', 'ruby', 'php', 'dotnet', 'swift', 'elixir', 'cpp'])
  })
})

describe('the latest commit', () => {
  it('parses the time and subject, and drops control characters', async () => {
    const read = vi.fn<GitReader>(async () => '86400\tfix:\u001b[31m red\u0007 text\n')
    expect(await lastCommitOf('/r', read, { PATH: '/bin', HOME: '/h', SECRET: 'no' })).toEqual({ subject: 'fix:[31m red text', at: '1970-01-02T00:00:00.000Z' })
    const [args, env] = read.mock.calls[0] ?? []
    expect(args).toEqual(expect.arrayContaining(['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'safe.bareRepository=explicit', '-C', '/r', 'log', '-1', '--no-show-signature']))
    expect(env).toEqual({
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'x-delorun-none',
      GIT_CEILING_DIRECTORIES: '/', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', PATH: '/bin', HOME: '/h',
    })
  })

  it('keeps Git from looking above the folder', async () => {
    const read = vi.fn<GitReader>(async () => undefined)
    await lastCommitOf('/home/p/repo', read, {})
    expect(read.mock.calls[0]?.[1].GIT_CEILING_DIRECTORIES).toBe('/home/p')
  })

  it('runs no Git when the parent path holds the separator of the ceiling list', async () => {
    const read = vi.fn<GitReader>(async () => '5\tx')
    expect(await lastCommitOf(`/home/a${delimiter}b/repo`, read, {})).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('drops bidirectional and other format characters from a subject', async () => {
    expect((await lastCommitOf('/r', async () => '5\tfix \u202Egnp.exe\u200B\u2066x', {}))?.subject).toBe('fix gnp.exex')
  })

  it('cuts a long subject', async () => {
    const found = await lastCommitOf('/r', async () => `0\t${'x'.repeat(MAX_COMMIT_SUBJECT + 50)}`, {})
    expect(found?.subject).toHaveLength(MAX_COMMIT_SUBJECT)
  })

  it.each([['no output', undefined], ['empty output', ''], ['an unreadable time', 'soon\tx'], ['an empty subject', '5\t \u0007']])('gives nothing for %s', async (_, output) => {
    expect(await lastCommitOf('/r', async () => output, {})).toBeUndefined()
  })
})

describe('the limit on Git runs', () => {
  it('never has more than the limit in flight, runs every queued request and refuses past the queue', async () => {
    let active = 0
    let peak = 0
    const gates: (() => void)[] = []
    const read = limitGit(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => { gates.push(resolve) })
      active -= 1
      return 'done'
    }, 3, 4)
    const answers = Array.from({ length: 10 }, () => read([], {}))
    // Three run, four wait, three are refused at once.
    await Promise.resolve()
    expect(await Promise.all(answers.slice(7))).toEqual([undefined, undefined, undefined])
    while (gates.length > 0 || active > 0) {
      gates.shift()?.()
      await Promise.resolve()
    }
    expect((await Promise.all(answers)).filter(each => each === 'done')).toHaveLength(7)
    expect(peak).toBe(3)
    expect(await limitGit(async () => 'again', 3, 4)([], {})).toBe('again')
  })

  it('frees the place when a run throws', async () => {
    const read = limitGit(async () => { throw new Error('boom') }, 1, 1)
    await expect(read([], {})).rejects.toThrow('boom')
    await expect(read([], {})).rejects.toThrow('boom')
  })
})
