/**
 * The Tailscale private provider's checks and commands, over a fake `tailscale`: it is never run through `sudo`, each
 * failed check names C7's code and what the person does, the serve target is the fixed listener port, a rule on the
 * serve port that is not this home's own is removed and confirmed gone before the provider writes its own, Funnel on
 * the serve address refuses, and `serve status --json` is read as Tailscale's `ipn.ServeConfig` JSON.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delorun/contract-admission'
import { TAILSCALE_OPERATOR_COMMAND } from '@delorun/contract-reach-providers'
import { checkServeAccess, TailscalePrivateProvider, TAILSCALE_PRIVATE_VISIBILITY, tailscaleAddress, type ReachSpec } from '../src/provider.ts'
import {
  isMissing, isPermissionRefusal, parseServeRules, readComputerUser, readServeRules, readTailscale, removeServe, systemTailscale, type TailscaleResult, type TailscaleRunner,
} from '../src/tailscale.ts'
import { fakeTailscale, ownRule } from './fake-tailscale.ts'

const HOST = 'home.example.ts.net'
const ADDRESS = brandString<StudioAddress>(`https://${HOST}`)

/** A fake `tailscale` whose answers a spec sets per subcommand. */
function fake(answers: Partial<Record<string, TailscaleResult>> = {}): { readonly run: TailscaleRunner; readonly calls: string[][] } {
  const calls: string[][] = []
  const status = { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [HOST] }), stderr: '' }
  return {
    calls,
    run: async (args) => {
      calls.push([...args])
      const answer = answers[args[0] ?? ''] ?? (args[0] === 'status' ? status : { code: 0, stdout: '', stderr: '' })
      return Promise.resolve(answer)
    },
  }
}

const LISTENER_PORT = 24_680
const TARGET = `http://127.0.0.1:${String(LISTENER_PORT)}`
const rows = (row: object): Parameters<TailscalePrivateProvider['resolve']>[0] => ({ tailscalePrivate: { enabled: true, address: ADDRESS, servePort: 443, listenerPort: LISTENER_PORT, serveCheckIntervalMs: 60_000, elevationMinutes: 15, ...row } })
const SPEC: ReachSpec = { option: 'tailscale-private', listener: 'reach-tailscale-private', address: ADDRESS, servePort: 443, listenerPort: LISTENER_PORT, checkIntervalMs: 60_000, elevationMinutes: 15 }

describe('the Tailscale private provider', () => {
  it('declares tailnet-membership and resolves only an https ts.net address', () => {
    const provider = new TailscalePrivateProvider(fake().run)
    expect(provider.factor).toBe('tailnet-membership')
    expect(provider.visibility()).toBe(TAILSCALE_PRIVATE_VISIBILITY)
    expect(provider.resolve({})).toBeUndefined()
    expect(provider.resolve(rows({ enabled: false }))).toBeUndefined()
    expect(provider.resolve(rows({}))).toEqual(SPEC)
    // Pins the listener port check: an unchosen port would write a rule to a port no program holds.
    for (const listenerPort of [0, 65_536, 1.5]) expect(() => provider.resolve(rows({ listenerPort }))).toThrow(expect.objectContaining({ code: 'PORT_CONFLICT' }))
    expect(() => provider.resolve(rows({ address: 'https://studio.example.org' }))).toThrow(expect.objectContaining({ code: 'TAILSCALE_ADDRESS_MISMATCH' }))
    expect(() => provider.resolve(rows({ address: `http://${HOST}` }))).toThrow(expect.objectContaining({ code: 'TAILSCALE_ADDRESS_MISMATCH' }))
    expect(() => provider.resolve(rows({ servePort: 0 }))).toThrow(expect.objectContaining({ code: 'PORT_CONFLICT' }))
    // Pins the minutes check: a row the person edited to more than an hour, or that reach.apply reads unvalidated, is refused.
    for (const elevationMinutes of [0, 61, 2.5]) expect(() => provider.resolve(rows({ elevationMinutes }))).toThrow(expect.objectContaining({ code: 'ELEVATION_MINUTES_INVALID' }))
    expect(provider.resolve(rows({ elevationMinutes: 60 }))).toEqual({ ...SPEC, elevationMinutes: 60 })
    expect(tailscaleAddress(HOST, 8443)).toBe(`https://${HOST}:8443`)
  })

  it('configures the serve target to the fixed listener port and removes it, confirming the removal, never through sudo', async () => {
    const tailscale = fakeTailscale(HOST)
    const provider = new TailscalePrivateProvider(tailscale.run)
    await provider.start(SPEC)
    expect(tailscale.config).toEqual(ownRule(HOST, 443, LISTENER_PORT))
    await provider.stop(SPEC)
    expect(tailscale.calls).toEqual([
      ['version'], ['status', '--json'], ['serve', 'status', '--json'], ['serve', '--bg', '--https=443', TARGET],
      ['serve', 'status', '--json'], ['serve', '--https=443', 'off'], ['serve', 'status', '--json'],
    ])
    expect(tailscale.calls.flat()).not.toContain('sudo')
    // Stopping with nothing served runs no removal.
    tailscale.calls.length = 0
    await provider.stop(SPEC)
    expect(tailscale.calls).toEqual([['serve', 'status', '--json']])
  })

  it('keeps its own rule left by an earlier run, and removes any other rule on the serve port before writing its own', async () => {
    const own = fakeTailscale(HOST)
    own.config = ownRule(HOST, 443, LISTENER_PORT)
    await new TailscalePrivateProvider(own.run).start(SPEC)
    expect(own.calls.filter(call => call.at(-1) === 'off')).toEqual([])
    // Pins the removal of a foreign rule: a rule to another port would serve whatever program binds it on the phone's origin.
    const foreign = fakeTailscale(HOST)
    foreign.config = ownRule(HOST, 443, 1234)
    await new TailscalePrivateProvider(foreign.run).start(SPEC)
    expect(foreign.calls.slice(2)).toEqual([
      ['serve', 'status', '--json'], ['serve', 'status', '--json'], ['serve', '--https=443', 'off'], ['serve', 'status', '--json'], ['serve', '--bg', '--https=443', TARGET],
    ])
    expect(foreign.config).toEqual(ownRule(HOST, 443, LISTENER_PORT))
  })

  it('refuses while Funnel is on for the address, and when a foreign rule cannot be removed, writing nothing', async () => {
    // Pins the Funnel refusal: the studio would be on the public internet under the phone's origin.
    const funnel = fakeTailscale(HOST)
    funnel.config = { AllowFunnel: { [`${HOST}:443`]: true } }
    await expect(new TailscalePrivateProvider(funnel.run).start(SPEC)).rejects.toMatchObject({ code: 'TAILSCALE_FUNNEL_ON', detail: expect.stringContaining('tailscale funnel --https=443 off, then restart Delorun') })
    expect(funnel.calls.some(call => call[1] === '--bg')).toBe(false)
    // Pins the removal's result check: a failed `off` is reported, and the provider writes no rule over it.
    const stuck = fakeTailscale(HOST, { 'serve off': { code: 1, stdout: '', stderr: 'denied\n' } })
    stuck.config = ownRule(HOST, 443, 1234)
    await expect(new TailscalePrivateProvider(stuck.run).start(SPEC)).rejects.toMatchObject({ code: 'TAILSCALE_SERVE_CONFLICT', detail: expect.stringContaining('tailscale serve --https=443 off failed (denied)') })
    expect(stuck.calls.some(call => call[1] === '--bg')).toBe(false)
    // Pins the confirmation: a foreground session that keeps the port after the removal is reported.
    const foreground = fakeTailscale(HOST, { 'serve off': { code: 0, stdout: '', stderr: '' } })
    foreground.config = { Foreground: { session: ownRule(HOST, 443, 1234) } }
    await expect(new TailscalePrivateProvider(foreground.run).start(SPEC)).rejects.toMatchObject({ code: 'TAILSCALE_SERVE_CONFLICT', detail: expect.stringContaining('still serves') })
    await expect(new TailscalePrivateProvider(foreground.run).stop(SPEC)).rejects.toMatchObject({ code: 'TAILSCALE_SERVE_CONFLICT' })
  })

  it('rechecks a ready option: Funnel blocks, an unreadable status is unknown', async () => {
    const tailscale = fakeTailscale(HOST)
    const provider = new TailscalePrivateProvider(tailscale.run)
    await expect(provider.check(SPEC)).resolves.toEqual({ kind: 'ok' })
    // Pins the periodic Funnel check: Funnel turned on after start is found.
    tailscale.config = { ...ownRule(HOST, 443, LISTENER_PORT), AllowFunnel: { [`${HOST}:443`]: true } }
    await expect(provider.check(SPEC)).resolves.toMatchObject({ kind: 'blocked', error: { code: 'TAILSCALE_FUNNEL_ON' } })
    tailscale.answers['serve status'] = { code: 1, stdout: '', stderr: 'tailscaled not running' }
    await expect(provider.check(SPEC)).resolves.toMatchObject({ kind: 'unknown', error: { code: 'TAILSCALE_NOT_LOGGED_IN', detail: 'tailscale serve status failed: tailscaled not running' } })
    await expect(new TailscalePrivateProvider(() => Promise.reject(new Error('runner broke'))).check(SPEC)).resolves.toMatchObject({ kind: 'unknown', error: { detail: 'tailscale serve status failed: runner broke' } })
    await expect(new TailscalePrivateProvider(() => Promise.reject('gone')).check(SPEC)).resolves.toMatchObject({ kind: 'unknown', error: { detail: 'tailscale serve status failed: gone' } })
  })

  it('names each failed check with C7\'s code', async () => {
    const provider = (answers: Parameters<typeof fake>[0]): TailscalePrivateProvider => new TailscalePrivateProvider(fake(answers).run)
    const spec = SPEC
    await expect(provider({ version: { code: null, stdout: '', stderr: '' } }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_INSTALLED' })
    await expect(provider({ status: { code: 1, stdout: '', stderr: 'stopped' } }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    await expect(provider({ status: { code: 0, stdout: 'not json', stderr: '' } }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    await expect(provider({ status: { code: 0, stdout: 'null', stderr: '' } }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    await expect(provider({ status: { code: 0, stdout: '{}', stderr: '' } }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    await expect(provider({ status: { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' } }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    // Pins the HTTPS check: without certificates, tailscale serve answers nothing a browser accepts.
    await expect(provider({ status: { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [] }), stderr: '' } }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_HTTPS_DISABLED' })
    await expect(provider({ status: { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'other.example.ts.net.' }, CertDomains: ['other.example.ts.net'] }), stderr: '' } }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_ADDRESS_MISMATCH' })
    // Pins "prints the one command and never runs sudo".
    const setting = (answer: TailscaleResult): TailscalePrivateProvider => new TailscalePrivateProvider(fakeTailscale(HOST, { 'serve set': answer }).run)
    await expect(setting({ code: 1, stdout: '', stderr: 'Access denied: serve config denied' }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_SERVE_NOT_PERMITTED', detail: expect.stringContaining(TAILSCALE_OPERATOR_COMMAND) })
    await expect(setting({ code: 1, stdout: '', stderr: '\nsomething else broke\n' }).start(spec)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN', detail: 'tailscale serve failed: something else broke' })
    await expect(setting({ code: 1, stdout: '', stderr: '' }).start(spec)).rejects.toMatchObject({ detail: 'tailscale serve failed: no reason given' })
    expect([isPermissionRefusal('permission denied'), isPermissionRefusal('use --operator'), isPermissionRefusal('timeout')]).toEqual([true, true, false])
    await expect(readTailscale(fake({ status: { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: 'x', CertDomains: 'x' }), stderr: '' } }).run)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
  })

  it('reads one host and port of tailscale serve status --json', () => {
    const read = (config: unknown): ReturnType<typeof parseServeRules> => parseServeRules(JSON.stringify(config), HOST, 443, TARGET)
    const nothing = { present: false, own: false, funnel: false, removal: '--https=443' }
    expect(read(null)).toEqual(nothing)
    expect(read({})).toEqual(nothing)
    expect(read(ownRule(HOST, 443, LISTENER_PORT))).toEqual({ present: true, own: true, funnel: false, removal: '--https=443' })
    // Keys compare in any case, and a proxy target may end in a slash.
    expect(read({ TCP: { 443: { HTTPS: true } }, Web: { 'HOME.example.ts.net:443': { Handlers: { '/': { Proxy: `${TARGET}/` } } } } })).toMatchObject({ own: true })
    // Rules on another port or for another name of this machine are not this port's.
    expect(read(ownRule(HOST, 8443, 1))).toEqual(nothing)
    expect(read({ Web: { 'other.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } })).toEqual(nothing)
    // Each foreign form is present and not this home's own, and names the flag that removes it.
    expect(read(ownRule(HOST, 443, 1234))).toEqual({ present: true, own: false, funnel: false, removal: '--https=443' })
    expect(read({ ...ownRule(HOST, 443, LISTENER_PORT), Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: TARGET }, '/x': { Text: 'hi' } } } } })).toMatchObject({ present: true, own: false })
    expect(read({ TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/app': { Proxy: TARGET } } } } })).toMatchObject({ own: false })
    expect(read({ TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': { Text: 'hi' } } } } })).toMatchObject({ own: false })
    expect(read({ TCP: { 443: { TCPForward: '127.0.0.1:22' } } })).toEqual({ present: true, own: false, funnel: false, removal: '--tcp=443' })
    expect(read({ TCP: { 443: { HTTPS: true, TCPForward: '127.0.0.1:22' } }, Web: ownRule(HOST, 443, LISTENER_PORT).Web })).toMatchObject({ own: false, removal: '--tcp=443' })
    expect(read({ TCP: { 443: { HTTP: true } }, Web: ownRule(HOST, 443, LISTENER_PORT).Web })).toEqual({ present: true, own: false, funnel: false, removal: '--http=443' })
    expect(read({ TCP: { 443: {} } })).toEqual({ present: true, own: false, funnel: false, removal: '--https=443' })
    expect(read({ ...ownRule(HOST, 443, LISTENER_PORT), Foreground: { session: ownRule(HOST, 443, LISTENER_PORT) } })).toMatchObject({ present: true, own: false })
    expect(read({ Foreground: { session: ownRule(HOST, 443, 1), other: 'x' } })).toEqual({ present: true, own: false, funnel: false, removal: '--https=443' })
    // Funnel for this host and port, in the background or a foreground session; Funnel elsewhere is not this port's.
    expect(read({ AllowFunnel: { [`${HOST}:443`]: true } })).toEqual({ ...nothing, funnel: true })
    expect(read({ Foreground: { session: { AllowFunnel: { [`${HOST}:443`]: true } } } })).toEqual({ ...nothing, funnel: true })
    expect(read({ AllowFunnel: { [`${HOST}:8443`]: true, [`${HOST}:443`]: false } })).toEqual(nothing)
    // Fields of another type read as absent.
    expect(read({ TCP: [], Web: { [`${HOST}:443`]: 'x' }, AllowFunnel: 'x', Foreground: [] })).toEqual(nothing)
    expect(read({ TCP: { 443: 'x' }, Web: { [`${HOST}:443`]: { Handlers: [] } } })).toEqual(nothing)
    expect(read({ TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': 'x' } } } })).toMatchObject({ own: false })
    for (const text of ['not json', '[]', '"text"', '3']) expect(parseServeRules(text, HOST, 443, TARGET)).toBeUndefined()
  })

  it('names each serve status and removal failure with C7\'s code', async () => {
    await expect(readServeRules(fake({ serve: { code: null, stdout: '', stderr: '' } }).run, HOST, 443, TARGET)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_INSTALLED' })
    await expect(readServeRules(fake({ serve: { code: 1, stdout: '', stderr: 'Access denied: serve config denied' } }).run, HOST, 443, TARGET)).rejects.toMatchObject({ code: 'TAILSCALE_SERVE_NOT_PERMITTED', detail: expect.stringContaining(TAILSCALE_OPERATOR_COMMAND) })
    await expect(readServeRules(fake({ serve: { code: 1, stdout: '', stderr: 'no tailscaled\n' } }).run, HOST, 443, TARGET)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN', detail: 'tailscale serve status failed: no tailscaled' })
    // Pins the JSON check: output that is not the configuration is never read as an empty one.
    await expect(readServeRules(fake({ serve: { code: 0, stdout: '', stderr: '' } }).run, HOST, 443, TARGET)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN', detail: 'tailscale serve status failed: its output is not the serve configuration' })
    const tailscale = fakeTailscale(HOST)
    await removeServe(tailscale.run, HOST, 443, TARGET)
    expect(tailscale.calls).toEqual([['serve', 'status', '--json']])
    tailscale.config = { TCP: { 443: { TCPForward: '127.0.0.1:22' } } }
    await removeServe(tailscale.run, HOST, 443, TARGET)
    expect(tailscale.calls.at(-2)).toEqual(['serve', '--tcp=443', 'off'])
    expect(tailscale.config).toEqual({ TCP: {}, Web: {} })
    const silent = fakeTailscale(HOST, { 'serve off': { code: 1, stdout: '', stderr: '' } })
    silent.config = ownRule(HOST, 443, 1)
    await expect(removeServe(silent.run, HOST, 443, TARGET)).rejects.toMatchObject({ code: 'TAILSCALE_SERVE_CONFLICT', detail: expect.stringContaining('failed (no reason given)') })
  })

  it('tests that the person may configure serve before anything is written, leaving no rule behind unless the home keeps its own', async () => {
    const request = { host: HOST, servePort: 443, listenerPort: LISTENER_PORT, keepOwn: false, next: 'then try again' }
    const fresh = fakeTailscale(HOST)
    await checkServeAccess(fresh.run, request)
    // Pins the test by configuring: the serve target is set and removed again, and nothing stays served.
    expect(fresh.calls.filter(call => call[1] !== 'status')).toEqual([['serve', '--bg', '--https=443', TARGET], ['serve', '--https=443', 'off']])
    expect(fresh.config).toEqual({ TCP: {}, Web: {} })
    // A kept rule of this home is configured again unchanged; a stopped home's own rule is removed.
    const kept = fakeTailscale(HOST)
    kept.config = ownRule(HOST, 443, LISTENER_PORT)
    await checkServeAccess(kept.run, { ...request, keepOwn: true })
    expect(kept.config).toEqual(ownRule(HOST, 443, LISTENER_PORT))
    const stale = fakeTailscale(HOST)
    stale.config = ownRule(HOST, 443, LISTENER_PORT)
    await checkServeAccess(stale.run, request)
    expect(stale.config).toEqual({ TCP: {}, Web: {} })
    const funnel = fakeTailscale(HOST)
    funnel.config = { AllowFunnel: { [`${HOST}:443`]: true } }
    await expect(checkServeAccess(funnel.run, request)).rejects.toMatchObject({ code: 'TAILSCALE_FUNNEL_ON', detail: expect.stringContaining('then try again') })
    expect(funnel.calls).toEqual([['serve', 'status', '--json']])
    const denied = { code: 1, stdout: '', stderr: 'Access denied: serve config denied' }
    await expect(checkServeAccess(fakeTailscale(HOST, { 'serve set': denied }).run, request)).rejects.toMatchObject({ code: 'TAILSCALE_SERVE_NOT_PERMITTED', detail: expect.stringContaining(TAILSCALE_OPERATOR_COMMAND) })
    const foreign = fakeTailscale(HOST, { 'serve off': denied })
    foreign.config = ownRule(HOST, 443, 1)
    await expect(checkServeAccess(foreign.run, request)).rejects.toMatchObject({ code: 'TAILSCALE_SERVE_NOT_PERMITTED', detail: expect.stringContaining('may still serve home.example.ts.net:443') })
  })

  it('tells a missing binary from a timeout, a too large answer and a binary that cannot run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'delorun-reach-'))
    try {
      const slow = join(directory, 'slow')
      await writeFile(slow, '#!/bin/sh\nsleep 5\n')
      await chmod(slow, 0o700)
      const loud = join(directory, 'loud')
      await writeFile(loud, '#!/bin/sh\nhead -c 4096 /dev/zero | tr \'\\0\' x\n')
      await chmod(loud, 0o700)
      const locked = join(directory, 'locked')
      await writeFile(locked, '#!/bin/sh\necho hi\n')
      await chmod(locked, 0o600)
      const missing = await systemTailscale(join(directory, 'missing'))(['version'])
      expect(isMissing(missing)).toBe(true)
      const timedOut = await systemTailscale(slow, 150)(['status'])
      expect(timedOut).toMatchObject({ code: null, failure: 'timeout', stderr: 'tailscale did not finish within 0.15 seconds' })
      expect(isMissing(timedOut)).toBe(false)
      const tooLarge = await systemTailscale(loud, 5_000, 1024)(['status'])
      expect(tooLarge).toMatchObject({ code: null, failure: 'output-too-large', stdout: '' })
      expect(tooLarge.stderr).toContain('printed more than')
      expect(await systemTailscale(locked)(['status'])).toMatchObject({ code: null, failure: 'not-run' })
      // A large tailnet's status stays under the default limit.
      const large = join(directory, 'large')
      await writeFile(large, '#!/bin/sh\nhead -c 2097152 /dev/zero | tr \'\\0\' x\n')
      await chmod(large, 0o700)
      expect((await systemTailscale(large)(['status'])).stdout).toHaveLength(2_097_152)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports a tailscale that did not answer as not signed in, never as not installed', async () => {
    const hung: TailscaleResult = { code: null, stdout: '', stderr: 'tailscale did not finish within 15 seconds', failure: 'timeout' }
    // Pins the mapping: callers and the stop read NOT_INSTALLED as "nothing serves".
    await expect(readTailscale(fake({ version: hung }).run)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN', detail: 'tailscale version failed: tailscale did not finish within 15 seconds' })
    await expect(readTailscale(fake({ status: hung }).run)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN', detail: 'tailscale status failed: tailscale did not finish within 15 seconds' })
    await expect(readServeRules(fake({ serve: hung }).run, HOST, 443, TARGET)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_LOGGED_IN' })
    await expect(readServeRules(fake({ serve: { code: null, stdout: '', stderr: '' } }).run, HOST, 443, TARGET)).rejects.toMatchObject({ code: 'TAILSCALE_NOT_INSTALLED' })
  })

  it('refuses a serve check interval a timer cannot take', () => {
    const provider = new TailscalePrivateProvider(fake().run)
    // Pins the interval check: a delay below 1 or above 2147483647 makes Node run the check every millisecond.
    for (const serveCheckIntervalMs of [0, 999, 1.5, Number.NaN, 2_147_483_648]) expect(() => provider.resolve(rows({ serveCheckIntervalMs })), String(serveCheckIntervalMs)).toThrow(/serveCheckIntervalMs must be a whole number/u)
    expect(provider.resolve(rows({ serveCheckIntervalMs: 2_147_483_647 }))).toMatchObject({ checkIntervalMs: 2_147_483_647 })
  })

  it('runs the system tailscale without a shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'delorun-reach-'))
    try {
      const script = join(directory, 'tailscale')
      await writeFile(script, '#!/bin/sh\necho "$@"\necho oops >&2\nexit 3\n')
      await chmod(script, 0o700)
      // An argument with shell syntax reaches the program as one argument and runs nothing.
      await expect(systemTailscale(script)(['status', '$(touch hacked); --json'])).resolves.toEqual({ code: 3, stdout: 'status $(touch hacked); --json\n', stderr: 'oops\n' })
      await expect(systemTailscale(join(directory, 'missing'))(['version'])).resolves.toMatchObject({ code: null })
      await writeFile(script, '#!/bin/sh\necho ok\n')
      await expect(systemTailscale(script)(['version'])).resolves.toEqual({ code: 0, stdout: 'ok\n', stderr: '' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('the computer\'s Tailscale user', () => {
  /** A runner that answers `status --json` with the given text. */
  const answering = (stdout: string): TailscaleRunner => async () => ({ code: 0, stdout, stderr: '' })

  it('is the login of the user that Self.UserID names', async () => {
    // Pins the lookup: the own-user pairing mode compares a request's login with this one.
    await expect(readComputerUser(answering(JSON.stringify({ Self: { UserID: 42 }, User: { 41: { LoginName: 'other@example.com' }, 42: { LoginName: 'me@example.com' } } })))).resolves.toBe('me@example.com')
  })

  it('is unknown for a tagged node, a missing entry, an empty login or output that is not the status', async () => {
    for (const stdout of [
      JSON.stringify({ Self: { Tags: ['tag:server'] }, User: {} }),
      JSON.stringify({ Self: { UserID: 1 }, User: {} }),
      JSON.stringify({ Self: { UserID: 1 }, User: { 1: { LoginName: '' } } }),
      'null',
      'not json',
    ]) {
      // Pins the fail-closed answer: with no own user, the own-user mode accepts no request without a window.
      await expect(readComputerUser(answering(stdout))).resolves.toBeUndefined()
    }
  })
})
