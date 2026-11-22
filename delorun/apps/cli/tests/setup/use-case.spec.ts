import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureHomeTree } from '@delorun/home'
import { SETUP_DEFAULTS } from '@delorun/contract-setup-answers'
import { EXIT } from '../../src/exit.ts'
import { profileDirectory } from '../../src/profile.ts'
import { parseAnswers, readAnswersDocument } from '../../src/setup/answers.ts'
import { runSection, runSetup, type SetupRequest } from '../../src/setup/index.ts'
import { SetupCancelled, type Prompter } from '../../src/setup/prompts.ts'
import { BACK_CHOICE } from '../../src/setup/steps.ts'
import { scriptedPrompter, type Answer, type Recording } from './support.ts'

vi.mock('../../src/delorun-bundles.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/delorun-bundles.ts')>(),
  linkDelorunBundles: vi.fn(() => Promise.resolve()),
}))

const PROFILE = 'default'
const DS = 'deepseek-official'
const TIMEOUT_MS = 60_000

let osHome: string
let home: string
let recording: Recording

/**
 * Run an interactive setup against a script.
 * @param script - the answers in order.
 * @param options - extra request fields.
 * @returns the exit code.
 */
async function interactive(script: readonly Answer[], options: Partial<SetupRequest> = {}): Promise<number> {
  return runSetup({
    home,
    profile: PROFILE,
    output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
    env: {},
    form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) },
    keyCheck: () => Promise.resolve({ ok: true }),
    portIsFree: () => Promise.resolve(true),
    ...options,
  })
}

/** @returns the recorded answers of the profile. */
function recordOf(): { useCase: string, background: boolean, updateCheck: boolean, prompts: string, reach: { option: string }, sections: { id: string, status: string }[] } {
  return JSON.parse(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8')) as ReturnType<typeof recordOf>
}

/** @returns the questions the person was asked, without their kind. */
function questions(): string[] {
  return recording.asked.map(line => line.replace(/^[a-z]+: /u, ''))
}

/** @returns the screen as one text. */
function screen(): string {
  return recording.screen.join('\n')
}

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-use-case-')))
  home = join(osHome, '.delorun')
  await ensureHomeTree(home, PROFILE)
  recording = { screen: [], asked: [] }
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('the opening question', { timeout: TIMEOUT_MS }, () => {
  it('asks how the person will use Delorun, with three short options and the recommended one marked', async () => {
    await interactive(['local', DS, 'environment', 'safer', 'save'])
    expect(questions()[0]).toBe('How will you use Delorun?')
    expect(screen()).toContain([
      '? How will you use Delorun?',
      '> Just me, on this computer (recommended) (Delorun runs here, in your browser)',
      '  Also from my phone or another device (and from your phone, over Tailscale)',
      '  For scripts and automation (no studio; run it from scripts)',
      '  What does each one mean?',
    ].join('\n'))
    expect(screen()).not.toContain('Suits most people.')
    expect(screen().split('? How will you use')[0] ?? '').not.toContain('(recommended)')
    expect(screen()).toMatch(/^delorun .* · new home in /mu)
  })

  it('shows what each option means only when asked, then asks again', async () => {
    await interactive(['explain', 'local', DS, 'environment', 'safer', 'save'])
    expect(questions().slice(0, 2)).toEqual(['How will you use Delorun?', 'How will you use Delorun?'])
    expect(screen()).toContain('Just me, on this computer (recommended)\n    Delorun runs in the background and opens in your browser on this computer. Nothing outside this computer can reach it.\n    Suits most people.\n    Change later: delorun setup reach.')
    expect(screen()).toContain('Change later: delorun reach off.')
    expect(screen()).toContain('Change later: delorun setup key, delorun setup background.')
    expect(screen()).toContain('Needs Tailscale installed and signed in on this computer.')
  })
})

describe('the three use cases', { timeout: TIMEOUT_MS }, () => {
  it('local asks the provider, the key, the prompts and the review, and keeps the defaults for the rest', async () => {
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    expect(questions()).toEqual([
      'How will you use Delorun?',
      'Which model provider should Delorun use?',
      'How should Delorun get the DeepSeek API key?',
      'How much should Delorun ask before it changes things?',
      'Save these answers and set up Delorun?',
    ])
    expect(recordOf()).toMatchObject({ useCase: 'local', background: true, updateCheck: true, prompts: 'safer', reach: { option: 'none' } })
    expect(recordOf().sections).toEqual([
      { id: 'privacy', status: 'seen' }, { id: 'import', status: 'skipped' }, { id: 'key', status: 'answered' }, { id: 'prompts', status: 'answered' },
      { id: 'background', status: 'skipped' }, { id: 'reach', status: 'skipped' }, { id: 'changes-protection', status: 'skipped' }, { id: 'profile', status: 'skipped' },
    ])
  })

  it('remote adds the phone question first-class, preselected on Yes, and keeps remote access off when the person answers No', async () => {
    expect(await interactive(['remote', DS, 'environment', 'safer', 'no', 'save'])).toBe(EXIT.ok)
    expect(questions()).toContain('Open Delorun from your phone or another device over Tailscale?')
    expect(screen()).toContain('? Open Delorun from your phone or another device over Tailscale?\n> Yes\n')
    expect(recordOf()).toMatchObject({ useCase: 'remote', background: true, reach: { option: 'none' } })
    expect(screen()).toContain('Remote access is off. To turn it on later, install Tailscale and sign in')
  })

  it('automation asks neither the background, the phone, the profile nor the import, starts on the environment key and keeps no studio running', async () => {
    expect(await interactive(['automation', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    expect(questions().filter(question => /background|phone|Tailscale|Name for|Port/u.test(question))).toEqual([])
    expect(screen()).toContain('How should Delorun get the DeepSeek API key?\n  Paste it now\n> Use DEEPSEEK_API_KEY (recommended)')
    expect(recordOf()).toMatchObject({ useCase: 'automation', background: false })
    expect(screen()).toContain('Run a task from a script or CI: delorun headless "your task"')
  })

  it('More settings on the review opens the remaining sections, then returns to the review', async () => {
    expect(await interactive(['local', DS, 'environment', 'safer', 'more', 'off', 'no', 'no', 'no', 'default', '4100', 'save'])).toBe(EXIT.ok)
    expect(screen()).toContain('> Save and set up\n  More settings (privacy, background, remote access, changes protection, profile name and port)\n  Cancel (nothing is saved)')
    expect(questions().filter(question => question.startsWith('Save these'))).toHaveLength(2)
    expect(recordOf()).toMatchObject({ useCase: 'local', background: false, updateCheck: false })
    expect(recordOf().sections.find(record => record.id === 'profile')?.status).toBe('answered')
  })

  it('--yes keeps the local use case and every safe default, and --config accepts a use case and defaults to local without one', async () => {
    const yes = join(osHome, 'yes', '.delorun')
    await ensureHomeTree(yes, PROFILE)
    expect(await runSetup({ home: yes, profile: PROFILE, env: {}, form: { kind: 'yes' }, portIsFree: () => Promise.resolve(true), output: { stdout: () => undefined, stderr: () => undefined } })).toBe(EXIT.ok)
    expect(JSON.parse(readFileSync(join(profileDirectory(yes, PROFILE), 'setup-answers.json'), 'utf8'))).toMatchObject({ useCase: 'local', background: true, prompts: 'safer' })
    const document = { ...SETUP_DEFAULTS, modelProvider: { id: DS, credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' }, baseURL: null, model: null }, useCase: 'automation', background: false }
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
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    const path = join(profileDirectory(home, PROFILE), 'setup-answers.json')
    writeFileSync(path, JSON.stringify({ version: 1, ...old, mode: 'full' }))
    const request: SetupRequest = { home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form: { kind: 'interactive', prompter: scriptedPrompter(['stock'], recording) } }
    expect(await runSection(request, 'prompts')).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ useCase: 'local', prompts: 'stock' })
  })
})

describe('the review', { timeout: TIMEOUT_MS }, () => {
  it('lists every answer, including the release check and prompts after a declined dangerous mode, and says nothing is saved yet', async () => {
    expect(await interactive(['local', DS, 'environment', 'dangerous', 'no', 'save'])).toBe(EXIT.ok)
    const review = screen().split('# Review\n')[1]?.split('\n?')[0]
    expect(review).toBe([
      '  How you use Delorun: just me, on this computer',
      '  Release check: on, once a day',
      '  Model: DeepSeek, default model. Key: read from DEEPSEEK_API_KEY at each start.',
      '  Prompts: Ask me first',
      '  Keep running in the background: yes',
      '  Remote access: off',
      '  Changes protection: unchanged',
      '  Setup name: default, studio port 3080',
      '  ',
      '  Nothing is saved until you choose Save and set up.',
    ].join('\n'))
  })

  it('leaves out what the use case does not set up', async () => {
    await interactive(['automation', DS, 'environment', 'safer', 'save'])
    const review = screen().split('# Review\n')[1]?.split('\n?')[0] ?? ''
    expect(review).not.toContain('background')
    expect(review).not.toContain('Remote access')
    expect(review).toContain('Release check')
  })
})

describe('the way back', { timeout: TIMEOUT_MS }, () => {
  it('returns from the review to the prompts question, and from More settings to the review', async () => {
    expect(await interactive(['local', DS, 'environment', 'safer', BACK_CHOICE, 'stock', 'more', BACK_CHOICE, 'save'])).toBe(EXIT.ok)
    expect(questions().filter(question => question.startsWith('How much should'))).toHaveLength(2)
    expect(questions().filter(question => question.startsWith('Save these'))).toHaveLength(3)
    expect(recordOf().prompts).toBe('stock')
  })

  it('returns from the first More settings question to the review, and from the next ones to the one before', async () => {
    expect(await interactive(['local', DS, 'environment', 'safer', 'more', 'on', 'yes', BACK_CHOICE, 'no', 'no', 'no', 'default', BACK_CHOICE, '3080', 'save'])).toBe(EXIT.ok)
    expect(questions().filter(question => question.startsWith('Keep Delorun running'))).toHaveLength(2)
  })

  it('returns from the dangerous-mode confirmation to the prompts question, not to the provider', async () => {
    expect(await interactive(['local', DS, 'environment', 'dangerous', BACK_CHOICE, 'safer', 'save'])).toBe(EXIT.ok)
    expect(questions().filter(question => question.startsWith('Which model provider'))).toHaveLength(1)
    expect(questions().filter(question => question.startsWith('How much should'))).toHaveLength(2)
  })

  it('returns from the provider list to the provider question, and from the key to the key source', async () => {
    expect(await interactive(['local', 'more', BACK_CHOICE, 'more', 'anthropic', 'environment', 'claude-sonnet-5-5', 'safer', 'save'])).toBe(EXIT.ok)
    expect(questions().filter(question => question.startsWith('Which model provider'))).toHaveLength(2)
    expect(questions().filter(question => question === 'Which provider?')).toHaveLength(2)
  })
})

describe('the key questions', { timeout: TIMEOUT_MS }, () => {
  it('names the provider\'s key page and explains an environment variable in one line', async () => {
    await interactive(['local', 'more', 'groq', 'environment', 'openai/gpt-oss-120b', 'safer', 'save'])
    expect(screen()).toContain('Groq needs an API key to answer. Create one at https://console.groq.com/keys')
    expect(screen()).toContain('An environment variable is a named setting that your terminal passes to the programs it starts.')
    expect(screen()).toContain('Change later: delorun setup key.')
  })

  it('warns at once, with the fix, when the chosen key variable is unset, and not when it is set', async () => {
    await interactive(['local', DS, 'environment', 'safer', 'save'])
    expect(screen()).toContain('DEEPSEEK_API_KEY is not set in this terminal. Chats will not answer until you set it (for example, add export DEEPSEEK_API_KEY=your-key to your shell profile) and then run delorun stop, then delorun start.')
    recording = { screen: [], asked: [] }
    await rmSyncProfile()
    await interactive(['local', DS, 'environment', 'safer', 'save'], { env: { DEEPSEEK_API_KEY: 'fake-key-for-the-test' } })
    expect(screen()).not.toContain('is not set in this terminal')
  })

  it('offers DeepSeek, more providers and choosing later, with a line for each', async () => {
    await interactive(['local', 'none', 'safer', 'save'])
    expect(screen()).toContain('DeepSeek (recommended)\n    Delorun\'s default models, the ones it is tuned for.')
    expect(screen()).toContain('Choose later\n    The studio opens, but chats cannot answer until you run delorun setup key.')
    expect(screen()).toContain('Add a model key first: delorun setup key')
  })
})

describe('the prompts question', { timeout: TIMEOUT_MS }, () => {
  it('lists Ask me first, Ask less (like DeepSeek Harness) and Never ask (dangerous) in plain lines, dangerous always last', async () => {
    await interactive(['local', DS, 'environment', 'safer', 'save'])
    expect(screen()).toContain('? How much should Delorun ask before it changes things?\n> Ask me first (recommended)\n  Ask less (like DeepSeek Harness)\n  Never ask (dangerous)\n  ← Back')
    expect(screen()).toContain('Ask me first (recommended)\n    Delorun asks before a chat gets full access to a folder, adds a tool server, edits its own instructions or schedules work. You can allow each once.\n    Change later: delorun setup prompts.')
  })
})

describe('Ctrl-C', { timeout: TIMEOUT_MS }, () => {
  /** @returns a prompter that cancels the question after the given number of answers. */
  function cancelling(after: number): Prompter {
    const inner = scriptedPrompter(['local', DS, 'environment', 'safer', 'save'], recording)
    let count = 0
    const guard = <T>(run: () => Promise<T>): Promise<T> => {
      if (count >= after) return Promise.reject(new SetupCancelled())
      count += 1
      return run()
    }
    return {
      select: (message, options, initial) => guard(() => inner.select(message, options, initial)),
      confirm: (message, initial) => guard(() => inner.confirm(message, initial)),
      secret: (message, allowEmpty) => guard(() => inner.secret(message, allowEmpty)),
      text: (message, initial, validate, allowEmpty) => guard(() => inner.text(message, initial, validate, allowEmpty)),
      note: (body, title) => { inner.note(body, title) },
    }
  }

  it.each([0, 2, 4])('at question %i saves nothing and says so, with the interrupt exit code', async (after) => {
    const error = await runSetup({ home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form: { kind: 'interactive', prompter: cancelling(after) }, keyCheck: () => Promise.resolve({ ok: true }) }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SetupCancelled)
    expect((error as Error).message).toBe('Setup cancelled. Nothing was saved. Run delorun to start again.')
    expect(() => readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'))).toThrow()
    expect(EXIT.interrupted).toBe(130)
  })

  it('names what an earlier run kept when the cancel follows saved work', () => {
    expect(new SetupCancelled('The answers of the earlier run are kept for default.').message).toBe('Setup cancelled. The answers of the earlier run are kept for default. Run delorun to finish setting up.')
  })
})

describe('the ending', { timeout: TIMEOUT_MS }, () => {
  it('prints the next steps and nothing else: no install question, no start, no studio address', async () => {
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    const ending = screen().split('Delorun is set up.')[1] ?? ''
    expect(ending).toContain('Start Delorun and open the studio: delorun')
    expect(ending).toContain('https://docs.delorun.com/guide/get-started/install#the-studio-and-your-first-chat')
    expect(ending).toContain('Change an answer later: delorun setup <section> (delorun setup --list shows the sections).')
    expect(recording.asked.filter(question => question.includes('Install the delorun command'))).toEqual([])
    expect(screen()).not.toMatch(/Studio: http|is running in|opened in your browser/u)
  })
})

/** Remove the profile a first run created, so the next run starts from the same home. */
async function rmSyncProfile(): Promise<void> {
  rmSync(profileDirectory(home, PROFILE), { recursive: true })
}
