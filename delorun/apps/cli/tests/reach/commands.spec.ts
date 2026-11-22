/**
 * `delorun reach` and `delorun devices` over a temporary home, with `tailscale` and the home socket faked:
 * what each action checks, writes and prints, and what it refuses.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId, StudioAddress } from '@delorun/contract-admission'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { Base64Url } from '@delorun/contract-device-approval'
import { HomeAuth, type DeviceSummary } from '@delorun/home-auth'
import { acquireHomeLock, newStartId, runDirectory } from '@delorun/home'
import type { ResponseLine, UnsignedRequest } from '@delorun/home-process'
import { chooseListenerPort, type TailscaleResult, type TailscaleRunner } from '@delorun/reach'
import { LISTENER_PORT_RANGE } from '@delorun/contract-reach-providers'
import { fakeTailscale, ownRule } from '../fixtures/fake-tailscale.ts'
import { EXIT } from '../../src/exit.ts'
import type { CommandContext } from '../../src/command.ts'
import { createReachCommand, homeRuns, type ReachDependencies } from '../../src/reach/command.ts'
import { localReach } from '../../src/reach/host.ts'
import { createDevicesCommand, type DevicesDependencies } from '../../src/devices/command.ts'
import { localDeviceApproval } from '../../src/devices/host.ts'
import { readableTime } from '../../src/output.ts'
import { listenerPortFor, readPairingAt, REACH_OFF, reachRowsOf, TRUST_STATEMENT } from '@delorun/setup-apply'
import { readReachRow, writeReachRow } from '../../src/reach/row.ts'
import { reachSection } from '../../src/reach/setup-section.ts'
import { BACK } from '../../src/setup/steps.ts'

const HOST = 'home.example.ts.net'
let osHome: string
let delorunHome: string
let out: { stdout: string; stderr: string }
let context: CommandContext

beforeEach(() => {
  osHome = mkdtempSync(join(tmpdir(), 'delorun-reach-'))
  delorunHome = join(osHome, '.delorun')
  mkdirSync(join(delorunHome, 'profiles', 'default'), { recursive: true, mode: 0o700 })
  writeFileSync(join(delorunHome, 'profiles', 'default', 'package.json'), '{"name":"dsh-profile-default","private":true}\n')
  out = { stdout: '', stderr: '' }
  context = {
    env: { ...process.env, HOME: osHome, DELORUN_HOME: delorunHome, DELORUN_PROFILE: undefined },
    stdout: (text) => { out.stdout += text },
    stderr: (text) => { out.stderr += text },
  }
})

afterEach(() => { rmSync(osHome, { recursive: true, force: true }) })

/** A fake `tailscale` answering per subcommand. */
function tailscale(answers: Partial<Record<string, TailscaleResult>> = {}, calls: string[][] = []): TailscaleRunner {
  return async (args) => {
    calls.push([...args])
    const key = args[0] === 'serve' ? `serve ${args[1] ?? ''}` : args[0] ?? ''
    if (answers[key] !== undefined) return Promise.resolve(answers[key])
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [HOST] }), stderr: '' }
    if (key === 'serve status') return { code: 0, stdout: '{}\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function reach(overrides: Partial<ReachDependencies> = {}): ReturnType<typeof createReachCommand> {
  return createReachCommand({
    tailscale: tailscale(),
    running: () => false,
    send: () => Promise.resolve([{ stream: 'out', line: '' }] as never),
    ask: () => Promise.resolve('y'),
    terminal: true,
    ...overrides,
  })
}

function patchRows(): unknown {
  return parse(readFileSync(join(delorunHome, 'profiles', 'default', 'cordis.patch.yml'), 'utf8'))
}

describe('delorun reach', () => {
  it('turns Tailscale private on with this machine\'s address and a fixed listener port, and prints the trust statement', async () => {
    const calls: string[][] = []
    await expect(reach({ tailscale: tailscale({}, calls) }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.ok)
    const row = readReachRow(delorunHome, 'default')
    expect(patchRows()).toEqual([{ id: 'delorun-reach', config: { enabled: true, tailscalePrivate: { enabled: true, address: `https://${HOST}`, servePort: 443, listenerPort: row.listenerPort, serveCheckIntervalMs: 60_000, elevationMinutes: 15 } } }])
    expect(row.listenerPort).toBeGreaterThanOrEqual(LISTENER_PORT_RANGE.min)
    expect(row.listenerPort).toBeLessThanOrEqual(LISTENER_PORT_RANGE.max)
    for (const line of TRUST_STATEMENT) expect(out.stdout).toContain(line)
    // A phone grants full access with Face ID or its PIN (A483): the statement says so and never promises a code unlock or that a phone cannot grant it.
    expect(out.stdout).toContain('asks for Face ID or that phone\'s PIN, once per action, and nothing stays unlocked')
    expect(out.stdout).toContain('granting full access')
    expect(out.stdout).not.toMatch(/cannot grant full access|approve an unlock|typing the code the phone shows/)
    expect(out.stdout).not.toContain('run commands or read files on this computer')
    expect(out.stdout).toContain('It starts with Delorun')
    expect(calls.flat()).not.toContain('sudo')
    // Pins the choice made once: turning it on again keeps the recorded port.
    await reach({ running: () => true }).run(['on', 'tailscale'], context)
    expect(out.stderr).toContain('Restart Delorun to apply it')
    expect(readReachRow(delorunHome, 'default').listenerPort).toBe(row.listenerPort)
  })

  it('prints the one operator command and turns nothing on when the user may not configure serve', async () => {
    const refused = tailscale({ 'serve status': { code: 1, stdout: '', stderr: 'Access denied: serve config denied' } })
    await expect(reach({ tailscale: refused }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('sudo tailscale set --operator=$USER')
    expect(existsSync(join(delorunHome, 'profiles', 'default', 'cordis.patch.yml'))).toBe(false)
    // Pins the serve status check: a status it cannot read turns nothing on.
    const other = tailscale({ 'serve status': { code: 1, stdout: '', stderr: 'no serve config' } })
    await expect(reach({ tailscale: other }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('tailscale serve status failed: no serve config (TAILSCALE_NOT_LOGGED_IN)')
    expect(existsSync(join(delorunHome, 'profiles', 'default', 'cordis.patch.yml'))).toBe(false)
  })

  it('refuses while Funnel is on, and removes a rule it does not own, or any rule while Delorun is stopped', async () => {
    // Pins the Funnel refusal: remote access is not turned on for an address on the public internet.
    const funnel = fakeTailscale(HOST)
    funnel.config = { AllowFunnel: { [`${HOST}:443`]: true } }
    await expect(reach({ tailscale: funnel.run }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('tailscale funnel --https=443 off, then run delorun reach on tailscale again (TAILSCALE_FUNNEL_ON)')
    expect(existsSync(join(delorunHome, 'profiles', 'default', 'cordis.patch.yml'))).toBe(false)
    // Pins the removal at reach on: a stale rule of a stopped home forwards to a port no program of this home holds.
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    writeReachRow(delorunHome, 'default', { ...REACH_OFF, listenerPort: port })
    const stale = fakeTailscale(HOST)
    stale.config = ownRule(HOST, 443, port)
    await expect(reach({ tailscale: stale.run }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.ok)
    expect(stale.config).toEqual({ TCP: {}, Web: {} })
    expect(readReachRow(delorunHome, 'default').listenerPort).toBe(port)
    // A running home whose option holds the listener port keeps its own rule and loses a foreign one.
    const live = (state: string) => (async (_home: string, _profile: string, request: { readonly op: string }) =>
      Promise.resolve([{ ok: true, options: request.op === 'reach.status' ? [{ option: 'tailscale-private', state }] : [] }] as never))
    const own = fakeTailscale(HOST)
    own.config = ownRule(HOST, 443, port)
    await expect(reach({ tailscale: own.run, running: () => true, send: live('ready') }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(own.config).toEqual(ownRule(HOST, 443, port))
    // Pins the live-state check: a running home whose option is blocked holds no port, so its own rule is removed too.
    const blocked = fakeTailscale(HOST)
    blocked.config = ownRule(HOST, 443, port)
    await expect(reach({ tailscale: blocked.run, running: () => true, send: live('blocked') }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(blocked.config).toEqual({ TCP: {}, Web: {} })
    const foreign = fakeTailscale(HOST)
    foreign.config = ownRule(HOST, 443, 1234)
    await expect(reach({ tailscale: foreign.run, running: () => true }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(foreign.config).toEqual({ TCP: {}, Web: {} })
    // Pins the removal's result check: a rule that stays is reported, and the command fails.
    const stuck = fakeTailscale(HOST, { 'serve off': { code: 1, stdout: '', stderr: 'denied' } })
    stuck.config = ownRule(HOST, 443, 1234)
    await expect(reach({ tailscale: stuck.run }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('(TAILSCALE_SERVE_CONFLICT)')
  })

  it('names a failed Tailscale check and refuses a wrong command line or a missing profile', async () => {
    await expect(reach({ tailscale: tailscale({ version: { code: null, stdout: '', stderr: '' } }) }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('TAILSCALE_NOT_INSTALLED')
    await expect(reach({ tailscale: () => Promise.reject(new Error('broken runner')) }).run(['on', 'tailscale'], context)).rejects.toThrow('broken runner')
    await expect(reach().run(['on', 'funnel'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(reach().run([], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(reach().run(['up'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(reach().run(['off', '--profile', 'work'], context)).rejects.toMatchObject({ exit: EXIT.failed })
  })

  it('turns it off, removes the serve target, confirms it is gone and keeps the address', async () => {
    await reach().run(['on', 'tailscale'], context)
    const row = readReachRow(delorunHome, 'default')
    const live = fakeTailscale(HOST)
    live.config = ownRule(HOST, 443, row.listenerPort)
    await expect(reach({ tailscale: live.run, running: () => true }).run(['off'], context)).resolves.toBe(EXIT.failed)
    expect(live.calls).toEqual([['serve', 'status', '--json'], ['serve', '--https=443', 'off'], ['serve', 'status', '--json']])
    expect(live.config).toEqual({ TCP: {}, Web: {} })
    expect(readReachRow(delorunHome, 'default')).toEqual({ ...row, enabled: false })
    expect(out.stdout).toContain('Tailscale no longer serves this computer\'s studio.')
    expect(out.stderr).toContain('Restart Delorun to close it')
    // Pins the confirmation: a rule still served after the removal fails the command with the reason.
    const stuck = fakeTailscale(HOST, { 'serve off': { code: 0, stdout: '', stderr: '' } })
    stuck.config = { Foreground: { session: ownRule(HOST, 443, row.listenerPort) } }
    out.stderr = ''
    await expect(reach({ tailscale: stuck.run }).run(['off'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('Tailscale may still serve this computer\'s studio. Tailscale still serves home.example.ts.net:443')
    // Without Tailscale nothing serves; a row without an address asks Tailscale for this machine's name.
    await expect(reach({ tailscale: tailscale({ version: { code: null, stdout: '', stderr: '' }, 'serve status': { code: null, stdout: '', stderr: '' } }) }).run(['off'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('Tailscale is not installed')
    writeReachRow(delorunHome, 'default', REACH_OFF)
    const calls: string[][] = []
    await expect(reach({ tailscale: tailscale({}, calls) }).run(['off'], context)).resolves.toBe(EXIT.ok)
    expect(calls.map(call => call[0])).toEqual(['version', 'status', 'serve'])
    await expect(reach({ tailscale: () => Promise.reject(new Error('broken runner')) }).run(['off'], context)).rejects.toThrow('broken runner')
  })

  it('reports the row, and the running home\'s state', async () => {
    await reach().run(['status'], context)
    expect(out.stdout).toContain('Remote access is off. Turn it on with delorun reach on tailscale.')
    expect(out.stdout).not.toContain('is not running')
    await reach().run(['on', 'tailscale'], context)
    out.stdout = ''
    await reach().run(['status'], context)
    expect(out.stdout).toContain('Delorun is not running, so the address does not work until you run delorun start.')
    out.stdout = ''
    // The live state answers only the studio's own page, so a running home is pointed to, never asked over HTTP.
    await reach({ running: () => true }).run(['status'], context)
    expect(out.stdout).toContain(`Remote access is on over Tailscale at https://${HOST}`)
    expect(out.stdout).toContain('Settings → Devices')
  })

  it('applies a change to the running home and prints each option\'s live state, and names what the home answered otherwise', async () => {
    const sent: string[] = []
    const answering = (answer: (op: string) => ResponseLine[] | Error) => async (_home: string, _profile: string, request: UnsignedRequest): Promise<ResponseLine[]> => {
      sent.push(request.op)
      const lines = answer(request.op)
      return lines instanceof Error ? Promise.reject(lines) : Promise.resolve(lines)
    }
    const ready = { option: 'tailscale-private', state: 'ready', address: `https://${HOST}` }
    await expect(reach({ running: () => true, send: answering(() => [{ ok: true, options: [ready] }]) }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.ok)
    expect(sent).toEqual(['reach.apply'])
    expect(out.stdout).toContain(`Remote access over Tailscale is ready at https://${HOST}`)
    expect(out.stdout).toContain(`Open https://${HOST}/auth/sign-in on the phone`)
    const failures: [ResponseLine[] | Error, string][] = [
      [new Error('no socket'), 'the home process did not answer (no socket)'],
      [[], 'the home process closed the request without an answer'],
      [[{ ok: false, error: 'REACH_UNAVAILABLE', detail: 'not loaded' }], 'the home process refused with REACH_UNAVAILABLE: not loaded'],
      [[{ ok: false, error: 'BUSY' }], 'the home process refused with BUSY.'],
      [[{ ok: true, options: 'x' }], 'the home process answered with states this command cannot read'],
      [[{ ok: true, options: [null] }], 'the home process answered with states this command cannot read'],
      [[{ ok: true, options: [{ option: 'tailscale-private' }] }], 'the home process answered with states this command cannot read'],
    ]
    for (const [answer, reason] of failures) {
      out.stderr = ''
      await expect(reach({ running: () => true, send: answering(op => (op === 'reach.apply' ? answer : [])) }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
      expect(out.stderr).toContain(reason)
      expect(out.stderr).toContain('Restart Delorun to apply it: delorun stop, then delorun start.')
    }
    out.stderr = ''
    // oxlint-disable-next-line prefer-promise-reject-errors -- a socket library that rejects with a bare value.
    await expect(reach({ running: () => true, send: () => Promise.reject('closed') }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('the home process did not answer (closed)')
    // A start the home answers as blocked names its cause, and the command fails.
    out.stdout = ''
    out.stderr = ''
    const blocked = { option: 'tailscale-private', state: 'blocked', cause: 'TAILSCALE_FUNNEL_ON', detail: 'Funnel is on' }
    await expect(reach({ running: () => true, send: answering(() => [{ ok: true, options: [blocked] }]) }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(out.stdout).toContain('Remote access over Tailscale is blocked (TAILSCALE_FUNNEL_ON): Funnel is on')
    expect(out.stderr).toContain('did not make the address ready')
    // Off closes the running listener through the same request.
    out.stdout = ''
    await expect(reach({ running: () => true, send: answering(() => [{ ok: true, options: [{ option: 'tailscale-private', state: 'off' }] }]) }).run(['off'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('Remote access over Tailscale is off')
    out.stderr = ''
    await expect(reach({ running: () => true, send: answering(() => []) }).run(['off'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('Restart Delorun to close it')
    // Status reads the live state, and says when it cannot.
    out.stdout = ''
    await reach({ running: () => true, send: answering(() => [{ ok: true, options: [{ ...ready, state: 'degraded', cause: 'X' }] }]) }).run(['status'], context)
    expect(out.stdout).toContain(`Remote access over Tailscale is degraded at https://${HOST} (X): `)
    await reach({ running: () => true, send: answering(() => []) }).run(['status'], context)
    expect(out.stdout).toContain('its live state could not be read')
  })

  it('hands the running Host\'s reach service to the update channel, reading the row when an apply arrives', async () => {
    expect(localReach({ get: () => undefined } as never, () => ({}))).toBeUndefined()
    const applied: unknown[] = []
    const service = {
      mounted: true,
      status: () => [{ option: 'tailscale-private', state: 'ready', address: `https://${HOST}` }, { option: 'tailscale-private', state: 'blocked', cause: 'C', detail: 'D' }],
      apply: async (rows: unknown) => { applied.push(rows); return Promise.resolve([{ option: 'tailscale-private', state: 'off' }]) },
    }
    const rows = reachRowsOf({ ...REACH_OFF, enabled: true, address: `https://${HOST}` })
    const local = localReach({ get: () => service } as never, () => rows)
    expect(local?.status()).toEqual([{ option: 'tailscale-private', state: 'ready', address: `https://${HOST}` }, { option: 'tailscale-private', state: 'blocked', cause: 'C', detail: 'D' }])
    await expect(local?.apply()).resolves.toEqual([{ option: 'tailscale-private', state: 'off' }])
    expect(applied).toEqual([{ tailscalePrivate: { ...REACH_OFF, enabled: true, address: `https://${HOST}` } }])
    const unloaded = localReach({ get: () => ({ ...service, mounted: false, apply: async () => Promise.resolve(undefined) }) } as never, () => rows)
    expect(unloaded?.status()).toBeUndefined()
    await expect(unloaded?.apply()).resolves.toBeUndefined()
  })

  it('reads a home\'s lock to tell whether Delorun runs', async () => {
    expect(homeRuns(delorunHome, 'default')).toBe(false)
    mkdirSync(runDirectory(delorunHome, 'default'), { recursive: true, mode: 0o700 })
    const lock = await acquireHomeLock({ runDirectory: runDirectory(delorunHome, 'default'), runtime: brandString<RuntimeVersion>('0.0.0'), probe: () => Promise.resolve('silent'), startId: newStartId() })
    try {
      expect(homeRuns(delorunHome, 'default')).toBe(true)
    } finally {
      lock.release()
    }
  })
})

/** A scripted home socket and prompt for `delorun devices`. */
function devices(overrides: Partial<DevicesDependencies> & { readonly lines?: ResponseLine[][]; readonly answers?: (string | undefined)[] } = {}): { command: ReturnType<typeof createDevicesCommand>; sent: UnsignedRequest[] } {
  const sent: UnsignedRequest[] = []
  const lines = [...(overrides.lines ?? [])]
  const answers = [...(overrides.answers ?? [])]
  const command = createDevicesCommand({
    running: () => true,
    send: async (_home, _profile, request) => {
      sent.push(request)
      return Promise.resolve(lines.shift() ?? [])
    },
    ask: () => Promise.resolve(answers.shift()),
    terminal: true,
    pin: { secret: () => Promise.resolve(undefined), stdinLine: () => Promise.resolve(undefined), interactive: false, stdinIsTerminal: false, now: () => 0 },
    ...overrides,
  })
  return { command, sent }
}

const PENDING = { requestId: 'AAAAAAAAAAAAAAAAAAAAAA', label: 'Phone', platform: 'iOS', address: `https://${HOST}`, createdAt: 0, expiresAt: 1 }
const SECOND = { requestId: 'BBBBBBBBBBBBBBBBBBBBBB', label: 'Tablet', platform: '', address: `https://${HOST}`, createdAt: 1000, expiresAt: 2 }

describe('delorun devices', () => {
  // Putting the `powers` action back makes this command run instead of refusing with the usage code.
  it('no longer has a powers action: `delorun devices powers` is an unknown action', async () => {
    const { command } = devices()
    await expect(command.run(['powers'], context)).rejects.toMatchObject({ exit: EXIT.usage, message: expect.stringContaining('unknown action "powers"') })
  })

  beforeEach(() => {
    writeReachRow(delorunHome, 'default', { ...REACH_OFF, enabled: true, address: `https://${HOST}/` })
  })

  it('fails at once, without waiting, when remote access is off', async () => {
    writeReachRow(delorunHome, 'default', REACH_OFF)
    const { command, sent } = devices()
    await expect(command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(sent).toEqual([])
    expect(out.stderr).toBe('! Remote access is off, so no phone can reach this studio. Turn it on first: delorun reach on tailscale\n')
  })

  it('approves the waiting device with the typed code, giving a wrong code another try', async () => {
    const { command, sent } = devices({
      lines: [
        [{ ok: true, closesAt: 1, pending: [PENDING] }],
        [{ ok: false, error: 'APPROVAL_FAILED', detail: 'APPROVAL_CODE_MISMATCH: wrong' }],
        [{ ok: true, device: { id: 'd', label: 'Phone', address: PENDING.address } }],
      ],
      answers: ['1', '0000 0000', '1234 5678'],
    })
    await expect(command.run(['approve'], context)).resolves.toBe(EXIT.ok)
    expect(sent).toEqual([
      { op: 'devices.approve', args: {} },
      { op: 'devices.approve', args: { requestId: PENDING.requestId, typedCode: '0000 0000' } },
      { op: 'devices.approve', args: { requestId: PENDING.requestId, typedCode: '1234 5678' } },
    ])
    expect(out.stdout).toContain(`  1. Phone (iOS), asked at ${readableTime(0)}, request AAAAAAAA\n`)
    expect(out.stdout).toContain('Approved Phone.')
    expect(out.stderr).toContain('Try again.')
    // The waiting line names the sign-in page the phone opens.
    expect(out.stdout).toContain(`Open https://${HOST}/auth/sign-in on it and choose Ask for approval.`)
  })

  it('lists every pending request and approves the one the person chooses', async () => {
    const asked: string[] = []
    const answers = ['3', 'abc', ' 2 ', '1234 5678']
    const { command, sent } = devices({
      lines: [[{ ok: true, closesAt: 1, pending: [PENDING, SECOND] }], [{ ok: true, device: { id: 'd' } }]],
      ask: (message) => { asked.push(message); return Promise.resolve(answers.shift()) },
    })
    await expect(command.run(['approve'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('  1. Phone (iOS)')
    expect(out.stdout).toContain(`  2. Tablet, asked at ${readableTime(1000)}, request BBBBBBBB\n`)
    // Pins the choice: without it the first request, which any tailnet device may have sent, is the one approved.
    expect(sent.at(-1)).toEqual({ op: 'devices.approve', args: { requestId: SECOND.requestId, typedCode: '1234 5678' } })
    expect(out.stderr).toContain('Type a number from 1 to 2, or c and a number.')
    expect(asked.at(-1)).toBe('Type the 8-digit code Tablet shows')
    expect(out.stdout).toContain('Approved Tablet.')
  })

  it('cancels the request the person chooses and shows the requests again', async () => {
    const { command, sent } = devices({
      lines: [
        [{ ok: true, closesAt: 1, pending: [PENDING, SECOND] }],
        [{ ok: true, cancelled: PENDING.requestId }],
        [{ ok: true, closesAt: 1, pending: [SECOND] }],
        [{ ok: true, device: { id: 'd' } }],
      ],
      answers: ['c 1', '1', '1234 5678'],
    })
    await expect(command.run(['approve'], context)).resolves.toBe(EXIT.ok)
    // Pins the cancel: the person frees the place of a request they do not know, and only that one.
    expect(sent).toEqual([
      { op: 'devices.approve', args: {} },
      { op: 'devices.approve', args: { cancelRequestId: PENDING.requestId } },
      { op: 'devices.approve', args: {} },
      { op: 'devices.approve', args: { requestId: SECOND.requestId, typedCode: '1234 5678' } },
    ])
    expect(out.stdout).toContain('Cancelled the request of Phone.')
    for (const answer of ['cancel 2', 'C2']) {
      const other = devices({ lines: [[{ ok: true, pending: [PENDING, SECOND] }], [{ ok: true }]], answers: [answer] })
      await other.command.run(['approve'], context)
      expect(other.sent[1]).toEqual({ op: 'devices.approve', args: { cancelRequestId: SECOND.requestId } })
    }
  })

  it('after three wrong codes for one request, shows the others still waiting', async () => {
    const wrong = { ok: false, error: 'APPROVAL_FAILED', detail: 'APPROVAL_CODE_MISMATCH: wrong' }
    const { command, sent } = devices({
      lines: [[{ ok: true, pending: [PENDING, SECOND] }], [wrong], [wrong], [wrong], [{ ok: true, pending: [SECOND] }], [{ ok: true }]],
      answers: ['1', '1', '2', '3', '1', '1234 5678'],
    })
    await expect(command.run(['approve'], context)).resolves.toBe(EXIT.ok)
    expect(out.stderr).toContain('Three wrong codes cancelled this request; any other request still waits.')
    expect(sent.at(-1)).toEqual({ op: 'devices.approve', args: { requestId: SECOND.requestId, typedCode: '1234 5678' } })
  })

  it('shows the requests again when the chosen one ended on its own', async () => {
    const expired = { ok: false, error: 'APPROVAL_FAILED', detail: 'APPROVAL_EXPIRED: gone' }
    const approving = devices({ lines: [[{ ok: true, pending: [PENDING] }], [expired], [{ ok: true, pending: [SECOND] }], [{ ok: true }]], answers: ['1', '1234 5678', '1', '1234 5678'] })
    await expect(approving.command.run(['approve'], context)).resolves.toBe(EXIT.ok)
    expect(out.stderr).toContain('That request is no longer waiting.')
    expect(out.stdout).toContain('Approved Tablet.')
    const cancelling = devices({ lines: [[{ ok: true, pending: [PENDING] }], [expired], [{ ok: true, pending: [] }]], answers: ['c1'] })
    await expect(cancelling.command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(cancelling.sent.at(-1)).toEqual({ op: 'devices.approve', args: {} })
    expect(out.stderr).toContain('No device asked for approval')
  })

  it('escapes the control and bidirectional characters a request or a record carries', async () => {
    const planted = { ...PENDING, label: 'Ph\u001b[2Jone\u202e', platform: 'iOS\r\n\u2066', requestId: '\u001b]0;x\u0007AAAAAAAAAAAAAA' }
    const asked: string[] = []
    const answers = ['1', '1234 5678']
    const { command } = devices({ lines: [[{ ok: true, pending: [planted] }], [{ ok: true }]], ask: (message) => { asked.push(message); return Promise.resolve(answers.shift()) } })
    await expect(command.run(['approve'], context)).resolves.toBe(EXIT.ok)
    // Pins the escape on print: without it the label clears the screen and reverses the text that follows it.
    expect(out.stdout).toContain(`Ph\\u001b[2Jone\\u202e (iOS\\u000d\\u000a\\u2066), asked at ${readableTime(0)}, request \\u001b]0;x\\u0007`)
    expect(out.stdout).toContain('Approved Ph\\u001b[2Jone\\u202e.')
    expect(asked).toContain('Type the 8-digit code Ph\\u001b[2Jone\\u202e shows')
    const base: DeviceSummary = { id: brandString<DeviceId>('dev\u009b1'), label: 'Ph\u2067one', platform: 'i\u0000OS', address: brandString<StudioAddress>(`https://${HOST}\u0008`), approvedAt: 0, approvedBy: brandString<DeviceId>('dev\u007f2'), lastSignInAt: null }
    const listed = vi.spyOn(HomeAuth.prototype, 'devices').mockResolvedValue({ owner: { claimedAt: 0, firstDeviceId: 'local' }, devices: [base] })
    try {
      out.stdout = ''
      await expect(devices().command.run(['list'], context)).resolves.toBe(EXIT.ok)
      expect(out.stdout).toBe(`dev\\u009b1  Ph\\u2067one (i\\u0000OS)\n    https://${HOST}\\u0008, approved by dev\\u007f2 ${readableTime(0)}, never signed in\n`)
    } finally {
      listed.mockRestore()
    }
  })

  it('refuses an approval without a running home, a closed window, a refusal, a cancel and an unreadable list', async () => {
    await expect(devices({ running: () => false }).command.run(['approve'], context)).resolves.toBe(EXIT.notRunning)
    expect(out.stderr).toContain("Delorun isn't running. Start it with: delorun start")
    await expect(devices({ lines: [[{ ok: true, closesAt: 1, pending: [] }]] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [[{ ok: true, closesAt: 1 }]] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [[{ ok: false, error: 'LOOPBACK_REQUIRED', detail: 'needs you' }]] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('LOOPBACK_REQUIRED (needs you)')
    await expect(devices({ lines: [[{ ok: false, error: 'APPROVALS_UNAVAILABLE' }]] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [[{ ok: true, pending: [{ ...PENDING, platform: '' }] }]], answers: [undefined] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('cancelled; no device was approved')
    await expect(devices({ lines: [[{ ok: true, pending: [PENDING] }]], answers: ['1', undefined] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [[{ ok: true, pending: [PENDING] }], [{ ok: false, error: 'SCHEMA_VIOLATION' }]], answers: ['1', 'x'] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('no device was approved: SCHEMA_VIOLATION')
    await expect(devices({ lines: [[{ ok: true, pending: [PENDING] }], [{ ok: false, error: 'APPROVAL_FAILED', detail: 'NO_OWNER: none' }]], answers: ['c1'] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('the request was not cancelled: NO_OWNER: none')
    for (const pending of [{}, [null], [{ ...PENDING, label: 7 }], [{ ...PENDING, createdAt: '0' }], [{ ...PENDING, createdAt: Number.NaN }]]) {
      await expect(devices({ lines: [[{ ok: true, pending }]] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    }
    expect(out.stderr).toContain('a list of requests this command cannot read')
  })

  it('lists the home\'s devices from its records, and says when there is none', async () => {
    await expect(devices().command.run(['list'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('No device is trusted on this computer yet')
    const auth = new HomeAuth({ directory: join(delorunHome, 'secrets', 'home-auth') })
    await auth.start()
    await auth.claim({ listener: 'loopback', host: '127.0.0.1:3080', source: 'local', ownerCode: (await auth.issueOwnerCode()).code, devicePublicKey: { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>('A'.repeat(43)), y: brandString<Base64Url>('B'.repeat(43)) }, label: 'This computer', address: brandString<StudioAddress>('http://127.0.0.1:3080') })
    await auth.stop()
    out.stdout = ''
    await devices().command.run(['list'], context)
    expect(out.stdout).toContain('This computer')
    expect(out.stdout).toContain('claimed this home')
    expect(out.stdout).toContain('never signed in')
    writeFileSync(join(delorunHome, 'secrets', 'home-auth', 'owner.json'), '{"v":2}', { mode: 0o600 })
    await expect(devices().command.run(['list'], context)).resolves.toBe(EXIT.failed)
  })

  it('describes each device by who approved it and when it last signed in', async () => {
    const base: DeviceSummary = { id: brandString<DeviceId>('dev-1'), label: 'Phone', platform: 'iOS', address: brandString<StudioAddress>(`https://${HOST}`), approvedAt: 0, approvedBy: 'local', lastSignInAt: 0 }
    const second: DeviceSummary = { ...base, id: brandString<DeviceId>('dev-2'), platform: '', approvedBy: brandString<DeviceId>('dev-1') }
    const listed = vi.spyOn(HomeAuth.prototype, 'devices').mockResolvedValue({ owner: { claimedAt: 0, firstDeviceId: 'local' }, devices: [base, second] })
    try {
      await expect(devices().command.run(['list'], context)).resolves.toBe(EXIT.ok)
      expect(out.stdout).toContain('dev-1  Phone (iOS)')
      expect(out.stdout).toContain(`approved at this computer ${readableTime(0)}, last signed in ${readableTime(0)}`)
      expect(out.stdout).toContain('dev-2  Phone\n')
      expect(out.stdout).toContain('approved by dev-1')
      // A failure that is not the home's own record error reaches the caller unchanged.
      listed.mockRejectedValue(new Error('disk gone'))
      await expect(devices().command.run(['list'], context)).rejects.toThrow('disk gone')
    } finally {
      listed.mockRestore()
    }
  })

  it('passes on a failure of the records that is not the home\'s own', async () => {
    const revoked = vi.spyOn(HomeAuth.prototype, 'revokeDevice').mockRejectedValue(new Error('disk gone'))
    try {
      await expect(devices({ running: () => false }).command.run(['remove', 'dev-1'], context)).rejects.toThrow('disk gone')
    } finally {
      revoked.mockRestore()
    }
  })

  it('removes a device through the home socket when Delorun runs, or on the records when it does not', async () => {
    const removed = devices({ lines: [[{ ok: true, removed: true, sessions: 2, connections: 1 }]] })
    await expect(removed.command.run(['remove', 'dev-1', '--profile', 'default'], context)).resolves.toBe(EXIT.ok)
    // Pins the channel: the removal goes over the home socket, which only the person's own command can use.
    expect(removed.sent).toEqual([{ op: 'devices.remove', args: { deviceId: 'dev-1' } }])
    expect(out.stdout).toContain('2 session(s) ended')
    await expect(devices({ lines: [[{ ok: false, error: 'REMOVAL_FAILED', detail: 'NO_OWNER: No owner' }]] }).command.run(['remove', 'dev-1'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('REMOVAL_FAILED (NO_OWNER: No owner)')
    await expect(devices({ lines: [[{ ok: false, error: 'LOOPBACK_REQUIRED' }]] }).command.run(['remove', 'dev-1'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('LOOPBACK_REQUIRED')
    await expect(devices({ running: () => false }).command.run(['remove', 'dev-1'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('no owner yet')
    await expect(devices().command.run(['remove'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(devices().command.run(['remove', '--profile', 'default'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(devices().command.run(['remove', '--profile=default'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    // A device id may begin with `-`, as base64url text does.
    const dashed = devices({ lines: [[{ ok: true, removed: true, sessions: 0, connections: 0 }]] })
    await expect(dashed.command.run(['remove', '-y1', '--profile', 'default'], context)).resolves.toBe(EXIT.ok)
    expect(dashed.sent).toEqual([{ op: 'devices.remove', args: { deviceId: '-y1' } }])
  })

  it('removes a device on the records of a home that is not running', async () => {
    const auth = new HomeAuth({ directory: join(delorunHome, 'secrets', 'home-auth') })
    await auth.start()
    await auth.openApprovalWindow()
    await auth.stop()
    await expect(devices({ running: () => false }).command.run(['remove', 'dev-1'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('0 session(s) ended')
  })

  it('prints an owner code only to a terminal', async () => {
    await expect(devices().command.run(['code'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toMatch(/Owner code: [A-Z2-7]{26}/)
    out.stdout = ''
    await devices({ terminal: false }).command.run(['code'], context)
    expect(out.stdout).toContain('only to a terminal')
    await expect(devices().command.run([], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(devices().command.run(['wipe'], context)).rejects.toMatchObject({ exit: EXIT.usage })
  })
})

describe('the pieces the commands share', () => {
  it('reads the reach row, or off', () => {
    const path = join(delorunHome, 'profiles', 'default', 'cordis.patch.yml')
    expect(readReachRow(delorunHome, 'default')).toEqual(REACH_OFF)
    for (const text of ['just: a map\n', '- 1\n- ~\n- id: delorun-reach\n', '- id: delorun-reach\n  config: {}\n', '- id: delorun-reach\n  config: ~\n', '- id: other\n', '- id: delorun-reach\n  config:\n    tailscalePrivate: 1\n']) {
      writeFileSync(path, text)
      expect(readReachRow(delorunHome, 'default')).toEqual(REACH_OFF)
    }
    writeFileSync(path, '- id: delorun-reach\n  config:\n    tailscalePrivate:\n      enabled: yes\n')
    expect(readReachRow(delorunHome, 'default')).toEqual(REACH_OFF)
    writeFileSync(path, '- id: delorun-reach\n  config:\n    tailscalePrivate:\n      listenerPort: 23456\n      serveCheckIntervalMs: 5000\n')
    expect(readReachRow(delorunHome, 'default')).toEqual({ ...REACH_OFF, listenerPort: 23_456, serveCheckIntervalMs: 5000 })
  })

  it('keeps a recorded listener port unless it is unset, or held by another program while Delorun is stopped', async () => {
    const port = await chooseListenerPort(LISTENER_PORT_RANGE)
    await expect(listenerPortFor(port, false)).resolves.toBe(port)
    const held = createServer()
    await new Promise<void>((resolve) => { held.listen(port, '127.0.0.1', () => { resolve() }) })
    try {
      // A running home holds the port itself.
      await expect(listenerPortFor(port, true)).resolves.toBe(port)
      // Pins the re-choice: a port another program holds would refuse every start.
      await expect(listenerPortFor(port, false)).resolves.not.toBe(port)
    } finally {
      await new Promise<void>((resolve) => { held.close(() => { resolve() }) })
    }
    for (const unset of [0, 70_000, 1.5]) await expect(listenerPortFor(unset, true)).resolves.toBeGreaterThanOrEqual(LISTENER_PORT_RANGE.min)
  })

  it('gives the home process the Host\'s local approval, or nothing without home-auth', async () => {
    expect(localDeviceApproval({ get: () => undefined })).toBeUndefined()
    const calls: string[] = []
    const homeAuth = {
      openApprovalWindow: () => { calls.push('open'); return Promise.resolve(5) },
      approvalWindowOpenUntil: () => 5,
      pendingApprovals: () => [],
      approveLocally: (id: string, code: string) => { calls.push(`${id} ${code}`); return Promise.resolve({ id: 'd', label: 'Phone', address: 'a', platform: '' }) },
      cancelApproval: (id: string) => { calls.push(`cancel ${id}`) },
      revokeDevice: (id: string) => { calls.push(`remove ${id}`); return Promise.resolve({ removed: true, sessions: 2, connections: 1, extra: 'dropped' }) },
      elevationsAtComputer: () => unlocks,
      devices: () => Promise.resolve({ devices: [{ id: 'phone', label: 'Phone', platform: 'iOS' }] }),
      approveElevation: (id: string, code: string) => { calls.push(`elevate ${id} ${code}`); return { ...RUNNING, deviceId: 'phone', listener: 'reach-tailscale-private', sessionId: 's', startedAt: 0 } },
      revokeElevation: (id: string) => { calls.push(`revoke ${id}`); return true },
    }
    let unlocks: { pending: unknown[]; running: unknown[] } = { pending: [], running: [] }
    const approval = localDeviceApproval({ get: (name: string) => (name === 'homeAuth' ? homeAuth : undefined) } as never)
    await expect(approval?.openWindow()).resolves.toBe(5)
    expect(approval?.windowOpenUntil()).toBe(5)
    expect(approval?.pending()).toEqual([])
    await expect(approval?.approve('r', '1')).resolves.toEqual({ id: 'd', label: 'Phone', address: 'a' })
    approval?.cancel('r')
    await expect(approval?.remove('d')).resolves.toEqual({ removed: true, sessions: 2, connections: 1 })
    // A home with nothing to name is not asked for its devices, which it refuses without an owner.
    await expect(approval?.elevations()).resolves.toEqual({ pending: [], running: [] })
    unlocks = {
      pending: [{ requestId: 'r', deviceId: 'phone', listener: 'reach-tailscale-private', sessionId: 's', requestedAt: 1, expiresAt: 2 }],
      running: [{ id: 'e', deviceId: 'gone', listener: 'reach-tailscale-private', sessionId: 't', startedAt: 0, endsAt: 3 }],
    }
    await expect(approval?.elevations()).resolves.toEqual({
      pending: [{ requestId: 'r', deviceId: 'phone', label: 'Phone', platform: 'iOS', requestedAt: 1, expiresAt: 2 }],
      running: [{ id: 'e', deviceId: 'gone', label: '', platform: '', endsAt: 3 }],
    })
    expect(approval?.approveElevation('r', '1')).toEqual({ id: RUNNING.id, deviceId: 'phone', endsAt: RUNNING.endsAt })
    expect(approval?.revokeElevation('e')).toBe(true)
    expect(calls).toEqual(['open', 'r 1', 'cancel r', 'remove d', 'elevate r 1', 'revoke e'])
  })
})

const REQUEST = { requestId: 'CCCCCCCCCCCCCCCCCCCCCC', deviceId: 'phone', label: 'Phone', platform: 'iOS', requestedAt: 0, expiresAt: 1 }
const RUNNING = { id: 'DDDDDDDDDDDDDDDDDDDDDD', deviceId: 'laptop', label: 'Laptop', platform: '', endsAt: 900_000 }

describe('delorun devices elevate', () => {
  it('lists the requests and the unlocks, and unlocks the chosen device with the code it shows', async () => {
    const { command, sent } = devices({
      lines: [
        [{ ok: true, pending: [REQUEST], running: [RUNNING] }],
        [{ ok: false, error: 'ELEVATION_FAILED', detail: 'APPROVAL_CODE_MISMATCH: Type it again' }],
        [{ ok: true, elevation: { id: 'e', deviceId: 'phone', endsAt: 900_000 } }],
      ],
      answers: ['2', 'x', '1', '0000 0000', '1234 5678'],
    })
    await expect(command.run(['elevate'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain(`  1. Phone (iOS) asks to unlock, asked at ${readableTime(0)}, request CCCCCCCC\n`)
    expect(out.stdout).toContain(`  2. Laptop is unlocked until ${readableTime(900_000)}\n`)
    // Pins the kind check: a number alone never approves anything for a device that is unlocked already.
    expect(out.stderr).toContain('That device is unlocked already. Type e and its number to end the unlock.')
    expect(out.stderr).toContain('Type a number from 1 to 2, or e and a number.')
    expect(out.stderr).toContain('Try again.')
    expect(sent).toEqual([
      { op: 'devices.elevate', args: {} },
      { op: 'devices.elevate', args: { requestId: REQUEST.requestId, typedCode: '0000 0000' } },
      { op: 'devices.elevate', args: { requestId: REQUEST.requestId, typedCode: '1234 5678' } },
    ])
    expect(out.stdout).toContain(`Unlocked sensitive actions on Phone until ${readableTime(900_000)}.`)
  })

  it('ends a running unlock or declines a request, and shows the rest again', async () => {
    const ending = devices({
      lines: [
        [{ ok: true, pending: [REQUEST], running: [RUNNING] }],
        [{ ok: true, revoked: true }],
        [{ ok: true, pending: [REQUEST], running: [] }],
        [{ ok: true, revoked: false }],
        [{ ok: true, pending: [], running: [] }],
      ],
      answers: ['e 2', 'END1'],
    })
    await expect(ending.command.run(['elevate'], context)).resolves.toBe(EXIT.ok)
    expect(ending.sent).toEqual([
      { op: 'devices.elevate', args: {} },
      { op: 'devices.elevate', args: { revokeId: RUNNING.id } },
      { op: 'devices.elevate', args: {} },
      { op: 'devices.elevate', args: { revokeId: REQUEST.requestId } },
      { op: 'devices.elevate', args: {} },
    ])
    expect(out.stdout).toContain('Ended the unlock of Laptop.')
    expect(out.stderr).toContain('That request or unlock had ended already.')
    expect(out.stdout).toContain('No device asks to unlock sensitive actions')
    const declining = devices({ lines: [[{ ok: true, pending: [REQUEST], running: [] }], [{ ok: true, revoked: true }], [{ ok: true, pending: [], running: [] }]], answers: ['e1'] })
    await expect(declining.command.run(['elevate'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('Declined the request of Phone.')
  })

  it('shows the list again after the third wrong code or a request that ended on its own', async () => {
    const wrong = { ok: false, error: 'ELEVATION_FAILED', detail: 'APPROVAL_CODE_MISMATCH: wrong' }
    const listed = { ok: true, pending: [REQUEST], running: [] }
    const empty = { ok: true, pending: [], running: [] }
    const guessing = devices({ lines: [[listed], [wrong], [wrong], [wrong], [empty]], answers: ['1', '1', '2', '3'] })
    await expect(guessing.command.run(['elevate'], context)).resolves.toBe(EXIT.ok)
    expect(out.stderr).toContain('Three wrong codes cancelled this request')
    const expired = devices({ lines: [[listed], [{ ok: false, error: 'ELEVATION_FAILED', detail: 'APPROVAL_EXPIRED: gone' }], [empty]], answers: ['1', '1'] })
    await expect(expired.command.run(['elevate'], context)).resolves.toBe(EXIT.ok)
    expect(out.stderr).toContain('That request is no longer waiting.')
  })

  it('refuses without a running home, on a refusal, a cancel and an unreadable list', async () => {
    await expect(devices({ running: () => false }).command.run(['elevate'], context)).resolves.toBe(EXIT.notRunning)
    expect(out.stderr).toContain("Delorun isn't running. Start it with: delorun start")
    await expect(devices({ lines: [[{ ok: false, error: 'LOOPBACK_REQUIRED', detail: 'needs you' }]] }).command.run(['elevate'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('Delorun refused: LOOPBACK_REQUIRED (needs you)')
    const listed = { ok: true, pending: [REQUEST], running: [RUNNING] }
    await expect(devices({ lines: [[listed]], answers: [undefined] }).command.run(['elevate'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('cancelled; nothing changed')
    await expect(devices({ lines: [[listed]], answers: ['1', undefined] }).command.run(['elevate'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('cancelled; nothing was unlocked')
    await expect(devices({ lines: [[listed], [{ ok: false, error: 'ELEVATION_FAILED', detail: 'NO_OWNER: none' }]], answers: ['1', '12345678'] }).command.run(['elevate'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('nothing was unlocked: NO_OWNER: none')
    await expect(devices({ lines: [[listed], [{ ok: false, error: 'ELEVATION_FAILED' }]], answers: ['e2'] }).command.run(['elevate'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('nothing was ended: ELEVATION_FAILED')
    for (const answer of [{}, { pending: [] }, { pending: [], running: {} }, { pending: [null], running: [] }, { pending: [{ ...REQUEST, label: 7 }], running: [] }, { pending: [], running: [{ ...RUNNING, endsAt: Number.NaN }] }, { pending: [], running: [{ ...RUNNING, endsAt: '0' }] }]) {
      await expect(devices({ lines: [[{ ok: true, ...answer }]] }).command.run(['elevate'], context)).resolves.toBe(EXIT.failed)
    }
    expect(out.stderr).toContain('a list of unlocks this command cannot read')
  })

  it('says only what it can read of the unlock the home started, and escapes a device\'s name', async () => {
    const planted = { ...REQUEST, label: 'Ph\u001b[2Jone', platform: 'iOS\u202e' }
    for (const elevation of [undefined, null, { endsAt: 'soon' }, { endsAt: Number.NaN }]) {
      out.stdout = ''
      const { command } = devices({ lines: [[{ ok: true, pending: [planted], running: [] }], [{ ok: true, elevation }]], answers: ['1', '12345678'] })
      await expect(command.run(['elevate'], context)).resolves.toBe(EXIT.ok)
      expect(out.stdout).toContain('Unlocked sensitive actions on Ph\\u001b[2Jone. End it sooner')
    }
    expect(out.stdout).toContain('Ph\\u001b[2Jone (iOS\\u202e) asks to unlock')
  })
})

describe('setup\'s reach section', () => {
  const draft = { phase: 'single', answers: { reach: { option: 'none', identityFactor: null } }, secret: undefined } as never
  const mainDraft = { phase: 'main', answers: { reach: { option: 'none', identityFactor: null } }, secret: undefined } as never
  const io = (answers: readonly (boolean | string | typeof BACK)[], notes: string[], initials: string[] = []) => {
    const queue = [...answers]
    return {
      confirm: () => Promise.resolve(queue.shift()),
      select: (_message: string, _options: unknown, initial: string) => { initials.push(initial); return Promise.resolve(queue.shift()) },
      note: (body: string) => { notes.push(body) },
    } as never
  }

  it('asks, checks Tailscale, shows the trust statement and writes the row', async () => {
    const notes: string[] = []
    const section = reachSection(tailscale(), () => false)
    expect(section.appliesTo({} as never)).toBe(true)
    const on = await section.ask(io([true, false], notes), draft, { home: delorunHome, profile: 'default' } as never)
    expect(on).toEqual({ answers: { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership', pairing: 'own-user' } }, status: 'answered' })
    // Pins the second question: any device on the tailnet may ask only when the person says so, and going back returns.
    await expect(section.ask(io([true, true], notes), draft, { home: delorunHome, profile: 'default' } as never)).resolves.toEqual({ answers: { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership', pairing: 'tailnet' } }, status: 'answered' })
    await expect(section.ask(io([true, BACK], notes), draft, { home: delorunHome, profile: 'default' } as never)).resolves.toBe(BACK)
    expect(notes.some(note => note.includes(TRUST_STATEMENT[0]!))).toBe(true)
    const directory = join(delorunHome, 'profiles', 'default')
    const answers = { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership', pairing: 'tailnet' } } as never
    await expect(section.apply({ home: delorunHome, env: {}, directory, secret: undefined }, answers)).resolves.toContain('ask to pair')
    expect(readPairingAt(join(directory, 'cordis.patch.yml')).mayAskWithoutWindow).toBe('tailnet')
    const row = readReachRow(delorunHome, 'default')
    expect(row).toEqual({ enabled: true, address: `https://${HOST}`, servePort: 443, listenerPort: expect.any(Number), serveCheckIntervalMs: 60_000, elevationMinutes: 15 })
    // Applying again keeps the port chosen once.
    await section.apply({ home: delorunHome, env: {}, directory, secret: undefined }, answers)
    expect(readReachRow(delorunHome, 'default').listenerPort).toBe(row.listenerPort)
  })

  it('asks "Use Delorun from your other devices too? (phone, tablet, another computer, over Tailscale)" in the main flow with No preselected, runs the checks on Yes and keeps the safe pairing without asking', async () => {
    const notes: string[] = []
    const initials: string[] = []
    const asked: string[] = []
    const mainIo = (answers: readonly (string | typeof BACK)[]) => {
      const queue = [...answers]
      return {
        confirm: (message: string) => { asked.push(message); return Promise.resolve(queue.shift()) },
        select: (message: string, options: { value: string, label: string }[], initial: string) => { asked.push(`${message} ${options.map(option => option.label).join(' / ')}`); initials.push(initial); return Promise.resolve(queue.shift()) },
        note: (body: string) => { notes.push(body) },
      } as never
    }
    const section = reachSection(tailscale(), () => false)
    const environment = { home: delorunHome, profile: 'default' } as never
    await expect(section.ask(mainIo(['no']), mainDraft, environment)).resolves.toEqual({ answers: { useCase: 'local', reach: { option: 'none', identityFactor: null } }, status: 'answered' })
    expect(asked).toEqual(['Use Delorun from your other devices too? (phone, tablet, another computer, over Tailscale) No, just this computer / Yes, over Tailscale'])
    expect(initials).toEqual(['no'])
    await expect(section.ask(mainIo(['yes']), mainDraft, environment)).resolves.toEqual({ answers: { useCase: 'remote', reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership', pairing: 'own-user' } }, status: 'answered' })
    expect(asked).toHaveLength(2)
    expect(notes.some(note => note.includes(TRUST_STATEMENT[0]!))).toBe(true)
    await expect(section.ask(mainIo([BACK]), mainDraft, environment)).resolves.toBe(BACK)
    await expect(reachSection(tailscale({ version: { code: null, stdout: '', stderr: '' } }), () => false).ask(mainIo(['yes']), mainDraft, environment)).resolves.toEqual({ answers: { useCase: 'remote', reach: { option: 'none', identityFactor: null } }, status: 'answered' })
    expect(notes.at(-1)).toContain('Remote access stays off')
    const earlier = { phase: 'main', answers: { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership', pairing: 'tailnet' } }, secret: undefined } as never
    await expect(section.ask(mainIo(['yes']), earlier, environment)).resolves.toMatchObject({ answers: { reach: { pairing: 'tailnet' } } })
    expect(initials.at(-1)).toBe('yes')
  })

  it('leaves remote access off when the person says no, goes back, or a check fails', async () => {
    const notes: string[] = []
    const off = { answers: { reach: { option: 'none', identityFactor: null } }, status: 'answered' }
    await expect(reachSection(tailscale(), () => false).ask(io([false], notes), draft, { home: delorunHome, profile: 'default' } as never)).resolves.toEqual(off)
    await expect(reachSection(tailscale(), () => false).ask(io([BACK], notes), draft, { home: delorunHome, profile: 'default' } as never)).resolves.toBe(BACK)
    await expect(reachSection(tailscale({ version: { code: null, stdout: '', stderr: '' } }), () => false).ask(io([true], notes), draft, { home: delorunHome, profile: 'default' } as never)).resolves.toEqual(off)
    expect(notes.at(-1)).toContain('Remote access stays off')
    // Pins setup's Funnel check: an address on the public internet is not offered.
    const funnel = fakeTailscale(HOST)
    funnel.config = { AllowFunnel: { [`${HOST}:443`]: true } }
    await expect(reachSection(funnel.run, () => false).ask(io([true], notes), draft, { home: delorunHome, profile: 'default' } as never)).resolves.toEqual(off)
    expect(notes.at(-1)).toContain('tailscale funnel --https=443 off, then try again\nRemote access stays off')
    await expect(reachSection(() => Promise.reject(new Error('broken')), () => false).ask(io([true], notes), draft, { home: delorunHome, profile: 'default' } as never)).rejects.toThrow('broken')
    const none = { reach: { option: 'none', identityFactor: null } } as never
    await expect(reachSection(tailscale(), () => false).apply({ home: delorunHome, env: {}, directory: delorunHome, secret: undefined }, none)).resolves.toBeUndefined()
  })
})
