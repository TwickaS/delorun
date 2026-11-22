/**
 * The questions of `delorun setup` on a fresh home: the privacy line, the phone question, the DeepSeek Harness import
 * when a stock home exists, the port when 3080 is busy; the forms that ask nothing; and the sections that stay behind
 * `delorun setup <section>`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { ensureHomeTree } from '@delorun/home'
import { SETUP_DEFAULTS } from '@delorun/contract-setup-answers'
import { EXIT } from '../../src/exit.ts'
import { profileDirectory } from '../../src/profile.ts'
import { readPairingAt, TRUST_STATEMENT } from '@delorun/setup-apply'
import { readReachRow } from '../../src/reach/row.ts'
import { parseAnswers, readAnswersDocument } from '../../src/setup/answers.ts'
import { runSection, runSetup, type SetupRequest } from '../../src/setup/index.ts'
import { SetupCancelled, type Prompter } from '../../src/setup/prompts.ts'
import { BACK_CHOICE } from '../../src/setup/steps.ts'
import { fakeTailscale } from '../fixtures/fake-tailscale.ts'
import { removeScratch, stockHome } from '../import-home/support.ts'
import { registryWithTailscale, scriptedPrompter, type Answer, type Recording } from './support.ts'

vi.mock('../../src/delorun-bundles.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/delorun-bundles.ts')>(),
  linkDelorunBundles: vi.fn(() => Promise.resolve()),
}))

const PROFILE = 'default'
const HOST = 'home.example.ts.net'
const TIMEOUT_MS = 60_000
const PHONE = 'select: Use it from your phone too?'
const PRIVACY_LINE = 'Delorun sends nothing about you. Details: https://delorun.com/privacy'

let osHome: string
let home: string
let recording: Recording

/**
 * Run the interactive setup against a script, with a Tailscale that is ready.
 * @param script - the answers in order.
 * @param options - extra request fields.
 * @returns the exit code.
 */
async function interactive(script: readonly Answer[], options: Partial<SetupRequest> = {}): Promise<number | undefined> {
  return runSetup({
    home,
    profile: PROFILE,
    output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
    env: { HOME: osHome },
    form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) },
    registry: registryWithTailscale(fakeTailscale(HOST).run),
    keyCheck: () => Promise.resolve({ ok: true }),
    portIsFree: () => Promise.resolve(true),
    ...options,
  })
}

/** @returns the recorded answers of the profile. */
function recordOf(): { useCase: string, background: boolean, updateCheck: boolean, prompts: string, importStockHome: boolean, modelProvider: unknown, profile: { name: string | null, port: number | null }, reach: { option: string, pairing?: string }, sections: { id: string, status: string }[] } {
  return JSON.parse(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8')) as ReturnType<typeof recordOf>
}

/** @returns the questions the person was asked, as `kind: message`. */
function questions(): string[] {
  return recording.asked
}

/** @returns the screen as one text. */
function screen(): string {
  return recording.screen.join('\n')
}

/** @returns the profile's patch rows. */
function patchOf(): { id: string, config: Record<string, unknown> }[] {
  return parse(readFileSync(join(profileDirectory(home, PROFILE), 'cordis.patch.yml'), 'utf8')) as { id: string, config: Record<string, unknown> }[]
}

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-main-flow-')))
  home = join(osHome, '.delorun')
  await ensureHomeTree(home, PROFILE)
  recording = { screen: [], asked: [] }
})

afterEach(() => {
  removeScratch()
  rmSync(osHome, { recursive: true, force: true })
})

describe('a fresh home', { timeout: TIMEOUT_MS }, () => {
  it('shows the privacy line and asks only the phone question, with No preselected and nothing about how it is used', async () => {
    expect(await interactive(['no'])).toBe(EXIT.ok)
    expect(questions()).toEqual([PHONE])
    expect(screen()).toMatch(/^delorun .* · new home in /mu)
    expect(screen()).toContain(`# Privacy\n  ${PRIVACY_LINE}`)
    expect(screen()).toContain('? Use it from your phone too?\n> No, just this computer\n  Yes, over Tailscale\n= No, just this computer')
    expect(screen()).not.toContain('← Back')
    for (const gone of ['How will you use Delorun?', '# Review', 'More settings', 'Nothing is saved until', 'Release check', 'Check for new releases?']) expect(screen()).not.toContain(gone)
  })

  it('keeps the release check statement and the other privacy facts for delorun setup privacy', async () => {
    expect(await interactive(['no'])).toBe(EXIT.ok)
    expect(screen()).not.toContain('releases.delorun.com')
    recording = { screen: [], asked: [] }
    const request: SetupRequest = { home, profile: PROFILE, env: {}, output: { stdout: text => void recording.screen.push(text.trim()), stderr: () => undefined }, form: { kind: 'interactive', prompter: scriptedPrompter(['off'], recording) } }
    expect(await runSection(request, 'privacy')).toBe(EXIT.ok)
    expect(screen()).toContain('Delorun has no telemetry of its own.')
    expect(screen()).toContain('About once a day Delorun checks releases.delorun.com')
    expect(questions()).toEqual(['select: Check for new releases?'])
    expect(recordOf().updateCheck).toBe(false)
  })

  it('records the defaults: the local use case, no model provider, safer prompts, background on, the release check on', async () => {
    expect(await interactive(['no'])).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ useCase: 'local', modelProvider: null, prompts: 'safer', background: true, updateCheck: true, importStockHome: false, reach: { option: 'none' }, profile: { name: null, port: null } })
    expect(recordOf().sections).toEqual([
      { id: 'privacy', status: 'seen' }, { id: 'reach', status: 'answered' }, { id: 'changes-protection', status: 'skipped' }, { id: 'import', status: 'skipped' },
      { id: 'key', status: 'skipped' }, { id: 'prompts', status: 'skipped' }, { id: 'background', status: 'skipped' }, { id: 'profile', status: 'skipped' },
    ])
    expect(screen()).toContain('Add a model key first: delorun setup key')
  })
})

describe('the phone question', { timeout: TIMEOUT_MS }, () => {
  it('No keeps remote access off and the use case local', async () => {
    expect(await interactive(['no'])).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ useCase: 'local', reach: { option: 'none' } })
    expect(patchOf().map(row => row.id)).not.toContain('delorun-reach')
  })

  it('Yes with Tailscale ready shows the trust statement, keeps the own-user pairing without asking, and sets the remote use case', async () => {
    expect(await interactive(['yes', 'no'])).toBe(EXIT.ok)
    expect(questions()).toEqual([PHONE, 'select: Hold changes to your plugins and to Delorun itself for your review before they load?'])
    expect(screen()).toContain('# Remote access')
    expect(screen()).toContain(TRUST_STATEMENT[0] as string)
    expect(recordOf()).toMatchObject({ useCase: 'remote', reach: { option: 'tailscale-private', pairing: 'own-user' } })
    expect(readReachRow(home, PROFILE)).toMatchObject({ enabled: true, address: `https://${HOST}` })
    expect(readPairingAt(join(profileDirectory(home, PROFILE), 'cordis.patch.yml')).mayAskWithoutWindow).toBe('own-user')
    expect(questions().join('\n')).not.toContain('any device on your tailnet')
  })

  it('Yes with Tailscale not ready leaves it off, says what to fix, and asks nothing more, with the use case still remote', async () => {
    const tailscale = fakeTailscale(HOST, { version: { code: null, stdout: '', stderr: '' } })
    expect(await interactive(['yes'], { registry: registryWithTailscale(tailscale.run) })).toBe(EXIT.ok)
    expect(questions()).toEqual([PHONE])
    expect(screen()).toContain('Remote access stays off; run delorun reach on tailscale once that is fixed.')
    expect(recordOf()).toMatchObject({ useCase: 'remote', reach: { option: 'none' } })
    expect(readReachRow(home, PROFILE).enabled).toBe(false)
  })

  it('prints no phone line at the end when the check failed and phone access stays off', async () => {
    const tailscale = fakeTailscale(HOST, { version: { code: null, stdout: '', stderr: '' } })
    expect(await interactive(['yes'], { registry: registryWithTailscale(tailscale.run) })).toBe(EXIT.ok)
    const ending = screen().split('Delorun is set up.')[1] ?? ''
    expect(ending).not.toMatch(/phone|devices approve|Remote access/u)
  })
})

describe('the port question', { timeout: TIMEOUT_MS }, () => {
  it('is not asked when 3080 is free', async () => {
    expect(await interactive(['no'], { portIsFree: port => Promise.resolve(port === 3080) })).toBe(EXIT.ok)
    expect(questions()).toEqual([PHONE])
    expect(recordOf().profile.port).toBeNull()
  })

  it('asks "Port 3080 is in use. Use 3081?" when it is busy, and Yes takes 3081', async () => {
    expect(await interactive(['no', 'use'], { portIsFree: port => Promise.resolve(port !== 3080) })).toBe(EXIT.ok)
    expect(questions()).toEqual([PHONE, 'select: Port 3080 is in use. Use 3081?'])
    expect(screen()).toContain('? Port 3080 is in use. Use 3081?\n> Yes\n  Enter another port\n  ← Back')
    expect(recordOf().profile).toEqual({ name: null, port: 3081 })
    expect(patchOf()).toContainEqual({ id: 'webserver', config: { host: '127.0.0.1', port: 3081, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
  })

  it('takes the port the person enters, and asks again for one that is in use', async () => {
    const busy = new Set([3080, 3081, 4200])
    expect(await interactive(['no', 'other', '4200', '4300'], { portIsFree: port => Promise.resolve(!busy.has(port)) })).toBe(EXIT.ok)
    expect(screen()).toContain('Port 4200 is in use on this computer. Choose another.')
    expect(recordOf().profile.port).toBe(4300)
  })

  it('goes straight to entering a port when no port after 3080 is free', async () => {
    expect(await interactive(['no', '5000'], { portIsFree: port => Promise.resolve(port === 5000) })).toBe(EXIT.ok)
    expect(questions()).toEqual([PHONE, 'text: Port for the studio (leave empty to go back)'])
    expect(recordOf().profile.port).toBe(5000)
  })

  it('goes back from the port question to the phone question', async () => {
    expect(await interactive(['no', BACK_CHOICE, 'no', 'use'], { portIsFree: port => Promise.resolve(port !== 3080) })).toBe(EXIT.ok)
    expect(questions().filter(question => question === PHONE)).toHaveLength(2)
  })
})

describe('a home with a DeepSeek Harness home', { timeout: TIMEOUT_MS }, () => {
  const QUESTION = 'select: Copy your 2 DeepSeek Harness chats?'

  it('asks the import question after the phone question, and Yes copies the chats', async () => {
    stockHome(join(osHome, '.dsh'))
    expect(await interactive(['no', 'yes'])).toBe(EXIT.ok)
    expect(questions()).toEqual([PHONE, QUESTION])
    expect(existsSync(join(home, 'sessions'))).toBe(true)
    expect(recordOf().importStockHome).toBe(true)
  })

  it('Later copies nothing and names the command', async () => {
    stockHome(join(osHome, '.dsh'))
    expect(await interactive(['no', 'later'])).toBe(EXIT.ok)
    expect(screen()).toContain('Later (delorun import-home)')
    expect(existsSync(join(home, 'sessions'))).toBe(false)
    expect(recordOf().importStockHome).toBe(false)
  })

  it('Show what stays behind lists everything, then asks again', async () => {
    stockHome(join(osHome, '.dsh'))
    expect(await interactive(['no', 'show', 'later'])).toBe(EXIT.ok)
    expect(questions()).toEqual([PHONE, QUESTION, QUESTION])
    expect(screen()).toContain('What stays behind, and why:')
  })

  it('goes back from the import question to the phone question', async () => {
    stockHome(join(osHome, '.dsh'))
    expect(await interactive(['no', BACK_CHOICE, 'no', 'later'])).toBe(EXIT.ok)
    expect(questions().filter(question => question === PHONE)).toHaveLength(2)
  })

  it('is not asked without a DeepSeek Harness home', async () => {
    expect(await interactive(['no'])).toBe(EXIT.ok)
    expect(questions().filter(question => question.includes('DeepSeek Harness'))).toEqual([])
  })
})

describe('a run without a terminal', { timeout: TIMEOUT_MS }, () => {
  /**
   * @param request - extra request fields.
   * @returns the exit code of a run whose form asks for the questions but has no terminal.
   */
  function withoutTerminal(request: Partial<SetupRequest> = {}): Promise<number | undefined> {
    return runSetup({
      home, profile: PROFILE, env: { HOME: osHome }, form: { kind: 'interactive' }, portIsFree: () => Promise.resolve(true),
      output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
      registry: registryWithTailscale(fakeTailscale(HOST).run),
      ...request,
    })
  }

  it('takes the safe defaults and asks nothing, as --yes does, instead of refusing', async () => {
    expect(await withoutTerminal()).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ useCase: 'local', prompts: 'safer', importStockHome: false, modelProvider: null, reach: { option: 'none' }, profile: { port: null } })
    expect(recordOf().sections.find(record => record.id === 'reach')?.status).toBe('skipped')
    expect(screen()).toContain('Delorun is set up. Nothing is running yet.')
    expect(screen()).toContain('Delorun has no telemetry of its own.')
  })

  it('does not import a DeepSeek Harness home it was not told to', async () => {
    stockHome(join(osHome, '.dsh'))
    expect(await withoutTerminal()).toBe(EXIT.ok)
    expect(existsSync(join(home, 'sessions'))).toBe(false)
  })

  it('takes the next free port when 3080 is busy, and says so', async () => {
    expect(await withoutTerminal({ portIsFree: port => Promise.resolve(port !== 3080) })).toBe(EXIT.ok)
    expect(screen()).toContain('! Port 3080 is in use, so the studio will use 3081. Change it later with: delorun setup profile')
    expect(recordOf().profile.port).toBe(3081)
  })

  it('names the provider --provider gives, as --yes does', async () => {
    expect(await withoutTerminal({ providerChoice: { id: 'deepseek-official', model: undefined, baseURL: undefined, keyEnv: undefined }, env: { HOME: osHome, DEEPSEEK_API_KEY: 'a-key-for-the-test' } })).toBe(EXIT.ok)
    expect(recordOf().modelProvider).toMatchObject({ id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } })
  })
})

describe('--phone, --import-dsh and --port', { timeout: TIMEOUT_MS }, () => {
  /**
   * @param request - extra request fields.
   * @returns the exit code of a `--yes` run.
   */
  function yes(request: Partial<SetupRequest>): Promise<number | undefined> {
    return runSetup({
      home, profile: PROFILE, env: { HOME: osHome }, form: { kind: 'yes' }, portIsFree: () => Promise.resolve(true),
      output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
      registry: registryWithTailscale(fakeTailscale(HOST).run),
      ...request,
    })
  }

  it('--phone turns phone access on with the same checks, shows the trust statement and asks no question', async () => {
    expect(await yes({ answerFlags: { phone: true } })).toBe(EXIT.ok)
    expect(screen()).toContain(TRUST_STATEMENT[0] as string)
    expect(recordOf()).toMatchObject({ useCase: 'remote', reach: { option: 'tailscale-private', pairing: 'own-user' } })
    expect(readReachRow(home, PROFILE).enabled).toBe(true)
    expect(recordOf().sections.find(record => record.id === 'reach')?.status).toBe('answered')
  })

  it('--phone fails with the check\'s message when Tailscale is not ready, and writes nothing', async () => {
    const tailscale = fakeTailscale(HOST, { version: { code: null, stdout: '', stderr: '' } })
    const error = await yes({ answerFlags: { phone: true }, registry: registryWithTailscale(tailscale.run) }).catch((caught: unknown) => caught as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/^delorun setup --phone: .+/u)
    expect((error as Error).message).not.toContain('Remote access stays off')
    expect(existsSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'))).toBe(false)
  })

  it('--import-dsh prints the same summary and copies the chats', async () => {
    stockHome(join(osHome, '.dsh'))
    expect(await yes({ answerFlags: { importDsh: true } })).toBe(EXIT.ok)
    expect(screen()).toContain('Will copy:    2 chats · 1 attachment · 1 workspace')
    expect(screen()).toContain('Your DeepSeek Harness folder is only read.')
    expect(existsSync(join(home, 'sessions'))).toBe(true)
    expect(recordOf().importStockHome).toBe(true)
  })

  it('--import-dsh without a DeepSeek Harness home says so in one line and imports nothing', async () => {
    expect(await yes({ answerFlags: { importDsh: true } })).toBe(EXIT.ok)
    expect(screen()).toContain('delorun setup --import-dsh: there is no DeepSeek Harness home to copy, so nothing was imported.')
    expect(recordOf().importStockHome).toBe(false)
  })

  it('--import-dsh leaves a home that already holds chats alone, with the same line', async () => {
    stockHome(join(osHome, '.dsh'))
    mkdirSync(join(home, 'sessions', '--p--', 's9'), { recursive: true })
    writeFileSync(join(home, 'sessions', '--p--', 's9', 'session.v4.jsonl.zstd'), 'a chat')
    expect(await yes({ answerFlags: { importDsh: true } })).toBe(EXIT.ok)
    expect(screen()).toContain('there is no DeepSeek Harness home to copy')
  })

  it('--port sets the studio port; a busy port is refused with the port named', async () => {
    expect(await yes({ answerFlags: { port: 4100 } })).toBe(EXIT.ok)
    expect(recordOf().profile.port).toBe(4100)
    expect(patchOf()).toContainEqual({ id: 'webserver', config: { host: '127.0.0.1', port: 4100, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    const error = await yes({ answerFlags: { port: 4100 }, portIsFree: () => Promise.resolve(false) }).catch((caught: unknown) => caught as Error)
    expect((error as Error).message).toBe('delorun setup --port 4100: port 4100 is in use on this computer; choose another')
  })

  it('--port 3080 keeps the automatic port', async () => {
    expect(await yes({ answerFlags: { port: 3080 } })).toBe(EXIT.ok)
    expect(recordOf().profile.port).toBeNull()
  })

  it('pre-select the answers in a terminal run: Yes over Tailscale, and the port offered', async () => {
    expect(await interactive(['yes', 'no'], { answerFlags: { phone: true } })).toBe(EXIT.ok)
    expect(screen()).toContain('  No, just this computer\n> Yes, over Tailscale')
    recording = { screen: [], asked: [] }
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    expect(await interactive(['no', 'use'], { answerFlags: { port: 4100 }, portIsFree: port => Promise.resolve(port !== 4100) })).toBe(EXIT.ok)
    expect(questions()).toContain('select: Port 4100 is in use. Use 4101?')
    expect(recordOf().profile.port).toBe(4101)
  })

  it('--port in a terminal run that finds the port free asks nothing and writes it', async () => {
    expect(await interactive(['no'], { answerFlags: { port: 4100 } })).toBe(EXIT.ok)
    expect(questions()).toEqual([PHONE])
    expect(recordOf().profile.port).toBe(4100)
  })
})

describe('the sections the main flow leaves out', { timeout: TIMEOUT_MS }, () => {
  /**
   * Run one section again on the profile the main flow set up.
   * @param id - the section.
   * @param script - the answers.
   * @param options - extra request fields.
   * @returns the exit code.
   */
  async function again(id: string, script: readonly Answer[], options: Partial<SetupRequest> = {}): Promise<number | undefined> {
    return runSection({
      home, profile: PROFILE, env: {}, output: { stdout: text => void recording.screen.push(text.trim()), stderr: () => undefined },
      form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) }, keyCheck: () => Promise.resolve({ ok: true }), portIsFree: () => Promise.resolve(true),
      ...options,
    }, id)
  }

  it('still ask their own questions as delorun setup <section>: key, prompts, background, privacy, profile', async () => {
    expect(await interactive(['no'])).toBe(EXIT.ok)
    recording = { screen: [], asked: [] }
    expect(await again('key', ['deepseek-official', 'environment', 'deepseek-flash'])).toBe(EXIT.ok)
    expect(await again('prompts', ['stock'])).toBe(EXIT.ok)
    expect(await again('background', [false])).toBe(EXIT.ok)
    expect(await again('privacy', ['off'])).toBe(EXIT.ok)
    expect(await again('profile', ['4300'])).toBe(EXIT.ok)
    expect(questions()).toEqual([
      'select: Which model provider should Delorun use?',
      'select: How should Delorun get the DeepSeek API key?',
      'select: Which DeepSeek model should new chats start on?',
      'select: How much should Delorun ask before it changes things?',
      'confirm: Keep Delorun running in the background after the terminal closes?',
      'select: Check for new releases?',
      'text: Port for the studio',
    ])
    expect(recordOf()).toMatchObject({ prompts: 'stock', background: false, updateCheck: false, profile: { port: 4300 }, modelProvider: { id: 'deepseek-official', model: 'deepseek-flash' } })
  })

  it('still ask the phone and the import questions as delorun setup reach and import, in their full form', async () => {
    expect(await interactive(['no'])).toBe(EXIT.ok)
    recording = { screen: [], asked: [] }
    expect(await again('reach', [true, true], { registry: registryWithTailscale(fakeTailscale(HOST).run) })).toBe(EXIT.ok)
    expect(questions()).toEqual([
      'confirm: Open Delorun from your phone or another device over Tailscale?',
      'confirm: Let any device on your tailnet ask to pair, not only devices signed in as your own Tailscale user? Every request still needs the code from its screen, typed at this computer.',
    ])
    expect(recordOf().reach).toMatchObject({ option: 'tailscale-private', pairing: 'tailnet' })
  })
})

describe('Ctrl-C', { timeout: TIMEOUT_MS }, () => {
  it('at the phone question saves nothing and says so, with the interrupt exit code', async () => {
    const cancelling: Prompter = { ...scriptedPrompter([], recording), select: () => Promise.reject(new SetupCancelled()) }
    const error = await runSetup({ home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form: { kind: 'interactive', prompter: cancelling } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SetupCancelled)
    expect((error as Error).message).toBe('Setup cancelled. Nothing was saved. Run delorun to start again.')
    expect(existsSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'))).toBe(false)
    expect(EXIT.interrupted).toBe(130)
  })

  it('names what an earlier run kept when the cancel follows saved work', () => {
    expect(new SetupCancelled('The answers of the earlier run are kept for default.').message).toBe('Setup cancelled. The answers of the earlier run are kept for default. Run delorun to finish setting up.')
  })
})

describe('the answers record', { timeout: TIMEOUT_MS }, () => {
  it('keeps the use case field, which nothing asks: --config accepts one and defaults to local without one', () => {
    const document = { ...SETUP_DEFAULTS, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' }, baseURL: null, model: null }, useCase: 'automation', background: false }
    const path = join(osHome, 'automation.json')
    writeFileSync(path, JSON.stringify(document))
    expect(readAnswersDocument(path)).toMatchObject({ useCase: 'automation', background: false })
    const { useCase: _useCase, ...without } = document
    writeFileSync(path, JSON.stringify(without))
    expect(readAnswersDocument(path).useCase).toBe('local')
    writeFileSync(path, JSON.stringify({ ...document, useCase: 'everything' }))
    expect(() => readAnswersDocument(path)).toThrow('useCase')
  })

  it('reads an answers record written with the Quick or Full mode, without a use case, and ignores the mode', async () => {
    const { useCase: _useCase, ...old } = SETUP_DEFAULTS
    for (const mode of ['quick', 'full']) {
      const checked = parseAnswers({ ...old, mode })
      expect(checked.success).toBe(true)
      expect(checked.data).toMatchObject({ useCase: 'local' })
      expect(Object.keys(checked.data ?? {})).not.toContain('mode')
    }
    expect(parseAnswers({ ...old, mode: 'sometimes' }).success).toBe(false)
    expect(await interactive(['no'])).toBe(EXIT.ok)
    const path = join(profileDirectory(home, PROFILE), 'setup-answers.json')
    writeFileSync(path, JSON.stringify({ version: 1, ...old, mode: 'full' }))
    const request: SetupRequest = { home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form: { kind: 'interactive', prompter: scriptedPrompter(['stock'], recording) } }
    expect(await runSection(request, 'prompts')).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ useCase: 'local', prompts: 'stock' })
  })
})

describe('the ending', { timeout: TIMEOUT_MS }, () => {
  it('prints the next steps and nothing else when the run has no start: the studio address, no install question', async () => {
    expect(await interactive(['no'])).toBe(EXIT.ok)
    const ending = screen().split('Delorun is set up.')[1] ?? ''
    expect(ending).toContain('Start Delorun and open the studio: delorun')
    expect(ending).toContain('https://docs.delorun.com/guide/install#the-studio-and-your-first-chat')
    expect(ending).toContain('Change an answer later: delorun setup <section> (delorun setup --list shows the sections).')
    expect(recording.asked.filter(question => question.includes('Install the delorun command'))).toEqual([])
    expect(ending).toContain('Studio: http://127.0.0.1:3080')
    expect(screen()).not.toMatch(/is running in|opened in your browser/u)
  })
})
