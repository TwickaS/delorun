/** Project facts: stacks from marker names, and the latest commit parsed from one bounded Git run. */
import { describe, expect, it, vi } from 'vitest'
import { lastCommitOf, stacksOf } from '../src/project-facts.ts'
import { MAX_COMMIT_SUBJECT } from '../src/wire.ts'

describe('the stacks of a folder', () => {
  it('maps each marker to one stack and ignores other names, including inherited property names', () => {
    expect(stacksOf(['Cargo.toml', 'README.md', 'pom.xml', 'build.gradle.kts', 'toString', 'a.sln', 'mix.exs', 'Package.swift', 'Gemfile', 'composer.json', 'CMakeLists.txt', 'deno.jsonc']))
      .toEqual(['deno', 'rust', 'java', 'ruby', 'php', 'dotnet', 'swift', 'elixir', 'cpp'])
  })
})

describe('the latest commit', () => {
  it('parses the time and subject, and drops control characters', async () => {
    const read = vi.fn(async () => '86400\tfix:\u001b[31m red\u0007 text\n')
    expect(await lastCommitOf('/r', read, { PATH: '/bin', HOME: '/h', SECRET: 'no' })).toEqual({ subject: 'fix:[31m red text', at: '1970-01-02T00:00:00.000Z' })
    const [args, env] = read.mock.calls[0] as unknown as [string[], Record<string, string>]
    expect(args).toEqual(expect.arrayContaining(['-c', 'core.fsmonitor=false', '-C', '/r', 'log', '-1', '--no-show-signature']))
    expect(env).toEqual({ GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', PATH: '/bin', HOME: '/h' })
  })

  it('cuts a long subject', async () => {
    const found = await lastCommitOf('/r', async () => `0\t${'x'.repeat(MAX_COMMIT_SUBJECT + 50)}`, {})
    expect(found?.subject).toHaveLength(MAX_COMMIT_SUBJECT)
  })

  it.each([['no output', undefined], ['empty output', ''], ['an unreadable time', 'soon\tx'], ['an empty subject', '5\t \u0007']])('gives nothing for %s', async (_, output) => {
    expect(await lastCommitOf('/r', async () => output, {})).toBeUndefined()
  })
})
