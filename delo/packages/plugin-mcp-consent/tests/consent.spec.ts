/**
 * Specs of `@delo/plugin-mcp-consent`: the acceptance store's file handling
 * and the `mcpAddConsent` provider's reviews — an accepted command allowed
 * without asking, a changed command asked again, a missing or malformed store
 * asked again, and every registration behind the switch.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeloMcpConsent, Config, apply } from '../src/index.ts'
import {
  AcceptanceStoreError,
  acceptanceStorePath,
  parseAcceptanceStore,
  serializeAcceptanceStore,
} from '../src/store.ts'

/** The server command every review of the suite judges. */
const COMMAND = { serverName: 'srv', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'] as readonly string[] }

/** The text of a valid store holding one acceptance, written at the protected mode. */
function acceptedStore(command: string, args: readonly string[]): string {
  return serializeAcceptanceStore(new Map([[command, { args, acceptedAt: 1_700_000_000_000 }]]))
}

describe('the acceptance store path', () => {
  it('sits under the home\'s protected state, in the plugin\'s own directory', () => {
    expect(acceptanceStorePath('/home/person/.delo')).toBe('/home/person/.delo/secrets/mcp-add-consent/acceptances.json')
  })
})

describe('the acceptance store format', () => {
  it('round-trips the acceptances, sorted by command, with a trailing newline', () => {
    const entries = new Map([
      ['zed', { args: ['-y', 'z'], acceptedAt: 2 }],
      ['alpha', { args: ['-a'], acceptedAt: 1 }],
    ])
    const text = serializeAcceptanceStore(entries)
    expect(text).toBe(`${JSON.stringify({
      v: 1,
      acceptances: {
        alpha: { args: ['-a'], acceptedAt: 1 },
        zed: { args: ['-y', 'z'], acceptedAt: 2 },
      },
    }, null, 2)}\n`)
    const parsed = parseAcceptanceStore(text)
    expect(parsed.get('alpha')).toEqual({ args: ['-a'], acceptedAt: 1 })
    expect(parsed.get('zed')).toEqual({ args: ['-y', 'z'], acceptedAt: 2 })
  })

  it('refuses a document that is not this version\'s format', () => {
    for (const [text, problem] of [
      ['{', 'no JSON document'],
      ['[]', 'not a JSON object'],
      [JSON.stringify({ v: 2, acceptances: {} }), 'the store\'s version is 2, not 1'],
      [JSON.stringify({ v: 1, acceptances: {}, extra: true }), 'the store sets extra'],
      [JSON.stringify({ v: 1, acceptances: { npx: { args: ['-y'], acceptedAt: 1, extra: true } } }), 'the acceptance of the command "npx" sets extra'],
      [JSON.stringify({ v: 1, acceptances: { npx: { args: ['y'], acceptedAt: 'now' } } }), 'the acceptance of the command "npx" does not hold a number acceptance time'],
      [JSON.stringify({ v: 1, acceptances: { '': { args: [], acceptedAt: 1 } } }), 'an empty command'],
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
    writeStore(acceptedStore(COMMAND.command, COMMAND.args))
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: true })
  })

  it('asks again when the arguments changed', async () => {
    writeStore(acceptedStore(COMMAND.command, ['-y', '@modelcontextprotocol/server-fs', '/elsewhere']))
    await expect(consent.review(COMMAND)).resolves.toEqual({
      allow: false,
      reason: 'the person accepted a different argument list with this command',
    })
  })

  it('asks again for a command the store holds no acceptance for', async () => {
    writeStore(acceptedStore('other-command', []))
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
      JSON.stringify({ v: 2, acceptances: { [COMMAND.command]: { args: COMMAND.args, acceptedAt: 1 } } }),
      JSON.stringify({ v: 1, acceptances: { [COMMAND.command]: { args: COMMAND.args, acceptedAt: 1, note: 'x' } } }),
    ]) {
      writeStore(text)
      await expect(consent.review(COMMAND)).resolves.toSatisfy((decision: { allow: boolean, reason: string }) =>
        decision.allow === false && decision.reason.startsWith('the acceptance store could not be read'))
    }
  })

  it('asks again while the store is laxer than the protected mode or not a regular file', async () => {
    const path = writeStore(acceptedStore(COMMAND.command, COMMAND.args))
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
    await consent.accept(COMMAND.command, COMMAND.args)
    const path = store()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..'), ).mode & 0o777).toBe(0o700)
    // The recorded acceptance holds the accepted argument list and the acceptance time it was recorded with, per the
    // store's documented shape; the time itself is the recording's, so the parse is what the shape check reads.
    expect(parseAcceptanceStore(readFileSync(path, 'utf8')).get(COMMAND.command)).toEqual({ args: COMMAND.args, acceptedAt: expect.any(Number) })
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: true })
  })

  it('grants a changed command by accepting it again with its new arguments', async () => {
    await consent.accept(COMMAND.command, COMMAND.args)
    const changed = { ...COMMAND, args: ['-y', '@modelcontextprotocol/server-fs', '/elsewhere'] as readonly string[] }
    await expect(consent.review(changed)).resolves.toEqual({ allow: false, reason: 'the person accepted a different argument list with this command' })
    await consent.accept(changed.command, changed.args)
    await expect(consent.review(changed)).resolves.toEqual({ allow: true })
    await expect(consent.review(COMMAND)).resolves.toEqual({ allow: false, reason: 'the person accepted a different argument list with this command' })
  })

  it('refuses to accept into a store that is not this version\'s format, and leaves it unchanged', async () => {
    const path = writeStore('{ not json')
    await expect(consent.accept(COMMAND.command, COMMAND.args)).rejects.toThrow(/the acceptance store is refused/)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
    expect(existsSync(`${path}.tmp-`)).toBe(false)
  })

  it('refuses an empty command', async () => {
    await expect(consent.accept('', [])).rejects.toThrow('the command to accept is empty')
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

  it('mounts the consent service while on', async () => {
    // The mount is a plugin fiber, so apply settles only once the service is registered.
    await apply(ctx, { enabled: true })
    expect(ctx.get('mcpAddConsent')).toBeInstanceOf(DeloMcpConsent)
  })
})
