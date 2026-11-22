/**
 * `delorun devices pin set | off | resume | status` against a real home socket and the real PIN files: how the secret
 * is read, what is refused before anything is sent, and that the secret appears in no argument, output or file name.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PinModeStore } from '@delorun/home-auth'
import { createReachCommand, homeRuns } from '../src/reach/command.ts'
import { REACH_OFF } from '@delorun/setup-apply'
import { writeReachRow } from '../src/reach/row.ts'
import { sendHomeRequest, type LocalDeviceApproval, type UnsignedRequest } from '@delorun/home-process'
import { EXIT } from '../src/exit.ts'
import { PIN_OPTIONS_NO_EFFECT } from '../src/help.ts'
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
  home = join(osHome, '.delorun')
  running = undefined
  sent = []
  out = { stdout: '', stderr: '' }
  context = {
    env: { ...process.env, HOME: osHome, DELORUN_HOME: home, DELORUN_PROFILE: undefined },
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
    setPinOptions: async (options) => { await store.load(); return store.setOptions(options) },
    turnPinOff: async () => { await store.load(); await store.off() },
    resumePin: async () => { await store.load(); await store.resume() },
  }
}

/**
 * Build the command with a scripted prompt and standard input, over the real socket.
 * @param overrides - the dependency values to replace.
 * @returns the command.
 */
function command(overrides: { readonly typed?: (string | undefined)[]; readonly line?: string | undefined; readonly interactive?: boolean; readonly stdinIsTerminal?: boolean } = {}): ReturnType<typeof createDevicesCommand> {
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
      stdinIsTerminal: overrides.stdinIsTerminal ?? false,
      now: Date.now,
    },
  }
  return createDevicesCommand(dependencies)
}

describe('delorun devices pin', () => {
  it('sets a PIN over the home socket, prints what it allows and keeps the secret out of output and file names', async () => {
    running = await startRunningHome(home, PROFILE, undefined, pinOnlyApproval())
    const code = await command({ typed: [SECRET, SECRET] }).run(['pin', 'set'], context)
    expect(out.stderr).toBe('')
    expect(code).toBe(EXIT.ok)
    expect(out.stderr).toBe('')
    expect(sent).toEqual([{ op: 'pin.set', args: { secret: SECRET } }])
    expect(out.stdout).toContain('PIN mode is on, with a PIN.')
    // Pins the grant model's words (A483): the output never promises a page that stays unlocked for a while.
    expect(out.stdout).toContain('confirms each sensitive action by typing the PIN when it asks, one action at a time; nothing stays unlocked.')
    expect(out.stdout).not.toMatch(/idle minutes|locks again|unlock sensitive actions/)
    expect(out.stdout).toContain('five on one device remove that device and sign it out')
    expect(out.stdout).not.toContain('lock that device')
    expect(out.stdout + out.stderr).not.toContain(SECRET)
    expect(readdirSync(secrets()).join(' ')).not.toContain(SECRET)
    for (const file of readdirSync(secrets())) expect(readFileSync(join(secrets(), file), 'utf8')).not.toContain(SECRET)
    out.stdout = ''
    await expect(command().run(['pin', 'status'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toBe('PIN mode is on, with a PIN.\n')
    await expect(command().run(['pin', 'resume'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('The PIN and Face ID are resumed.')
    await expect(command().run(['pin', 'off'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('PIN mode is off and the PIN is dropped.')
    out.stdout = ''
    await command().run(['pin', 'status'], context)
    expect(out.stdout).toBe('PIN mode is off. Turn it on with delorun devices pin set.\n')
  }, 60_000)

  it('status names a setting that waits to be set back once the mode is off, by field and without its value', async () => {
    mkdirSync(secrets(), { recursive: true, mode: 0o700 })
    writeFileSync(join(secrets(), 'reach-pin-settings.json'), JSON.stringify({ v: 1, lifts: [{ ns: 'delorun-delegation-consent', field: 'enabled', previous: true, set: SECRET }] }), { mode: 0o600 })
    await command().run(['pin', 'status'], context)
    expect(out.stdout).toContain('delorun-delegation-consent.enabled')
    expect(out.stdout).not.toContain(SECRET)
  })

  it('accepts and ignores the old lock options of set, with one line saying so, so older scripts keep working', async () => {
    running = await startRunningHome(home, PROFILE, undefined, pinOnlyApproval())
    const code = await command({ typed: [SECRET, SECRET] }).run(['pin', 'set', '--idle-minutes', '5', '--lock-when-hidden'], context)
    expect(code).toBe(EXIT.ok)
    expect(sent).toEqual([{ op: 'pin.set', args: { secret: SECRET } }])
    expect(out.stderr).toBe('delorun devices pin set: --idle-minutes and --lock-when-hidden have no effect and are ignored: a device confirms each action with Face ID or the PIN, and nothing stays unlocked.\n')
    expect(out.stdout).toContain('PIN mode is on, with a PIN.')
  }, 60_000)

  it('stores the idle minutes and lock-when-hidden with no secret, says they have no effect, and keeps the PIN', async () => {
    running = await startRunningHome(home, PROFILE, undefined, pinOnlyApproval())
    await command({ typed: [SECRET, SECRET] }).run(['pin', 'set'], context)
    const hashBefore = readFileSync(join(secrets(), 'pin-mode.json'), 'utf8').match(/"dk":\s*"[^"]+"/)?.[0]
    expect(hashBefore).toBeDefined()
    sent = []
    out.stdout = ''
    await expect(command().run(['pin', 'options', '--idle-minutes', '7', '--lock-when-hidden'], context)).resolves.toBe(EXIT.ok)
    expect(sent).toEqual([{ op: 'pin.options', args: { idleMinutes: 7, lockWhenHidden: true } }])
    expect(out.stdout).toContain('Saved: 7 idle minutes, lock when hidden.')
    expect(out.stdout).toContain(PIN_OPTIONS_NO_EFFECT)
    await expect(command().run(['pin', 'options', '--no-lock-when-hidden'], context)).resolves.toBe(EXIT.ok)
    expect(sent.at(-1)).toEqual({ op: 'pin.options', args: { lockWhenHidden: false } })
    out.stdout = ''
    await command().run(['pin', 'status'], context)
    expect(out.stdout).toBe('PIN mode is on, with a PIN.\n')
    expect(readFileSync(join(secrets(), 'pin-mode.json'), 'utf8').match(/"dk":\s*"[^"]+"/)?.[0]).toBe(hashBefore)
    // Nothing to change, an out-of-range value and a conflict are refused before anything is sent.
    sent = []
    for (const options of [[], ['--idle-minutes', '0'], ['--idle-minutes', '61'], ['--idle-minutes', 'x'], ['--lock-when-hidden', '--no-lock-when-hidden']]) {
      await expect(command().run(['pin', 'options', ...options], context), options.join(' ')).rejects.toMatchObject({ exit: EXIT.usage })
    }
    expect(sent).toEqual([])
  }, 60_000)

  it('says the home refused an options change while PIN mode is off', async () => {
    running = await startRunningHome(home, PROFILE, undefined, pinOnlyApproval())
    await expect(command().run(['pin', 'options', '--idle-minutes', '7'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('Delorun refused')
    expect(out.stderr).toContain('PIN_MODE_OFF')
  }, 60_000)

  it('reads one line from standard input with --stdin and takes a passcode', async () => {
    running = await startRunningHome(home, PROFILE, undefined, pinOnlyApproval())
    await expect(command({ line: 'correct horse battery', interactive: false }).run(['pin', 'set', '--stdin'], context)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('PIN mode is on, with a passcode.')
    expect(out.stdout + out.stderr).not.toContain('correct horse')
  }, 60_000)

  it('refuses --stdin when standard input is a terminal, which would echo the secret, and reads nothing', async () => {
    // Pins the TTY check: a typed line on a terminal shows on screen and in scrollback.
    await expect(command({ line: SECRET, interactive: true, stdinIsTerminal: true }).run(['pin', 'set', '--stdin'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain('standard input is a terminal')
    expect(out.stderr).not.toContain(SECRET)
    expect(sent).toEqual([])
  })

  it('never echoes a stray argument of options, off or resume, which may be a secret', async () => {
    for (const action of ['options', 'off', 'resume']) {
      const failure = await command().run(['pin', action, SECRET], context).catch((error: unknown) => error)
      expect(failure, action).toMatchObject({ exit: EXIT.usage })
      expect(String((failure as Error).message), action).not.toContain(SECRET)
    }
    expect(sent).toEqual([])
  })

  it('never echoes an unknown action, which may be a PIN typed in the action\'s place', async () => {
    const failure = await command().run(['pin', SECRET], context).catch((error: unknown) => error)
    expect(failure).toMatchObject({ exit: EXIT.usage })
    expect(String((failure as Error).message)).toContain('unknown action')
    expect(String((failure as Error).message)).not.toContain(SECRET)
    expect(sent).toEqual([])
  })

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

  it('never takes the secret from an argument', async () => {
    const refused = await command().run(['pin', 'set', SECRET], context).catch((error: unknown) => error)
    expect(refused).toMatchObject({ exit: EXIT.usage })
    expect(String(refused instanceof Error ? refused.message : refused)).not.toContain(SECRET)
    await expect(command().run(['pin', 'set', `--secret=${SECRET}`], context)).rejects.toMatchObject({ exit: EXIT.usage })
    await expect(command().run(['pin', 'later'], context)).rejects.toMatchObject({ exit: EXIT.usage })
    expect(sent).toEqual([])
  })

  it('says to start Delorun when the home does not run, and shows a Host without home-auth\'s refusal', async () => {
    await expect(command({ typed: [SECRET, SECRET] }).run(['pin', 'set'], context)).resolves.toBe(EXIT.failed)
    expect(out.stderr).toContain("Delorun isn't running")
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
