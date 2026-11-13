import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DANGEROUS_PHRASE } from '@delo/contract-setup-answers'
import { ensureHomeTree } from '@delo/home'
import { runSetup, type SetupForm, type SetupHooks } from '../../src/setup/index.ts'
import { dangerousGrantPath } from '../../src/setup/dangerous.ts'
import { readPromptsRows, writePromptRows } from '../../src/setup/prompt-switches.ts'
import { sectionStep } from '../../src/setup/progress.ts'
import { writeUpdateCheckRow } from '../../src/setup/update-check.ts'
import { EXIT } from '../../src/exit.ts'
import { profileDirectory } from '../../src/profile.ts'
import { scriptedPrompter, type Answer, type Recording } from './support.ts'

const PROFILE = 'default'
const DS = 'deepseek-official'
const KEY = 'fixture-key-value'
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
  return runSetup({ home, profile: PROFILE, env: {}, output: { stdout: text => void lines.push(text), stderr: text => void lines.push(text) }, form, keyCheck: () => Promise.resolve({ ok: true }), portIsFree: () => Promise.resolve(true), ...hooks === undefined ? {} : { hooks } })
}

const patchPath = (): string => join(profileDirectory(home, PROFILE), 'cordis.patch.yml')
const credentialsPath = (): string => join(home, '.credentials.yaml')

/** The first run every case starts from: the typed key stored, "Ask me first". */
const FIRST_RUN: readonly Answer[] = ['local', DS, 'prompt', KEY, 'safer', 'save']

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-rerun-')))
  home = join(osHome, '.delo')
  await ensureHomeTree(home, PROFILE)
  lines = []
  expect(await run(FIRST_RUN)).toBe(EXIT.ok)
  lines = []
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('setup on a finished profile in a terminal', { timeout: TIMEOUT_MS }, () => {
  it('says what it will do, keeps the saved key without printing it, and writes nothing when no answer changes', async () => {
    const before = { patch: statSync(patchPath()).mtimeMs, credentials: statSync(credentialsPath()).mtimeMs, credentialsText: readFileSync(credentialsPath(), 'utf8') }
    expect(await run(['local', DS, 'keep', 'safer', 'save'])).toBe(EXIT.ok)
    expect(lines.join('')).toContain('asks every question again with your current choices selected')
    expect(lines.join('')).toContain('Kept as they were:')
    expect(recording.screen).toContain('> Keep the saved key')
    expect(recording.screen.join('\n')).not.toContain(KEY)
    expect(lines.join('')).not.toContain(KEY)
    expect(recording.asked.some(question => question.includes('Name for this setup'))).toBe(false)
    expect(statSync(patchPath()).mtimeMs).toBe(before.patch)
    expect(statSync(credentialsPath()).mtimeMs).toBe(before.credentials)
    expect(readFileSync(credentialsPath(), 'utf8')).toBe(before.credentialsText)
  })

  it('starts each question on what the configuration holds now, including a change made in Settings', async () => {
    writePromptRows(patchPath(), 'stock')
    writeUpdateCheckRow(patchPath(), false)
    // The answers record still says "Ask me first" and the check on; the rows decide.
    expect(await run(['local', DS, 'keep', 'stock', 'more', 'off', 'yes', 'no', 'no', '3080', 'save'])).toBe(EXIT.ok)
    const screen = recording.screen.join('\n')
    expect(screen).toContain('> Ask less (like DeepSeek Harness)')
    expect(screen).toMatch(/\? Check for new releases\?\n {2}Yes[^\n]*\n> No/u)
    expect(screen).not.toContain('(changed)')
  })

  it('marks a changed answer in the review and writes only that section', async () => {
    writePromptRows(patchPath(), 'stock')
    const credentials = statSync(credentialsPath()).mtimeMs
    expect(await run(['local', DS, 'keep', 'safer', 'save'])).toBe(EXIT.ok)
    expect(recording.screen.join('\n')).toContain('Prompts: Ask me first (changed)')
    expect(readPromptsRows(patchPath())).toBe('safer')
    expect(statSync(credentialsPath()).mtimeMs).toBe(credentials)
    expect(lines.join('')).toContain('Kept as they were:')
  })

  it('stores a newly typed key and reports the key section as changed', async () => {
    expect(await run(['local', DS, 'prompt', 'second-key', 'safer', 'save'])).toBe(EXIT.ok)
    expect(readFileSync(credentialsPath(), 'utf8')).toContain('second-key')
  })

  it('still asks both dangerous-mode confirmations to turn it on, asks none to stay on, and withdraws the grant when it is turned off', async () => {
    expect(await run(['local', DS, 'keep', 'dangerous', 'yes', DANGEROUS_PHRASE, 'save'])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(true)
    expect(recording.asked.filter(question => question.startsWith('select: Allow any chat'))).toHaveLength(1)

    expect(await run(['local', DS, 'keep', 'dangerous', 'save'])).toBe(EXIT.ok)
    expect(recording.screen.join('\n')).toContain('> Never ask (dangerous)')
    expect(recording.asked.some(question => question.includes('Allow any chat'))).toBe(false)
    expect(existsSync(dangerousGrantPath(home))).toBe(true)

    expect(await run(['local', DS, 'keep', 'safer', 'save'])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
  })

  it('does not turn dangerous mode on when the first confirmation is declined', async () => {
    expect(await run(['local', DS, 'keep', 'dangerous', 'no', 'save'])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
  })

  it('resumes an interrupted re-run like a first run', async () => {
    await expect(run(['local', DS, 'keep', 'stock', 'save'], { afterStep: (step) => { if (step === sectionStep('privacy')) throw new Error('interrupted') } })).rejects.toThrow('interrupted')
    lines = []
    expect(await run([])).toBe(EXIT.ok)
    expect(recording.asked).toEqual([])
    expect(lines.join('')).toContain('Resuming the setup of default')
    expect(readFileSync(credentialsPath(), 'utf8')).toContain(KEY)
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
