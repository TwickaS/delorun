import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DANGEROUS_PHRASE } from '@delorun/contract-setup-answers'
import { ensureHomeTree } from '@delorun/home'
import { runSection, runSetup, type SetupForm, type SetupHooks, type SetupRequest } from '../../src/setup/index.ts'
import { dangerousGrantPath } from '@delorun/plugin-permission-defaults/store'
import { readPromptsRows, writePromptRows } from '../../src/setup/prompt-switches.ts'
import { sectionStep } from '../../src/setup/progress.ts'
import { writeUpdateCheckRow } from '../../src/setup/update-check.ts'
import { EXIT } from '../../src/exit.ts'
import { profileDirectory } from '../../src/profile.ts'
import { fakeTailscale } from '../fixtures/fake-tailscale.ts'
import { readPairingAt } from '../../src/reach/pairing-row.ts'
import { readReachRow } from '../../src/reach/row.ts'
import { registryWithTailscale, scriptedPrompter, type Answer, type Recording } from './support.ts'

const PROFILE = 'default'
const DS = 'deepseek-official'
const KEY = 'fixture-key-value'
const MODEL = 'deepseek-flash'
const HOST = 'home.example.ts.net'
const TIMEOUT_MS = 60_000

let osHome: string
let home: string
let lines: string[]
let recording: Recording

/**
 * Run setup against the scratch home with a scripted prompter.
 * @param script - the answers in order.
 * @param hooks - test hooks.
 * @returns the exit code.
 */
function run(script: readonly Answer[], hooks?: SetupHooks): Promise<number> {
  recording = { screen: [], asked: [] }
  const form: SetupForm = { kind: 'interactive', prompter: scriptedPrompter(script, recording) }
  return runSetup({ home, profile: PROFILE, env: {}, output: { stdout: text => void lines.push(text), stderr: text => void lines.push(text) }, form, keyCheck: () => Promise.resolve({ ok: true }), portIsFree: () => Promise.resolve(true), registry: registryWithTailscale(fakeTailscale(HOST).run), ...hooks === undefined ? {} : { hooks } })
}

const patchPath = (): string => join(profileDirectory(home, PROFILE), 'cordis.patch.yml')
const credentialsPath = (): string => join(home, '.credentials.yaml')

/**
 * Run one section on the profile that is set up.
 * @param id - the section.
 * @param script - the answers in order.
 * @returns the exit code.
 */
function section(id: string, script: readonly Answer[]): Promise<number> {
  const request: SetupRequest = {
    home, profile: PROFILE, env: {}, output: { stdout: text => void lines.push(text), stderr: text => void lines.push(text) },
    form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) }, keyCheck: () => Promise.resolve({ ok: true }), registry: registryWithTailscale(fakeTailscale(HOST).run),
  }
  return runSection(request, id)
}

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-rerun-')))
  home = join(osHome, '.delorun')
  await ensureHomeTree(home, PROFILE)
  lines = []
  // The first run every case starts from: no phone, then the typed key stored through the key section.
  expect(await run(['no'])).toBe(EXIT.ok)
  expect(await section('key', [DS, 'prompt', KEY, MODEL])).toBe(EXIT.ok)
  lines = []
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('setup on a finished profile in a terminal', { timeout: TIMEOUT_MS }, () => {
  it('says what it will do, keeps the saved key without printing it, and writes nothing when no answer changes', async () => {
    const before = { patch: statSync(patchPath()).mtimeMs, credentials: statSync(credentialsPath()).mtimeMs, credentialsText: readFileSync(credentialsPath(), 'utf8') }
    expect(await run(['no'])).toBe(EXIT.ok)
    expect(lines.join('')).toContain('asks every question again with your current choices selected')
    expect(lines.join('')).toContain('Kept as they were:')
    expect(recording.asked).toEqual(['select: Use it from your phone too?'])
    expect(recording.screen).toContain('> No, just this computer')
    expect(recording.screen.join('\n')).not.toContain(KEY)
    expect(lines.join('')).not.toContain(KEY)
    expect(statSync(patchPath()).mtimeMs).toBe(before.patch)
    expect(statSync(credentialsPath()).mtimeMs).toBe(before.credentials)
    expect(readFileSync(credentialsPath(), 'utf8')).toBe(before.credentialsText)
  })

  it('does not ask the port question for a profile that is set up, even when its own studio holds the port', async () => {
    expect(await runSetup({ home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form: { kind: 'interactive', prompter: scriptedPrompter(['no'], recording) }, portIsFree: () => Promise.resolve(false), registry: registryWithTailscale(fakeTailscale(HOST).run) })).toBe(EXIT.ok)
    expect(recording.asked.filter(question => question.includes('is in use'))).toEqual([])
  })

  it('leaves what Settings changed alone: prompts, the release check and the model are not asked again', async () => {
    writePromptRows(patchPath(), 'stock')
    writeUpdateCheckRow(patchPath(), false)
    expect(await run(['no'])).toBe(EXIT.ok)
    expect(readPromptsRows(patchPath())).toBe('stock')
    expect(readFileSync(patchPath(), 'utf8')).toMatch(/delorun-update-check[\s\S]*enabled: false/u)
    expect(JSON.parse(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8'))).toMatchObject({ prompts: 'stock', updateCheck: false, modelProvider: { id: DS } })
    expect(lines.join('')).toContain('Kept as they were:')
  })

  it('writes only the section whose answer changed: a phone Yes writes the remote access row and keeps the key', async () => {
    const credentials = statSync(credentialsPath()).mtimeMs
    expect(await run(['yes', 'no'])).toBe(EXIT.ok)
    expect(readReachRow(home, PROFILE).enabled).toBe(true)
    expect(statSync(credentialsPath()).mtimeMs).toBe(credentials)
    expect(lines.join('')).toContain('Kept as they were:')
    expect(lines.join('')).not.toMatch(/Kept as they were:[^\n]*remote access/u)
  })

  it('starts the phone question on Yes once phone access is on, and keeps who may ask to pair', async () => {
    expect(await section('reach', [true, true])).toBe(EXIT.ok)
    expect(readPairingAt(patchPath()).mayAskWithoutWindow).toBe('tailnet')
    expect(await run(['yes', 'no'])).toBe(EXIT.ok)
    expect(recording.screen).toContain('> Yes, over Tailscale')
    expect(readPairingAt(patchPath()).mayAskWithoutWindow).toBe('tailnet')
    expect(lines.join('')).toMatch(/Kept as they were:[^\n]*remote access/u)
  })

  it('leaves dangerous mode and its grant as they are, and delorun setup prompts still turns it on and off', async () => {
    expect(await section('prompts', ['dangerous', 'yes', DANGEROUS_PHRASE])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(true)
    expect(recording.asked.filter(question => question.startsWith('select: Allow any chat'))).toHaveLength(1)

    expect(await run(['no'])).toBe(EXIT.ok)
    expect(readPromptsRows(patchPath())).toBe('dangerous')
    expect(existsSync(dangerousGrantPath(home))).toBe(true)

    expect(await section('prompts', ['dangerous'])).toBe(EXIT.ok)
    expect(recording.asked.some(question => question.includes('Allow any chat'))).toBe(false)
    expect(existsSync(dangerousGrantPath(home))).toBe(true)

    expect(await section('prompts', ['safer'])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
  })

  it('does not turn dangerous mode on when the first confirmation is declined', async () => {
    expect(await section('prompts', ['dangerous', 'no'])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
  })

  it('resumes an interrupted re-run like a first run', async () => {
    await expect(run(['yes', 'no'], { afterStep: (step) => { if (step === sectionStep('privacy')) throw new Error('interrupted') } })).rejects.toThrow('interrupted')
    lines = []
    expect(await run([])).toBe(EXIT.ok)
    expect(recording.asked).toEqual([])
    expect(lines.join('')).toContain('Resuming the setup of default')
    expect(readFileSync(credentialsPath(), 'utf8')).toContain(KEY)
    expect(readReachRow(home, PROFILE).enabled).toBe(true)
  })

  it.each([
    ['keep', [], []],
    [undefined, [KEY], ['secret: Deepseek API key']],
  ])('resumes before the key step with the credential source %s', async (credentialSource, script, asked) => {
    const { version, ...answers } = JSON.parse(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8')) as Record<string, unknown>
    mkdirSync(join(home, 'run', PROFILE), { recursive: true })
    writeFileSync(join(home, 'run', PROFILE, 'setup-progress.json'), JSON.stringify({ version, answers, completed: ['profile'], ...credentialSource === undefined ? {} : { credentialSource } }))
    expect(await run(script)).toBe(EXIT.ok)
    expect(recording.asked.map(question => question.replace(/^secret: .*API key$/u, 'secret: Deepseek API key'))).toEqual(asked)
    expect(readFileSync(credentialsPath(), 'utf8')).toContain(KEY)
  })

  it('keeps today\'s message when no prompter or terminal is available', async () => {
    expect(await runSetup({ home, profile: PROFILE, env: {}, output: { stdout: text => void lines.push(text), stderr: () => undefined }, form: { kind: 'interactive' } })).toBe(EXIT.ok)
    expect(lines.join('')).toContain('already set up')
    expect(lines.join('')).not.toContain('asks every question again')
  })
})
