import { existsSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR } from '@deepseek-ai/dsh/profile-boot'
import * as UpdateCheck from '@delorun/bundle-local/update-check'
import { ensureHomeTree, runDirectory } from '@delorun/home'
import { PROFILE_STEP, PROGRESS_FILENAME, readProgress, sectionStep, writeProgress, type SetupStep } from '../../src/setup/progress.ts'
import { runSection, runSetup, type SetupForm, type SetupHooks, type SetupRequest } from '../../src/setup/index.ts'
import { CliError, EXIT } from '../../src/exit.ts'
import { hasCliProfile, profileDirectory } from '../../src/profile.ts'
import { scriptedPrompter, type Answer, type Recording } from './support.ts'

const PROFILE = 'default'
const KEY = 'fixture-key-value'

let osHome: string
let home: string
let lines: string[]
let output: { stdout: (text: string) => void, stderr: (text: string) => void }
let recording: Recording

/** Each setup run adds Delorun's bundle to the profile with a pnpm install, which takes seconds on a loaded host. */
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
 * @param root - the Delorun home.
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
 * @param root - the Delorun home.
 * @returns the promise of the exit code.
 */
function setup(form: SetupForm, env: Record<string, string | undefined> = { DEEPSEEK_API_KEY: KEY }, hooks?: SetupHooks, root: string = home, extra: Partial<SetupRequest> = {}) {
  return runSetup({ home: root, profile: PROFILE, output, env, form, keyCheck: () => Promise.resolve({ ok: true }), portIsFree: () => Promise.resolve(true), ...(hooks === undefined ? {} : { hooks }), ...extra })
}

/** The `--provider deepseek-official` flags. */
const DEEPSEEK_CHOICE: Partial<SetupRequest> = { providerChoice: { id: 'deepseek-official', model: undefined, baseURL: undefined, keyEnv: undefined } }

/**
 * @param script - the answers in order.
 * @returns the interactive form that plays them.
 */
function asked(script: readonly Answer[]): SetupForm {
  return { kind: 'interactive', prompter: scriptedPrompter(script, recording) }
}

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-setup-')))
  home = join(osHome, '.delorun')
  await ensureHomeTree(home, PROFILE)
  lines = []
  recording = { screen: [], asked: [] }
  output = { stdout: text => void lines.push(text), stderr: text => void lines.push(text) }
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

/** The main flow's one question on a home without a stock home: no phone. */
const NO_PHONE: readonly Answer[] = ['no']

describe('setup forms', { timeout: SETUP_TIMEOUT_MS }, () => {
  it('interactive and --yes runs produce identical profile writes', async () => {
    const interactiveHome = join(osHome, 'interactive', '.delorun')
    await ensureHomeTree(interactiveHome, PROFILE)
    expect(await setup(asked(NO_PHONE), {}, undefined, interactiveHome)).toBe(EXIT.ok)

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
    expect(lines.join('')).toContain('Delorun has no telemetry of its own.')
    expect(lines.join('')).toContain('You can turn them on later in Settings → Safety → Privacy.')
    const patch = readFileSync(join(profileDirectory(home, PROFILE), 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toMatch(/reach|forward/i)
    expect(parse(patch)).toHaveLength(4)
  })

  it('takes the --yes answers when the questions have no terminal, and writes the same profile', async () => {
    expect(await setup({ kind: 'interactive' }, {})).toBe(EXIT.ok)
    expect(hasCliProfile(home, PROFILE)).toBe(true)
    const yesHome = join(osHome, 'yes', '.delorun')
    await ensureHomeTree(yesHome, PROFILE)
    expect(await setup({ kind: 'yes' }, {}, undefined, yesHome)).toBe(EXIT.ok)
    expect(writesOf(home).filter(line => !line.includes('setup-answers.json'))).toEqual(writesOf(yesHome).filter(line => !line.includes('setup-answers.json')))
    expect(lines.join('')).toContain('Delorun has no telemetry of its own.')
  })

  it('--yes without --provider sets up no provider, writes no provider row and says how to add one', async () => {
    expect(await setup({ kind: 'yes' }, {})).toBe(EXIT.ok)
    expect(lines.join('')).toContain('No model provider was set up now, and no provider setting changed. New chats still start on deepseek-flash from DeepSeek')
    expect(readFileSync(join(profileDirectory(home, PROFILE), 'cordis.patch.yml'), 'utf8')).not.toMatch(/llm-|agent-default-model/u)
    expect(existsSync(join(home, '.credentials.yaml'))).toBe(false)
  })

  it('--yes --provider stops with a typed error naming the variable when the key is unset', async () => {
    const error = await setup({ kind: 'yes' }, {}, undefined, home, DEEPSEEK_CHOICE).catch((caught: unknown) => caught)
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
  it('resumes at the first step that did not finish, without repeating a finished step or asking the phone question again', async () => {
    const steps: SetupStep[] = []
    const interrupt: SetupHooks = {
      afterStep(step) {
        steps.push(step)
        if (step === sectionStep('reach')) throw new Error('interrupted')
      },
    }
    await expect(setup(asked(NO_PHONE), {}, interrupt)).rejects.toThrow('interrupted')
    expect(steps).toEqual([PROFILE_STEP, sectionStep('privacy'), sectionStep('reach')])
    expect(readProgress(runDirectory(home, PROFILE))?.completed).toEqual(steps)

    recording.asked.length = 0
    const resumed: SetupStep[] = []
    // The phone answer was recorded before the interruption, so a resume that asks it again fails on the empty script.
    expect(await setup(asked([]), {}, { afterStep: step => void resumed.push(step) })).toBe(EXIT.ok)
    expect(resumed).toEqual(['changes-protection', 'import', 'key', 'prompts', 'background', 'autostart', 'profile'].map(sectionStep))
    expect(recording.asked).toEqual([])
    expect(lines.join('')).toContain('Resuming the setup')

    const clean = join(osHome, 'clean', '.delorun')
    await ensureHomeTree(clean, PROFILE)
    expect(await setup(asked(NO_PHONE), {}, undefined, clean)).toBe(EXIT.ok)
    expect(writesOf(home)).toEqual(writesOf(clean))
  })

  it('asks for the key again when a recorded run chose to type it and stopped before the key section, and a non-terminal resume refuses', async () => {
    const interrupt: SetupHooks = { afterStep: (step) => { if (step === PROFILE_STEP) throw new Error('interrupted') } }
    await expect(setup(asked(NO_PHONE), {}, interrupt)).rejects.toThrow('interrupted')
    // The main flow does not ask for a key; a run record from a flow that did (a --config document or an earlier release) is resumed the same way.
    const progress = readProgress(runDirectory(home, PROFILE))
    if (progress === undefined) throw new Error('the interrupted run left no record')
    writeProgress(runDirectory(home, PROFILE), { ...progress, answers: { ...progress.answers, modelProvider: { id: 'deepseek-official', credential: { source: 'prompt' }, baseURL: null, model: null } } })
    await expect(setup({ kind: 'yes' })).rejects.toThrow('needs the model key')
    recording.asked.length = 0
    expect(await setup(asked(['typed-key-value']), {})).toBe(EXIT.ok)
    expect(recording.asked.filter(question => question.startsWith('secret'))).toEqual(['secret: DeepSeek API key'])
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'typed-key-value' } })
  })

  it('records every step in order when nothing interrupts', async () => {
    const steps: SetupStep[] = []
    expect(await setup({ kind: 'yes' }, undefined, { afterStep: step => void steps.push(step) })).toBe(EXIT.ok)
    expect(steps).toEqual([PROFILE_STEP, ...['privacy', 'reach', 'changes-protection', 'import', 'key', 'prompts', 'background', 'autostart', 'profile'].map(sectionStep)])
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

describe('the first start after setup', { timeout: SETUP_TIMEOUT_MS }, () => {
  /**
   * The release-check row as a start composes the profile: the bundles' layers, then the profile's own patch.
   * @param root - the Delorun home.
   * @returns the composed row.
   */
  function composedUpdateCheckRow(root: string = home): ReturnType<typeof composeEntries>[number] | undefined {
    const profile = loadProfile('delorun', PROFILE, INSTALL_ANCHOR, root)
    expect(profile.skippedBundles).toEqual([])
    return composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]).find(row => row.id === 'delorun-update-check')
  }

  /**
   * Mount the release-check plugin with a row's config, as the Loader mounts the row.
   * @param config - the composed row's config.
   * @returns whether the row provided the check's service.
   */
  async function mountsCheck(config: Record<string, unknown> | undefined): Promise<boolean> {
    const ctx = new Context()
    try {
      await ctx.plugin(UpdateCheck, config as never)
      return ctx.get('delorunUpdateCheck') !== undefined
    } finally {
      await ctx.fiber.dispose()
    }
  }

  it('update-notice-off-at-first-start: delorun setup privacy turning the check off puts the row off in the profile the first start composes, so no check mounts', async () => {
    expect(await setup(asked(NO_PHONE), {})).toBe(EXIT.ok)
    const again: SetupRequest = { home, profile: PROFILE, output, env: {}, form: asked(['off']) }
    expect(await runSection(again, 'privacy')).toBe(EXIT.ok)
    const row = composedUpdateCheckRow()
    expect(row).toEqual({ id: 'delorun-update-check', name: '@delorun/bundle-local/update-check', config: { intervalHours: 24, timeoutSeconds: 15, enabled: false } })
    expect(await mountsCheck(row?.config)).toBe(false)
  })

  it('picks the next free studio port when the default one is in use, and says which', async () => {
    const taken = new Set([3080, 3081])
    const lines: string[] = []
    const request: Partial<SetupRequest> = { portIsFree: port => Promise.resolve(!taken.has(port)), output: { stdout: text => void lines.push(text), stderr: () => undefined } }
    expect(await setup({ kind: 'yes' }, undefined, undefined, home, request)).toBe(EXIT.ok)
    expect(lines.join('')).toContain('! Port 3080 is in use, so the studio will use 3082. Change it later with: delorun setup profile')
    expect(readFileSync(join(home, 'profiles', PROFILE, 'cordis.patch.yml'), 'utf8')).toContain('port: 3082')
  })

  it('refuses, naming the range, when no studio port near the default is free', async () => {
    const error = await setup({ kind: 'yes' }, undefined, undefined, home, { portIsFree: () => Promise.resolve(false) }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toContain('ports 3080 to 3180 are all in use on this computer')
  })

  it('keeps the default port without a word when it is free', async () => {
    const lines: string[] = []
    expect(await setup({ kind: 'yes' }, undefined, undefined, home, { output: { stdout: text => void lines.push(text), stderr: () => undefined } })).toBe(EXIT.ok)
    expect(lines.join('')).not.toContain('is in use')
  })

  it('update-notice-off-at-first-start: --yes --no-update-check turns it off the same way, and a setup that keeps it on mounts the check', async () => {
    const onHome = join(osHome, 'on', '.delorun')
    await ensureHomeTree(onHome, PROFILE)
    expect(await setup({ kind: 'yes' }, undefined, undefined, onHome)).toBe(EXIT.ok)
    const on = composedUpdateCheckRow(onHome)
    expect(on?.config).toEqual({ enabled: true, intervalHours: 24, timeoutSeconds: 15 })
    expect(await mountsCheck(on?.config)).toBe(true)

    expect(await runSetup({ home, profile: PROFILE, output, env: { DEEPSEEK_API_KEY: KEY }, form: { kind: 'yes' }, noUpdateCheck: true, portIsFree: () => Promise.resolve(true) })).toBe(EXIT.ok)
    const off = composedUpdateCheckRow()
    expect(off?.config).toEqual({ intervalHours: 24, timeoutSeconds: 15, enabled: false })
    expect(await mountsCheck(off?.config)).toBe(false)
  })
})
