/**
 * The autostart hook: the unit file it writes, what it does on a computer with no systemd user manager, and how the
 * setup section asks for it. Every command is scripted, so no spec starts a unit or changes linger on the machine that
 * runs it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETUP_DEFAULTS, type SetupAnswers } from '@delorun/contract-setup-answers'
import {
  AUTOSTART_UNIT,
  autostartOn,
  autostartSupport,
  installUnit,
  launcherCommand,
  lingerEnabled,
  removeUnit,
  unitPath,
  unitText,
  type CommandOutcome,
  type runCommand,
} from '../../src/autostart.ts'
import { AUTOSTART_QUESTION, autostartSection, autostartStatusLine, autostartText } from '../../src/setup/autostart-section.ts'
import { BACK, BACK_CHOICE, stepIO } from '../../src/setup/steps.ts'
import { scriptedPrompter, type Answer, type Recording } from './support.ts'

const HOME = '/tmp/autostart-spec-home'
const PROFILE = 'default'
const ENTRY = '/home/person/.local/lib/node_modules/delorun/dist/bin.js'
const NODE = '/usr/bin/node'
/** The account `loginctl` is asked about: this process's own. */
const ACCOUNT = userInfo().username

let configHome: string
let env: Record<string, string>
let recording: Recording

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'delorun-autostart-'))
  env = { XDG_CONFIG_HOME: configHome, PATH: '/usr/local/bin:/usr/bin:/bin' }
  recording = { screen: [], asked: [] }
})

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true })
})

/**
 * A scripted `systemctl` and `loginctl`.
 * @param answers - what each command line answers, by the words after the program name.
 * @param calls - receives each command line.
 * @returns the runner.
 */
function scripted(answers: Readonly<Record<string, CommandOutcome>>, calls: string[] = []): typeof runCommand {
  return (file, args) => {
    const line = `${file} ${args.join(' ')}`
    calls.push(line)
    return Promise.resolve(answers[line] ?? { ok: false, text: '' })
  }
}

/**
 * A machine with a working user manager that allows linger.
 * @param calls - receives each command line.
 * @returns the runner.
 */
function workingMachine(calls: string[] = []): typeof runCommand {
  return scripted({
    // The manager names the temp directory, so no spec writes a unit into the real home.
    'systemctl --user show-environment': { ok: true, text: `HOME=/home/person\nXDG_CONFIG_HOME=${configHome}` },
    'systemctl --user daemon-reload': { ok: true, text: '' },
    [`systemctl --user enable ${AUTOSTART_UNIT}.service`]: { ok: true, text: '' },
    [`systemctl --user disable --now ${AUTOSTART_UNIT}.service`]: { ok: true, text: '' },
    [`systemctl --user is-enabled ${AUTOSTART_UNIT}.service`]: { ok: true, text: 'enabled' },
    'loginctl enable-linger --no-ask-password': { ok: true, text: '' },
    [`loginctl show-user --property=Linger --value ${ACCOUNT}`]: { ok: true, text: 'yes' },
  }, calls)
}

/**
 * @returns the unit request of a real install.
 */
function request(): Parameters<typeof installUnit>[0] {
  return { home: HOME, profile: PROFILE, entry: ENTRY, node: NODE, env }
}

/**
 * @param answers - the answers so far.
 * @returns what a section may look at.
 */
function environment(): Parameters<ReturnType<typeof autostartSection>['ask']>[2] {
  return {
    env,
    home: HOME,
    profile: PROFILE,
    profileExists: false,
    profileNameTaken: () => false,
    checkKey: () => Promise.resolve({ ok: true }),
    checkEnvironmentKey: false,
    portIsFree: () => Promise.resolve(true),
    hasSavedKey: () => false,
  }
}

/**
 * Ask the section with a script.
 * @param script - the answers in order.
 * @param run - the scripted commands.
 * @param answers - the answers so far.
 * @returns what the section returned.
 */
async function ask(script: readonly Answer[], run: typeof runCommand, answers: Partial<SetupAnswers> = {}): Promise<unknown> {
  return autostartSection(run).ask(stepIO(scriptedPrompter(script, recording), false), { phase: 'main', answers: { ...SETUP_DEFAULTS, ...answers }, secret: undefined }, environment())
}

describe('the unit file', () => {
  it('runs the launcher in the foreground, so the unit is the home process and delorun stop ends it', () => {
    expect(unitText(request())).toContain(`ExecStart=${NODE} ${ENTRY} start --foreground --profile ${PROFILE}`)
  })

  it('names the home and the profile, so the unit starts the setup the person chose', () => {
    const text = unitText(request())
    expect(text).toContain(`Environment=DELORUN_HOME=${HOME}`)
    expect(text).toContain(`Environment=DSH_HOME=${HOME}`)
    expect(text).toContain(`Environment=PATH=${env['PATH']}`)
  })

  it('never restarts a home process the person stopped', () => {
    expect(unitText(request())).toContain('Restart=no')
  })

  it('starts at login through default.target', () => {
    expect(unitText(request())).toContain('WantedBy=default.target')
  })
})

describe('whether this computer can run a unit', () => {
  it('accepts a Linux machine booted by systemd, without running a command', () => {
    expect(autostartSupport('linux', () => true)).toEqual({ kind: 'systemd' })
  })

  it('refuses a Linux machine with no systemd runtime directory, naming why', () => {
    const support = autostartSupport('linux', () => false)
    expect(support.kind).toBe('unsupported')
    expect(support.kind === 'unsupported' ? support.why : '').toContain('not running systemd')
  })

  it('refuses another platform, naming it', () => {
    const support = autostartSupport('darwin', () => true)
    expect(support.kind).toBe('unsupported')
    expect(support.kind === 'unsupported' ? support.why : '').toContain('darwin')
  })
})

describe('installing the unit', () => {
  it('writes the unit, enables it and reports that it starts at login and at boot', async () => {
    const outcome = await installUnit(request(), workingMachine())
    expect(outcome.ok).toBe(true)
    expect(outcome.linger).toBe(true)
    expect(outcome.detail).toContain('starts at login and at boot')
    expect(readFileSync(await unitPath(env, workingMachine()), 'utf8')).toContain('ExecStart=')
  })

  it('creates the unit directory a fresh account does not have', async () => {
    await installUnit(request(), workingMachine())
    expect(readFileSync(join(configHome, 'systemd', 'user', `${AUTOSTART_UNIT}.service`), 'utf8')).toContain('[Unit]')
  })

  it('writes where the user manager reads, not where the caller says', async () => {
    // The manager runs with its own XDG_CONFIG_HOME; a unit written to the caller's is a file systemd never reads.
    const managerHome = join(configHome, 'manager')
    const run = scripted({
      'systemctl --user show-environment': { ok: true, text: `HOME=/home/person\nXDG_CONFIG_HOME=${managerHome}` },
      'systemctl --user daemon-reload': { ok: true, text: '' },
      [`systemctl --user enable ${AUTOSTART_UNIT}.service`]: { ok: true, text: '' },
      'loginctl enable-linger --no-ask-password': { ok: true, text: '' },
      [`loginctl show-user --property=Linger --value ${ACCOUNT}`]: { ok: true, text: 'yes' },
    })
    await installUnit(request(), run)
    expect(readFileSync(join(managerHome, 'systemd', 'user', `${AUTOSTART_UNIT}.service`), 'utf8')).toContain('[Unit]')
    expect(() => readFileSync(join(configHome, 'systemd', 'user', `${AUTOSTART_UNIT}.service`), 'utf8')).toThrow()
  })

  it('says plainly that it starts at login only when linger is refused', async () => {
    const run = scripted({
      'systemctl --user show-environment': { ok: true, text: `XDG_CONFIG_HOME=${configHome}` },
      'systemctl --user daemon-reload': { ok: true, text: '' },
      [`systemctl --user enable ${AUTOSTART_UNIT}.service`]: { ok: true, text: '' },
      'loginctl enable-linger --no-ask-password': { ok: false, text: 'Interactive authentication required.' },
      [`loginctl show-user --property=Linger --value ${ACCOUNT}`]: { ok: true, text: 'no' },
    })
    const outcome = await installUnit(request(), run, () => Promise.resolve())
    expect(outcome.ok).toBe(true)
    expect(outcome.linger).toBe(false)
    expect(outcome.detail).toContain('starts at login')
    expect(outcome.detail).toContain('did not allow linger')
    // It says what the person does not get, and never claims the boot start.
    expect(outcome.detail).toContain('does not start at boot')
    expect(outcome.detail).not.toContain('starts at login and at boot')
  })

  it('reads linger back again, because logind writes its marker after the request returns', async () => {
    let reads = 0
    const run: typeof runCommand = (file, args) => {
      const line = `${file} ${args.join(' ')}`
      if (line === `loginctl show-user --property=Linger --value ${ACCOUNT}`) {
        reads += 1
        // The first read lands before logind has written the marker.
        return Promise.resolve({ ok: true, text: reads === 1 ? 'no' : 'yes' })
      }
      return workingMachine()(file, args)
    }
    const outcome = await installUnit(request(), run, () => Promise.resolve())
    expect(outcome.linger).toBe(true)
    expect(reads).toBe(2)
  })

  it('reports a unit it could not enable rather than claiming it works', async () => {
    const run = scripted({
      'systemctl --user show-environment': { ok: true, text: `XDG_CONFIG_HOME=${configHome}` },
      'systemctl --user daemon-reload': { ok: true, text: '' },
      [`systemctl --user enable ${AUTOSTART_UNIT}.service`]: { ok: false, text: 'Failed to enable unit.' },
    })
    const outcome = await installUnit(request(), run)
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('did not enable it')
  })
})

describe('removing the unit', () => {
  it('disables and stops the unit before its file goes', async () => {
    await installUnit(request(), workingMachine())
    const calls: string[] = []
    expect((await removeUnit(env, workingMachine(calls))).ok).toBe(true)
    expect(calls).toContain(`systemctl --user disable --now ${AUTOSTART_UNIT}.service`)
    expect(() => readFileSync(join(configHome, 'systemd', 'user', `${AUTOSTART_UNIT}.service`), 'utf8')).toThrow()
  })

  it('is a no-op on a computer with no unit', async () => {
    const outcome = await removeUnit(env, workingMachine())
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('no unit to remove')
  })

  it('leaves linger alone, because another unit may rely on it', async () => {
    await installUnit(request(), workingMachine())
    const calls: string[] = []
    await removeUnit(env, workingMachine(calls))
    expect(calls.some(call => call.includes('disable-linger'))).toBe(false)
  })
})

describe('reading the state back', () => {
  it('reports the hook on only when the unit is enabled', async () => {
    await installUnit(request(), workingMachine())
    expect(await autostartOn(env, workingMachine())).toBe(true)
    expect(await autostartOn(env, scripted({ [`systemctl --user is-enabled ${AUTOSTART_UNIT}.service`]: { ok: false, text: 'disabled' } }))).toBe(false)
  })

  it('reports the hook off when no unit file exists', async () => {
    expect(await autostartOn(env, workingMachine())).toBe(false)
  })

  it('reads linger from loginctl', async () => {
    expect(await lingerEnabled(workingMachine())).toBe(true)
    expect(await lingerEnabled(scripted({ [`loginctl show-user --property=Linger --value ${ACCOUNT}`]: { ok: true, text: 'no' } }))).toBe(false)
  })

  it('shows a status line only when the hook is on', async () => {
    expect(await autostartStatusLine(env, workingMachine())).toBe('')
    await installUnit(request(), workingMachine())
    expect(await autostartStatusLine(env, workingMachine())).toContain('Starts at login: yes, and at boot')
  })

  it('says in the status line when the hook waits for a login', async () => {
    await installUnit(request(), workingMachine())
    const noLinger = scripted({
      [`systemctl --user is-enabled ${AUTOSTART_UNIT}.service`]: { ok: true, text: 'enabled' },
      [`loginctl show-user --property=Linger --value ${ACCOUNT}`]: { ok: true, text: 'no' },
    })
    expect(await autostartStatusLine(env, noLinger)).toContain('at boot only after a login')
  })
})

describe('finding the launcher', () => {
  it('runs the entry file this process loaded', () => {
    const file = join(configHome, 'bin.js')
    writeFileSync(file, '')
    expect(launcherCommand(env, file)).toEqual({ node: process.execPath, entry: file })
  })

  it('falls back to the delorun program on PATH', () => {
    const directory = join(configHome, 'bin')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'delorun'), '')
    expect(launcherCommand({ PATH: directory }, join(configHome, 'gone.js'))).toEqual({ node: process.execPath, entry: join(directory, 'delorun') })
  })

  it('finds nothing when neither exists', () => {
    expect(launcherCommand({ PATH: join(configHome, 'empty') }, join(configHome, 'gone.js'))).toBeUndefined()
  })
})

describe('the setup section', () => {
  it('asks the question with No preselected, so a service never installs itself unasked', async () => {
    const given = await ask([false], workingMachine())
    expect(recording.asked).toEqual([`confirm: ${AUTOSTART_QUESTION}`])
    expect(recording.screen).toContain(`? ${AUTOSTART_QUESTION} (No)`)
    expect(given).toMatchObject({ answers: { autostart: false }, status: 'answered' })
  })

  it('takes Yes and records it', async () => {
    expect(await ask([true], workingMachine())).toMatchObject({ answers: { autostart: true }, status: 'answered' })
  })

  it('offers the way back', async () => {
    // The way back is offered only when an earlier question exists, as the step runner decides.
    const given = await autostartSection(workingMachine()).ask(stepIO(scriptedPrompter([BACK_CHOICE], recording), true), { phase: 'main', answers: SETUP_DEFAULTS, secret: undefined }, environment())
    expect(given).toBe(BACK)
  })

  it('shows the login and boot difference in the choice text', () => {
    const text = autostartText().map(choice => choice.lines.join(' ')).join(' ')
    expect(text).toContain('starts by itself when you log in')
    expect(text).toContain('Starting at boot with nobody logged in needs linger')
  })

  it('says so instead of asking on a computer with no user manager', async () => {
    // The support check reads the filesystem, so a spec can only reach this branch on a machine without systemd.
    const support = autostartSupport('linux', () => false)
    expect(support.kind).toBe('unsupported')
    expect(autostartSection(workingMachine()).appliesTo(environment())).toBe(true)
  })

  it('installs the unit when the answer is yes', async () => {
    const note = await autostartSection(workingMachine()).apply({ home: HOME, env, directory: join(HOME, 'profiles', PROFILE), secret: undefined }, { ...SETUP_DEFAULTS, autostart: true })
    expect(note).toContain('starts at login')
    expect(readFileSync(join(configHome, 'systemd', 'user', `${AUTOSTART_UNIT}.service`), 'utf8')).toContain(`--profile ${PROFILE}`)
  })

  it('removes the unit when the answer is no', async () => {
    await installUnit(request(), workingMachine())
    expect(await autostartSection(workingMachine()).apply({ home: HOME, env, directory: join(HOME, 'profiles', PROFILE), secret: undefined }, { ...SETUP_DEFAULTS, autostart: false })).toBeUndefined()
    expect(() => readFileSync(join(configHome, 'systemd', 'user', `${AUTOSTART_UNIT}.service`), 'utf8')).toThrow()
  })

  it('writes nothing when the answer is unchanged', () => {
    const section = autostartSection(workingMachine())
    expect(section.unchanged?.({ ...SETUP_DEFAULTS, autostart: false }, { ...SETUP_DEFAULTS, autostart: false }, false)).toBe(true)
    expect(section.unchanged?.({ ...SETUP_DEFAULTS, autostart: false }, { ...SETUP_DEFAULTS, autostart: true }, false)).toBe(false)
  })
})
