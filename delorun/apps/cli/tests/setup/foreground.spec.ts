/**
 * The end of a fresh terminal setup: Delorun starts in this terminal and opens the studio, and the PIN and keep-the-command
 * questions run after the studio announcement while it runs. No real npm, no real start, no real home socket.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETUP_DEFAULTS, type SetupAnswers } from '@delorun/contract-setup-answers'
import type { ResponseLine, UnsignedRequest } from '@delorun/home-process'
import { ensureHomeTree } from '@delorun/home'
import { EXIT } from '../../src/exit.ts'
import type { CommandResult } from '../../src/command.ts'
import type { StartRequest } from '../../src/start.ts'
import { runForeground, runNpm, type ForegroundDependencies, type NpmResult } from '../../src/setup/foreground.ts'
import { runSetup, type SetupRequest } from '../../src/setup/index.ts'
import { SetupCancelled, type Prompter } from '../../src/setup/prompts.ts'
import { fakeTailscale } from '../fixtures/fake-tailscale.ts'
import { registryWithTailscale, scriptedPrompter, type Answer, type Recording } from './support.ts'

vi.mock('../../src/delorun-bundles.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/delorun-bundles.ts')>(),
  linkDelorunBundles: vi.fn(() => Promise.resolve()),
}))

const PROFILE = 'default'
const PIN = '739104'
const PIN_QUESTION = 'confirm: Set a PIN for your other devices now? (6 digits or more; asked for each sensitive action)'
const KEEP_QUESTION = 'select: Keep the delorun command?\nRuns: npm install -g delorun@0.1.0'
const PHONE_QUESTION = 'select: Use Delorun from your other devices too? (phone, tablet, another computer, over Tailscale)'
const PHONE_ON: SetupAnswers = { ...SETUP_DEFAULTS, useCase: 'remote', reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership', pairing: 'own-user' } }
const LAUNCHED = { DELORUN_LAUNCHER_VERSION: '0.1.0' }
const IS_INSTALLED = '✔ delorun is installed. Next time: delorun'
const PIN_LATER = 'No PIN is set. delorun devices pin set sets it later, and so does the studio\'s Settings → Safety → PIN mode.'
const ENDING_LINES = [
  'Delorun runs in this terminal. Ctrl+C stops it.',
  'To keep it running after you close the terminal: delorun start --background',
  '(or Settings → General → How Delorun runs).',
  'Change an answer later: delorun setup <section> (delorun setup --list)',
  'To start Delorun by itself when you log in: delorun setup autostart',
  'If something looks wrong: delorun doctor',
]

let recording: Recording
/** Everything written and every event, in order. */
let events: string[]
let npmCalls: string[][]
let npmResults: NpmResult[]
let sent: UnsignedRequest[]
let interrupted: number
let started: StartRequest[]
let pinSecrets: (string | undefined)[]
let pinAnswer: ResponseLine[]

/**
 * A start that prints the studio announcement, awaits the request's steps as the home process's start does, and returns.
 * @param request - the start.
 * @returns undefined, as a start whose profile runner owns the exit code.
 */
async function announcingStart(request: StartRequest): Promise<CommandResult> {
  started.push(request)
  request.output.stdout('Run delorun open to open the studio in your browser.\n')
  events.push('announced')
  await request.afterStart?.()
  return undefined
}

/**
 * @param overrides - the dependencies to replace.
 * @returns fake dependencies over the recorded state.
 */
function dependencies(overrides: Partial<ForegroundDependencies> = {}): ForegroundDependencies {
  return {
    start: announcingStart,
    pin: {
      running: () => true,
      send: (_home, _profile, request) => { sent.push(request); return Promise.resolve(pinAnswer) },
      secret: () => Promise.resolve(pinSecrets.shift()),
      stdinLine: () => Promise.resolve(undefined),
      interactive: true,
      stdinIsTerminal: true,
      now: () => 0,
    },
    npm: (args) => { npmCalls.push([...args]); return Promise.resolve(npmResults.shift() ?? { ok: true, output: '' }) },
    interrupt: () => { interrupted += 1 },
    userHome: '/home/person',
    ...overrides,
  }
}

/**
 * Run the steps after the start against a script.
 * @param script - the answers in order.
 * @param options - the answers, the environment, the channel origin and replaced dependencies.
 * @returns the start's result.
 */
async function foreground(script: readonly Answer[], options: { answers?: SetupAnswers, env?: Record<string, string>, channelOrigin?: string, deps?: Partial<ForegroundDependencies>, prompter?: Prompter } = {}): Promise<CommandResult> {
  return runForeground({
    home: '/h', profile: PROFILE, env: options.env ?? {}, answers: options.answers ?? SETUP_DEFAULTS,
    output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
    prompter: options.prompter ?? scriptedPrompter(script, recording), channelOrigin: options.channelOrigin, sandbox: undefined, dependencies: dependencies(options.deps),
  })
}

/**
 * A terminal 80 columns wide wraps a long line at a word.
 * @param line - one line of output.
 * @returns the line broken at spaces into lines of at most 80 columns, the continuation indented as the line was.
 */
function wrapAt80(line: string): string {
  if (line.length <= 80) return line
  const indent = /^\s*/u.exec(line)?.[0] ?? ''
  const rows: string[] = []
  let row = ''
  for (const word of line.trim().split(' ')) {
    if (row !== '' && `${indent}${row} ${word}`.length > 80) {
      rows.push(`${indent}${row}`)
      row = word
    } else {
      row = row === '' ? word : `${row} ${word}`
    }
  }
  return [...rows, `${indent}${row}`].join('\n')
}

/** @returns the screen as one text. */
function screen(): string {
  return recording.screen.join('\n')
}

beforeEach(() => {
  recording = { screen: [], asked: [] }
  events = []
  npmCalls = []
  npmResults = []
  sent = []
  interrupted = 0
  started = []
  pinSecrets = [PIN, PIN]
  pinAnswer = [{ ok: true, secret: 'pin' }]
})

describe('a run that starts Delorun in this terminal', () => {
  it('starts with the studio opening, asks after the announcement with the home process running, then prints the ending', async () => {
    expect(await foreground([true, 'no'], { answers: PHONE_ON, env: LAUNCHED })).toBeUndefined()
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ home: '/h', profile: PROFILE, open: true })
    expect(recording.screen.indexOf('Run delorun open to open the studio in your browser.')).toBeLessThan(recording.screen.indexOf(`? Set a PIN for your other devices now? (6 digits or more; asked for each sensitive action) (Yes)`))
    expect(recording.asked).toEqual([PIN_QUESTION, KEEP_QUESTION])
    expect(screen().endsWith(`${ENDING_LINES.join('\n')}`)).toBe(true)
    expect(screen()).not.toContain('Nothing is running yet')
  })

  it('asks no phone question when phone access is off, and no command question when the launcher did not start the run', async () => {
    await foreground([])
    expect(recording.asked).toEqual([])
    expect(screen()).toContain(ENDING_LINES[0])
  })
})

describe('the phone PIN', () => {
  it('Yes sets it over the home socket, and the PIN is in no output or screen line', async () => {
    await foreground([true], { answers: PHONE_ON })
    expect(sent).toEqual([{ op: 'pin.set', args: { secret: PIN } }])
    expect(screen()).toContain('PIN mode is on, with a PIN.')
    expect(screen()).not.toContain(PIN)
    expect(screen()).not.toContain(PIN_LATER)
  })

  it('declined prints one line about delorun devices pin set and sends nothing', async () => {
    await foreground([false], { answers: PHONE_ON })
    expect(sent).toEqual([])
    expect(recording.screen.filter(line => line === PIN_LATER)).toHaveLength(1)
    expect(screen()).toContain(ENDING_LINES[0])
  })

  it('refused by the home prints the line and goes on to the ending', async () => {
    pinAnswer = [{ ok: false, error: 'PIN_REFUSED' }]
    await foreground([true], { answers: PHONE_ON })
    expect(screen()).toContain('stderr: delorun devices pin set: Delorun refused: PIN_REFUSED. Nothing was changed.')
    expect(recording.screen.filter(line => line === PIN_LATER)).toHaveLength(1)
    expect(screen()).toContain(ENDING_LINES[0])
    expect(screen()).not.toContain(PIN)
  })

  it('two entries that differ set nothing and print the line', async () => {
    pinSecrets = [PIN, '111111']
    await foreground([true], { answers: PHONE_ON })
    expect(sent).toEqual([])
    expect(screen()).toContain('stderr: delorun devices pin set: the two entries differ. Nothing was changed.')
    expect(screen()).toContain(PIN_LATER)
  })

  it('a PIN the rules refuse is refused before anything is sent', async () => {
    pinSecrets = ['123', '123']
    await foreground([true], { answers: PHONE_ON })
    expect(sent).toEqual([])
    expect(screen()).toContain(PIN_LATER)
  })
})

describe('keeping the delorun command', () => {
  it('Yes runs npm install -g at the launcher\'s version and says so', async () => {
    await foreground(['yes'], { env: LAUNCHED })
    expect(npmCalls).toEqual([['install', '-g', 'delorun@0.1.0']])
    expect(recording.screen).toContain(IS_INSTALLED)
  })

  it('No installs nothing', async () => {
    await foreground(['no'], { env: LAUNCHED })
    expect(npmCalls).toEqual([])
    expect(screen()).not.toContain('installed')
    expect(screen()).toContain(ENDING_LINES[0])
  })

  it('retries under ~/.local when npm refuses for permission, and prints the PATH hint', async () => {
    npmResults = [{ ok: false, output: 'npm error code EACCES\nnpm error syscall mkdir' }, { ok: true, output: '' }]
    await foreground(['yes'], { env: LAUNCHED })
    expect(npmCalls).toEqual([['install', '-g', 'delorun@0.1.0'], ['install', '-g', '--prefix', '/home/person/.local', 'delorun@0.1.0']])
    expect(screen()).toContain('✔ delorun is installed under ~/.local. Next time: delorun\nAdd ~/.local/bin to your PATH')
  })

  it('treats EPERM as a permission refusal too, and prints the command when the retry fails as well', async () => {
    npmResults = [{ ok: false, output: 'npm error code EPERM' }, { ok: false, output: 'npm error code EACCES' }]
    await foreground(['yes'], { env: LAUNCHED })
    expect(npmCalls).toHaveLength(2)
    expect(screen()).toContain('npm could not install it, even under ~/.local. To install it yourself, run: npm install -g --prefix ~/.local delorun@0.1.0')
    expect(screen()).not.toContain(IS_INSTALLED)
  })

  it('prints the command for the person to run on any other failure, without retrying', async () => {
    npmResults = [{ ok: false, output: 'npm error code E404' }]
    await foreground(['yes'], { env: LAUNCHED })
    expect(npmCalls).toHaveLength(1)
    expect(screen()).toContain('npm could not install it. To install it yourself, run: npm install -g delorun@0.1.0')
    expect(screen()).toContain(ENDING_LINES[0])
  })

  it('asks nothing when the launcher did not start the run, and nothing when the version is not one', async () => {
    await foreground([], { env: {} })
    await foreground([], { env: { DELORUN_LAUNCHER_VERSION: 'latest' } })
    expect(recording.asked).toEqual([])
    expect(npmCalls).toEqual([])
  })

  it('offers the package file as text only for a launcher built for another channel, and runs nothing', async () => {
    await foreground([], { env: { DELORUN_LAUNCHER_VERSION: '0.1.0-rc.1' }, channelOrigin: 'http://127.0.0.1:18080' })
    expect(recording.asked).toEqual([])
    expect(npmCalls).toEqual([])
    expect(screen()).toContain('0.1.0-rc.1 is not on the npm registry, so install the package file this launcher came from: npm install -g ./delorun-0.1.0-rc.1.tgz')
    expect(screen()).not.toContain('delorun@0.1.0-rc.1')
  })

  it('collects the output of the program it runs, and reports one that fails or cannot start as not ok', async () => {
    const version = await runNpm(['--version'], process.execPath)
    expect(version).toEqual({ ok: true, output: `${process.version}\n` })
    expect((await runNpm(['--no-such-option'], process.execPath)).ok).toBe(false)
    expect((await runNpm([], join(tmpdir(), 'no-such-program-for-the-test'))).ok).toBe(false)
  })
})

describe('Ctrl+C while a question is open', () => {
  it('stops Delorun and prints nothing more, not even the ending', async () => {
    const cancelling: Prompter = { ...scriptedPrompter([], recording), confirm: () => Promise.reject(new SetupCancelled()) }
    expect(await foreground([], { answers: PHONE_ON, prompter: cancelling })).toBeUndefined()
    expect(interrupted).toBe(1)
    expect(screen()).not.toContain(ENDING_LINES[0])
    expect(screen()).not.toContain(PIN_LATER)
  })

  it('stops it in the keep-the-command question as well', async () => {
    const cancelling: Prompter = { ...scriptedPrompter([], recording), select: () => Promise.reject(new SetupCancelled()) }
    await foreground([], { env: LAUNCHED, prompter: cancelling })
    expect(interrupted).toBe(1)
    expect(npmCalls).toEqual([])
    expect(screen()).not.toContain(ENDING_LINES[0])
  })
})

describe('a start that hands over or refuses', () => {
  it('runs no step and prints the plain ending when the start hands over to a running home', async () => {
    const handed = (): Promise<CommandResult> => Promise.resolve(EXIT.ok)
    expect(await foreground([], { answers: PHONE_ON, env: LAUNCHED, deps: { start: handed } })).toBe(EXIT.ok)
    expect(recording.asked).toEqual([])
    expect(npmCalls).toEqual([])
    expect(screen()).toContain('Delorun is set up. Nothing is running yet.\nStudio: http://127.0.0.1:3080')
  })

  it('lets a refusal of the start reach the caller and prints no ending', async () => {
    const refusing = (): Promise<CommandResult> => Promise.reject(new Error('the start refused'))
    await expect(foreground([], { deps: { start: refusing } })).rejects.toThrow('the start refused')
    expect(screen()).toBe('')
  })
})

describe('runSetup', () => {
  let osHome: string
  let home: string

  beforeEach(async () => {
    osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-foreground-')))
    home = join(osHome, '.delorun')
    await ensureHomeTree(home, PROFILE)
  })

  afterEach(() => { rmSync(osHome, { recursive: true, force: true }) })

  /**
   * @param form - the form.
   * @param options - replaced request fields.
   * @returns the result.
   */
  function run(form: SetupRequest['form'], options: Partial<SetupRequest> = {}): Promise<CommandResult> {
    return runSetup({
      home, profile: PROFILE, env: { HOME: osHome, ...LAUNCHED }, form,
      output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
      registry: registryWithTailscale(fakeTailscale('home.example.ts.net').run), keyCheck: () => Promise.resolve({ ok: true }), portIsFree: () => Promise.resolve(true),
      sandboxCheck: () => Promise.resolve(undefined),
      foreground: dependencies(), ...options,
    })
  }

  it('a fresh interactive run writes first, then starts once, and its terminal at 80 columns is the fixture', { timeout: 60_000 }, async () => {
    const wroteBeforeStart = vi.fn()
    const result = await run({ kind: 'interactive', prompter: scriptedPrompter(['no', 'yes'], recording) }, {
      foreground: dependencies({ start: (request) => { wroteBeforeStart(existsSync(join(home, 'profiles', PROFILE, 'setup-answers.json'))); return announcingStart(request) } }),
    })
    expect(result).toBeUndefined()
    expect(wroteBeforeStart).toHaveBeenCalledWith(true)
    expect(started).toHaveLength(1)
    expect(npmCalls).toEqual([['install', '-g', 'delorun@0.1.0']])
    const text = `${recording.screen.map(line => wrapAt80(line.replaceAll(osHome, '~').replace(/^delorun .* · new home/u, 'delorun <version> · new home'))).join('\n')}\n`
    await expect(text).toMatchFileSnapshot('./fixtures/fresh-run-80-columns.txt')
  })

  it('a devices Yes run names the address and the pairing in its terminal at 80 columns, as the second fixture', { timeout: 60_000 }, async () => {
    const result = await run({ kind: 'interactive', prompter: scriptedPrompter(['yes', 'no', true, 'no'], recording) }, { registry: registryWithTailscale(fakeTailscale('my-pc.example.ts.net').run) })
    expect(result).toBeUndefined()
    expect(screen()).toContain('Finish setup here, or on any device signed in to your Tailscale: https://my-pc.example.ts.net')
    expect(screen()).toContain('A new device asks to pair: approve it here at this computer, or unlock it with the PIN.')
    expect(screen().indexOf('Finish setup here')).toBeLessThan(screen().indexOf('Delorun runs in this terminal. Ctrl+C stops it.'))
    expect(screen()).not.toContain('The studio opens on this computer only')
    const text = `${recording.screen.map(line => wrapAt80(line.replaceAll(osHome, '~').replace(/^delorun .* · new home/u, 'delorun <version> · new home'))).join('\n')}\n`
    await expect(text).toMatchFileSnapshot('./fixtures/devices-run-80-columns.txt')
  })

  it('a form without a terminal starts nothing and prints the plain ending', { timeout: 60_000 }, async () => {
    expect(await run({ kind: 'interactive' })).toBe(EXIT.ok)
    expect(started).toEqual([])
    expect(screen()).toContain('Studio: http://127.0.0.1:3080')
    expect(screen()).not.toContain(ENDING_LINES[0])
  })

  it('--yes starts nothing and prints the plain ending with the chosen port', { timeout: 60_000 }, async () => {
    expect(await run({ kind: 'yes' }, { answerFlags: { port: 3123 } })).toBe(EXIT.ok)
    expect(started).toEqual([])
    expect(screen()).toContain('Studio: http://127.0.0.1:3123')
    expect(recording.asked).toEqual([])
  })

  it('a re-run of a finished setup starts nothing', { timeout: 60_000 }, async () => {
    await run({ kind: 'interactive', prompter: scriptedPrompter(['no', 'no'], recording) })
    expect(started).toHaveLength(1)
    recording.screen.length = 0
    expect(await run({ kind: 'interactive', prompter: scriptedPrompter(['no'], { screen: [], asked: [] }) })).toBe(EXIT.ok)
    expect(started).toHaveLength(1)
    expect(screen()).toContain('Delorun is already set up.')
    expect(screen()).toContain('Studio: http://127.0.0.1:3080')
    expect(screen()).not.toContain(ENDING_LINES[0])
  })

  it('a phone Yes asks the PIN after the start and sets it with the running home', { timeout: 60_000 }, async () => {
    await run({ kind: 'interactive', prompter: scriptedPrompter(['yes', 'no', true, 'no'], recording) }, { env: { HOME: osHome, ...LAUNCHED } })
    expect(recording.asked.at(0)).toBe(PHONE_QUESTION)
    expect(recording.asked.slice(-2)).toEqual([PIN_QUESTION, KEEP_QUESTION])
    expect(sent).toEqual([{ op: 'pin.set', args: { secret: PIN } }])
  })
})
