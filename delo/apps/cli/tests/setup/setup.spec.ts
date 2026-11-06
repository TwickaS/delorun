import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureHomeTree, runDirectory } from '@delo/home'
import { DOCKER_NOT_ENFORCED_LABEL } from '../../src/setup/interactive.ts'
import { readAnswersDocument, yesAnswers } from '../../src/setup/answers.ts'
import { dockerConnectEnforced, probeSandboxDialect, type SandboxDialect } from '../../src/setup/dialect.ts'
import { readProgress, SETUP_STEPS, type SetupStep } from '../../src/setup/progress.ts'
import { runSetup, type SetupForm, type SetupHooks } from '../../src/setup/index.ts'
import { SetupCancelled, type Prompter, type PromptOption } from '../../src/setup/prompts.ts'
import { CliError, EXIT } from '../../src/exit.ts'
import { hasCliProfile, profileDirectory } from '../../src/profile.ts'

const PROFILE = 'default'
const KEY = 'fixture-key-value'

let osHome: string
let home: string
let lines: string[]
let output: { stdout: (text: string) => void, stderr: (text: string) => void }

/**
 * A prompter whose answers come from a table: each question is answered by the first key its message contains.
 * @param answers - answers by a fragment of the question.
 * @param secret - the key the secret question returns, or `undefined` to fail when it is asked.
 * @returns the prompter and what it was asked.
 */
function scripted(answers: Record<string, string | boolean>, secret?: string): {
  prompter: Prompter
  selects: { message: string, options: readonly PromptOption<string>[], initial: string }[]
  confirms: { message: string, initial: boolean }[]
  secrets: string[]
  notes: string[]
} {
  const selects: { message: string, options: readonly PromptOption<string>[], initial: string }[] = []
  const confirms: { message: string, initial: boolean }[] = []
  const secrets: string[] = []
  const notes: string[] = []
  /**
   * @param message - the question.
   * @returns the scripted answer for it.
   */
  const pick = (message: string): string | boolean => {
    const key = Object.keys(answers).find(fragment => message.includes(fragment))
    if (key === undefined) throw new Error(`no scripted answer for: ${message}`)
    return answers[key] as string | boolean
  }
  const prompter: Prompter = {
    select<T extends string>(message: string, options: readonly PromptOption<T>[], initial: T): Promise<T> {
      selects.push({ message, options, initial })
      const value = pick(message)
      const chosen = options.find(option => option.value === value)
      if (chosen === undefined) throw new Error(`answer ${String(value)} is not an option of: ${message}`)
      return Promise.resolve(chosen.value)
    },
    confirm(message, initial) {
      confirms.push({ message, initial })
      const value = pick(message)
      if (typeof value !== 'boolean') throw new Error(`confirm answered with a non-boolean for: ${message}`)
      return Promise.resolve(value)
    },
    secret(message) {
      secrets.push(message)
      if (secret === undefined) return Promise.reject(new Error('the key was asked again'))
      return Promise.resolve(secret)
    },
    note(body) {
      notes.push(body)
    },
  }
  return { prompter, selects, confirms, secrets, notes }
}

/** The answers that match `--yes`: the key from the environment, every default. */
const defaultAnswers: Record<string, string | boolean> = {
  'come from': 'environment',
  'Where do commands run': 'native',
  'studio': true,
  'other models': false,
  'desktop analytics': false,
  'session-log upload': false,
  'set up Delo': true,
}

/**
 * Every file under a directory, relative to it, with its content.
 * @param root - the directory.
 * @returns sorted `path<TAB>content` lines; a missing directory yields none.
 */
function tree(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry)
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
 * Run setup and collect its output.
 * @param form - the form.
 * @param env - the environment.
 * @param hooks - test hooks.
 * @param root - the Delo home.
 * @returns the promise of the exit code.
 */
function setup(form: SetupForm, env: Record<string, string | undefined> = { DEEPSEEK_API_KEY: KEY }, hooks?: SetupHooks, root: string = home) {
  return runSetup({ home: root, profile: PROFILE, output, env, form, ...(hooks === undefined ? {} : { hooks }) })
}

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-setup-')))
  home = join(osHome, '.delo')
  await ensureHomeTree(home, PROFILE)
  lines = []
  output = { stdout: text => void lines.push(text), stderr: text => void lines.push(text) }
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('setup answers', () => {
  it('states that Delo has no telemetry yet and that both upstream opt-ins default to No', async () => {
    const asked = scripted(defaultAnswers)
    expect(await setup({ kind: 'interactive', prompter: asked.prompter, dialect: 'bwrap' })).toBe(EXIT.ok)
    const statement = asked.notes.join('\n')
    expect(statement).toContain('Delo has no telemetry of its own.')
    expect(statement).toContain('off unless you turn them on')
    const analytics = asked.confirms.find(question => question.message.includes('desktop analytics'))
    const sessionLog = asked.confirms.find(question => question.message.includes('session-log upload'))
    expect(analytics?.initial).toBe(false)
    expect(sessionLog?.initial).toBe(false)
    const yesRoot = join(osHome, 'yes-statement', '.delo')
    await ensureHomeTree(yesRoot, PROFILE)
    expect(await setup({ kind: 'yes' }, undefined, undefined, yesRoot)).toBe(EXIT.ok)
    expect(lines.join('')).toContain('Delo has no telemetry of its own.')
  })

  it('labels Docker mode when the dialect cannot enforce docker-connect, and not when it can', async () => {
    const docker: Record<string, string> = { 'Container shape': 'S2', 'Resource preset': 'small' }
    for (const [dialect, labelled] of [['landlock', true], ['bwrap', false], ['seatbelt', false]] as const) {
      const root = join(osHome, `docker-${dialect}`, '.delo')
      await ensureHomeTree(root, PROFILE)
      const asked = scripted({ ...defaultAnswers, 'Where do commands run': 'docker', ...docker })
      await setup({ kind: 'interactive', prompter: asked.prompter, dialect }, { DEEPSEEK_API_KEY: KEY }, undefined, root)
      const option = asked.selects.find(question => question.message.includes('Where do commands run'))?.options.find(entry => entry.value === 'docker')
      expect(option?.hint).toBe(labelled ? DOCKER_NOT_ENFORCED_LABEL : undefined)
    }
  })

  it('reports Docker as the C1 label on a system without a sandbox', () => {
    expect(dockerConnectEnforced('none')).toBe(false)
    expect(dockerConnectEnforced('landlock')).toBe(false)
    expect(dockerConnectEnforced('windows-acl')).toBe(false)
  })

  it('probes the dialect: bwrap when it is on the path on Linux, Landlock otherwise, Seatbelt on macOS', () => {
    const bin = join(osHome, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'bwrap'), '')
    expect(probeSandboxDialect('linux', bin)).toBe('bwrap')
    expect(probeSandboxDialect('linux', join(osHome, 'empty'))).toBe('landlock')
    expect(probeSandboxDialect('darwin', undefined)).toBe('seatbelt')
    const unknown: SandboxDialect = probeSandboxDialect('freebsd', undefined)
    expect(unknown).toBe('none')
  })
})

describe('setup forms', () => {
  it('interactive and --yes runs produce identical profile writes', async () => {
    const interactiveHome = join(osHome, 'interactive', '.delo')
    await ensureHomeTree(interactiveHome, PROFILE)
    const asked = scripted(defaultAnswers)
    expect(await setup({ kind: 'interactive', prompter: asked.prompter, dialect: 'bwrap' }, {}, undefined, interactiveHome)).toBe(EXIT.ok)

    expect(await setup({ kind: 'yes' })).toBe(EXIT.ok)

    expect(writesOf(interactiveHome)).toEqual(writesOf(home))
    expect(JSON.parse(readFileSync(join(profileDirectory(interactiveHome, PROFILE), 'setup-answers.json'), 'utf8'))).toEqual(JSON.parse(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8')))
    expect(parse(readFileSync(join(profileDirectory(home, PROFILE), 'cordis.patch.yml'), 'utf8'))).toEqual([{ id: 'session-log-deepseek', config: { enabled: false } }])
  })

  it('writes the opt-in row only after the person turns the opt-in on in the interactive form', async () => {
    const asked = scripted({ ...defaultAnswers, 'session-log upload': true })
    expect(await setup({ kind: 'interactive', prompter: asked.prompter, dialect: 'bwrap' })).toBe(EXIT.ok)
    expect(parse(readFileSync(join(profileDirectory(home, PROFILE), 'cordis.patch.yml'), 'utf8'))).toEqual([{ id: 'session-log-deepseek', config: { enabled: true } }])
  })

  it('stores a typed key in the credentials document and never in the progress record', async () => {
    const asked = scripted({ ...defaultAnswers, 'come from': 'prompt' }, 'typed-key-value')
    expect(await setup({ kind: 'interactive', prompter: asked.prompter, dialect: 'bwrap' }, {})).toBe(EXIT.ok)
    const credentials = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    expect(parse(credentials)).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'typed-key-value' } })
    expect(statSync(join(home, '.credentials.yaml')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8')).not.toContain('typed-key-value')
  })

  it('--yes and --config leave reach and credential forwarding off', async () => {
    expect(await setup({ kind: 'yes' })).toBe(EXIT.ok)
    expect(lines.join('')).toContain('Delo has no telemetry of its own.')
    expect(lines.join('')).toContain('are off unless you turn them on here')
    const patch = readFileSync(join(profileDirectory(home, PROFILE), 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toMatch(/reach|forward/i)
    expect(yesAnswers({ DEEPSEEK_API_KEY: KEY }).reach).toEqual({ option: 'none', identityFactor: null })
    const document = join(osHome, 'answers.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 1, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, studioAdditions: true, runtime: { kind: 'native' }, reach: { option: 'none', identityFactor: null }, helpSetUpModels: false, sessionLogUpload: false, desktopAnalytics: false, importStockHome: false }))
    expect(readAnswersDocument(document).reach.option).toBe('none')
  })

  it('refuses a --config document that enables reach or an upstream opt-in, and names the field only', () => {
    const base = {
      schemaVersion: 1,
      modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } },
      studioAdditions: true,
      runtime: { kind: 'native' },
      reach: { option: 'none', identityFactor: null },
      helpSetUpModels: false,
      sessionLogUpload: false,
      desktopAnalytics: false,
      importStockHome: false,
    }
    const cases: [string, unknown, string][] = [
      ['reach', { ...base, reach: { option: 'tailscale-private', identityFactor: 'passkey' } }, 'reach.option'],
      ['session-log upload', { ...base, sessionLogUpload: true }, 'sessionLogUpload'],
      ['desktop analytics', { ...base, desktopAnalytics: true }, 'desktopAnalytics'],
    ]
    for (const [label, document, field] of cases) {
      const path = join(osHome, `${label.replace(/\W/g, '-')}.json`)
      writeFileSync(path, JSON.stringify(document))
      expect(() => readAnswersDocument(path), label).toThrow(field)
    }
  })

  it('refuses a --config document that carries a credential value, and never echoes it', () => {
    const secret = 'sk-SECRET-VALUE-1234'
    const value = { schemaVersion: 1, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY', value: secret } } }
    const named = { schemaVersion: 1, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: secret } } }
    for (const [label, document] of [['field', value], ['name', named]] as const) {
      const path = join(osHome, `${label}.json`)
      writeFileSync(path, JSON.stringify(document))
      let message = ''
      try {
        readAnswersDocument(path)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toMatch(/credential/)
      expect(message).not.toContain(secret)
    }
  })

  it('refuses an unknown answers version', () => {
    const path = join(osHome, 'version.json')
    writeFileSync(path, JSON.stringify({ schemaVersion: 2 }))
    expect(() => readAnswersDocument(path)).toThrow('schemaVersion')
  })

  it('--yes stops with a typed error naming the variable when the key is unset', async () => {
    const error = await setup({ kind: 'yes' }, {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect(String((error as Error).message)).toContain('DEEPSEEK_API_KEY')
    expect(hasCliProfile(home, PROFILE)).toBe(false)
  })

  it('a cancelled review writes nothing', async () => {
    const asked = scripted({ ...defaultAnswers, 'set up Delo': false })
    await expect(setup({ kind: 'interactive', prompter: asked.prompter, dialect: 'bwrap' })).rejects.toBeInstanceOf(SetupCancelled)
    expect(hasCliProfile(home, PROFILE)).toBe(false)
    expect(existsSync(join(runDirectory(home, PROFILE), 'setup-progress.json'))).toBe(false)
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

describe('an interrupted setup', () => {
  it('resumes at the first step that did not finish, without repeating a finished step or asking the key again', async () => {
    const steps: SetupStep[] = []
    const interrupt: SetupHooks = {
      afterStep(step) {
        steps.push(step)
        if (step === 'credential') throw new Error('interrupted')
      },
    }
    const asked = scripted({ ...defaultAnswers, 'come from': 'prompt' }, 'typed-key-value')
    await expect(setup({ kind: 'interactive', prompter: asked.prompter, dialect: 'bwrap' }, {}, interrupt)).rejects.toThrow('interrupted')
    expect(steps).toEqual(['profile', 'credential'])
    expect(readProgress(runDirectory(home, PROFILE))?.completed).toEqual(['profile', 'credential'])

    const resumed: SetupStep[] = []
    // A scripted prompter with no secret fails if the key is asked again.
    const noKey = scripted({ ...defaultAnswers, 'come from': 'prompt' })
    expect(await setup({ kind: 'interactive', prompter: noKey.prompter, dialect: 'bwrap' }, {}, { afterStep: step => void resumed.push(step) })).toBe(EXIT.ok)
    expect(resumed).toEqual(['profile-rows', 'desktop-row'])
    expect(noKey.secrets).toEqual([])
    expect(lines.join('')).toContain('Resuming the setup')

    const clean = join(osHome, 'clean', '.delo')
    await ensureHomeTree(clean, PROFILE)
    expect(await setup({ kind: 'interactive', prompter: scripted({ ...defaultAnswers, 'come from': 'prompt' }, 'typed-key-value').prompter, dialect: 'bwrap' }, {}, undefined, clean)).toBe(EXIT.ok)
    expect(writesOf(home)).toEqual(writesOf(clean))
  })

  it('asks for the key again when the run stopped before the credential step, and a non-terminal resume refuses', async () => {
    const interrupt: SetupHooks = { afterStep: (step) => { if (step === 'profile') throw new Error('interrupted') } }
    const asked = scripted({ ...defaultAnswers, 'come from': 'prompt' }, 'typed-key-value')
    await expect(setup({ kind: 'interactive', prompter: asked.prompter, dialect: 'bwrap' }, {}, interrupt)).rejects.toThrow('interrupted')
    await expect(setup({ kind: 'yes' })).rejects.toThrow('needs the model key')
    const resumed = scripted({ ...defaultAnswers, 'come from': 'prompt' }, 'typed-key-value')
    expect(await setup({ kind: 'interactive', prompter: resumed.prompter, dialect: 'bwrap' })).toBe(EXIT.ok)
    expect(resumed.secrets).toHaveLength(1)
    expect(parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'typed-key-value' } })
  })

  it('records every step in order when nothing interrupts', async () => {
    const steps: SetupStep[] = []
    expect(await setup({ kind: 'yes' }, undefined, { afterStep: step => void steps.push(step) })).toBe(EXIT.ok)
    expect(steps).toEqual([...SETUP_STEPS])
  })
})
