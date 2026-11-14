import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureHomeTree, runDirectory } from '@delorun/home'
import { PARITY_SWITCHES } from '@delorun/contract-parity-composition'
import { SETUP_DEFAULTS } from '@delorun/contract-setup-answers'
import { CliError, EXIT } from '../../src/exit.ts'
import { hasCliProfile, profileDirectory } from '../../src/profile.ts'
import { readBackgroundAnswer } from '../../src/setup/background.ts'
import { LineCapture } from '@delorun/logs'
import { LINKING_PROGRESS, linkDelorunBundles } from '../../src/delorun-bundles.ts'
import { runSection, runSetup, sectionList, type SetupRequest } from '../../src/setup/index.ts'
import type { KeyTarget } from '../../src/setup/key-check.ts'
import { installedCatalog } from '../../src/setup/providers.ts'
import { readProgress } from '../../src/setup/progress.ts'
import { defaultRegistry, privacySection, SectionRegistry, type SetupSection } from '../../src/setup/sections.ts'
import { SetupCancelled } from '../../src/setup/prompts.ts'
import { BACK_CHOICE } from '../../src/setup/steps.ts'
import { scriptedPrompter, type Answer, type Recording } from './support.ts'

vi.mock('../../src/delorun-bundles.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/delorun-bundles.ts')>(),
  linkDelorunBundles: vi.fn(() => Promise.resolve()),
}))

const PROFILE = 'default'
const DS = 'deepseek-official'
const MODEL = 'deepseek-flash'
const DEEPSEEK_CHOICE = { id: DS, model: undefined, baseURL: undefined, keyEnv: undefined }
const TYPED_KEY = 'sk-typed-fixture-key-9f3a'
const TIMEOUT_MS = 60_000

let osHome: string
let home: string
let recording: Recording

/**
 * Run an interactive setup against a script.
 * @param script - the answers in order.
 * @param options - extra request fields and the fake ending's behaviour.
 * @returns the exit code.
 */
async function interactive(script: readonly Answer[], options: Partial<SetupRequest> = {}): Promise<number> {
  const { ...rest } = options
  return runSetup({
    home,
    profile: PROFILE,
    output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
    env: {},
    form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) },
    keyCheck: () => Promise.resolve({ ok: true }),
    portIsFree: () => Promise.resolve(true),
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
function recordOf(profile = PROFILE): { useCase: string, sections: { id: string, status: string }[], background: boolean, prompts: string, profile: { name: string | null, port: number | null }, modelProvider: unknown } {
  return JSON.parse(readFileSync(join(profileDirectory(home, profile), 'setup-answers.json'), 'utf8')) as ReturnType<typeof recordOf>
}

/**
 * @param root - a directory.
 * @returns every regular file under it, at any depth.
 */
function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

/** @returns the screen as one text, the profile directory shown as a placeholder. */
function screen(): string {
  return recording.screen.join('\n').replaceAll(profileDirectory(home, PROFILE), '<profile>').replaceAll(profileDirectory(home, 'work'), '<work profile>')
}

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-modes-')))
  home = join(osHome, '.delorun')
  await ensureHomeTree(home, PROFILE)
  recording = { screen: [], asked: [] }
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

const QUICK_SCRIPT: readonly Answer[] = ['local', DS, 'prompt', TYPED_KEY, 'safer', 'save']

describe('the main flow', { timeout: TIMEOUT_MS }, () => {
  it('stores the key, writes the safer prompt rows and records what was asked', async () => {
    expect(await interactive(QUICK_SCRIPT)).toBe(EXIT.ok)
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: TYPED_KEY } })
    expect(patchOf()).toEqual([
      { id: 'delorun-permission-defaults', config: { enabled: true, fullAccessEverywhere: false } },
      { id: 'delorun-instruction-consent', config: { enabled: true, approvedPluginWrites: true } },
      { id: 'delorun-mcp-consent', config: { enabled: true } },
      { id: 'delorun-schedule-consent', config: { enabled: true } },
    ])
    expect(readBackgroundAnswer(profileDirectory(home, PROFILE))).toBe(true)
  })

  it('writes "Ask less" as the parity value of every prompt switch', async () => {
    expect(await interactive(['local', DS, 'environment', 'stock', 'save'])).toBe(EXIT.ok)
    const byId = new Map(patchOf().map(row => [row.id, row.config]))
    const parityOf = (id: string): boolean => {
      const entry = PARITY_SWITCHES.find(candidate => candidate.id === id)
      return entry?.state === 'built' ? entry.parityValue : true
    }
    expect(Object.fromEntries(byId)).toEqual({
      'delorun-permission-defaults': { enabled: parityOf('permission_defaults'), fullAccessEverywhere: false },
      'delorun-instruction-consent': { enabled: parityOf('instruction_layer_consent'), approvedPluginWrites: parityOf('approved_plugin_write_consent') },
      'delorun-mcp-consent': { enabled: parityOf('mcp_add_consent') },
      'delorun-schedule-consent': { enabled: parityOf('scheduled_task_consent') },
    })
    expect(byId.has('delorun-fetch-guard')).toBe(false)
    expect(byId.has('delorun-delegation-consent')).toBe(false)
    expect(byId.has('delorun-plugin-changes')).toBe(false)
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  })

  it.each([
    ['DeepSeek', QUICK_SCRIPT],
    ['a pi-ai provider', ['local', 'more', 'anthropic', 'prompt', TYPED_KEY, 'claude-sonnet-5-5', 'safer', 'save']],
  ] as const)('typed key is never printed, and for %s no file under the home holds it but the credentials document', async (_, script) => {
    expect(await interactive(script)).toBe(EXIT.ok)
    expect(recording.screen.join('\n')).not.toContain(TYPED_KEY)
    expect(recording.asked.join('\n')).not.toContain(TYPED_KEY)
    const files = filesUnder(home).filter(file => file !== join(home, '.credentials.yaml'))
    expect(files).toContain(join(profileDirectory(home, PROFILE), 'cordis.patch.yml'))
    expect(files).toContain(join(profileDirectory(home, PROFILE), 'setup-answers.json'))
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toContain(TYPED_KEY)
    expect(readFileSync(join(home, '.credentials.yaml'), 'utf8')).toContain(TYPED_KEY)
    expect(existsSync(join(runDirectory(home, PROFILE), 'setup-progress.json'))).toBe(false)
  })

  it('writes nothing when the person cancels at the review', async () => {
    await expect(interactive(['local', DS, 'environment', 'safer', 'cancel'])).rejects.toBeInstanceOf(SetupCancelled)
    expect(hasCliProfile(home, PROFILE)).toBe(false)
    expect(readProgress(runDirectory(home, PROFILE))).toBeUndefined()
  })
})

describe('the way back', { timeout: TIMEOUT_MS }, () => {
  it('returns to the previous question and keeps the answers of the earlier ones', async () => {
    expect(await interactive(['local', DS, 'prompt', TYPED_KEY, BACK_CHOICE, DS, 'environment', 'stock', 'save'])).toBe(EXIT.ok)
    expect(recording.asked.filter(question => question.startsWith('select: How should Delorun get'))).toHaveLength(2)
    expect(recordOf().modelProvider).toEqual({ id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' }, baseURL: null, model: null })
    expect(recordOf().prompts).toBe('stock')
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  })

  it('treats an empty key as "go back" to the source question, and returns from the provider question to the first screen, which has no back choice', async () => {
    expect(await interactive(['local', DS, 'prompt', '', BACK_CHOICE, BACK_CHOICE, 'local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    expect(recording.asked.filter(question => question.startsWith('select: How should Delorun get'))).toHaveLength(3)
    expect(recording.asked.filter(question => question.startsWith('select: How will you'))).toHaveLength(2)
    const first = screen().split('# Privacy')[0] ?? ''
    expect(first).not.toContain('← Back')
  })

  it('lets the use case change after two steps back, and the new one sets its defaults', async () => {
    expect(await interactive(['local', DS, 'environment', BACK_CHOICE, BACK_CHOICE, 'automation', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ useCase: 'automation', background: false })
    expect(recordOf().sections.find(record => record.id === 'reach')?.status).toBe('skipped')
  })

  it('goes back from the review to the last question that was asked, and skips passed-over sections', async () => {
    expect(await interactive(['local', DS, 'environment', 'safer', BACK_CHOICE, 'stock', 'save'])).toBe(EXIT.ok)
    expect(recordOf().prompts).toBe('stock')
    expect(recording.asked.filter(question => question.startsWith('select: How much should'))).toHaveLength(2)
    expect(recording.asked.filter(question => question.includes('background'))).toEqual([])
  })

  it('does not show the privacy note again when the way back stops at a later question', async () => {
    expect(await interactive(['local', DS, 'environment', BACK_CHOICE, DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    expect(screen().split('# Privacy')).toHaveLength(2)
  })
})

describe('the key check', { timeout: TIMEOUT_MS }, () => {
  it('sends a typed key to one live check before it is stored, and never checks it again', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: true } as const))
    expect(await interactive(QUICK_SCRIPT, { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(checkKey).toHaveBeenCalledTimes(1)
    expect(checkKey.mock.calls.map(call => call.at(1))).toEqual([TYPED_KEY])
  })

  it('says why a check failed and lets the person enter the key again', async () => {
    const checkKey = vi.fn((_target: KeyTarget, key: string) => Promise.resolve(key === TYPED_KEY ? { ok: true } as const : { ok: false, reason: 'api.example did not accept the key (HTTP 401).' } as const))
    expect(await interactive(['local', DS, 'prompt', 'wrong-key-1', 'again', TYPED_KEY, 'safer', 'save'], { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(screen()).toContain('The key was not checked successfully: api.example did not accept the key (HTTP 401).')
    expect(screen()).not.toContain('wrong-key-1')
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8')).refs.DEEPSEEK_API_KEY).toBe(TYPED_KEY)
  })

  it('stores a key that failed the check only when the person chooses to continue', async () => {
    const checkKey = (): Promise<{ ok: false, reason: string }> => Promise.resolve({ ok: false, reason: 'could not reach api.example.' })
    expect(await interactive(['local', DS, 'prompt', 'unchecked-key-2', 'continue', 'safer', 'save'], { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8')).refs.DEEPSEEK_API_KEY).toBe('unchecked-key-2')
  })

  it('says on the review that a key the person continued with was not verified, and why, without the key', async () => {
    const checkKey = (): Promise<{ ok: false, reason: string }> => Promise.resolve({ ok: false, reason: 'could not reach api.example.' })
    expect(await interactive(['local', DS, 'prompt', 'unchecked-key-4', 'continue', 'safer', 'save'], { keyCheck: checkKey })).toBe(EXIT.ok)
    const review = screen().split('# Review\n')[1]?.split('\n?')[0]
    expect(review).toContain('  Model: DeepSeek, default model. Key: pasted now, not verified: could not reach api.example.\n  Prompts: Ask me first')
    expect(screen()).not.toContain('unchecked-key-4')
  })

  it('shows no failed check on the review once a later key passed, or the person went back and chose the environment', async () => {
    const checkKey = vi.fn((_target: KeyTarget, key: string) => Promise.resolve(key === TYPED_KEY ? { ok: true } as const : { ok: false, reason: 'api.example did not accept the key (HTTP 401).' } as const))
    expect(await interactive(['local', DS, 'prompt', 'wrong-key-5', 'again', TYPED_KEY, 'safer', 'save'], { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(screen()).toContain('  Model: DeepSeek, default model. Key: pasted now.\n')
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    recording.screen.length = 0
    expect(await interactive(['local', DS, 'prompt', 'wrong-key-6', 'continue', BACK_CHOICE, DS, 'environment', 'safer', 'save'], { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(screen()).toContain('  Model: DeepSeek, default model. Key: read from DEEPSEEK_API_KEY at each start.\n')
    expect(screen()).not.toContain('not verified')
  })

  it('says on the review that the environment\'s key failed its check with --check-key', async () => {
    const checkKey = (): Promise<{ ok: false, reason: string }> => Promise.resolve({ ok: false, reason: 'api.example did not accept the key (HTTP 401).' })
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'], { keyCheck: checkKey, env: { DEEPSEEK_API_KEY: 'env-key-value-8' }, checkEnvironmentKey: true })).toBe(EXIT.ok)
    expect(screen()).toContain('  Model: DeepSeek, default model. Key: read from DEEPSEEK_API_KEY at each start, not verified: api.example did not accept the key (HTTP 401).\n')
    expect(screen()).not.toContain('env-key-value-8')
  })

  it('goes back from the failed-check choice to the source question', async () => {
    const checkKey = (): Promise<{ ok: false, reason: string }> => Promise.resolve({ ok: false, reason: 'could not reach api.example.' })
    expect(await interactive(['local', DS, 'prompt', 'unchecked-key-3', BACK_CHOICE, 'environment', 'safer', 'save'], { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  })

  it('checks a key from the environment only with --check-key', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: false, reason: 'api.example did not accept the key (HTTP 401).' } as const))
    const env = { DEEPSEEK_API_KEY: 'env-key-value-7' }
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'], { keyCheck: checkKey, env })).toBe(EXIT.ok)
    expect(checkKey).not.toHaveBeenCalled()
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    recording.screen.length = 0
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'], { keyCheck: checkKey, env, checkEnvironmentKey: true })).toBe(EXIT.ok)
    expect(checkKey.mock.calls.map(call => call.at(1))).toEqual(['env-key-value-7'])
    expect(screen()).toContain('The key in DEEPSEEK_API_KEY was not checked successfully: api.example did not accept the key (HTTP 401).')
    expect(screen()).not.toContain('env-key-value-7')
  })

  it('does not check an unset environment variable even with --check-key', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: true } as const))
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'], { keyCheck: checkKey, checkEnvironmentKey: true })).toBe(EXIT.ok)
    expect(checkKey).not.toHaveBeenCalled()
  })
})

describe('sections', { timeout: TIMEOUT_MS }, () => {
  it('lists the sections, one line each', () => {
    expect(sectionList(defaultRegistry())).toBe([
      'Sections (delorun setup <section> runs one again):',
      '  privacy             Privacy',
      '  import              Import a DeepSeek Harness home',
      '  key                 Model provider and key',
      '  prompts             Prompts',
      '  background          Background',
      '  reach               Remote access',
      '  changes-protection  Changes protection',
      '  profile             Profile name and port',
      '',
    ].join('\n'))
  })

  it('runs one section again on a profile that is set up and updates the answers record', async () => {
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
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
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    const request = (script: readonly Answer[]): SetupRequest => ({
      home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined },
      form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) },
      keyCheck: () => Promise.resolve({ ok: true }), portIsFree: () => Promise.resolve(true),
    })
    expect(await runSection(request([DS, 'prompt', TYPED_KEY, MODEL]), 'key')).toBe(EXIT.ok)
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
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    const registry = new SectionRegistry()
    registry.register({ ...privacySection, id: 'elsewhere', appliesTo: () => false }, { order: 1 })
    await expect(runSection(request({ kind: 'interactive', prompter }, registry), 'elsewhere')).rejects.toThrow('does not apply on this computer')
    await expect(runSection(request({ kind: 'yes' }), 'prompts')).rejects.toBeInstanceOf(CliError)
  })

  it('reads an answers record that is missing or no longer valid as the defaults', async () => {
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
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
    return { ...privacySection, id, title: id, plan: { local: 'asked', remote: 'asked', automation: 'asked' } }
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
    expect(await interactive(['local', 'yes', DS, 'environment', 'safer', 'save'], { registry })).toBe(EXIT.ok)
    expect(recording.asked.slice(0, 3)).toEqual(['select: How will you use Delorun?', 'select: Example question?', 'select: Which model provider should Delorun use?'])
    expect(recordOf().sections.map(record => record.id)).toEqual(['privacy', 'import', 'example', 'key', 'prompts', 'background', 'reach', 'changes-protection', 'profile'])
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
      { id: 'changes-protection', status: 'skipped' },
      { id: 'profile', status: 'skipped' },
    ])
    expect(screen()).toContain('Delorun is set up. Nothing is running yet.')
    expect(screen()).toContain('Add a model key first: delorun setup key')
    expect(patchOf().map(row => row.id)).toEqual(['delorun-permission-defaults', 'delorun-instruction-consent', 'delorun-mcp-consent', 'delorun-schedule-consent'])
  })

  it('checks the environment key live only with --check-key, and refuses a key the provider does not accept without printing it', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: false, reason: 'api.example did not accept the key (HTTP 401).' } as const))
    expect(await unattended({ keyCheck: checkKey, providerChoice: DEEPSEEK_CHOICE })).toBe(EXIT.ok)
    expect(checkKey).not.toHaveBeenCalled()
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    const error = await unattended({ keyCheck: checkKey, checkEnvironmentKey: true, providerChoice: DEEPSEEK_CHOICE }).catch((caught: unknown) => caught)
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
    expect(checkKey.mock.calls.map(call => call.at(1))).toEqual(['env-key-value-8'])
    expect(recordOf().prompts).toBe('stock')
    expect(readBackgroundAnswer(profileDirectory(home, PROFILE))).toBe(false)
    expect(patchOf()).toContainEqual({ id: 'webserver', config: { host: '127.0.0.1', port: 4400, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
  })

  it('names the --profile flag in the next step when the profile is not the default', async () => {
    const document = join(osHome, 'named.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'safer', background: true, profile: { name: 'work', port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    expect(await unattended({ form: { kind: 'config', path: document } })).toBe(EXIT.ok)
    expect(screen()).toContain('Start Delorun and open the studio: delorun --profile work')
  })
})

describe('what setup does around the sections', { timeout: TIMEOUT_MS }, () => {
  it('shows the bundle linking as one progress line, with its output in the profile\'s home log', async () => {
    vi.mocked(linkDelorunBundles).mockImplementationOnce((_home, _profile, _bundles, _linking, report) => {
      report.progress(LINKING_PROGRESS)
      new LineCapture(report.log, 'stdout', 'info').write('pnpm linked /abs/path/bundle\n')
      report.progress('done\n')
      return Promise.resolve()
    })
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    // The scripted output records each write on a line of its own.
    expect(screen()).toContain(`${LINKING_PROGRESS}\ndone\nDelorun is set up. Nothing is running yet.`)
    expect(screen()).not.toContain('/abs/path/bundle')
    expect(readFileSync(join(home, 'logs', `home-${PROFILE}`, 'home.log'), 'utf8')).toContain('pnpm linked /abs/path/bundle')
  })

  it('finishes setup when the home log cannot be written, dropping the linking\'s records', async () => {
    vi.mocked(linkDelorunBundles).mockImplementationOnce((_home, _profile, _bundles, _linking, report) => {
      report.log.close()
      rmSync(report.log.location.dir, { recursive: true })
      writeFileSync(report.log.location.dir, 'a file where the log directory belongs')
      new LineCapture(report.log, 'stdout', 'info').write('pnpm linked the bundle\n')
      report.progress(`${LINKING_PROGRESS}done\n`)
      return Promise.resolve()
    })
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    expect(screen()).toContain(`${LINKING_PROGRESS}done`)
    expect(screen()).not.toContain('pnpm linked the bundle')
  })

  it('stops with the cause when the profile cannot be created, and leaves the run to resume', async () => {
    mkdirSync(join(home, 'profiles'), { recursive: true })
    writeFileSync(profileDirectory(home, PROFILE), 'a file where the profile directory belongs')
    const error = await interactive(['local', DS, 'environment', 'safer', 'save']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as Error).message).toContain(`could not create the CLI profile ${PROFILE} at ${profileDirectory(home, PROFILE)}`)
    expect(readProgress(runDirectory(home, PROFILE))?.completed).toEqual([])
  })

  it('resumes after a link failure with the profile that was already created', async () => {
    vi.mocked(linkDelorunBundles).mockRejectedValueOnce(new Error('pnpm failed'))
    await expect(interactive(['local', DS, 'environment', 'safer', 'save'])).rejects.toThrow('pnpm failed')
    expect(hasCliProfile(home, PROFILE)).toBe(true)
    expect(readProgress(runDirectory(home, PROFILE))?.completed).toEqual([])
    expect(await interactive([false])).toBe(EXIT.ok)
    expect(readProgress(runDirectory(home, PROFILE))).toBeUndefined()
    expect(screen()).toContain('Resuming the setup of default.')
  })

  it('says nothing about an environment key that passes --check-key', async () => {
    const checkKey = vi.fn(() => Promise.resolve({ ok: true } as const))
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'], { keyCheck: checkKey, env: { DEEPSEEK_API_KEY: 'passing-key-9' }, checkEnvironmentKey: true })).toBe(EXIT.ok)
    expect(checkKey).toHaveBeenCalledTimes(1)
    expect(screen()).not.toContain('Key check')
  })

  it('refuses a --config document whose environment variable is unset, and writes nothing', async () => {
    const document = join(osHome, 'unset.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'ELSEWHERE_KEY' } }, prompts: 'safer', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    const error = await runSetup({ home, profile: PROFILE, env: {}, form: { kind: 'config', path: document }, output: { stdout: () => undefined, stderr: () => undefined } }).catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('delorun setup --config: ELSEWHERE_KEY is not set; set it to the DeepSeek key')
    expect(hasCliProfile(home, PROFILE)).toBe(false)
  })

  it('prints a note a section returns from its writes, in a run and when the section runs again', async () => {
    const registry = defaultRegistry()
    registry.register({ ...privacySection, id: 'extra', title: 'Extra', asks: () => true, ask: () => Promise.resolve({ answers: {}, status: 'answered' as const }), apply: () => Promise.resolve('The extra section wrote its file.') }, { order: 60 })
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'], { registry })).toBe(EXIT.ok)
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
    registry.register({ ...withoutReview, id: 'quiet', title: 'Quiet', plan: { local: 'asked', remote: 'asked', automation: 'asked' }, asks: () => true, ask: () => Promise.resolve({ answers: {}, status: 'answered' as const }) }, { order: 60 })
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'], { registry })).toBe(EXIT.ok)
    expect(screen()).toContain('  Model: DeepSeek, default model. Key: read from DEEPSEEK_API_KEY at each start.\n  Prompts: Ask me first\n')
    expect(screen()).not.toContain('Quiet')
  })

  it('stops a key write that has no typed key to store', async () => {
    const keySection = defaultRegistry().find('key') as SetupSection
    await expect(keySection.apply({ home, env: {}, directory: home, secret: undefined }, SETUP_DEFAULTS)).rejects.toThrow('the model key was not entered')
  })

  it('reviews the key line without a draft as a key nothing is known to have failed to check', () => {
    const keySection = defaultRegistry().find('key') as SetupSection
    expect(keySection.review?.(SETUP_DEFAULTS)).toBe('Model: DeepSeek, default model. Key: pasted now.')
  })
})

describe('the release check', { timeout: TIMEOUT_MS }, () => {
  /** The release-check row turned off, as Settings → General → Updates saves it: the bundle's config restated with `enabled` off. */
  const OFF_ROW = { id: 'delorun-update-check', name: '@delorun/bundle-local/update-check', config: { intervalHours: 24, timeoutSeconds: 15, enabled: false } }



  it('delorun setup privacy shows the note, turns the check off, and turns it on again by removing the row', async () => {
    expect(await interactive(['local', DS, 'environment', 'safer', 'save'])).toBe(EXIT.ok)
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
    expect(screen()).toContain('Delorun has no telemetry of its own.')
    expect(screen()).toContain('> Yes (recommended)')
    expect(screen()).toContain('Updated the privacy section of the profile default.')
    recording.screen.length = 0
    expect(await runSection(request('on'), 'privacy')).toBe(EXIT.ok)
    expect(screen()).toContain('> No')
    expect(patchOf()).toEqual(prompts)
    expect(recordOf()).toMatchObject({ updateCheck: true })
  })


  it('reads a version-2 answers document and record as the check on, and records them as version 4', async () => {
    const document = join(osHome, 'version-2.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'safer', background: false, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    expect(await runSetup({ home, profile: PROFILE, env: { DEEPSEEK_API_KEY: 'env-key-value-11' }, form: { kind: 'config', path: document }, output: { stdout: () => undefined, stderr: () => undefined } })).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ schemaVersion: 4, updateCheck: true })
    const record = join(profileDirectory(home, PROFILE), 'setup-answers.json')
    const version2: Record<string, unknown> = { ...JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>, schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } } }
    Reflect.deleteProperty(version2, 'updateCheck')
    Reflect.deleteProperty(version2, 'useCase')
    writeFileSync(record, JSON.stringify(version2))
    const request: SetupRequest = { home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form: { kind: 'interactive', prompter: scriptedPrompter(['stock'], recording) } }
    expect(await runSection(request, 'prompts')).toBe(EXIT.ok)
    expect(recordOf()).toMatchObject({ schemaVersion: 4, updateCheck: true, background: false, prompts: 'stock' })
  })
})

describe('the model provider question', { timeout: TIMEOUT_MS }, () => {
  it('sets up another provider in Quick: its key under its own variable, its route and the model new chats start on, checked against its catalog endpoint', async () => {
    const catalog = await installedCatalog()
    const model = catalog.models('anthropic')[0]?.id as string
    const checkKey = vi.fn((_target: KeyTarget, _key: string) => Promise.resolve({ ok: true } as const))
    expect(await interactive(['local', 'more', 'anthropic', 'prompt', TYPED_KEY, model, 'safer', 'save'], { keyCheck: checkKey })).toBe(EXIT.ok)
    expect(checkKey.mock.calls.map(([target, key]) => [target.provider.id, target.baseURL, key])).toEqual([['anthropic', 'https://api.anthropic.com', TYPED_KEY]])
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))).toEqual({ version: 1, refs: { ANTHROPIC_API_KEY: TYPED_KEY } })
    const byId = new Map(patchOf().map(row => [row.id, row.config]))
    expect(byId.get('llm-pi-ai')).toEqual({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } })
    expect(byId.get('agent-default-model')).toEqual({ provider: 'anthropic', model })
    expect(recordOf().modelProvider).toEqual({ id: 'anthropic', credential: { source: 'prompt' }, baseURL: null, model })
    expect(screen()).toContain(`  Model: Anthropic, ${model}. Key: pasted now.\n`)
    expect(screen()).not.toContain(TYPED_KEY)
  })

  it('asks an OpenAI-compatible endpoint\'s base URL and model in both modes, refusing a URL that is not http or https, and goes back inside the section', async () => {
    const script = ['local', 'more', 'openai-compatible', 'ftp://host', 'http://127.0.0.1:11434/v1', 'qwen3:8b', BACK_CHOICE, '', 'http://127.0.0.1:11434/v1', 'llama3.3', 'environment', 'safer', 'save']
    expect(await interactive(script, { env: { OPENAI_COMPATIBLE_API_KEY: 'local' } })).toBe(EXIT.ok)
    expect(screen()).toContain('! Enter an http or https URL without a user name, password, query or fragment')
    expect(recordOf().modelProvider).toEqual({ id: 'openai-compatible', credential: { source: 'environment', name: 'OPENAI_COMPATIBLE_API_KEY' }, baseURL: 'http://127.0.0.1:11434/v1', model: 'llama3.3' })
    expect(new Map(patchOf().map(row => [row.id, row.config])).get('llm-pi-ai')).toEqual({
      providers: { 'openai-compatible': { displayName: 'OpenAI-compatible endpoint', apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'llama3.3' }] } },
    })
  })

  it('goes back from the key source to the provider question and from the model to the key source', async () => {
    const catalog = await installedCatalog()
    const model = catalog.models('openai')[0]?.id as string
    expect(await interactive(['local', 'more', 'groq', BACK_CHOICE, 'openai', 'environment', BACK_CHOICE, 'environment', model, 'safer', 'save'])).toBe(EXIT.ok)
    expect(recordOf().modelProvider).toEqual({ id: 'openai', credential: { source: 'environment', name: 'OPENAI_API_KEY' }, baseURL: null, model })
  })

  it('sets up no provider with "None for now", writes no provider row and says how to add one', async () => {
    expect(await interactive(['local', 'none', 'safer', 'save'])).toBe(EXIT.ok)
    expect(recordOf().modelProvider).toBeNull()
    expect(patchOf().map(row => row.id)).not.toContain('agent-default-model')
    expect(screen()).toContain('  Model: chosen later; chats cannot answer until delorun setup key\n')
    expect(screen()).toContain('No model provider was set up now, and no provider setting changed. New chats still start on deepseek-flash from DeepSeek, which reads its key from DEEPSEEK_API_KEY unless the profile names another variable.')
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  })

  it('starts the model question on the provider\'s recommended model, not the catalog\'s first', async () => {
    expect(await interactive(['local', 'more', 'openai', 'environment', 'gpt-6.1-sol', 'safer', 'save'])).toBe(EXIT.ok)
    expect(screen()).toContain('> gpt-6.1-sol')
    expect(screen()).not.toContain('> gpt-4\n')
  })

  it('warns, without refusing, about an endpoint another computer serves over plain http', async () => {
    expect(await interactive(['local', 'more', 'openai-compatible', 'http://192.0.2.20:8000/v1', 'local', 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    expect(screen()).toContain('# Plain http\n  http://192.0.2.20:8000 is reached over plain http')
    recording.screen.length = 0
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    expect(await interactive(['local', 'more', 'openai-compatible', 'http://127.0.0.1:8000/v1', 'local', 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    expect(screen()).not.toContain('Plain http')
  })

  it('leaves the provider rows as they are with "None for now" after another provider, and says which model new chats still use', async () => {
    expect(await interactive(['local', 'more', 'groq', 'environment', 'openai/gpt-oss-120b', 'safer', 'save'])).toBe(EXIT.ok)
    const before = patchOf()
    recording.screen.length = 0
    const request: SetupRequest = {
      home, profile: PROFILE, env: {}, output: { stdout: text => void recording.screen.push(text.trim()), stderr: () => undefined },
      form: { kind: 'interactive', prompter: scriptedPrompter(['none'], recording) },
    }
    expect(await runSection(request, 'key')).toBe(EXIT.ok)
    expect(patchOf()).toEqual(before)
    expect(recordOf().modelProvider).toBeNull()
    expect(screen()).toContain('New chats still start on openai/gpt-oss-120b from Groq, which reads its key from GROQ_API_KEY unless the profile names another variable.')
  })

  it('offers the earlier answer again when the section runs again, and keeps the other routes when the provider changes', async () => {
    expect(await interactive(['local', 'more', 'openai-compatible', 'http://127.0.0.1:8000/v1', 'local', 'environment', 'safer', 'save'])).toBe(EXIT.ok)
    recording.screen.length = 0
    const request: SetupRequest = {
      home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined },
      form: { kind: 'interactive', prompter: scriptedPrompter([DS, 'environment', MODEL], recording) }, keyCheck: () => Promise.resolve({ ok: true }),
    }
    expect(await runSection(request, 'key')).toBe(EXIT.ok)
    expect(screen()).toContain('> More providers')
    expect(recordOf().modelProvider).toEqual({ id: DS, credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' }, baseURL: null, model: MODEL })
    expect(patchOf().map(row => row.id)).toContain('llm-pi-ai')
    expect(patchOf().map(row => row.id)).not.toContain('agent-default-model')
  })
})
