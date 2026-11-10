import { existsSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureHomeTree, runDirectory } from '@delo/home'
import { PROFILE_STEP, PROGRESS_FILENAME, readProgress, sectionStep, type SetupStep } from '../../src/setup/progress.ts'
import { runSetup, type SetupForm, type SetupHooks } from '../../src/setup/index.ts'
import { CliError, EXIT } from '../../src/exit.ts'
import { hasCliProfile, profileDirectory } from '../../src/profile.ts'
import { fakeEnding, scriptedPrompter, type Answer, type EndingLog, type Recording } from './support.ts'

const PROFILE = 'default'
const KEY = 'fixture-key-value'

let osHome: string
let home: string
let lines: string[]
let output: { stdout: (text: string) => void, stderr: (text: string) => void }
let recording: Recording
let ending: EndingLog

/** Each setup run adds Delo's bundle to the profile with a pnpm install, which takes seconds on a loaded host. */
const SETUP_TIMEOUT_MS = 60_000

/** Entries of a profile directory that the package manager writes for setup's `link:` dependency. */
const PACKAGE_MANAGER_OUTPUTS = new Set(['node_modules', 'pnpm-lock.yaml', '.plugin-manager'])

/**
 * Every file under a directory, relative to it, with its content. The package manager's outputs are left out: they
 * derive from the dependency `package.json` records, `pnpm-lock.yaml` spells a link relative to where the home lies,
 * and `.plugin-manager/` holds upstream's per-operation logs under random names.
 * @param root - the directory.
 * @returns sorted `path<TAB>content` lines; a missing directory yields none.
 */
function tree(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry)
      if (PACKAGE_MANAGER_OUTPUTS.has(entry)) continue
      if (statSync(full).isDirectory()) walk(full)
      else out.push(`${relative(root, full)}\t${readFileSync(full, 'utf8')}`)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * The files setup writes for a profile and the home's credentials document, in one comparable value.
 * @param root - the Delo home.
 * @returns the lines of the profile directory and of the credentials document.
 */
function writesOf(root: string): string[] {
  const credentials = join(root, '.credentials.yaml')
  return [
    ...tree(profileDirectory(root, PROFILE)).map(line => `profile/${line}`),
    ...(existsSync(credentials) ? [`credentials\t${readFileSync(credentials, 'utf8')}`] : []),
  ]
}

/**
 * Run setup and collect its output. The profile is created and linked for real.
 * @param form - the form.
 * @param env - the environment.
 * @param hooks - test hooks.
 * @param root - the Delo home.
 * @returns the promise of the exit code.
 */
function setup(form: SetupForm, env: Record<string, string | undefined> = { DEEPSEEK_API_KEY: KEY }, hooks?: SetupHooks, root: string = home) {
  return runSetup({ home: root, profile: PROFILE, output, env, form, ending: fakeEnding(ending), keyCheck: () => Promise.resolve({ ok: true }), ...(hooks === undefined ? {} : { hooks }) })
}

/**
 * @param script - the answers in order.
 * @returns the interactive form that plays them.
 */
function asked(script: readonly Answer[]): SetupForm {
  return { kind: 'interactive', prompter: scriptedPrompter(script, recording) }
}

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-setup-')))
  home = join(osHome, '.delo')
  await ensureHomeTree(home, PROFILE)
  lines = []
  recording = { screen: [], asked: [] }
  ending = { spawned: [], started: [], opened: 0 }
  output = { stdout: text => void lines.push(text), stderr: text => void lines.push(text) }
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

const QUICK_WITH_ENVIRONMENT_KEY: readonly Answer[] = ['quick', 'environment', 'safer', 'save', false]

describe('setup forms', { timeout: SETUP_TIMEOUT_MS }, () => {
  it('interactive and --yes runs produce identical profile writes', async () => {
    const interactiveHome = join(osHome, 'interactive', '.delo')
    await ensureHomeTree(interactiveHome, PROFILE)
    expect(await setup(asked(QUICK_WITH_ENVIRONMENT_KEY), {}, undefined, interactiveHome)).toBe(EXIT.ok)

    expect(await setup({ kind: 'yes' })).toBe(EXIT.ok)

    expect(writesOf(interactiveHome).filter(line => !line.includes('setup-answers.json'))).toEqual(writesOf(home).filter(line => !line.includes('setup-answers.json')))
    const answersOf = (root: string): Record<string, unknown> => {
      const { sections: _sections, ...answers } = JSON.parse(readFileSync(join(profileDirectory(root, PROFILE), 'setup-answers.json'), 'utf8')) as Record<string, unknown>
      return answers
    }
    expect(answersOf(interactiveHome)).toEqual(answersOf(home))
  })

  it('--yes leaves reach and credential forwarding off and writes no row for either', async () => {
    expect(await setup({ kind: 'yes' })).toBe(EXIT.ok)
    expect(lines.join('')).toContain('Delo has no telemetry of its own.')
    expect(lines.join('')).toContain('You can turn them on later in Settings → Privacy.')
    const patch = readFileSync(join(profileDirectory(home, PROFILE), 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toMatch(/reach|forward/i)
    expect(parse(patch)).toHaveLength(4)
  })

  it('refuses the questions without a terminal, and writes nothing', async () => {
    const error = await setup({ kind: 'interactive' }, {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exit).toBe(EXIT.usage)
    expect((error as Error).message).toContain('the questions need a terminal')
    expect(hasCliProfile(home, PROFILE)).toBe(false)
  })

  it('--yes stops with a typed error naming the variable when the key is unset', async () => {
    const error = await setup({ kind: 'yes' }, {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect(String((error as Error).message)).toContain('DEEPSEEK_API_KEY')
    expect(hasCliProfile(home, PROFILE)).toBe(false)
  })

  it('reports a finished setup as set up and writes nothing again', async () => {
    expect(await setup({ kind: 'yes' })).toBe(EXIT.ok)
    const before = writesOf(home)
    lines = []
    expect(await setup({ kind: 'yes' })).toBe(EXIT.ok)
    expect(lines.join('')).toContain('already set up')
    expect(writesOf(home)).toEqual(before)
  })
})

describe('an interrupted setup', { timeout: SETUP_TIMEOUT_MS }, () => {
  it('resumes at the first step that did not finish, without repeating a finished step or asking the key again', async () => {
    const steps: SetupStep[] = []
    const interrupt: SetupHooks = {
      afterStep(step) {
        steps.push(step)
        if (step === sectionStep('key')) throw new Error('interrupted')
      },
    }
    const typed: readonly Answer[] = ['quick', 'prompt', 'typed-key-value', 'safer', 'save', false]
    await expect(setup(asked(typed), {}, interrupt)).rejects.toThrow('interrupted')
    expect(steps).toEqual([PROFILE_STEP, sectionStep('privacy'), sectionStep('import'), sectionStep('key')])
    expect(readProgress(runDirectory(home, PROFILE))?.completed).toEqual(steps)
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'typed-key-value' } })

    recording.asked.length = 0
    const resumed: SetupStep[] = []
    // The key was stored before the interruption, so a resume that asks for it again fails on the empty script.
    expect(await setup(asked([false]), {}, { afterStep: step => void resumed.push(step) })).toBe(EXIT.ok)
    expect(resumed).toEqual([sectionStep('prompts'), sectionStep('background'), sectionStep('profile')])
    expect(recording.asked.filter(question => question.startsWith('secret'))).toEqual([])
    expect(lines.join('')).toContain('Resuming the setup')

    const clean = join(osHome, 'clean', '.delo')
    await ensureHomeTree(clean, PROFILE)
    expect(await setup(asked(typed), {}, undefined, clean)).toBe(EXIT.ok)
    expect(writesOf(home)).toEqual(writesOf(clean))
  })

  it('asks for the key again when the run stopped before the key section, and a non-terminal resume refuses', async () => {
    const interrupt: SetupHooks = { afterStep: (step) => { if (step === PROFILE_STEP) throw new Error('interrupted') } }
    await expect(setup(asked(['quick', 'prompt', 'typed-key-value', 'safer', 'save', false]), {}, interrupt)).rejects.toThrow('interrupted')
    await expect(setup({ kind: 'yes' })).rejects.toThrow('needs the model key')
    recording.asked.length = 0
    expect(await setup(asked(['typed-key-value', false]), {})).toBe(EXIT.ok)
    expect(recording.asked.filter(question => question.startsWith('secret'))).toEqual(['secret: DeepSeek API key'])
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'typed-key-value' } })
  })

  it('records every step in order when nothing interrupts', async () => {
    const steps: SetupStep[] = []
    expect(await setup({ kind: 'yes' }, undefined, { afterStep: step => void steps.push(step) })).toBe(EXIT.ok)
    expect(steps).toEqual([PROFILE_STEP, ...['privacy', 'import', 'key', 'prompts', 'background', 'profile'].map(sectionStep)])
    expect(existsSync(join(runDirectory(home, PROFILE), 'setup-progress.json'))).toBe(false)
    expect(statSync(join(profileDirectory(home, PROFILE), 'setup-answers.json')).mode & 0o777).toBe(0o600)
  })
})

describe('the run record', () => {
  it('refuses a record that is not one setup wrote, naming the file', () => {
    const runDir = runDirectory(home, PROFILE)
    writeFileSync(join(runDir, PROGRESS_FILENAME), 'not json')
    expect(() => readProgress(runDir)).toThrow('is not a setup record; remove it to set up again')
    writeFileSync(join(runDir, PROGRESS_FILENAME), JSON.stringify({ version: 1, answers: { schemaVersion: 1, studioAdditions: true }, completed: [] }))
    expect(() => readProgress(runDir)).toThrow('is not a setup record; remove it to set up again')
  })
})
