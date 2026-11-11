/**
 * Specs of `@delo/plugin-mcp-consent`: the acceptance store's file handling
 * and the `mcpAddConsent` provider's reviews — an accepted start allowed
 * without asking, a changed command, argument list, working directory,
 * environment, resolved executable path, command shell or resolved working
 * directory asked again, a missing, malformed or superseded store asked again, and every
 * registration behind the switch.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { apply as startServer, MCP_ADD_CONSENT_PROVIDER_EXPORT, McpConsentRefusedError } from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig, McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import * as McpConsentPlugin from '../src/index.ts'
import { DeloMcpConsent, Config, apply } from '../src/index.ts'
import {
  AcceptanceStoreError,
  acceptanceOfStart,
  acceptanceStorePath,
  envDigest,
  parseAcceptanceStore,
  serializeAcceptanceStore,
  SupersededStoreError,
} from '../src/store.ts'

/** The secret value of the suite's configured environment, which no store text or reason may hold. */
const SECRET = 'secret-token-value'

/** The server start every review of the suite judges. */
const COMMAND: McpServerCommand = {
  serverName: 'srv',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'],
  env: { API_TOKEN: SECRET, NODE_ENV: 'production' },
  cwd: '/srv/mcp',
  resolvedCommand: '/usr/local/bin/npx',
  resolvedCwd: '/srv/mcp',
}

/** A Windows batch shim's start: the `.cmd` file and the canonical `COMSPEC` that runs it. */
const SHIM: McpServerCommand = {
  ...COMMAND,
  resolvedCommand: '/Program Files/nodejs/npx.cmd',
  resolvedShell: '/Windows/System32/cmd.exe',
}

/**
 * The text of a valid store holding the acceptance of one start.
 * @param start - the accepted start.
 * @returns the store's text.
 */
function acceptedStore(start: Omit<McpServerCommand, 'serverName'>): string {
  return serializeAcceptanceStore(new Map([[start.command, acceptanceOfStart(start, 1_700_000_000_000)]]))
}

/** One acceptance in the store's format, for the format specs. */
function acceptance(args: readonly string[], acceptedAt: number) {
  return { args, cwd: '', resolvedCommand: '/usr/bin/tool', resolvedCwd: '/home/person', envNames: [], envDigest: envDigest({}), acceptedAt }
}

describe('the acceptance store path', () => {
  it('sits under the home\'s protected state, in the plugin\'s own directory', () => {
    expect(acceptanceStorePath('/home/person/.delo')).toBe('/home/person/.delo/secrets/mcp-add-consent/acceptances.json')
  })
})

describe('the acceptance store format', () => {
  it('round-trips the acceptances, sorted by command, with a trailing newline', () => {
    const entries = new Map([
      ['zed', acceptance(['-y', 'z'], 2)],
      ['alpha', acceptance(['-a'], 1)],
    ])
    const text = serializeAcceptanceStore(entries)
    expect(text).toBe(`${JSON.stringify({
      v: 4,
      acceptances: {
        alpha: acceptance(['-a'], 1),
        zed: acceptance(['-y', 'z'], 2),
      },
    }, null, 2)}\n`)
    const parsed = parseAcceptanceStore(text)
    expect(parsed.get('alpha')).toEqual(acceptance(['-a'], 1))
    expect(parsed.get('zed')).toEqual(acceptance(['-y', 'z'], 2))
  })

  it('keeps the environment\'s names and digest, never its values', () => {
    const text = acceptedStore(COMMAND)
    expect(text).not.toContain(SECRET)
    expect(parseAcceptanceStore(text).get('npx')).toEqual({
      args: COMMAND.args,
      cwd: '/srv/mcp',
      resolvedCommand: '/usr/local/bin/npx',
      resolvedCwd: '/srv/mcp',
      envNames: ['API_TOKEN', 'NODE_ENV'],
      envDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      acceptedAt: 1_700_000_000_000,
    })
  })

  it('keeps the command shell of a batch file, and writes none for an executable that runs directly', () => {
    expect(parseAcceptanceStore(acceptedStore(SHIM)).get('npx')).toMatchObject({ resolvedShell: '/Windows/System32/cmd.exe' })
    expect(acceptedStore(COMMAND)).not.toContain('resolvedShell')
    expect(parseAcceptanceStore(acceptedStore(COMMAND)).get('npx')).not.toHaveProperty('resolvedShell')
  })

  it('digests an environment the same whatever order its keys were written in', () => {
    expect(envDigest({ B: '2', A: '1' })).toBe(envDigest({ A: '1', B: '2' }))
    expect(envDigest({ A: '1', B: '2' })).not.toBe(envDigest({ A: '1', B: '3' }))
    expect(envDigest({ A: '1' })).not.toBe(envDigest({ A: '1', B: '' }))
  })

  it('reads a version 1, 2 or 3 store as superseded, whatever it holds', () => {
    for (const [version, text] of [
      [1, JSON.stringify({ v: 1, acceptances: { npx: { args: ['-y'], acceptedAt: 1 } } })],
      [2, JSON.stringify({ v: 2, acceptances: { npx: { args: ['-y'], cwd: '', envNames: [], envDigest: envDigest({}), acceptedAt: 1 } } })],
      [3, JSON.stringify({ v: 3, acceptances: { npx: acceptance(['-y'], 1) } })],
    ] as const) {
      expect(() => parseAcceptanceStore(text)).toThrow(SupersededStoreError)
      expect(() => parseAcceptanceStore(text)).toThrow(`the store's version is ${String(version)}, written before an acceptance covered the resolved executable path, command shell and working directory`)
    }
  })

  it('refuses a document that is not this version\'s format', () => {
    const valid = acceptance(['-y'], 1)
    for (const [text, problem] of [
      ['{', 'no JSON document'],
      ['[]', 'not a JSON object'],
      [JSON.stringify({ v: 5, acceptances: {} }), 'the store\'s version is 5, not 4'],
      [JSON.stringify({ v: 4, acceptances: {}, extra: true }), 'the store sets extra'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, extra: true } } }), 'the acceptance of the command "npx" sets extra'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, acceptedAt: 'now' } } }), 'the acceptance of the command "npx" does not hold a number acceptance time'],
      [JSON.stringify({ v: 4, acceptances: { npx: { args: ['-y'], acceptedAt: 1 } } }), 'the acceptance of the command "npx" does not hold a working directory string'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, resolvedCommand: 'npx' } } }), 'the acceptance of the command "npx" does not hold an absolute resolved executable path'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, resolvedCommand: undefined } } }), 'the acceptance of the command "npx" does not hold an absolute resolved executable path'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, resolvedCwd: '.' } } }), 'the acceptance of the command "npx" does not hold an absolute resolved working directory'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, resolvedCwd: 7 } } }), 'the acceptance of the command "npx" does not hold an absolute resolved working directory'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, resolvedShell: 'cmd.exe' } } }), 'the acceptance of the command "npx" does not hold an absolute resolved command shell'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, resolvedShell: null } } }), 'the acceptance of the command "npx" does not hold an absolute resolved command shell'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, envNames: 'PATH' } } }), 'the acceptance of the command "npx" does not hold a list of environment variable names'],
      [JSON.stringify({ v: 4, acceptances: { npx: { ...valid, envDigest: 'PATH=/bin' } } }), 'the acceptance of the command "npx" does not hold a sha256 environment digest'],
      [JSON.stringify({ v: 4, acceptances: { '': valid } }), 'an empty command'],
    ] as const) {
      expect(() => parseAcceptanceStore(text)).toThrow(AcceptanceStoreError)
      expect(() => parseAcceptanceStore(text)).toThrow(problem)
    }
  })
})

describe('the mcpAddConsent provider', () => {
  let root: string
  let home: string
  let ctx: Context
  let consent: DeloMcpConsent

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'delo-mcp-consent-'))
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    vi.stubEnv('DELO_HOME', home)
    ctx = new Context()
    consent = new DeloMcpConsent(ctx)
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

  it('allows an accepted command without asking', async () => {
    writeStore(acceptedStore(COMMAND))
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: true })
  })

  it('allows an accepted start whatever order its environment keys were written in', async () => {
    writeStore(acceptedStore(COMMAND))
    await expect(consent.review({ ...COMMAND, env: { NODE_ENV: 'production', API_TOKEN: SECRET } })).resolves.toEqual({ allow: true })
  })

  it('asks again when the arguments changed', async () => {
    writeStore(acceptedStore({ ...COMMAND, args: ['-y', '@modelcontextprotocol/server-fs', '/elsewhere'] }))
    await expect(consent.review(COMMAND)).resolves.toEqual({
      allow: false,
      reason: 'the person accepted a different argument list with this command',
    })
  })

  it('asks again when an accepted command\'s environment changed, without naming a value', async () => {
    writeStore(acceptedStore(COMMAND))
    for (const env of [
      { ...COMMAND.env, NODE_OPTIONS: '--require /tmp/hook.js' },
      { ...COMMAND.env, API_TOKEN: 'another-token' },
      { NODE_ENV: 'production' },
      {},
    ]) {
      const decision = await consent.review({ ...COMMAND, env })
      expect(decision).toEqual({ allow: false, reason: 'the person accepted this command with different environment variables or values' })
      expect(JSON.stringify(decision)).not.toContain(SECRET)
    }
  })

  it('asks again when an accepted command\'s working directory changed', async () => {
    writeStore(acceptedStore(COMMAND))
    for (const cwd of ['/srv/other', '']) {
      await expect(consent.review({ ...COMMAND, cwd })).resolves.toEqual({
        allow: false,
        reason: 'the person accepted this command with a different working directory',
      })
    }
  })

  it('asks again when an accepted command resolves to another executable or working directory, naming both paths', async () => {
    writeStore(acceptedStore(COMMAND))
    await expect(consent.review({ ...COMMAND, resolvedCommand: '/srv/mcp/node_modules/.bin/npx' })).resolves.toEqual({
      allow: false,
      reason: 'the command resolves to the executable "/srv/mcp/node_modules/.bin/npx", and the person accepted "/usr/local/bin/npx"',
    })
    await expect(consent.review({ ...COMMAND, resolvedCwd: '/srv/other' })).resolves.toEqual({
      allow: false,
      reason: 'the working directory resolves to "/srv/other", and the person accepted this command run in "/srv/mcp"',
    })
  })

  it('does not honour a version 1 store, even for the exact command and arguments it accepted', async () => {
    writeStore(JSON.stringify({ v: 1, acceptances: { [COMMAND.command]: { args: COMMAND.args, acceptedAt: 1 } } }))
    for (const start of [COMMAND, { ...COMMAND, env: {}, cwd: '' }]) {
      await expect(consent.review(start)).resolves.toEqual({
        allow: false,
        reason: 'the acceptance store is of version 1, recorded before an acceptance covered the executable path, command shell and working directory the command resolves to, so nothing counts as accepted until the command is accepted again',
      })
    }
  })

  it('does not honour a version 2 store, even for the exact start it accepted', async () => {
    const { resolvedCommand: _command, resolvedCwd: _cwd, ...versionTwo } = acceptanceOfStart(COMMAND, 1)
    writeStore(JSON.stringify({ v: 2, acceptances: { [COMMAND.command]: versionTwo } }))
    await expect(consent.review(COMMAND)).resolves.toEqual({
      allow: false,
      reason: 'the acceptance store is of version 2, recorded before an acceptance covered the executable path, command shell and working directory the command resolves to, so nothing counts as accepted until the command is accepted again',
    })
  })

  it('does not honour a version 3 store, even for the exact start it accepted', async () => {
    writeStore(JSON.stringify({ v: 3, acceptances: { [COMMAND.command]: acceptanceOfStart(COMMAND, 1) } }))
    await expect(consent.review(COMMAND)).resolves.toEqual({
      allow: false,
      reason: 'the acceptance store is of version 3, recorded before an acceptance covered the executable path, command shell and working directory the command resolves to, so nothing counts as accepted until the command is accepted again',
    })
  })

  it('asks again when an accepted batch file now runs through another command shell, or through none', async () => {
    writeStore(acceptedStore(SHIM))
    await expect(consent.review(SHIM)).resolves.toEqual({ allow: true })
    await expect(consent.review({ ...SHIM, resolvedShell: '/Users/person/cmd.exe' })).resolves.toEqual({
      allow: false,
      reason: 'the command runs through the command shell "/Users/person/cmd.exe", and the person accepted it run through the command shell "/Windows/System32/cmd.exe"',
    })
    const { resolvedShell: _shell, ...direct } = SHIM
    await expect(consent.review(direct)).resolves.toEqual({
      allow: false,
      reason: 'the command runs through no command shell, and the person accepted it run through the command shell "/Windows/System32/cmd.exe"',
    })
  })

  it('accepting into a version 1 store starts a store of this version that holds only the new acceptance', async () => {
    const path = writeStore(JSON.stringify({ v: 1, acceptances: { other: { args: [], acceptedAt: 1 }, [COMMAND.command]: { args: COMMAND.args, acceptedAt: 1 } } }))
    await consent.accept(COMMAND)
    const entries = parseAcceptanceStore(readFileSync(path, 'utf8'))
    expect([...entries.keys()]).toEqual([COMMAND.command])
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: true })
    await expect(consent.review({ ...COMMAND, command: 'other', args: [], env: {}, cwd: '' })).resolves.toEqual({
      allow: false,
      reason: 'the acceptance store holds no acceptance for this command',
    })
  })

  it('asks again for a command the store holds no acceptance for', async () => {
    writeStore(acceptedStore({ ...COMMAND, command: 'other-command', args: [], env: {}, cwd: '' }))
    await expect(consent.review(COMMAND)).resolves.toEqual({
      allow: false,
      reason: 'the acceptance store holds no acceptance for this command',
    })
  })

  it('asks while no store exists', async () => {
    await expect(consent.review(COMMAND)).resolves.toEqual({
      allow: false,
      reason: 'no command is accepted yet (the acceptance store does not exist)',
    })
  })

  it('asks again while the store is malformed, even for an entry that looks like the acceptance', async () => {
    for (const text of [
      '{ not json',
      '[]',
      JSON.stringify({ v: 5, acceptances: { [COMMAND.command]: acceptanceOfStart(COMMAND, 1) } }),
      JSON.stringify({ v: 4, acceptances: { [COMMAND.command]: { ...acceptanceOfStart(COMMAND, 1), note: 'x' } } }),
    ]) {
      writeStore(text)
      await expect(consent.review(COMMAND)).resolves.toSatisfy((decision: { allow: boolean, reason: string }) =>
        decision.allow === false && decision.reason.startsWith('the acceptance store could not be read'))
    }
  })

  it('asks again while the store is laxer than the protected mode or not a regular file', async () => {
    const path = writeStore(acceptedStore(COMMAND))
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
    // Upstream's ~/.dsh under the real OS home is a home resolveDeloHome refuses (contract C1's HOME_IS_DSH_HOME),
    // so the review cannot read any store and asks again.
    vi.stubEnv('DELO_HOME', join(homedir(), '.dsh'))
    await expect(consent.review(COMMAND)).resolves.toSatisfy((decision: { allow: boolean, reason: string }) =>
      decision.allow === false && decision.reason.startsWith('the Delo home could not be resolved'))
  })

  it('records an acceptance that a later review allows without asking', async () => {
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: false, reason: 'no command is accepted yet (the acceptance store does not exist)' })
    await consent.accept(COMMAND)
    const path = store()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..'), ).mode & 0o777).toBe(0o700)
    // The recorded acceptance holds the accepted argument list and the acceptance time it was recorded with, per the
    // store's documented shape; the time itself is the recording's, so the parse is what the shape check reads.
    expect(parseAcceptanceStore(readFileSync(path, 'utf8')).get(COMMAND.command)).toEqual({ ...acceptanceOfStart(COMMAND, 0), acceptedAt: expect.any(Number) })
    expect(readFileSync(path, 'utf8')).not.toContain(SECRET)
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: true })
  })

  it('grants a changed command by accepting it again with its new arguments', async () => {
    await consent.accept(COMMAND)
    const changed = { ...COMMAND, args: ['-y', '@modelcontextprotocol/server-fs', '/elsewhere'] }
    await expect(consent.review(changed)).resolves.toEqual({ allow: false, reason: 'the person accepted a different argument list with this command' })
    await consent.accept(changed)
    await expect(consent.review(changed)).resolves.toEqual({ allow: true })
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: false, reason: 'the person accepted a different argument list with this command' })
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
  let consent: DeloMcpConsent

  /** A stdio server whose bare command `tool` is looked up on the Host's PATH, run in the Host's working directory. */
  const server: McpClientConfig = {
    transport: 'stdio',
    serverName: 'srv',
    command: 'tool',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 1_000,
    failOnStartupError: true,
  }

  beforeEach(() => {
    // Two directories, each with an executable `bin/tool`; the Host runs in `a` with `a/bin` first on its PATH.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-mcp-consent-start-')))
    a = join(root, 'a')
    b = join(root, 'b')
    for (const dir of [a, b]) {
      mkdirSync(join(dir, 'bin'), { recursive: true })
      writeFileSync(join(dir, 'bin', 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    mkdirSync(join(root, 'home'))
    vi.stubEnv('DELO_HOME', join(root, 'home'))
    vi.stubEnv('PATH', `${join(a, 'bin')}:${join(b, 'bin')}`)
    hostCwd = vi.spyOn(process, 'cwd').mockReturnValue(a)
    ctx = new Context()
    consent = new DeloMcpConsent(ctx)
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
    await expect(consent.review(start)).resolves.toEqual({ allow: true })
    return start
  }

  it('records the executable and working directory the start resolved to', async () => {
    const start = await acceptFirstStart()
    expect(start).toMatchObject({ command: 'tool', cwd: '', resolvedCommand: join(a, 'bin', 'tool'), resolvedCwd: a })
    expect(parseAcceptanceStore(readFileSync(acceptanceStorePath(join(root, 'home')), 'utf8')).get('tool'))
      .toMatchObject({ cwd: '', resolvedCommand: join(a, 'bin', 'tool'), resolvedCwd: a })
  })

  it('asks again when the accepted bare command now resolves to another executable on PATH', async () => {
    await acceptFirstStart()
    vi.stubEnv('PATH', `${join(b, 'bin')}:${join(a, 'bin')}`)

    const failure: unknown = await startServer(ctx, server).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(McpConsentRefusedError)
    expect(failure).toMatchObject({
      resolvedCommand: join(b, 'bin', 'tool'),
      reason: `the command resolves to the executable ${JSON.stringify(join(b, 'bin', 'tool'))}, and the person accepted ${JSON.stringify(join(a, 'bin', 'tool'))}`,
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
      reason: `the working directory resolves to ${JSON.stringify(b)}, and the person accepted this command run in ${JSON.stringify(a)}`,
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
    expect(Config()).toEqual({ enabled: false })
  })

  it('registers nothing while off', () => {
    apply(ctx, { enabled: false })
    expect(ctx.get('mcpAddConsent')).toBeUndefined()
  })

  it('declares itself an mcpAddConsent provider, so an mcp-client row waits for its row', () => {
    expect(Reflect.get(McpConsentPlugin, MCP_ADD_CONSENT_PROVIDER_EXPORT)).toBe(true)
  })

  it('mounts the consent service while on', async () => {
    // The mount is a plugin fiber, so apply settles only once the service is registered.
    await apply(ctx, { enabled: true })
    expect(ctx.get('mcpAddConsent')).toBeInstanceOf(DeloMcpConsent)
  })
})
