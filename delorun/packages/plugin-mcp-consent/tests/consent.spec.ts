/**
 * Specs of `@delorun/plugin-mcp-consent`: the acceptance store's file handling
 * and the `mcpAddConsent` provider's reviews — an accepted start allowed
 * without asking, a changed command, argument list, working directory,
 * environment, resolved executable path, command shell or resolved working
 * directory asked again, a missing, malformed or other-version store asked
 * again, and every registration behind the switch.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { apply as startServer, McpConsentRefusedError } from '@deepseek-ai/dsh-mcp-client'
import { MCP_ADD_CONSENT_PROVIDER_EXPORT } from '@deepseek-ai/dsh-mcp-client/consent'
import type { Config as McpClientConfig, McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { currentHolder, randomLockId } from '@delorun/home'
import * as McpConsentPlugin from '../src/index.ts'
import { pinsOf, type PinnedStart } from '../src/pins.ts'
import { DelorunMcpConsent, Config, acceptHint, apply } from '../src/index.ts'
import {
  AcceptanceStoreError,
  acceptanceOfStart,
  acceptanceStorePath,
  EMPTY_ACCEPTANCE_STORE,
  envDigests,
  parseAcceptanceStore,
  serializeAcceptanceStore,
  startDigest,
  withAcceptanceStoreLock,
} from '../src/store.ts'

/**
 * A private root that holds every executable and working directory the suite's starts name, because a review pins the
 * files a start runs: `usr/local/bin/npx`, `srv/mcp/node_modules/.bin/npx`, `Program Files/nodejs/npx.cmd`,
 * `usr/bin/uvx` and `usr/bin/other-command`, and the directories `srv/mcp` and `srv/other`.
 */
const FIX = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-mcp-consent-files-')))
for (const file of ['usr/local/bin/npx', 'srv/mcp/node_modules/.bin/npx', 'Program Files/nodejs/npx.cmd', 'usr/bin/uvx', 'usr/bin/other-command']) {
  mkdirSync(join(FIX, file, '..'), { recursive: true })
  writeFileSync(join(FIX, file), `#!/bin/sh\n# ${file}\n`, { mode: 0o755 })
}
mkdirSync(join(FIX, 'srv', 'other'))
afterAll(() => { rmSync(FIX, { recursive: true, force: true }) })

/** The secret value of the suite's configured environment, which no store text or reason may hold. */
const SECRET = 'secret-token-value'

/** The clause every refusal of the suite's server ends with, naming where the person accepts it. */
const HINT = acceptHint('srv')

/** The server start every review of the suite judges. */
const COMMAND: McpServerCommand = {
  serverName: 'srv',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'],
  env: { API_TOKEN: SECRET, NODE_ENV: 'production' },
  cwd: `${FIX}/srv/mcp`,
  resolvedCommand: `${FIX}/usr/local/bin/npx`,
  resolvedCwd: `${FIX}/srv/mcp`,
}

/** A Windows batch shim's start: the `.cmd` file and the canonical `COMSPEC` that runs it. */
const SHIM: McpServerCommand = {
  ...COMMAND,
  resolvedCommand: `${FIX}/Program Files/nodejs/npx.cmd`,
  resolvedShell: `${FIX}/Windows/System32/cmd.exe`,
}

/**
 * The words of a refusal of a store of another version.
 * @param version - the store's version.
 * @param path - the store's path.
 * @returns the reason.
 */
function otherVersionReason(version: number, path: string): string {
  return `the acceptance store could not be read, so nothing counts as accepted (the store's version is ${String(version)}, not 7; fix or remove ${JSON.stringify(path)}, then accept each MCP server again)${HINT}`
}

/**
 * A start with the files it runs, pinned as a review pins them.
 * @param start - the start.
 * @returns the start and its pinned files.
 */
async function pinned(start: McpServerCommand): Promise<PinnedStart> {
  return { ...start, files: await pinsOf(start) }
}

/**
 * The text of a valid store holding the acceptance of one start, its files pinned as they are now.
 * @param start - the accepted start.
 * @returns the store's text.
 */
async function acceptedStore(start: McpServerCommand): Promise<string> {
  return serializeAcceptanceStore({ ...EMPTY_ACCEPTANCE_STORE, acceptances: new Map([[start.serverName, acceptanceOfStart(await pinned(start), 1_700_000_000_000)]]) })
}

/** A pinned executable for the format specs. */
const TOOL_FILE = { path: '/usr/bin/tool', sha256: `sha256:${'0'.repeat(64)}` }

/**
 * One acceptance in the store's format, for the format specs.
 * @param args - the accepted arguments.
 * @param acceptedAt - the acceptance time.
 * @returns the acceptance.
 */
function acceptance(args: readonly string[], acceptedAt: number) {
  return { command: 'npx', args, cwd: '', resolvedCommand: '/usr/bin/tool', resolvedCwd: '/home/person', env: {}, files: [TOOL_FILE], acceptedAt }
}

describe('the acceptance store path', () => {
  it('sits under the home\'s protected state, in the plugin\'s own directory', () => {
    expect(acceptanceStorePath('/home/person/.delorun')).toBe('/home/person/.delorun/secrets/mcp-add-consent/acceptances.json')
  })
})

describe('the acceptance store format', () => {
  it('round-trips the acceptances by server name and the set-aside starts, sorted, with a trailing newline', () => {
    const store = {
      acceptances: new Map([['zed', acceptance(['-y', 'z'], 2)], ['alpha', acceptance(['-a'], 1)]]),
      setAside: new Map([['beta', { state: 'declined' as const, start: startDigest({ ...COMMAND, files: [] }) }]]),
    }
    const text = serializeAcceptanceStore(store)
    expect(text).toBe(`${JSON.stringify({
      v: 7,
      acceptances: { alpha: acceptance(['-a'], 1), zed: acceptance(['-y', 'z'], 2) },
      setAside: { beta: { state: 'declined', start: startDigest({ ...COMMAND, files: [] }) } },
    }, null, 2)}\n`)
    expect(parseAcceptanceStore(text)).toEqual(store)
  })

  it('keeps a digest of each environment variable, never a value, and the pinned executable', async () => {
    const text = await acceptedStore(COMMAND)
    expect(text).not.toContain(SECRET)
    expect(parseAcceptanceStore(text).acceptances.get('srv')).toEqual({
      command: 'npx',
      args: COMMAND.args,
      cwd: `${FIX}/srv/mcp`,
      resolvedCommand: `${FIX}/usr/local/bin/npx`,
      resolvedCwd: `${FIX}/srv/mcp`,
      env: { API_TOKEN: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), NODE_ENV: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
      files: [{ path: `${FIX}/usr/local/bin/npx`, sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }],
      acceptedAt: 1_700_000_000_000,
    })
  })

  it('keeps the command shell of a batch file, and writes none for an executable that runs directly', async () => {
    expect(parseAcceptanceStore(await acceptedStore(SHIM)).acceptances.get('srv')).toMatchObject({ resolvedShell: `${FIX}/Windows/System32/cmd.exe` })
    expect(await acceptedStore(COMMAND)).not.toContain('resolvedShell')
    expect(parseAcceptanceStore(await acceptedStore(COMMAND)).acceptances.get('srv')).not.toHaveProperty('resolvedShell')
  })

  it('digests an environment the same whatever order its keys were written in, one digest per variable', () => {
    expect(envDigests({ B: '2', A: '1' })).toEqual(envDigests({ A: '1', B: '2' }))
    expect(envDigests({ A: '1', B: '2' })['A']).toBe(envDigests({ A: '1', B: '3' })['A'])
    expect(envDigests({ A: '1', B: '2' })['B']).not.toBe(envDigests({ A: '1', B: '3' })['B'])
  })

  it('refuses a store of every other version, whatever it holds', () => {
    for (const version of [1, 2, 3, 4, 5, 8, '6', '7', null]) {
      const text = JSON.stringify({ v: version, acceptances: {}, setAside: {} })
      expect(() => parseAcceptanceStore(text)).toThrow(AcceptanceStoreError)
      expect(() => parseAcceptanceStore(text)).toThrow(`the store's version is ${JSON.stringify(version)}, not 7`)
    }
  })

  it('refuses a document that is not this version\'s format', () => {
    const valid = acceptance(['-y'], 1)
    const store = (acceptances: object, more: object = {}) => JSON.stringify({ v: 7, acceptances, setAside: {}, ...more })
    for (const [text, problem] of [
      ['{', 'no JSON document'],
      ['[]', 'not a JSON object'],
      [JSON.stringify({ v: 8, acceptances: {} }), 'the store\'s version is 8, not 7'],
      [store({}, { extra: true }), 'the store sets extra'],
      [JSON.stringify({ v: 7, acceptances: {} }), 'the store does not hold a setAside object'],
      [store({}, { commandKeyed: {} }), 'the store sets commandKeyed'],
      [store({ srv: { ...valid, files: [] } }), 'the acceptance of the server "srv" does not hold a list of pinned files'],
      [store({ srv: { ...valid, files: 'tool' } }), 'does not hold a list of pinned files'],
      [store({ srv: { ...valid, files: [{ ...TOOL_FILE, argument: 0 }] } }), 'does not pin the executable first and then arguments by their index'],
      [store({ srv: { ...valid, files: [TOOL_FILE, TOOL_FILE] } }), 'does not pin the executable first and then arguments by their index'],
      [store({ srv: { ...valid, files: [TOOL_FILE, { ...TOOL_FILE, argument: -1 }] } }), 'does not pin the executable first and then arguments by their index'],
      [store({ srv: { ...valid, files: [TOOL_FILE, { ...TOOL_FILE, argument: 1.5 }] } }), 'does not pin the executable first and then arguments by their index'],
      [store({ srv: { ...valid, files: [{ ...TOOL_FILE, path: 'tool' }] } }), 'pins a file without an absolute path'],
      [store({ srv: { ...valid, files: [{ ...TOOL_FILE, sha256: 'x' }] } }), 'pins a file without a sha256 digest'],
      [store({ srv: { ...valid, files: [{ ...TOOL_FILE, size: 1 }] } }), 'a pinned file of the acceptance of the server "srv" sets size'],
      [store({ srv: { ...valid, extra: true } }), 'the acceptance of the server "srv" sets extra'],
      [store({ srv: { ...valid, acceptedAt: 'now' } }), 'the acceptance of the server "srv" does not hold a number acceptance time'],
      [store({ srv: { ...valid, command: '' } }), 'the acceptance of the server "srv" does not hold a command'],
      [store({ srv: { ...valid, cwd: 1 } }), 'the acceptance of the server "srv" does not hold a working directory string'],
      [store({ srv: 'npx' }), 'the acceptance of the server "srv" is not an object'],
      [store({ srv: { ...valid, args: '-y' } }), 'the acceptance of the server "srv" does not hold a list of argument strings'],
      [store({ srv: { ...valid, resolvedCommand: 'npx' } }), 'the acceptance of the server "srv" does not hold an absolute resolved executable path'],
      [store({ srv: { ...valid, resolvedCwd: undefined } }), 'the acceptance of the server "srv" does not hold an absolute resolved working directory'],
      [store({ srv: { ...valid, resolvedShell: 'cmd.exe' } }), 'the acceptance of the server "srv" does not hold an absolute resolved command shell'],
      [store({ srv: { ...valid, resolvedShell: null } }), 'the acceptance of the server "srv" does not hold an absolute resolved command shell'],
      [store({ srv: { ...valid, env: { PATH: '/bin' } } }), 'the acceptance of the server "srv" does not hold a sha256 digest for each environment variable'],
      [store({ '../srv': valid }), 'which is not a server name'],
      [store({}, { setAside: { srv: { state: 'waiting', start: startDigest({ ...COMMAND, files: [] }) } } }), 'does not hold the state declined or revoked'],
      [store({}, { setAside: { srv: { state: 'declined', start: 'x' } } }), 'does not hold a sha256 start digest'],
    ] as const) {
      expect(() => parseAcceptanceStore(text)).toThrow(AcceptanceStoreError)
      expect(() => parseAcceptanceStore(text)).toThrow(problem)
    }
  })
})

describe('the acceptance store lock', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'delorun-mcp-store-lock-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a change while a live process holds the lock past the wait, changing nothing, and replaces a dead holder\'s lock', async () => {
    const path = acceptanceStorePath(root)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(`${path}.lock`, JSON.stringify({ v: 1, ...currentHolder(), id: randomLockId() }), { mode: 0o600 })
    const change = vi.fn(async () => 'changed')
    await expect(withAcceptanceStoreLock(path, change, 30)).rejects.toThrow(new AcceptanceStoreError(`process ${String(process.pid)} has been changing the MCP acceptance store for longer than 0.03 seconds, so nothing was changed; try again once it finishes`))
    expect(change).not.toHaveBeenCalled()
    // A process id that no running process has.
    writeFileSync(`${path}.lock`, JSON.stringify({ v: 1, pid: 2 ** 22 + 7, id: randomLockId() }), { mode: 0o600 })
    await expect(withAcceptanceStoreLock(path, change, 1000)).resolves.toBe('changed')
    expect(existsSync(`${path}.lock`)).toBe(false)
  })

  it('refuses a change while the lock file holds no lock record, changing nothing', async () => {
    const path = acceptanceStorePath(root)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(`${path}.lock`, JSON.stringify({ v: 2, ...currentHolder(), id: randomLockId() }), { mode: 0o600 })
    const change = vi.fn(async () => 'changed')
    await expect(withAcceptanceStoreLock(path, change, 30)).rejects.toThrow()
    expect(change).not.toHaveBeenCalled()
  })
})

describe('the mcpAddConsent provider', () => {
  let root: string
  let home: string
  let ctx: Context
  let consent: DelorunMcpConsent

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'delorun-mcp-consent-'))
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    vi.stubEnv('DELORUN_HOME', home)
    ctx = new Context()
    consent = new DelorunMcpConsent(ctx)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * The store's path in the suite's home.
   * @returns the absolute path.
   */
  function store(): string {
    return acceptanceStorePath(home)
  }

  /**
   * Write the store's file with the protected mode, creating its directory.
   * @param text - the file's text.
   * @returns the path written.
   */
  function writeStore(text: string): string {
    const path = store()
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, text, { mode: 0o600 })
    return path
  }

  it('allows an accepted start without asking', async () => {
    writeStore(await acceptedStore(COMMAND))
    await expect(consent.review(COMMAND)).resolves.toMatchObject({ allow: true })
  })

  it('allows an accepted start whatever order its environment keys were written in', async () => {
    writeStore(await acceptedStore(COMMAND))
    await expect(consent.review({ ...COMMAND, env: { NODE_ENV: 'production', API_TOKEN: SECRET } })).resolves.toMatchObject({ allow: true })
  })

  it('does not allow the same start under another server name', async () => {
    writeStore(await acceptedStore(COMMAND))
    await expect(consent.review({ ...COMMAND, serverName: 'other' })).resolves.toEqual({
      allow: false,
      reason: `the acceptance store holds no acceptance for this server${acceptHint('other')}`,
    })
  })

  it('asks again when the command or the arguments changed', async () => {
    writeStore(await acceptedStore({ ...COMMAND, args: ['-y', '@modelcontextprotocol/server-fs', '/elsewhere'] }))
    await expect(consent.review(COMMAND)).resolves.toEqual({
      allow: false,
      reason: `the person accepted a different argument list for this server${HINT}`,
    })
    await expect(consent.review({ ...COMMAND, command: 'uvx' })).resolves.toEqual({
      allow: false,
      reason: `the person accepted a different command for this server${HINT}`,
    })
  })

  it('asks again when an accepted server\'s environment changed, naming the variables but no value', async () => {
    writeStore(await acceptedStore(COMMAND))
    for (const [env, names] of [
      [{ ...COMMAND.env, NODE_OPTIONS: '--require /tmp/hook.js' }, 'NODE_OPTIONS'],
      [{ ...COMMAND.env, API_TOKEN: 'another-token' }, 'API_TOKEN'],
      [{ NODE_ENV: 'production' }, 'API_TOKEN'],
      [{}, 'API_TOKEN, NODE_ENV'],
    ] as const) {
      const decision = await consent.review({ ...COMMAND, env })
      expect(decision).toEqual({ allow: false, reason: `the person accepted this server with different environment variables or values (${names})${HINT}` })
      expect(JSON.stringify(decision)).not.toContain(SECRET)
      expect(JSON.stringify(decision)).not.toContain('hook.js')
    }
  })

  it('asks again when an accepted server\'s working directory changed', async () => {
    writeStore(await acceptedStore(COMMAND))
    for (const cwd of [`${FIX}/srv/other`, '']) {
      await expect(consent.review({ ...COMMAND, cwd })).resolves.toEqual({
        allow: false,
        reason: `the person accepted this server with a different working directory${HINT}`,
      })
    }
  })

  it('asks again when an accepted server resolves to another executable or working directory, naming both paths', async () => {
    writeStore(await acceptedStore(COMMAND))
    await expect(consent.review({ ...COMMAND, resolvedCommand: `${FIX}/srv/mcp/node_modules/.bin/npx` })).resolves.toEqual({
      allow: false,
      reason: `the command resolves to the executable "${FIX}/srv/mcp/node_modules/.bin/npx", and the person accepted "${FIX}/usr/local/bin/npx"${HINT}`,
    })
    await expect(consent.review({ ...COMMAND, resolvedCwd: `${FIX}/srv/other` })).resolves.toEqual({
      allow: false,
      reason: `the working directory resolves to "${FIX}/srv/other", and the person accepted this server run in "${FIX}/srv/mcp"${HINT}`,
    })
  })

  it('asks again when an accepted batch file now runs through another command shell, or through none', async () => {
    writeStore(await acceptedStore(SHIM))
    await expect(consent.review(SHIM)).resolves.toMatchObject({ allow: true })
    await expect(consent.review({ ...SHIM, resolvedShell: `${FIX}/Users/person/cmd.exe` })).resolves.toEqual({
      allow: false,
      reason: `the command runs through the command shell "${FIX}/Users/person/cmd.exe", and the person accepted it run through the command shell "${FIX}/Windows/System32/cmd.exe"${HINT}`,
    })
    const { resolvedShell: _shell, ...direct } = SHIM
    await expect(consent.review(direct)).resolves.toEqual({
      allow: false,
      reason: `the command runs through no command shell, and the person accepted it run through the command shell "${FIX}/Windows/System32/cmd.exe"${HINT}`,
    })
  })

  it('does not honour a store of another version, even for the exact start it accepted, and names what to do', async () => {
    const accepted = acceptanceOfStart(await pinned(COMMAND), 1)
    for (const version of [1, 5, 8]) {
      const path = writeStore(JSON.stringify({ v: version, acceptances: { srv: accepted }, setAside: {} }))
      await expect(consent.review(COMMAND)).resolves.toEqual({ allow: false, reason: otherVersionReason(version, path) })
      expect(consent.pending()[0]?.change).toBe('unreadable')
    }
  })

  it('records nothing into a store of another version, and asks the person to fix or remove it', async () => {
    const text = JSON.stringify({ v: 5, acceptances: {}, setAside: {} })
    const path = writeStore(text)
    await expect(consent.accept(COMMAND)).rejects.toThrow(`the acceptance store is refused, so nothing is recorded: the store's version is 5, not 7; fix or remove ${JSON.stringify(path)}, then accept each MCP server again`)
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('asks again for a server the store holds no acceptance for', async () => {
    writeStore(await acceptedStore({ serverName: 'another', command: 'other-command', args: [], env: {}, cwd: '', resolvedCommand: `${FIX}/usr/bin/other-command`, resolvedCwd: '/' }))
    await expect(consent.review(COMMAND)).resolves.toEqual({
      allow: false,
      reason: `the acceptance store holds no acceptance for this server${HINT}`,
    })
  })

  it('asks while no store exists', async () => {
    await expect(consent.review(COMMAND)).resolves.toEqual({
      allow: false,
      reason: `no server is accepted yet (the acceptance store does not exist)${HINT}`,
    })
  })

  it('asks again while the store is malformed, even for an entry that looks like the acceptance', async () => {
    for (const text of [
      '{ not json',
      '[]',
      JSON.stringify({ v: 7, acceptances: { srv: acceptanceOfStart(await pinned(COMMAND), 1) } }),
      JSON.stringify({ v: 7, acceptances: { srv: { ...acceptanceOfStart(await pinned(COMMAND), 1), note: 'x' } }, setAside: {} }),
      JSON.stringify({ v: 7, acceptances: { srv: { ...acceptanceOfStart(await pinned(COMMAND), 1), resolvedCommand: 'npx' } }, setAside: {} }),
    ]) {
      writeStore(text)
      await expect(consent.review(COMMAND)).resolves.toSatisfy((decision: { allow: boolean, reason: string }) =>
        decision.allow === false && decision.reason.startsWith('the acceptance store could not be read'))
    }
  })

  it('asks again while the store is laxer than the protected mode or not a regular file', async () => {
    const path = writeStore(await acceptedStore(COMMAND))
    chmodSync(path, 0o644)
    await expect(consent.review(COMMAND)).resolves.toSatisfy((decision: { allow: boolean, reason: string }) =>
      decision.allow === false && decision.reason.includes('the acceptance store could not be read'))
    rmSync(path)
    symlinkSync(join(root, 'elsewhere.json'), path)
    expect(readlinkSync(path)).toBe(join(root, 'elsewhere.json'))
    await expect(consent.review(COMMAND)).resolves.toSatisfy((decision: { allow: boolean, reason: string }) =>
      decision.allow === false && decision.reason.includes('the acceptance store could not be read'))
  })

  it('asks again when the home cannot be resolved', async () => {
    // Upstream's ~/.dsh under the real OS home is a home resolveDelorunHome refuses (contract C1's HOME_IS_DSH_HOME),
    // so the review cannot read any store and asks again.
    vi.stubEnv('DELORUN_HOME', join(homedir(), '.dsh'))
    await expect(consent.review(COMMAND)).resolves.toSatisfy((decision: { allow: boolean, reason: string }) =>
      decision.allow === false && decision.reason.startsWith('the Delorun home could not be resolved'))
  })

  it('records an acceptance that a later review allows without asking', async () => {
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: false, reason: `no server is accepted yet (the acceptance store does not exist)${HINT}` })
    await consent.accept(COMMAND)
    const path = store()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..'), ).mode & 0o777).toBe(0o700)
    // The time itself is the recording's, so the parse is what the check reads.
    expect(parseAcceptanceStore(readFileSync(path, 'utf8')).acceptances.get('srv')).toEqual({ ...acceptanceOfStart(await pinned(COMMAND), 0, 'unknown'), acceptedAt: expect.any(Number) })
    expect(readFileSync(path, 'utf8')).not.toContain(SECRET)
    await expect(consent.review(COMMAND)).resolves.toMatchObject({ allow: true })
  })

  it('grants a changed start by accepting it again, which replaces the server\'s acceptance', async () => {
    await consent.accept(COMMAND)
    const changed = { ...COMMAND, args: ['-y', '@modelcontextprotocol/server-fs', '/elsewhere'] }
    await expect(consent.review(changed)).resolves.toEqual({ allow: false, reason: `the person accepted a different argument list for this server${HINT}` })
    await consent.accept(changed)
    await expect(consent.review(changed)).resolves.toMatchObject({ allow: true })
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: false, reason: `the person accepted a different argument list for this server${HINT}` })
    expect([...parseAcceptanceStore(readFileSync(store(), 'utf8')).acceptances.keys()]).toEqual(['srv'])
  })

  it('refuses to accept into a store that is not this version\'s format, and leaves it unchanged', async () => {
    const path = writeStore('{ not json')
    await expect(consent.accept(COMMAND)).rejects.toThrow(/the acceptance store is refused/)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
    expect(existsSync(`${path}.tmp-`)).toBe(false)
  })

  it('refuses an empty command', async () => {
    await expect(consent.accept({ ...COMMAND, command: '' })).rejects.toThrow('the command to accept is empty')
  })

  it('refuses a start whose resolved paths are not absolute, and records nothing', async () => {
    for (const start of [{ ...COMMAND, resolvedCommand: 'npx' }, { ...COMMAND, resolvedCwd: 'srv/mcp' }, { ...SHIM, resolvedShell: 'cmd.exe' }]) {
      await expect(consent.accept(start)).rejects.toThrow('the start to accept holds a resolved path that is not absolute')
    }
    expect(existsSync(store())).toBe(false)
  })
})

describe('a server start the mcp-client resolves before the review', () => {
  let root: string
  let a: string
  let b: string
  let hostCwd: MockInstance<() => string>
  let ctx: Context
  let consent: DelorunMcpConsent

  /** A stdio server whose bare command `tool` is looked up on the Host's PATH, run in the Host's working directory. */
  const server: McpClientConfig = {
    transport: 'stdio',
    serverName: 'srv',
    command: 'tool',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 1_000,
    closeTimeoutMs: 5_000,
    expandTemplates: false,
    failOnStartupError: true,
  }

  beforeEach(() => {
    // Two directories, each with an executable `bin/tool`; the Host runs in `a` with `a/bin` first on its PATH.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-mcp-consent-start-')))
    a = join(root, 'a')
    b = join(root, 'b')
    for (const dir of [a, b]) {
      mkdirSync(join(dir, 'bin'), { recursive: true })
      writeFileSync(join(dir, 'bin', 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    mkdirSync(join(root, 'home'))
    vi.stubEnv('DELORUN_HOME', join(root, 'home'))
    vi.stubEnv('PATH', `${join(a, 'bin')}:${join(b, 'bin')}`)
    hostCwd = vi.spyOn(process, 'cwd').mockReturnValue(a)
    ctx = new Context()
    consent = new DelorunMcpConsent(ctx)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * Start the server once through the mcp-client, expecting the consent to refuse it, and accept the start the
   * refused review was shown, as the asking surface does.
   * @returns the accepted start.
   */
  async function acceptFirstStart(): Promise<McpServerCommand> {
    const review = vi.spyOn(consent, 'review')
    await expect(startServer(ctx, server)).rejects.toBeInstanceOf(McpConsentRefusedError)
    const start = review.mock.calls[0]?.[0]
    review.mockRestore()
    if (start === undefined) throw new Error('the mcp-client did not ask for a review')
    await consent.accept(start)
    await expect(consent.review(start)).resolves.toMatchObject({ allow: true })
    return start
  }

  it('records the executable and working directory the start resolved to', async () => {
    const start = await acceptFirstStart()
    expect(start).toMatchObject({ command: 'tool', cwd: '', resolvedCommand: join(a, 'bin', 'tool'), resolvedCwd: a })
    expect(parseAcceptanceStore(readFileSync(acceptanceStorePath(join(root, 'home')), 'utf8')).acceptances.get('srv'))
      .toMatchObject({ cwd: '', resolvedCommand: join(a, 'bin', 'tool'), resolvedCwd: a })
  })

  it('asks again when the accepted bare command now resolves to another executable on PATH', async () => {
    await acceptFirstStart()
    vi.stubEnv('PATH', `${join(b, 'bin')}:${join(a, 'bin')}`)

    const failure: unknown = await startServer(ctx, server).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(McpConsentRefusedError)
    expect(failure).toMatchObject({
      resolvedCommand: join(b, 'bin', 'tool'),
      reason: `the command resolves to the executable ${JSON.stringify(join(b, 'bin', 'tool'))}, and the person accepted ${JSON.stringify(join(a, 'bin', 'tool'))}${HINT}`,
    })
    expect((failure as Error).message).toContain(`which runs the executable ${JSON.stringify(join(b, 'bin', 'tool'))}`)
  })

  it('asks again when the accepted empty working directory resolves elsewhere because the Host runs in another directory', async () => {
    await acceptFirstStart()
    hostCwd.mockReturnValue(b)

    const failure: unknown = await startServer(ctx, server).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(McpConsentRefusedError)
    expect(failure).toMatchObject({
      resolvedCwd: b,
      reason: `the working directory resolves to ${JSON.stringify(b)}, and the person accepted this server run in ${JSON.stringify(a)}${HINT}`,
    })
  })
})

describe('the mcp_add_consent switch', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('defaults to off, the parity value', () => {
    expect(Config()).toEqual({ enabled: false, ask: 'outside' })
  })

  it('registers nothing while off', () => {
    apply(ctx, { enabled: false, ask: 'outside' })
    expect(ctx.get('mcpAddConsent')).toBeUndefined()
  })

  it('declares itself an mcpAddConsent provider, so an mcp-client row waits for its row', () => {
    expect(Reflect.get(McpConsentPlugin, MCP_ADD_CONSENT_PROVIDER_EXPORT)).toBe(true)
  })

  it('mounts the consent service while on', async () => {
    // The mount is a plugin fiber, so apply settles only once the service is registered.
    await apply(ctx, { enabled: true, ask: 'outside' })
    expect(ctx.get('mcpAddConsent')).toBeInstanceOf(DelorunMcpConsent)
  })
})
