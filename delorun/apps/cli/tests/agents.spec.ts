import { Module } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentsCommand, type AgentsDependencies } from '../src/agents/command.ts'
import { loginProgramFor } from '../src/agents/resolve.ts'
import { CliError, EXIT } from '../src/exit.ts'

const roots: string[] = []
const nodePath = process.env.NODE_PATH
// Resolution also searches NODE_PATH; without it only the profile's own packages can be found.
function refreshSearchPaths(): void {
  const initialise: unknown = Reflect.get(Module, '_initPaths')
  if (typeof initialise === 'function') initialise.call(Module)
}
function useOnlyTheProfile(): void {
  delete process.env.NODE_PATH
  refreshSearchPaths()
}
beforeEach(useOnlyTheProfile)
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (nodePath !== undefined) process.env.NODE_PATH = nodePath
  refreshSearchPaths()
})

/**
 * @param files - package files by path under the profile's node_modules.
 * @returns a profile directory holding them.
 */
function profileWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'delorun-agents-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), '{}')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, 'node_modules', path, '..'), { recursive: true })
    writeFileSync(join(root, 'node_modules', path), text)
  }
  return root
}

const manifest = (name: string, extra: object = {}): string => JSON.stringify({ name, version: '1.0.0', main: 'index.js', ...extra })
const LINUX = { platform: 'linux', arch: 'x64' } as const

const CLAUDE_ADDED = {
  '@deepseek-ai/dsh-subagent-claude-code/package.json': manifest('@deepseek-ai/dsh-subagent-claude-code'),
  '@deepseek-ai/dsh-subagent-claude-code/node_modules/@anthropic-ai/claude-agent-sdk/package.json': manifest('@anthropic-ai/claude-agent-sdk'),
  '@deepseek-ai/dsh-subagent-claude-code/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json': manifest('@anthropic-ai/claude-agent-sdk-linux-x64'),
  '@deepseek-ai/dsh-subagent-claude-code/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude': '#!/bin/sh\n',
}
const CODEX_ADDED = {
  '@deepseek-ai/dsh-subagent-codex/package.json': manifest('@deepseek-ai/dsh-subagent-codex'),
  '@deepseek-ai/dsh-subagent-codex/node_modules/@openai/codex/package.json': manifest('@openai/codex', { bin: { codex: 'bin/codex.js' } }),
}

describe('finding an added agent\'s sign-in program', () => {
  it('runs the bundled claude with auth login', () => {
    const dir = profileWith(CLAUDE_ADDED)
    const found = loginProgramFor('claude-code', dir, LINUX)
    expect(found?.args).toEqual(['auth', 'login'])
    expect(found?.program).toMatch(/claude-agent-sdk-linux-x64\/claude$/)
  })

  it('runs the bundled codex wrapper with login', () => {
    const dir = profileWith(CODEX_ADDED)
    const found = loginProgramFor('codex', dir, LINUX)
    expect(found?.program).toBe(process.execPath)
    expect(found?.args[0]).toMatch(/@openai\/codex\/bin\/codex\.js$/)
    expect(found?.args[1]).toBe('login')
  })

  it('finds nothing when the agent is not added, or its program is missing', () => {
    expect(loginProgramFor('codex', profileWith({}), LINUX)).toBeUndefined()
    expect(loginProgramFor('claude-code', profileWith({ '@deepseek-ai/dsh-subagent-claude-code/package.json': manifest('x') }), LINUX)).toBeUndefined()
    expect(loginProgramFor('claude-code', profileWith(CLAUDE_ADDED), { platform: 'linux', arch: 'arm64' })).toBeUndefined()
    expect(loginProgramFor('codex', profileWith({ ...CODEX_ADDED, '@deepseek-ai/dsh-subagent-codex/node_modules/@openai/codex/package.json': manifest('@openai/codex') }), LINUX)).toBeUndefined()
  })
})

describe('delorun agents login', () => {
  const run = (args: string[], change: Partial<AgentsDependencies> = {}) => {
    const out: string[] = []
    const dependencies: AgentsDependencies = {
      terminal: true, machine: LINUX,
      find: () => ({ program: '/bundled/claude', args: ['auth', 'login'] }),
      run: vi.fn(() => Promise.resolve(0)),
      ...change,
    }
    const result = createAgentsCommand(dependencies).run(args, { env: { DELORUN_HOME: mkdtempSync(join(tmpdir(), 'delorun-home-')) }, stdout: text => out.push(text), stderr: () => {} })
    return { result, out, dependencies }
  }

  it('runs the found program at a terminal and succeeds when it does', async () => {
    const { result, out, dependencies } = run(['login', 'claude-code'])
    await expect(result).resolves.toBe(EXIT.ok)
    expect(dependencies.run).toHaveBeenCalledExactlyOnceWith({ program: '/bundled/claude', args: ['auth', 'login'] }, expect.any(Object))
    expect(out.join('')).toContain('Signing in to Claude Code')
  })

  it('refuses without a terminal, before looking for anything', async () => {
    const find = vi.fn()
    const { result } = run(['login', 'codex'], { terminal: false, find })
    await expect(result).rejects.toThrow('delorun agents login: this needs you at a terminal to answer; run it in one.')
    expect(find).not.toHaveBeenCalled()
  })

  it('tells the person to add the agent first when it is not added', async () => {
    const { result, dependencies } = run(['login', 'codex'], { find: () => undefined })
    await expect(result).rejects.toThrow('Codex is not added. Add it first, in the Agents step of setup or in Plugins')
    expect(dependencies.run).not.toHaveBeenCalled()
  })

  it('fails with the sign-in program\'s exit code', async () => {
    const { result } = run(['login', 'claude-code'], { run: () => Promise.resolve(2) })
    await expect(result).rejects.toThrow('sign-in ended with exit code 2')
  })

  it.each([[[]], [['login']], [['login', 'gemini']], [['logout', 'codex']], [['login', 'codex', 'extra']]])('is a usage error for %j', async (args) => {
    const { result } = run(args)
    const error: unknown = await result.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exit).toBe(EXIT.usage)
  })

  it('names an unknown agent in one line and offers the two it knows', async () => {
    await expect(run(['login', 'nope']).result).rejects.toThrow('✗ Unknown agent "nope". Choose claude-code or codex.')
  })
})
