import { Module } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locateClaudeProgram, locateClaudeSdk, locateCodex, locatePack, locatePackage, loginProgramFor } from '../src/locate.ts'

const roots: string[] = []
const nodePath = process.env.NODE_PATH
// Resolution also searches NODE_PATH; without it only the profile's own packages can be found.
function refreshSearchPaths(): void {
  const initialise: unknown = Reflect.get(Module, '_initPaths')
  if (typeof initialise === 'function') initialise.call(Module)
}
beforeEach(() => {
  delete process.env.NODE_PATH
  refreshSearchPaths()
})
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
  const root = mkdtempSync(join(tmpdir(), 'delorun-locate-'))
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

const CLAUDE_PACK = '@deepseek-ai/dsh-subagent-claude-code'
const SDK = `${CLAUDE_PACK}/node_modules/@anthropic-ai/claude-agent-sdk`
const PLATFORM = `${SDK}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64`

/** The pinned SDK's own manifest leaves `./package.json` out of its `exports` map, as 0.3.263 does. */
const CLAUDE_ADDED = {
  [`${CLAUDE_PACK}/package.json`]: manifest(CLAUDE_PACK),
  [`${SDK}/package.json`]: JSON.stringify({
    name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', type: 'module',
    exports: { '.': { types: './sdk.d.ts', default: './sdk.mjs' }, './bridge': { default: './bridge.mjs' } },
  }),
  [`${SDK}/sdk.mjs`]: 'export {}\n',
  [`${PLATFORM}/package.json`]: manifest('@anthropic-ai/claude-agent-sdk-linux-x64', { version: '0.3.263' }),
  [`${PLATFORM}/claude`]: '#!/bin/sh\n',
}
const CODEX_PACK = '@deepseek-ai/dsh-subagent-codex'
const CODEX = `${CODEX_PACK}/node_modules/@openai/codex`
const CODEX_ADDED = {
  [`${CODEX_PACK}/package.json`]: manifest(CODEX_PACK),
  [`${CODEX}/package.json`]: manifest('@openai/codex', { version: '0.153.4', bin: { codex: 'bin/codex.js' } }),
  [`${CODEX}/bin/codex.js`]: '\n',
}

describe('finding a package whose exports leave out its manifest', () => {
  it('finds the folder and version through the main export', () => {
    const dir = profileWith(CLAUDE_ADDED)
    const found = locatePackage(join(dir, 'node_modules', CLAUDE_PACK, 'package.json'), '@anthropic-ai/claude-agent-sdk')
    expect(found).toEqual({ directory: join(dir, 'node_modules', SDK), version: '0.3.263' })
  })

  it('finds a package whose manifest is exported directly', () => {
    const dir = profileWith(CLAUDE_ADDED)
    expect(locatePack('claude-code', dir)).toEqual({ directory: join(dir, 'node_modules', CLAUDE_PACK), version: '1.0.0' })
  })

  it('finds nothing when a package exports neither its manifest nor a main entry', () => {
    const dir = profileWith({
      'only-subpaths/package.json': JSON.stringify({ name: 'only-subpaths', version: '1.0.0', exports: { './a': './a.js' } }),
      'only-subpaths/a.js': '\n',
    })
    expect(locatePackage(join(dir, 'package.json'), 'only-subpaths')).toBeUndefined()
  })
})

describe('finding the Claude Agent SDK and its program', () => {
  it('returns the SDK folder, version and the entry a driver imports', () => {
    const dir = profileWith(CLAUDE_ADDED)
    const sdk = locateClaudeSdk(dir)
    expect(sdk).toEqual({ directory: join(dir, 'node_modules', SDK), version: '0.3.263', entry: join(dir, 'node_modules', SDK, 'sdk.mjs') })
  })

  it('finds the native program in the platform package for this machine only', () => {
    const dir = profileWith(CLAUDE_ADDED)
    const sdk = locateClaudeSdk(dir)
    if (sdk === undefined) throw new Error('the fixture SDK was not found')
    expect(locateClaudeProgram(sdk, LINUX)).toBe(join(dir, 'node_modules', PLATFORM, 'claude'))
    expect(locateClaudeProgram(sdk, { platform: 'linux', arch: 'arm64' })).toBeUndefined()
  })

  it('finds no SDK when the pack is not added', () => {
    expect(locateClaudeSdk(profileWith({}))).toBeUndefined()
    expect(locateClaudeSdk(profileWith({ [`${CLAUDE_PACK}/package.json`]: manifest(CLAUDE_PACK) }))).toBeUndefined()
  })
})

describe('finding the Codex launcher', () => {
  it('returns the launcher script and the pinned version', () => {
    const dir = profileWith(CODEX_ADDED)
    expect(locateCodex(dir)).toEqual({ directory: join(dir, 'node_modules', CODEX), version: '0.153.4', script: join(dir, 'node_modules', CODEX, 'bin', 'codex.js') })
  })

  it('finds nothing without a codex bin or its script', () => {
    expect(locateCodex(profileWith({ ...CODEX_ADDED, [`${CODEX}/package.json`]: manifest('@openai/codex') }))).toBeUndefined()
    const { [`${CODEX}/bin/codex.js`]: _script, ...withoutScript } = CODEX_ADDED
    expect(locateCodex(profileWith(withoutScript))).toBeUndefined()
  })
})

describe('finding an added agent\'s sign-in program', () => {
  it('runs the bundled claude with auth login', () => {
    const found = loginProgramFor('claude-code', profileWith(CLAUDE_ADDED), LINUX)
    expect(found?.args).toEqual(['auth', 'login'])
    expect(found?.program).toMatch(/claude-agent-sdk-linux-x64\/claude$/)
  })

  it('runs the bundled codex launcher with login under this Node', () => {
    const found = loginProgramFor('codex', profileWith(CODEX_ADDED), LINUX)
    expect(found?.program).toBe(process.execPath)
    expect(found?.args[0]).toMatch(/@openai\/codex\/bin\/codex\.js$/)
    expect(found?.args[1]).toBe('login')
  })

  it('finds nothing when the agent is not added, or its program is missing', () => {
    expect(loginProgramFor('codex', profileWith({}), LINUX)).toBeUndefined()
    expect(loginProgramFor('claude-code', profileWith({ [`${CLAUDE_PACK}/package.json`]: manifest('x') }), LINUX)).toBeUndefined()
    expect(loginProgramFor('claude-code', profileWith(CLAUDE_ADDED), { platform: 'linux', arch: 'arm64' })).toBeUndefined()
  })
})
