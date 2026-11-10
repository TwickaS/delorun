import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureHomeTree, runDirectory } from '@delo/home'
import { PARITY_SWITCHES } from '@delo/contract-parity-composition'
import { CliError, EXIT } from '../../src/exit.ts'
import { hasCliProfile, profileDirectory } from '../../src/profile.ts'
import { readBackgroundAnswer } from '../../src/setup/background.ts'
import { linkDeloBundles } from '../../src/delo-bundles.ts'
import { runSection, runSetup, sectionList, type SetupRequest } from '../../src/setup/index.ts'
import { readProgress } from '../../src/setup/progress.ts'
import { SetupCancelled } from '../../src/setup/prompts.ts'
import { defaultRegistry, privacySection, SectionRegistry, type SetupSection } from '../../src/setup/sections.ts'
import { BACK_CHOICE } from '../../src/setup/steps.ts'
import { fakeEnding, scriptedPrompter, type Answer, type EndingBehaviour, type EndingLog, type Recording } from './support.ts'

const computerEndingMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/setup/ending.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/setup/ending.ts')>(),
  computerEnding: computerEndingMock,
}))

vi.mock('../../src/delo-bundles.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/delo-bundles.ts')>(),
  linkDeloBundles: vi.fn(() => Promise.resolve()),
}))

const PROFILE = 'default'
const TYPED_KEY = 'sk-typed-fixture-key-9f3a'
const TIMEOUT_MS = 60_000

let osHome: string
let home: string
let recording: Recording
let ending: EndingLog

/**
 * Run an interactive setup against a script.
 * @param script - the answers in order.
 * @param options - extra request fields and the fake ending's behaviour.
 * @returns the exit code.
 */
async function interactive(script: readonly Answer[], options: Partial<SetupRequest> & { behaviour?: EndingBehaviour } = {}): Promise<number> {
  const { behaviour, ...rest } = options
  return runSetup({
    home,
    profile: PROFILE,
    output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
    env: {},
    form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) },
    keyCheck: () => Promise.resolve({ ok: true }),
    portIsFree: () => Promise.resolve(true),
    ending: fakeEnding(ending, behaviour),
    ...rest,
  })
}

/**
 * @param profile - a profile name.
 * @returns the profile's patch rows.
 */
function patchOf(profile = PROFILE): { id: string, config: Record<string, unknown> }[] {
  return parse(readFileSync(join(profileDirectory(home, profile), 'cordis.patch.yml'), 'utf8')) as { id: string, config: Record<string, unknown> }[]
}

/**
 * @param profile - a profile name.
 * @returns the profile's recorded answers.
 */
function recordOf(profile = PROFILE): { sections: { id: string, status: string }[], background: boolean, prompts: string, profile: { name: string | null, port: number | null }, modelProvider: unknown } {
  return JSON.parse(readFileSync(join(profileDirectory(home, profile), 'setup-answers.json'), 'utf8')) as ReturnType<typeof recordOf>
}

/** @returns the screen as one text, the profile directory shown as a placeholder. */
function screen(): string {
  return recording.screen.join('\n').replaceAll(profileDirectory(home, PROFILE), '<profile>').replaceAll(profileDirectory(home, 'work'), '<work profile>')
}

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-modes-')))
  home = join(osHome, '.delo')
  await ensureHomeTree(home, PROFILE)
  recording = { screen: [], asked: [] }
  ending = { spawned: [], started: [], opened: 0 }
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

const QUICK_SCRIPT: readonly Answer[] = ['quick', 'prompt', TYPED_KEY, 'safer', 'save', true]

const QUICK_TRANSCRIPT = `? How do you want to set up Delorun?
> Quick (the model key and how careful prompts are)
  Full (also the release check, background running, the profile name and the port)
= Quick
# Privacy
  Delo has no telemetry of its own.
  DeepSeek Harness's desktop analytics and DeepSeek's session-log upload are off unless you turn them on. You can turn them on later in Settings → Privacy.
  Sending feedback includes a session-log prefix, and it is sent only when you send feedback.
  Once a day, and at start when a day has passed, Delo checks whether a newer release exists: it fetches timestamp.json, and a new root file when Delo's signing keys change, from releases.delorun.com and the newest release's manifest and log record from GitHub. It sends nothing about this installation or its plugins; those hosts see this computer's address. Turn it off in Settings → Privacy.
  Quick setup keeps the release check on. To turn it off before Delorun first starts, choose ← Back at the next question, then Full.
? Where does the DeepSeek API key come from?
> Enter the key now (stored in the home's credentials document)
  Read DEEPSEEK_API_KEY from the environment at each start
  ← Back
= Enter the key now
? DeepSeek API key (leave empty to go back)
= *************************
? How should Delorun ask before it changes things?
> Safer prompts (asks before instruction edits, new MCP servers, scheduled work and full access)
  Same as stock (behaves as DeepSeek Harness does)
  ← Back
= Safer prompts
# Review
  Setup: Quick
  DeepSeek API key: key entered now
  Prompts: Safer prompts
? Save these answers and set up Delorun?
> Save and set up
  Cancel (nothing is written)
  ← Back
= Save and set up
Set up the CLI profile default at <profile>.
? Install the delorun command? (runs npm install -g delorun) (Yes)
= Yes
Delorun is running in the background and keeps running after you close this terminal.
Studio: http://127.0.0.1:3080/ (opened in your browser)
  delorun status
  delorun logs --follow
  delorun stop`

describe('Quick setup', { timeout: TIMEOUT_MS }, () => {
  it('plays the Quick flow, top to bottom, as the person sees it', async () => {
    expect(await interactive(QUICK_SCRIPT)).toBe(EXIT.ok)
    expect(screen()).toBe(QUICK_TRANSCRIPT)
  })

  it('stores the key, writes the safer prompt rows, records what was asked and starts Delorun in the background', async () => {
    expect(await interactive(QUICK_SCRIPT)).toBe(EXIT.ok)
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: TYPED_KEY } })
    expect(patchOf()).toEqual([
      { id: 'delo-permission-defaults', config: { enabled: true } },
      { id: 'delo-instruction-consent', config: { enabled: true } },
      { id: 'delo-mcp-consent', config: { enabled: true } },
      { id: 'delo-schedule-consent', config: { enabled: true } },
    ])
    expect(recordOf().sections).toEqual([
      { id: 'privacy', status: 'seen' },
      { id: 'import', status: 'skipped' },
      { id: 'key', status: 'answered' },
      { id: 'prompts', status: 'answered' },
      { id: 'background', status: 'skipped' },
      { id: 'reach', status: 'skipped' },
      { id: 'profile', status: 'skipped' },
    ])
    expect(ending.spawned).toEqual(['npm install -g delorun'])
    expect(ending.started).toEqual(['background'])
    expect(ending.opened).toBe(1)
    expect(readBackgroundAnswer(profileDirectory(home, PROFILE))).toBe(true)
  })

  it('writes "Same as stock" as the parity value of every prompt switch', async () => {
    expect(await interactive(['quick', 'environment', 'stock', 'save', false])).toBe(EXIT.ok)
    const byId = new Map(patchOf().map(row => [row.id, row.config]))
    const parityOf = (id: string): boolean => {
      const entry = PARITY_SWITCHES.find(candidate => candidate.id === id)
      return entry?.state === 'built' ? entry.parityValue : true
    }
    expect(Object.fromEntries(byId)).toEqual({
      'delo-permission-defaults': { enabled: parityOf('permission_defaults') },
      'delo-instruction-consent': { enabled: parityOf('instruction_layer_consent') },
      'delo-mcp-consent': { enabled: parityOf('mcp_add_consent') },
      'delo-schedule-consent': { enabled: parityOf('scheduled_task_consent') },
    })
    expect([...byId.values()].every(config => config['enabled'] === false)).toBe(true)
    expect(byId.has('delo-fetch-guard')).toBe(false)
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  })

  it('never prints the typed key, and keeps it out of every file setup writes except the credentials document', async () => {
    expect(await interactive(QUICK_SCRIPT)).toBe(EXIT.ok)
    expect(recording.screen.join('\n')).not.toContain(TYPED_KEY)
    expect(recording.asked.join('\n')).not.toContain(TYPED_KEY)
    for (const file of [join(profileDirectory(home, PROFILE), 'setup-answers.json'), join(profileDirectory(home, PROFILE), 'cordis.patch.yml')]) {
      expect(readFileSync(file, 'utf8')).not.toContain(TYPED_KEY)
    }
    expect(existsSync(join(runDirectory(home, PROFILE), 'setup-progress.json'))).toBe(false)
  })

  it('writes nothing when the person cancels at the review', async () => {
    await expect(interactive(['quick', 'environment', 'safer', 'cancel'])).rejects.toBeInstanceOf(SetupCancelled)
    expect(hasCliProfile(home, PROFILE)).toBe(false)
    expect(readProgress(runDirectory(home, PROFILE))).toBeUndefined()
    expect(ending.started).toEqual([])
  })
})

describe('the way back', { timeout: TIMEOUT_MS }, () => {
  it('returns to the previous question and keeps the answers of the earlier ones', async () => {
    expect(await interactive(['quick', 'prompt', TYPED_KEY, BACK_CHOICE, 'environment', 'stock', 'save', false])).toBe(EXIT.ok)
    expect(recording.asked.filter(question => question.startsWith('select: Where does'))).toHaveLength(2)
    expect(recordOf().modelProvider).toEqual({ id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } })
    expect(recordOf().prompts).toBe('stock')
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  })

  it('treats an empty key as "go back" and returns to the first screen, which has no back choice', async () => {
    expect(await interactive(['quick', 'prompt', '', 'quick', 'environment', 'safer', 'save', false])).toBe(EXIT.ok)
    expect(recording.asked.filter(question => question.startsWith('select: How do you want'))).toHaveLength(2)
    const first = screen().split('# Privacy')[0] ?? ''
    expect(first).not.toContain('← Back')
  })

  it('lets the mode change after two steps back', async () => {
    expect(await interactive(['quick', 'environment', BACK_CHOICE, BACK_CHOICE, 'full', 'on', 'environment', 'safer', 'yes', 'no', 'default', '3080', 'save', false])).toBe(EXIT.ok)
    expect(recordOf().sections.find(record => record.id === 'profile')?.status).toBe('answered')
  })

  it('goes back from the review to the last question that was asked, and skips passed-over sections', async () => {
    expect(await interactive(['quick', 'environment', 'safer', BACK_CHOICE, 'stock', 'save', false])).toBe(EXIT.ok)
    expect(recordOf().prompts).toBe('stock')
    expect(recording.asked.filter(question => question.startsWith('select: How should'))).toHaveLength(2)
    expect(recording.asked.filter(question => question.includes('background'))).toEqual([])
  })

  it('does not show the privacy note again when the way back stops at a later question', async () => {
    expect(await interactive(['quick', 'environment', BACK_CHOICE, 'environment', 'safer', 'save', false])).toBe(EXIT.ok)
    expect(screen().split('# Privacy')).toHaveLength(2)
  })
})

describe('the key check', { timeout: TIMEOUT_MS }, () => {
  it('sends a typed key to one live check before it is stored, and never checks it again', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: true } as const))
    expect(await interactive(QUICK_SCRIPT, { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(checkKey).toHaveBeenCalledTimes(1)
    expect(checkKey).toHaveBeenCalledWith(TYPED_KEY)
  })

  it('says why a check failed and lets the person enter the key again', async () => {
    const checkKey = vi.fn((key: string) => Promise.resolve(key === TYPED_KEY ? { ok: true } as const : { ok: false, reason: 'api.example did not accept the key (HTTP 401).' } as const))
    expect(await interactive(['quick', 'prompt', 'wrong-key-1', 'again', TYPED_KEY, 'safer', 'save', false], { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(screen()).toContain('The key was not checked successfully: api.example did not accept the key (HTTP 401).')
    expect(screen()).not.toContain('wrong-key-1')
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8')).refs.DEEPSEEK_API_KEY).toBe(TYPED_KEY)
  })

  it('stores a key that failed the check only when the person chooses to continue', async () => {
    const checkKey = (): Promise<{ ok: false, reason: string }> => Promise.resolve({ ok: false, reason: 'could not reach api.example.' })
    expect(await interactive(['quick', 'prompt', 'unchecked-key-2', 'continue', 'safer', 'save', false], { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8')).refs.DEEPSEEK_API_KEY).toBe('unchecked-key-2')
  })

  it('goes back from the failed-check choice to the source question', async () => {
    const checkKey = (): Promise<{ ok: false, reason: string }> => Promise.resolve({ ok: false, reason: 'could not reach api.example.' })
    expect(await interactive(['quick', 'prompt', 'unchecked-key-3', BACK_CHOICE, 'quick', 'environment', 'safer', 'save', false], { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  })

  it('checks a key from the environment only with --check-key', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: false, reason: 'api.example did not accept the key (HTTP 401).' } as const))
    const env = { DEEPSEEK_API_KEY: 'env-key-value-7' }
    expect(await interactive(['quick', 'environment', 'safer', 'save', false], { keyCheck: checkKey, env })).toBe(EXIT.ok)
    expect(checkKey).not.toHaveBeenCalled()
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    recording.screen.length = 0
    expect(await interactive(['quick', 'environment', 'safer', 'save', false], { keyCheck: checkKey, env, checkEnvironmentKey: true })).toBe(EXIT.ok)
    expect(checkKey).toHaveBeenCalledWith('env-key-value-7')
    expect(screen()).toContain('The key in DEEPSEEK_API_KEY was not checked successfully: api.example did not accept the key (HTTP 401).')
    expect(screen()).not.toContain('env-key-value-7')
  })

  it('does not check an unset environment variable even with --check-key', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: true } as const))
    expect(await interactive(['quick', 'environment', 'safer', 'save', false], { keyCheck: checkKey, checkEnvironmentKey: true })).toBe(EXIT.ok)
    expect(checkKey).not.toHaveBeenCalled()
  })
})

const FULL_TRANSCRIPT = `? How do you want to set up Delorun?
> Quick (the model key and how careful prompts are)
  Full (also the release check, background running, the profile name and the port)
= Full
# Privacy
  Delo has no telemetry of its own.
  DeepSeek Harness's desktop analytics and DeepSeek's session-log upload are off unless you turn them on. You can turn them on later in Settings → Privacy.
  Sending feedback includes a session-log prefix, and it is sent only when you send feedback.
  Once a day, and at start when a day has passed, Delo checks whether a newer release exists: it fetches timestamp.json, and a new root file when Delo's signing keys change, from releases.delorun.com and the newest release's manifest and log record from GitHub. It sends nothing about this installation or its plugins; those hosts see this computer's address. Turn it off in Settings → Privacy.
? Check for new releases?
> Yes (once a day Delo fetches signed release files from releases.delorun.com and GitHub; it sends nothing about this installation, and those hosts see this computer's address)
  No (no release check request is made; turn it on later in Settings → Privacy or with delorun setup privacy)
  ← Back
= Yes
? Where does the DeepSeek API key come from?
> Enter the key now (stored in the home's credentials document)
  Read DEEPSEEK_API_KEY from the environment at each start
  ← Back
= Read DEEPSEEK_API_KEY from the environment at each start
? How should Delorun ask before it changes things?
> Safer prompts (asks before instruction edits, new MCP servers, scheduled work and full access)
  Same as stock (behaves as DeepSeek Harness does)
  ← Back
= Safer prompts
? Keep Delorun running in the background after the terminal closes?
> Yes
  No
  ← Back
= No
? Reach this studio from your phone over your own tailnet (Tailscale)?
  Yes
> No
  ← Back
= No
? Profile name (leave empty to go back) [default]
= work
? Port for the studio (leave empty to go back) [3080]
= 4100
# Review
  Setup: Full
  Check for new releases: yes
  DeepSeek API key: read from DEEPSEEK_API_KEY at each start
  Prompts: Safer prompts
  Keep running in the background: no
  Remote access: off
  Profile: work, port 4100
? Save these answers and set up Delorun?
> Save and set up
  Cancel (nothing is written)
  ← Back
= Save and set up
Set up the CLI profile work at <work profile>.
? Install the delorun command? (runs npm install -g delorun) (Yes)
= Yes
Delorun is running in this terminal. Closing the terminal stops it.
Studio: http://127.0.0.1:4100/ (opened in your browser)
  delorun status --profile work
  delorun logs --follow --profile work
  delorun stop --profile work`

describe('Full setup', { timeout: TIMEOUT_MS }, () => {
  const FULL_SCRIPT: readonly Answer[] = ['full', 'on', 'environment', 'safer', 'no', 'no', 'work', '4100', 'save', true]

  it('asks the background and profile sections after Quick\'s, and shows them on the review', async () => {
    expect(await interactive(FULL_SCRIPT, { behaviour: { address: 'http://127.0.0.1:4100/' } })).toBe(EXIT.ok)
    expect(screen()).toBe(FULL_TRANSCRIPT)
  })

  it('creates the profile under the chosen name, writes the port row and starts attached to the terminal', async () => {
    expect(await interactive(FULL_SCRIPT)).toBe(EXIT.ok)
    expect(hasCliProfile(home, 'work')).toBe(true)
    expect(hasCliProfile(home, PROFILE)).toBe(false)
    expect(patchOf('work')).toContainEqual({ id: 'webserver', config: { host: '127.0.0.1', port: 4100, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
    expect(recordOf('work').sections.map(record => record.status)).toEqual(['answered', 'skipped', 'answered', 'answered', 'answered', 'answered', 'answered'])
    expect(readBackgroundAnswer(profileDirectory(home, 'work'))).toBe(false)
    expect(ending.started).toEqual(['foreground'])
    expect(ending.opened).toBe(1)
    expect(screen()).toContain('Delorun is running in this terminal. Closing the terminal stops it.')
    expect(screen()).toContain('  delorun status --profile work')
    expect(screen()).toContain('  delorun stop --profile work')
  })

  it('keeps the default profile name and port without writing a port row', async () => {
    expect(await interactive(['full', 'on', 'environment', 'safer', 'yes', 'no', 'default', '3080', 'save', false])).toBe(EXIT.ok)
    expect(patchOf().map(row => row.id)).not.toContain('webserver')
    expect(recordOf().profile).toEqual({ name: null, port: null })
    expect(ending.started).toEqual(['background'])
  })

  it('asks again for a port that is in use, a port outside the range, a name that is taken, a reserved name and a name that is refused', async () => {
    mkdirSync(profileDirectory(home, 'taken'), { recursive: true })
    writeFileSync(join(profileDirectory(home, 'taken'), 'package.json'), '{}\n')
    const portIsFree = (port: number): Promise<boolean> => Promise.resolve(port !== 4100)
    expect(await interactive(['full', 'on', 'environment', 'safer', 'yes', 'no', 'taken', 'desktop', 'headless', 'a/b', 'work', '80', '4100', '4101', 'save', false], { portIsFree })).toBe(EXIT.ok)
    expect(screen()).toContain('! A profile named taken already exists.')
    expect(screen()).toContain('! Choose another name: "desktop" is reserved: it is the desktop app\'s own profile, which only the desktop app runs or changes.')
    expect(screen()).toContain('! Choose another name: "headless" is reserved: it is the profile `delorun headless` boots')
    expect(screen()).toContain('! Choose another name: "a/b" is not a profile name: a profile is 1 to 32 lowercase letters')
    expect(screen()).toContain('! Enter a port from 1024 to 65535.')
    expect(screen()).toContain('Port 4100 is in use on this computer. Choose another.')
    expect(recordOf('work').profile).toEqual({ name: 'work', port: 4101 })
  })

  it('goes back from the profile section to the background question', async () => {
    expect(await interactive(['full', 'on', 'environment', 'safer', 'yes', 'no', 'work', '', BACK_CHOICE, 'no', 'no', 'other', '4200', 'save', false])).toBe(EXIT.ok)
    expect(recordOf('other').profile).toEqual({ name: 'other', port: 4200 })
    expect(recordOf('other').background).toBe(false)
  })
})

describe('the ending', { timeout: TIMEOUT_MS }, () => {
  it('prints the exact install line when the person declines the install', async () => {
    expect(await interactive(['quick', 'environment', 'safer', 'save', false])).toBe(EXIT.ok)
    expect(ending.spawned).toEqual([])
    expect(screen()).toContain('To install it later, run:\n  npm install -g delorun')
  })

  it('prints the exact install line when the install fails, and still starts Delorun', async () => {
    expect(await interactive(QUICK_SCRIPT, { behaviour: { installExit: 127 } })).toBe(EXIT.ok)
    expect(screen()).toContain('The install did not finish. To install it yourself, run:\n  npm install -g delorun')
    expect(ending.started).toHaveLength(1)
  })

  it('treats a cancelled install offer as a decline', async () => {
    const script: Answer[] = ['quick', 'environment', 'safer', 'save']
    const prompter = scriptedPrompter(script, recording)
    const cancelling = { ...prompter, confirm: () => Promise.reject(new SetupCancelled()) }
    expect(await interactive([], { form: { kind: 'interactive', prompter: { ...cancelling, select: prompter.select, secret: prompter.secret, text: prompter.text, note: prompter.note } } })).toBe(EXIT.ok)
    expect(ending.started).toHaveLength(1)
    expect(screen()).toContain('To install it later')
  })

  it('prints the address and an SSH port-forward line when no browser can open', async () => {
    expect(await interactive(QUICK_SCRIPT, { behaviour: { canOpen: false } })).toBe(EXIT.ok)
    expect(ending.opened).toBe(0)
    expect(ending.started).toEqual(['background'])
    expect(screen()).toContain('Studio: http://127.0.0.1:3080/\n')
    expect(screen()).toContain('There is no browser to open here.')
    expect(screen()).toContain('  ssh -L 3080:127.0.0.1:3080 person@machine')
    expect(screen()).toContain('then run delorun open --print here and open the link it prints there; it signs in once, within one minute.')
  })

  it('names status and the log when the home process reports no studio, and opens nothing', async () => {
    expect(await interactive(QUICK_SCRIPT, { behaviour: { address: undefined } })).toBe(EXIT.ok)
    expect(screen()).toContain('The home process reports no studio; see delorun status and delorun logs --follow')
    expect(screen()).not.toContain('ssh -L')
    expect(ending.opened).toBe(0)
  })

  it('does not claim the studio opened when no browser took the link', async () => {
    expect(await interactive(QUICK_SCRIPT, { behaviour: { opens: false } })).toBe(EXIT.ok)
    expect(ending.opened).toBe(1)
    expect(screen()).toContain('Studio: http://127.0.0.1:3080/\n')
  })

  it('returns the start\'s failure code and prints no success text', async () => {
    expect(await interactive(QUICK_SCRIPT, { behaviour: { startResult: 1 } })).toBe(EXIT.failed)
    expect(screen()).not.toContain('Delorun is running')
  })
})

describe('sections', { timeout: TIMEOUT_MS }, () => {
  it('lists the sections with the modes that ask them', () => {
    expect(sectionList(defaultRegistry())).toBe([
      'Sections (delorun setup <section> runs one again):',
      '  privacy     Privacy (Quick and Full)',
      '  import      Import a DeepSeek Harness home (Quick and Full)',
      '  key         Model key (Quick and Full)',
      '  prompts     Prompts (Quick and Full)',
      '  background  Background (Full)',
      '  reach       Remote access (Full)',
      '  profile     Profile name and port (Full)',
      '',
    ].join('\n'))
  })

  it('runs one section again on a profile that is set up and updates the answers record', async () => {
    expect(await interactive(['quick', 'environment', 'safer', 'save', false])).toBe(EXIT.ok)
    recording.screen.length = 0
    const request: SetupRequest = {
      home, profile: PROFILE, env: {}, output: { stdout: text => void recording.screen.push(text.trim()), stderr: () => undefined },
      form: { kind: 'interactive', prompter: scriptedPrompter(['stock'], recording) },
    }
    expect(await runSection(request, 'prompts')).toBe(EXIT.ok)
    expect(patchOf().every(row => row.config['enabled'] === false)).toBe(true)
    expect(recordOf().prompts).toBe('stock')
    expect(recordOf().sections.find(record => record.id === 'prompts')?.status).toBe('answered')
    expect(recordOf().sections.find(record => record.id === 'key')?.status).toBe('answered')
    expect(screen()).toContain('Updated the prompts section of the profile default.')
    expect(recording.screen.join('\n')).not.toContain('← Back')
  })

  it('stores a typed key from the key section and asks no profile name for a profile that exists', async () => {
    expect(await interactive(['quick', 'environment', 'safer', 'save', false])).toBe(EXIT.ok)
    const request = (script: readonly Answer[]): SetupRequest => ({
      home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined },
      form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) },
      keyCheck: () => Promise.resolve({ ok: true }), portIsFree: () => Promise.resolve(true),
    })
    expect(await runSection(request(['prompt', TYPED_KEY]), 'key')).toBe(EXIT.ok)
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8')).refs.DEEPSEEK_API_KEY).toBe(TYPED_KEY)
    expect(await runSection(request(['4300']), 'profile')).toBe(EXIT.ok)
    expect(recordOf().profile).toEqual({ name: null, port: 4300 })
    expect(patchOf()).toContainEqual({ id: 'webserver', config: { host: '127.0.0.1', port: 4300, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
    expect(await runSection(request([]), 'background').catch((error: unknown) => (error as Error).message)).toContain('the script ended')
  })

  it('refuses an unknown section, a profile that is not set up, a section that does not apply and an unattended form', async () => {
    const request = (form: SetupRequest['form'], registry?: SectionRegistry): SetupRequest => ({ home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form, ...(registry === undefined ? {} : { registry }) })
    const prompter = scriptedPrompter([], recording)
    await expect(runSection(request({ kind: 'interactive', prompter }), 'nope')).rejects.toThrow('there is no section "nope"')
    await expect(runSection(request({ kind: 'interactive', prompter }), 'key')).rejects.toThrow('is not set up; run delorun setup first')
    expect(await interactive(['quick', 'environment', 'safer', 'save', false])).toBe(EXIT.ok)
    const registry = new SectionRegistry()
    registry.register({ ...privacySection, id: 'elsewhere', appliesTo: () => false }, { order: 1 })
    await expect(runSection(request({ kind: 'interactive', prompter }, registry), 'elsewhere')).rejects.toThrow('does not apply on this computer')
    await expect(runSection(request({ kind: 'yes' }), 'prompts')).rejects.toBeInstanceOf(CliError)
  })

  it('reads an answers record that is missing or no longer valid as the defaults', async () => {
    expect(await interactive(['quick', 'environment', 'safer', 'save', false])).toBe(EXIT.ok)
    const record = join(profileDirectory(home, PROFILE), 'setup-answers.json')
    const request = (): SetupRequest => ({ home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form: { kind: 'interactive', prompter: scriptedPrompter(['safer'], recording) } })
    for (const content of ['not json', JSON.stringify({ version: 1, studioAdditions: true })]) {
      writeFileSync(record, content)
      expect(await runSection(request(), 'prompts')).toBe(EXIT.ok)
      expect(recordOf().prompts).toBe('safer')
    }
    rmSync(record)
    expect(await runSection(request(), 'prompts')).toBe(EXIT.ok)
    expect(recordOf().sections).toEqual([{ id: 'prompts', status: 'answered' }])
  })
})

describe('the section registry', () => {
  /**
   * @param id - the section id.
   * @returns a section that asks nothing.
   */
  function stub(id: string): SetupSection {
    return { ...privacySection, id, title: id }
  }

  it('orders sections by their order and then by registration, and finds one by id', () => {
    const registry = new SectionRegistry()
    registry.register(stub('b'), { order: 20 })
    registry.register(stub('a'), { order: 10 })
    registry.register(stub('c'), { order: 20 })
    expect(registry.all().map(section => section.id)).toEqual(['a', 'b', 'c'])
    expect(registry.find('b')?.id).toBe('b')
    expect(registry.find('z')).toBeUndefined()
  })

  it('refuses a second section with the same id and removes a section with its disposer', () => {
    const registry = new SectionRegistry()
    const dispose = registry.register(stub('a'), { order: 1 })
    expect(() => registry.register(stub('a'), { order: 2 })).toThrow('section a is registered twice')
    dispose()
    expect(registry.all()).toEqual([])
  })

  it('puts a section registered between two existing ones into the flow where its order says', async () => {
    const registry = defaultRegistry()
    registry.register({
      ...stub('example'),
      asks: () => true,
      ask: (io) => io.confirm('Example question?', false).then(answer => typeof answer === 'boolean' ? { answers: { background: answer }, status: 'answered' as const } : answer),
      review: answers => `Example: ${answers.background ? 'yes' : 'no'}`,
    }, { order: 16 })
    expect(await interactive(['quick', 'yes', 'environment', 'safer', 'save', false], { registry })).toBe(EXIT.ok)
    expect(recording.asked.slice(0, 3)).toEqual(['select: How do you want to set up Delorun?', 'select: Example question?', 'select: Where does the DeepSeek API key come from?'])
    expect(recordOf().sections.map(record => record.id)).toEqual(['privacy', 'import', 'example', 'key', 'prompts', 'background', 'reach', 'profile'])
    expect(screen()).toContain('  Example: yes')
  })
})

describe('unattended forms', { timeout: TIMEOUT_MS }, () => {
  /**
   * @param request - extra request fields.
   * @returns the exit code of an unattended run.
   */
  function unattended(request: Partial<SetupRequest>): Promise<number> {
    return runSetup({
      home, profile: PROFILE, env: { DEEPSEEK_API_KEY: 'env-key-value-8' }, form: { kind: 'yes' },
      output: { stdout: text => void recording.screen.push(text.trim()), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
      ...request,
    })
  }

  it('records the privacy note as seen and every other section as skipped, starts nothing and prints the next step', async () => {
    expect(await unattended({})).toBe(EXIT.ok)
    expect(recordOf().sections).toEqual([
      { id: 'privacy', status: 'seen' },
      { id: 'import', status: 'skipped' },
      { id: 'key', status: 'skipped' },
      { id: 'prompts', status: 'skipped' },
      { id: 'background', status: 'skipped' },
      { id: 'reach', status: 'skipped' },
      { id: 'profile', status: 'skipped' },
    ])
    expect(screen()).toContain('Run delorun to start Delo and open the studio.')
    expect(patchOf().map(row => row.id)).toEqual(['delo-permission-defaults', 'delo-instruction-consent', 'delo-mcp-consent', 'delo-schedule-consent'])
  })

  it('checks the environment key live only with --check-key, and refuses a key the provider does not accept without printing it', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: false, reason: 'api.example did not accept the key (HTTP 401).' } as const))
    expect(await unattended({ keyCheck: checkKey })).toBe(EXIT.ok)
    expect(checkKey).not.toHaveBeenCalled()
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    const error = await unattended({ keyCheck: checkKey, checkEnvironmentKey: true }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as Error).message).toBe('delorun setup: the key in DEEPSEEK_API_KEY was not accepted: api.example did not accept the key (HTTP 401).')
    expect(hasCliProfile(home, PROFILE)).toBe(false)
    expect(statSync(home).isDirectory()).toBe(true)
  })

  it('accepts a key that passes --check-key, in the --config form too', async () => {
    const document = join(osHome, 'answers.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'stock', background: false, profile: { name: null, port: 4400 }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    const checkKey = vi.fn(() => Promise.resolve({ ok: true } as const))
    expect(await unattended({ form: { kind: 'config', path: document }, keyCheck: checkKey, checkEnvironmentKey: true })).toBe(EXIT.ok)
    expect(checkKey).toHaveBeenCalledWith('env-key-value-8')
    expect(recordOf().prompts).toBe('stock')
    expect(readBackgroundAnswer(profileDirectory(home, PROFILE))).toBe(false)
    expect(patchOf()).toContainEqual({ id: 'webserver', config: { host: '127.0.0.1', port: 4400, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
  })

  it('names the --profile flag in the next step when the profile is not the default', async () => {
    const document = join(osHome, 'named.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'safer', background: true, profile: { name: 'work', port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    expect(await unattended({ form: { kind: 'config', path: document } })).toBe(EXIT.ok)
    expect(screen()).toContain('Run delorun --profile work to start Delo and open the studio.')
  })
})

describe('what setup does around the sections', { timeout: TIMEOUT_MS }, () => {
  it('starts through the computer\'s ending when the request names none', async () => {
    computerEndingMock.mockImplementationOnce(() => fakeEnding(ending))
    const request: SetupRequest = {
      home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined },
      form: { kind: 'interactive', prompter: scriptedPrompter(['quick', 'environment', 'safer', 'save', false], recording) },
    }
    expect(await runSetup(request)).toBe(EXIT.ok)
    expect(computerEndingMock).toHaveBeenCalledWith(home, PROFILE, request.output, {})
    expect(ending.started).toHaveLength(1)
  })

  it('passes the bundle linking output to standard error', async () => {
    vi.mocked(linkDeloBundles).mockImplementationOnce((_home, _profile, _bundles, _linking, onOutput) => {
      onOutput('pnpm linked the bundle', 'stdout')
      return Promise.resolve()
    })
    expect(await interactive(['quick', 'environment', 'safer', 'save', false])).toBe(EXIT.ok)
    expect(screen()).toContain('stderr: pnpm linked the bundle')
  })

  it('stops with the cause when the profile cannot be created, and leaves the run to resume', async () => {
    mkdirSync(join(home, 'profiles'), { recursive: true })
    writeFileSync(profileDirectory(home, PROFILE), 'a file where the profile directory belongs')
    const error = await interactive(['quick', 'environment', 'safer', 'save', false]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as Error).message).toContain(`could not create the CLI profile ${PROFILE} at ${profileDirectory(home, PROFILE)}`)
    expect(readProgress(runDirectory(home, PROFILE))?.completed).toEqual([])
  })

  it('resumes after a link failure with the profile that was already created', async () => {
    vi.mocked(linkDeloBundles).mockRejectedValueOnce(new Error('pnpm failed'))
    await expect(interactive(['quick', 'environment', 'safer', 'save'])).rejects.toThrow('pnpm failed')
    expect(hasCliProfile(home, PROFILE)).toBe(true)
    expect(readProgress(runDirectory(home, PROFILE))?.completed).toEqual([])
    expect(await interactive([false])).toBe(EXIT.ok)
    expect(readProgress(runDirectory(home, PROFILE))).toBeUndefined()
    expect(screen()).toContain('Resuming the setup of default.')
  })

  it('says nothing about an environment key that passes --check-key', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: true } as const))
    expect(await interactive(['quick', 'environment', 'safer', 'save', false], { keyCheck: checkKey, env: { DEEPSEEK_API_KEY: 'passing-key-9' }, checkEnvironmentKey: true })).toBe(EXIT.ok)
    expect(checkKey).toHaveBeenCalledTimes(1)
    expect(screen()).not.toContain('Key check')
  })

  it('refuses a --config document whose environment variable is unset, and writes nothing', async () => {
    const document = join(osHome, 'unset.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'ELSEWHERE_KEY' } }, prompts: 'safer', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    const error = await runSetup({ home, profile: PROFILE, env: {}, form: { kind: 'config', path: document }, output: { stdout: () => undefined, stderr: () => undefined } }).catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('delorun setup: ELSEWHERE_KEY is not set; set it to the model key')
    expect(hasCliProfile(home, PROFILE)).toBe(false)
  })

  it('prints a note a section returns from its writes, in a run and when the section runs again', async () => {
    const registry = defaultRegistry()
    registry.register({ ...privacySection, id: 'extra', title: 'Extra', asks: () => true, ask: () => Promise.resolve({ answers: {}, status: 'answered' as const }), apply: () => Promise.resolve('The extra section wrote its file.') }, { order: 60 })
    expect(await interactive(['quick', 'environment', 'safer', 'save', false], { registry })).toBe(EXIT.ok)
    expect(screen()).toContain('The extra section wrote its file.')
    expect(recordOf().sections.find(record => record.id === 'extra')?.status).toBe('answered')
    recording.screen.length = 0
    const request: SetupRequest = { home, profile: PROFILE, env: {}, registry, output: { stdout: text => void recording.screen.push(text.trim()), stderr: () => undefined }, form: { kind: 'interactive', prompter: scriptedPrompter([], recording) } }
    expect(await runSection(request, 'extra')).toBe(EXIT.ok)
    expect(screen()).toContain('The extra section wrote its file.')
  })

  it('leaves a section without a review line off the review screen', async () => {
    const registry = defaultRegistry()
    const { review: _review, ...withoutReview } = privacySection
    registry.register({ ...withoutReview, id: 'quiet', title: 'Quiet', mode: 'quick', asks: () => true, ask: () => Promise.resolve({ answers: {}, status: 'answered' as const }) }, { order: 60 })
    expect(await interactive(['quick', 'environment', 'safer', 'save', false], { registry })).toBe(EXIT.ok)
    expect(screen()).toContain('# Review\n  Setup: Quick\n  DeepSeek API key: read from DEEPSEEK_API_KEY at each start\n  Prompts: Safer prompts\n?')
  })

  it('stops a key write that has no typed key to store', async () => {
    const { keySection } = await import('../../src/setup/sections.ts')
    const answers = { ...(await import('@delo/contract-setup-answers')).SETUP_DEFAULTS }
    expect(() => keySection.apply({ home, env: {}, directory: home, secret: undefined }, answers)).toThrow('the model key was not entered')
  })
})

describe('the way back inside the full sections', { timeout: TIMEOUT_MS }, () => {
  it('returns from the background question to the prompts question, and from the name to the background question', async () => {
    expect(await interactive(['full', 'on', 'environment', 'safer', BACK_CHOICE, 'stock', 'yes', 'no', '', BACK_CHOICE, 'no', 'no', 'default', '3080', 'save', false])).toBe(EXIT.ok)
    expect(recordOf().prompts).toBe('stock')
    expect(recordOf().background).toBe(false)
  })
})

describe('the release check', { timeout: TIMEOUT_MS }, () => {
  /** The release-check row turned off, as Settings → Privacy saves it: the bundle's config restated with `enabled` off. */
  const OFF_ROW = { id: 'delo-update-check', name: '@delo/bundle-local/update-check', config: { intervalHours: 24, timeoutSeconds: 15, enabled: false } }

  it('Full asks whether to check, and No writes the row off as Settings → Privacy would and shows it on the review', async () => {
    expect(await interactive(['full', 'off', 'environment', 'safer', 'yes', 'no', 'default', '3080', 'save', false])).toBe(EXIT.ok)
    expect(patchOf()).toContainEqual(OFF_ROW)
    expect(recordOf()).toMatchObject({ schemaVersion: 3, updateCheck: false })
    expect(screen()).toContain('# Review\n  Setup: Full\n  Check for new releases: no\n')
  })

  it('Yes, the default, writes no row, and the way back leads from the key question to the release check and from it to the mode', async () => {
    expect(await interactive(['full', BACK_CHOICE, 'full', 'off', BACK_CHOICE, 'on', 'environment', 'safer', 'yes', 'no', 'default', '3080', 'save', false])).toBe(EXIT.ok)
    expect(recording.asked.filter(question => question === 'select: How do you want to set up Delorun?')).toHaveLength(2)
    expect(recording.asked.filter(question => question === 'select: Check for new releases?')).toHaveLength(3)
    expect(patchOf().map(row => row.id)).not.toContain('delo-update-check')
    expect(recordOf()).toMatchObject({ updateCheck: true })
  })

  it('delorun setup privacy shows the note, turns the check off, and turns it on again by removing the row', async () => {
    expect(await interactive(['quick', 'environment', 'safer', 'save', false])).toBe(EXIT.ok)
    const prompts = patchOf()
    const request = (answer: string): SetupRequest => ({
      home, profile: PROFILE, env: {}, output: { stdout: text => void recording.screen.push(text.trim()), stderr: () => undefined },
      form: { kind: 'interactive', prompter: scriptedPrompter([answer], recording) },
    })
    recording.screen.length = 0
    expect(await runSection(request('off'), 'privacy')).toBe(EXIT.ok)
    expect(patchOf()).toEqual([...prompts, OFF_ROW])
    expect(recordOf()).toMatchObject({ updateCheck: false })
    expect(recordOf().sections.find(record => record.id === 'privacy')?.status).toBe('answered')
    expect(screen()).toContain('Delo has no telemetry of its own.')
    expect(screen()).toContain('> Yes (once a day')
    expect(screen()).toContain('Updated the privacy section of the profile default.')
    recording.screen.length = 0
    expect(await runSection(request('on'), 'privacy')).toBe(EXIT.ok)
    expect(screen()).toContain('> No (no release check request is made')
    expect(patchOf()).toEqual(prompts)
    expect(recordOf()).toMatchObject({ updateCheck: true })
  })

  it('--no-update-check turns the check off in Quick, which says so, preselects No in Full, and applies to --yes and --config', async () => {
    expect(await interactive(['quick', 'environment', 'safer', 'save', false], { noUpdateCheck: true })).toBe(EXIT.ok)
    expect(screen()).toContain('  This setup turns the release check off, so Delorun makes no release check request.')
    expect(screen()).not.toContain('Quick setup keeps the release check on.')
    expect(patchOf()).toContainEqual(OFF_ROW)
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    recording.screen.length = 0
    expect(await interactive(['full', 'off', 'environment', 'safer', 'yes', 'no', 'default', '3080', 'save', false], { noUpdateCheck: true })).toBe(EXIT.ok)
    expect(screen()).toContain('  Yes (once a day')
    expect(screen()).toContain('> No (no release check request is made')
    for (const form of [{ kind: 'yes' }, { kind: 'config', path: join(osHome, 'on.json') }] as const) {
      writeFileSync(join(osHome, 'on.json'), JSON.stringify({ schemaVersion: 3, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'safer', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false, updateCheck: true }))
      rmSync(profileDirectory(home, PROFILE), { recursive: true })
      expect(await runSetup({ home, profile: PROFILE, env: { DEEPSEEK_API_KEY: 'env-key-value-10' }, form, noUpdateCheck: true, output: { stdout: () => undefined, stderr: () => undefined } })).toBe(EXIT.ok)
      expect(patchOf()).toContainEqual(OFF_ROW)
      expect(recordOf()).toMatchObject({ updateCheck: false })
    }
  })

  it('reads a version-2 answers document and record as the check on, and records them as version 3', async () => {
    const document = join(osHome, 'version-2.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'safer', background: false, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    expect(await runSetup({ home, profile: PROFILE, env: { DEEPSEEK_API_KEY: 'env-key-value-11' }, form: { kind: 'config', path: document }, output: { stdout: () => undefined, stderr: () => undefined } })).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ schemaVersion: 3, updateCheck: true })
    const record = join(profileDirectory(home, PROFILE), 'setup-answers.json')
    const version2: Record<string, unknown> = { ...JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>, schemaVersion: 2 }
    Reflect.deleteProperty(version2, 'updateCheck')
    writeFileSync(record, JSON.stringify(version2))
    const request: SetupRequest = { home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form: { kind: 'interactive', prompter: scriptedPrompter(['stock'], recording) } }
    expect(await runSection(request, 'prompts')).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ schemaVersion: 3, updateCheck: true, background: false, prompts: 'stock' })
  })
})
