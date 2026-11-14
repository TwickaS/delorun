/**
 * `delorun devices pin set | off | resume | status` against a real home socket and the real PIN files: how the secret
 * is read, what is refused before anything is sent, and that the secret appears in no argument, output or file name.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PinModeStore } from '@delo/home-auth'
import { createReachCommand, homeRuns } from '../src/reach/command.ts'
import { REACH_OFF, writeReachRow } from '../src/reach/row.ts'
import { sendHomeRequest, type LocalDeviceApproval, type UnsignedRequest } from '@delo/home-process'
import { EXIT } from '../src/exit.ts'
import type { CommandContext } from '../src/command.ts'
import { createDevicesCommand, type DevicesDependencies } from '../src/devices/command.ts'
import { startRunningHome, type RunningHome } from './fixtures/running-home.ts'

const PROFILE = 'default'
const SECRET = '739104'

let osHome: string
let home: string
let running: RunningHome | undefined
let out: { stdout: string; stderr: string }
let context: CommandContext
let sent: UnsignedRequest[]

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-pin-')))
  home = join(osHome, '.delo')
  running = undefined
  sent = []
  out = { stdout: '', stderr: '' }
  context = {
    env: { ...process.env, HOME: osHome, DELO_HOME: home, DELO_PROFILE: undefined },
    stdout: (text) => { out.stdout += text },
    stderr: (text) => { out.stderr += text },
  }
})

afterEach(async () => {
  await running?.stop()
  rmSync(osHome, { recursive: true, force: true })
})

/** The directory the home keeps its PIN files in. */
const secrets = (): string => join(home, 'secrets', 'home-auth')

/**
 * A Host's local approval whose PIN members use the real PIN store and whose other members are never called here.
 * @returns the approval.
 */
function pinOnlyApproval(): LocalDeviceApproval {
  mkdirSync(secrets(), { recursive: true, mode: 0o700 })
  const store = new PinModeStore({ directory: secrets(), now: Date.now })
  const unused = (): never => { throw new Error('not a PIN operation') }
  return {
    openWindow: unused, windowOpenUntil: unused, pending: unused, approve: unused, cancel: unused, remove: unused,
    elevations: unused, approveElevation: unused, revokeElevation: unused,
    setPin: async (secret, options) => { await store.load(); return store.set(secret, options) },
    turnPinOff: async () => { await store.load(); await store.off() },
    resumePin: async () => { await store.load(); await store.resume() },
  }
}

/**
 * Build the command with a scripted prompt and standard input, over the real socket.
 * @param overrides - the dependency values to replace.
 * @returns the command.
 */
function command(overrides: { readonly typed?: (string | undefined)[]; readonly line?: string | undefined; readonly interactive?: boolean } = {}): ReturnType<typeof createDevicesCommand> {
  const typed = [...(overrides.typed ?? [])]
  const dependencies: DevicesDependencies = {
    running: homeRuns,
    send: async (h, p, request) => { sent.push(request); return sendHomeRequest(h, p, request) },
    ask: () => Promise.resolve(undefined),
    terminal: false,
    pin: {
      secret: () => Promise.resolve(typed.shift()),
      stdinLine: () => Promise.resolve(overrides.line),
      interactive: overrides.interactive ?? true,
      now: Date.now,
    },
  }
  return createDevicesCommand(dependencies)
}

describe('delorun devices pin', () => {
  it('sets a PIN over the home socket, prints what it allows and keeps the secret out of output and file names', async () => {
    running = await startRunningHome(home, PROFILE, undefined, pinOnlyApproval())
    const code = await command({ typed: [SECRET, SECRET] }).run(['pin', 'set', '--idle-minutes', '5', '--lock-when-hidden'], context)
    expect(out.stderr).toBe('')
    expect(code).toBe(EXIT.ok)
    expect(out.stderr).toBe('')
    expect(sent).toEqual([{ op: 'pin.set', args: { secret: SECRET, idleMinutes: 5, lockWhenHidden: true } }])
    expect(out.stdout).toContain('PIN mode is on, with a PIN.')
    expect(out.stdout).toContain('after 5 idle minutes, and at once when it is hidden')
    expect(out.stdout + out.stderr).not.toContain(SECRET)
    expect(readdirSync(secrets()).join(' ')).not.toContain(SECRET)
    for (const file of readdirSync(secrets())) expect(readFileSync(join(secrets(), file), 'utf8')).not.toContain(SECRET)
    out.stdout = ''
    await expect(command().run(['pin', 'status'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toBe('PIN mode is on, with a PIN; a page locks after 5 idle minutes and at once when it is hidden.\n')
    await expect(command().run(['pin', 'resume'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('PIN unlocks are resumed.')
    await expect(command().run(['pin', 'off'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('PIN mode is off and the PIN is dropped.')
    out.stdout = ''
    await command().run(['pin', 'status'], context)
    expect(out.stdout).toBe('PIN mode is off. Turn it on with delorun devices pin set.\n')
  }, 60_000)

  it('reads one line from standard input with --stdin and takes a passcode', async () => {
    running = await startRunningHome(home, PROFILE, undefined, pinOnlyApproval())
    await expect(command({ line: 'correct horse battery', interactive: false }).run(['pin', 'set', '--stdin'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('PIN mode is on, with a passcode.')
    expect(out.stdout + out.stderr).not.toContain('correct horse')
  }, 60_000)

  it('refuses without a terminal unless --stdin reads a line, and sends nothing', async () => {
    await expect(command({ interactive: false }).run(['pin', 'set'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('there is no terminal to ask for the PIN or passcode on')
    await expect(command({ interactive: false, line: undefined }).run(['pin', 'set', '--stdin'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('standard input held no PIN or passcode')
    expect(sent).toEqual([])
  })

  it('refuses a weak PIN, differing entries and a cancelled prompt before anything is sent, without printing the secret', async () => {
    await expect(command({ typed: ['123456', '123456'] }).run(['pin', 'set'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('a repeat, a run or a common PIN')
    expect(out.stderr).not.toContain('123456')
    out.stderr = ''
    await expect(command({ typed: [SECRET, '739105'] }).run(['pin', 'set'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('the two entries differ')
    expect(out.stderr).not.toContain(SECRET)
    out.stderr = ''
    await expect(command({ typed: [undefined] }).run(['pin', 'set'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('cancelled')
    expect(sent).toEqual([])
  })

  it('never takes the secret from an argument and rejects a bad idle time', async () => {
    const refused = await command().run(['pin', 'set', SECRET], context).catch((error: unknown) => error)
    expect(refused).toMatchObject({ exit: EXIT.usage })
    expect(String(refused instanceof Error ? refused.message : refused)).not.toContain(SECRET)
    await expect(command().run(['pin', 'set', `--secret=${SECRET}`], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(command({ typed: [SECRET, SECRET] }).run(['pin', 'set', '--idle-minutes', '61'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(command({ typed: [SECRET, SECRET] }).run(['pin', 'set', '--idle-minutes', 'soon'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(command().run(['pin', 'later'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    expect(sent).toEqual([])
  })

  it('says to start Delorun when the home does not run, and shows a Host without home-auth\'s refusal', async () => {
    await expect(command({ typed: [SECRET, SECRET] }).run(['pin', 'set'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('Delorun is not running')
    out.stderr = ''
    running = await startRunningHome(home, PROFILE, undefined)
    await expect(command({ typed: [SECRET, SECRET] }).run(['pin', 'set'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('APPROVALS_UNAVAILABLE')
    expect(out.stderr).not.toContain(SECRET)
  }, 60_000)

  it('is mentioned in one line by reach status when remote access is on and the mode is off', async () => {
    const reach = createReachCommand({ tailscale: () => Promise.resolve({ code: 1, stdout: '', stderr: '' }), running: () => false, send: () => Promise.resolve([]), ask: () => Promise.resolve('y'), terminal: false })
    await reach.run(['status'], context)
    expect(out.stdout).not.toContain('PIN mode')
    mkdirSync(join(home, 'profiles', PROFILE), { recursive: true, mode: 0o700 })
    writeFileSync(join(home, 'profiles', PROFILE, 'package.json'), '{"name":"dsh-profile-default","private":true}\n')
    writeReachRow(home, PROFILE, { ...REACH_OFF, enabled: true, address: 'https://home.example.ts.net/' })
    await reach.run(['status'], context)
    expect(out.stdout.match(/PIN mode is off/g)).toHaveLength(1)
    expect(out.stdout).toContain('delorun devices pin set')
  })
})
