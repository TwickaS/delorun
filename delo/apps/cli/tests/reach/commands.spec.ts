/**
 * `delorun reach` and `delorun devices` over a temporary home, with `tailscale` and the home socket faked:
 * what each action checks, writes and prints, and what it refuses.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DeviceId, StudioAddress } from '@delo/contract-admission'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { Base64Url } from '@delo/contract-device-approval'
import { HomeAuth, type DeviceSummary } from '@delo/home-auth'
import { acquireHomeLock, newStartId, runDirectory } from '@delo/home'
import type { ResponseLine, UnsignedRequest } from '@delo/home-process'
import type { TailscaleResult, TailscaleRunner } from '@delo/reach'
import { EXIT } from '../../src/exit.ts'
import type { CommandContext } from '../../src/command.ts'
import { createReachCommand, homeRuns, type ReachDependencies } from '../../src/reach/command.ts'
import { createDevicesCommand, type DevicesDependencies } from '../../src/devices/command.ts'
import { localDeviceApproval } from '../../src/devices/host.ts'
import { readReachRow, REACH_OFF } from '../../src/reach/row.ts'
import { reachSection } from '../../src/reach/setup-section.ts'
import { TRUST_STATEMENT } from '../../src/reach/trust.ts'
import { BACK } from '../../src/setup/steps.ts'

const HOST = 'home.example.ts.net'
let osHome: string
let deloHome: string
let out: { stdout: string; stderr: string }
let context: CommandContext

beforeEach(() => {
  osHome = mkdtempSync(join(tmpdir(), 'delorun-reach-'))
  deloHome = join(osHome, '.delo')
  mkdirSync(join(deloHome, 'profiles', 'default'), { recursive: true, mode: 0o700 })
  writeFileSync(join(deloHome, 'profiles', 'default', 'package.json'), '{"name":"dsh-profile-default","private":true}\n')
  out = { stdout: '', stderr: '' }
  context = {
    env: { ...process.env, HOME: osHome, DELO_HOME: deloHome, DELO_PROFILE: undefined },
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
    return { code: 0, stdout: '', stderr: '' }
  }
}

function reach(overrides: Partial<ReachDependencies> = {}): ReturnType<typeof createReachCommand> {
  return createReachCommand({ tailscale: tailscale(), running: () => false, ...overrides })
}

function patchRows(): unknown {
  return parse(readFileSync(join(deloHome, 'profiles', 'default', 'cordis.patch.yml'), 'utf8'))
}

describe('delorun reach', () => {
  it('turns Tailscale private on with this machine\'s address, and prints the trust statement', async () => {
    const calls: string[][] = []
    await expect(reach({ tailscale: tailscale({}, calls) }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.ok)
    expect(patchRows()).toEqual([{ id: 'delo-reach', config: { enabled: true, tailscalePrivate: { enabled: true, address: `https://${HOST}`, servePort: 443 } } }])
    for (const line of TRUST_STATEMENT) expect(out.stdout).toContain(line)
    expect(out.stdout).toContain('It starts with Delo')
    expect(calls.flat()).not.toContain('sudo')
    await reach({ running: () => true }).run(['on', 'tailscale'], context)
    expect(out.stdout).toContain('Restart Delo to apply it')
  })

  it('prints the one operator command and turns nothing on when the user may not configure serve', async () => {
    const refused = tailscale({ 'serve status': { code: 1, stdout: '', stderr: 'Access denied: serve config denied' } })
    await expect(reach({ tailscale: refused }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('sudo tailscale set --operator=$USER')
    expect(existsSync(join(deloHome, 'profiles', 'default', 'cordis.patch.yml'))).toBe(false)
    const other = tailscale({ 'serve status': { code: 1, stdout: '', stderr: 'no serve config' } })
    await expect(reach({ tailscale: other }).run(['on', 'tailscale'], context)).resolves.toBe(EXIT.ok)
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

  it('turns it off, removes the serve target and keeps the address', async () => {
    await reach().run(['on', 'tailscale'], context)
    const calls: string[][] = []
    await expect(reach({ tailscale: tailscale({}, calls), running: () => true }).run(['off'], context)).resolves.toBe(EXIT.ok)
    expect(calls).toEqual([['serve', '--https=443', 'off']])
    expect(readReachRow(deloHome, 'default')).toEqual({ enabled: false, address: `https://${HOST}`, servePort: 443 })
    expect(out.stdout).toContain('Restart Delo to close the remote listener now')
    await reach({ tailscale: tailscale({ 'serve --https=443': { code: 1, stdout: '', stderr: '' } }) }).run(['off'], context)
    expect(out.stdout).toContain('Tailscale did not confirm')
  })

  it('reports the row, and the running home\'s state', async () => {
    await reach().run(['status'], context)
    expect(out.stdout).toContain('Tailscale private: off')
    expect(out.stdout).toContain('Delo is not running')
    await reach().run(['on', 'tailscale'], context)
    out.stdout = ''
    // The live state answers only the studio's own page, so a running home is pointed to, never asked over HTTP.
    await reach({ running: () => true }).run(['status'], context)
    expect(out.stdout).toContain(`Tailscale private: on, https://${HOST}`)
    expect(out.stdout).toContain('Settings → Devices')
  })

  it('reads a home\'s lock to tell whether Delo runs', async () => {
    expect(homeRuns(deloHome, 'default')).toBe(false)
    mkdirSync(runDirectory(deloHome, 'default'), { recursive: true, mode: 0o700 })
    const lock = await acquireHomeLock({ runDirectory: runDirectory(deloHome, 'default'), runtime: brandString<RuntimeVersion>('0.0.0'), probe: () => Promise.resolve('silent'), startId: newStartId() })
    try {
      expect(homeRuns(deloHome, 'default')).toBe(true)
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
    ...overrides,
  })
  return { command, sent }
}

const PENDING = { requestId: 'AAAAAAAAAAAAAAAAAAAAAA', label: 'Phone', platform: 'iOS', address: `https://${HOST}`, createdAt: 0, expiresAt: 1 }

describe('delorun devices', () => {
  it('approves the waiting device with the typed code, giving a wrong code another try', async () => {
    const { command, sent } = devices({
      lines: [
        [{ ok: true, closesAt: 1, pending: [PENDING] }],
        [{ ok: false, error: 'APPROVAL_FAILED', detail: 'APPROVAL_CODE_MISMATCH: wrong' }],
        [{ ok: true, device: { id: 'd', label: 'Phone', address: PENDING.address } }],
      ],
      answers: ['0000 0000', '1234 5678'],
    })
    await expect(command.run(['approve'], context)).resolves.toBe(EXIT.ok)
    expect(sent).toEqual([
      { op: 'devices.approve', args: {} },
      { op: 'devices.approve', args: { requestId: PENDING.requestId, typedCode: '0000 0000' } },
      { op: 'devices.approve', args: { requestId: PENDING.requestId, typedCode: '1234 5678' } },
    ])
    expect(out.stdout).toContain('A device asks for approval: Phone (iOS)')
    expect(out.stdout).toContain('Approved Phone')
    expect(out.stderr).toContain('Try again.')
  })

  it('refuses an approval without a running home, a closed window, a refusal, a cancel and three wrong codes', async () => {
    await expect(devices({ running: () => false }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('Delo is not running')
    await expect(devices({ lines: [[{ ok: true, closesAt: 1, pending: [] }]] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [[{ ok: true, closesAt: 1 }]] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [[{ ok: false, error: 'LOOPBACK_REQUIRED', detail: 'needs you' }]] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('LOOPBACK_REQUIRED (needs you)')
    await expect(devices({ lines: [[{ ok: false, error: 'APPROVALS_UNAVAILABLE' }]] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [[{ ok: true, pending: [{ ...PENDING, platform: '' }] }]], answers: [undefined] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('cancelled')
    await expect(devices({ lines: [[{ ok: true, pending: [PENDING] }], [{ ok: false, error: 'APPROVAL_FAILED', detail: 'APPROVAL_EXPIRED: gone' }]], answers: ['1'] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    await expect(devices({ lines: [[{ ok: true, pending: [PENDING] }], [{ ok: false, error: 'SCHEMA_VIOLATION' }]], answers: ['x'] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    const wrong = { ok: false, error: 'APPROVAL_FAILED', detail: 'APPROVAL_CODE_MISMATCH: wrong' }
    await expect(devices({ lines: [[{ ok: true, pending: [PENDING] }], [wrong], [wrong], [wrong]], answers: ['1', '2', '3'] }).command.run(['approve'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('three wrong codes')
  })

  it('lists the home\'s devices from its records, and says when there is none', async () => {
    await expect(devices().command.run(['list'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('trusts no device yet')
    const auth = new HomeAuth({ directory: join(deloHome, 'secrets', 'home-auth') })
    await auth.start()
    await auth.claim({ listener: 'loopback', host: '127.0.0.1:3080', source: 'local', ownerCode: (await auth.issueOwnerCode()).code, devicePublicKey: { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>('A'.repeat(43)), y: brandString<Base64Url>('B'.repeat(43)) }, label: 'This computer', address: brandString<StudioAddress>('http://127.0.0.1:3080') })
    await auth.stop()
    out.stdout = ''
    await devices().command.run(['list'], context)
    expect(out.stdout).toContain('This computer')
    expect(out.stdout).toContain('claimed this home')
    expect(out.stdout).toContain('never signed in')
    writeFileSync(join(deloHome, 'secrets', 'home-auth', 'owner.json'), '{"v":2}', { mode: 0o600 })
    await expect(devices().command.run(['list'], context)).resolves.toBe(EXIT.failed)
  })

  it('describes each device by who approved it and when it last signed in', async () => {
    const base: DeviceSummary = { id: brandString<DeviceId>('dev-1'), label: 'Phone', platform: 'iOS', address: brandString<StudioAddress>(`https://${HOST}`), approvedAt: 0, approvedBy: 'local', lastSignInAt: 0 }
    const second: DeviceSummary = { ...base, id: brandString<DeviceId>('dev-2'), platform: '', approvedBy: brandString<DeviceId>('dev-1') }
    const listed = vi.spyOn(HomeAuth.prototype, 'devices').mockResolvedValue({ owner: { claimedAt: 0, firstDeviceId: 'local' }, devices: [base, second] })
    try {
      await expect(devices().command.run(['list'], context)).resolves.toBe(EXIT.ok)
      expect(out.stdout).toContain('dev-1  Phone (iOS)')
      expect(out.stdout).toContain('approved at this computer 1970-01-01T00:00:00.000Z, last signed in 1970-01-01T00:00:00.000Z')
      expect(out.stdout).toContain('dev-2  Phone\n')
      expect(out.stdout).toContain('approved by dev-1')
      // A failure that is not the home's own record error reaches the caller unchanged.
      listed.mockRejectedValue(new Error('disk gone'))
      await expect(devices().command.run(['list'], context)).rejects.toThrow('disk gone')
    } finally {
      listed.mockRestore()
    }
  })

  it('names the approved device even when the home answers without it', async () => {
    const { command } = devices({ lines: [[{ ok: true, pending: [PENDING] }], [{ ok: true }]], answers: ['1234 5678'] })
    await expect(command.run(['approve'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('Approved undefined.')
  })

  it('passes on a failure of the records that is not the home\'s own', async () => {
    const revoked = vi.spyOn(HomeAuth.prototype, 'revokeDevice').mockRejectedValue(new Error('disk gone'))
    try {
      await expect(devices({ running: () => false }).command.run(['remove', 'dev-1'], context)).rejects.toThrow('disk gone')
    } finally {
      revoked.mockRestore()
    }
  })

  it('removes a device through the home socket when Delo runs, or on the records when it does not', async () => {
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
    const auth = new HomeAuth({ directory: join(deloHome, 'secrets', 'home-auth') })
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
    const path = join(deloHome, 'profiles', 'default', 'cordis.patch.yml')
    expect(readReachRow(deloHome, 'default')).toEqual(REACH_OFF)
    for (const text of ['just: a map\n', '- 1\n- ~\n- id: delo-reach\n', '- id: delo-reach\n  config: {}\n', '- id: delo-reach\n  config:\n    tailscalePrivate: 1\n']) {
      writeFileSync(path, text)
      expect(readReachRow(deloHome, 'default')).toEqual(REACH_OFF)
    }
    writeFileSync(path, '- id: delo-reach\n  config:\n    tailscalePrivate:\n      enabled: yes\n')
    expect(readReachRow(deloHome, 'default')).toEqual(REACH_OFF)
  })

  it('gives the home process the Host\'s local approval, or nothing without home-auth', async () => {
    expect(localDeviceApproval({ get: () => undefined })).toBeUndefined()
    const calls: string[] = []
    const homeAuth = {
      openApprovalWindow: () => { calls.push('open'); return Promise.resolve(5) },
      approvalWindowOpenUntil: () => 5,
      pendingApprovals: () => [],
      approveLocally: (id: string, code: string) => { calls.push(`${id} ${code}`); return Promise.resolve({ id: 'd', label: 'Phone', address: 'a', platform: '' }) },
      revokeDevice: (id: string) => { calls.push(`remove ${id}`); return Promise.resolve({ removed: true, sessions: 2, connections: 1, extra: 'dropped' }) },
    }
    const approval = localDeviceApproval({ get: (name: string) => (name === 'homeAuth' ? homeAuth : undefined) } as never)
    await expect(approval?.openWindow()).resolves.toBe(5)
    expect(approval?.windowOpenUntil()).toBe(5)
    expect(approval?.pending()).toEqual([])
    await expect(approval?.approve('r', '1')).resolves.toEqual({ id: 'd', label: 'Phone', address: 'a' })
    await expect(approval?.remove('d')).resolves.toEqual({ removed: true, sessions: 2, connections: 1 })
    expect(calls).toEqual(['open', 'r 1', 'remove d'])
  })
})

describe('setup\'s reach section', () => {
  const draft = { mode: 'full', answers: { reach: { option: 'none', identityFactor: null } }, secret: undefined } as never
  const io = (answers: readonly (boolean | typeof BACK)[], notes: string[]) => {
    const queue = [...answers]
    return { confirm: () => Promise.resolve(queue.shift()), note: (body: string) => { notes.push(body) } } as never
  }

  it('asks, checks Tailscale, shows the trust statement and writes the row', async () => {
    const notes: string[] = []
    const section = reachSection(tailscale())
    expect(section.appliesTo({} as never)).toBe(true)
    const on = await section.ask(io([true], notes), draft, {} as never)
    expect(on).toEqual({ answers: { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership' } }, status: 'answered' })
    expect(notes[0]).toContain(TRUST_STATEMENT[0])
    const directory = join(deloHome, 'profiles', 'default')
    const answers = { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership' } } as never
    expect(section.review?.(answers)).toBe('Remote access: from your phone over Tailscale')
    await expect(section.apply({ home: deloHome, directory, secret: undefined }, answers)).resolves.toContain('delorun devices approve')
    expect(readReachRow(deloHome, 'default')).toEqual({ enabled: true, address: `https://${HOST}`, servePort: 443 })
  })

  it('leaves remote access off when the person says no, goes back, or a check fails', async () => {
    const notes: string[] = []
    const off = { answers: { reach: { option: 'none', identityFactor: null } }, status: 'answered' }
    await expect(reachSection(tailscale()).ask(io([false], notes), draft, {} as never)).resolves.toEqual(off)
    await expect(reachSection(tailscale()).ask(io([BACK], notes), draft, {} as never)).resolves.toBe(BACK)
    await expect(reachSection(tailscale({ version: { code: null, stdout: '', stderr: '' } })).ask(io([true], notes), draft, {} as never)).resolves.toEqual(off)
    expect(notes.at(-1)).toContain('Remote access stays off')
    await expect(reachSection(() => Promise.reject(new Error('broken'))).ask(io([true], notes), draft, {} as never)).rejects.toThrow('broken')
    const none = { reach: { option: 'none', identityFactor: null } } as never
    expect(reachSection(tailscale()).review?.(none)).toBe('Remote access: off')
    await expect(reachSection(tailscale()).apply({ home: deloHome, directory: deloHome, secret: undefined }, none)).resolves.toBeUndefined()
  })
})
