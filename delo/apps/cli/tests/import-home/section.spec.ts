/**
 * Setup's `import` section: asked only when the stock home is a directory and
 * not a link to one, and the Delo home holds no chat; its question shown after
 * the preview of the data, defaulting to no; its answer applied by carrying
 * out exactly the plan that preview showed, with the data alone; and a refusal
 * reported with its code. A setup run with a stock home asks it between
 * the privacy note and the key.
 */
import { existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SETUP_DEFAULTS, type SetupAnswers } from '@delo/contract-setup-answers'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { ensureHomeTree } from '@delo/home'
import { CliError, EXIT } from '../../src/exit.ts'
import { withHomeExclusive } from '../../src/home-exclusion.ts'
import { homeHasChats, importSection } from '../../src/import-home/section.ts'
import { profileDirectory } from '../../src/profile.ts'
import { runSetup } from '../../src/setup/index.ts'
import { defaultRegistry, type Draft, type SectionEnvironment } from '../../src/setup/sections.ts'
import { BACK, stepIO } from '../../src/setup/steps.ts'
import { scriptedPrompter, type Answer, type Recording } from '../setup/support.ts'
import { chatLog, fresh, put, removeScratch, snapshot, STOCK_SECRET, stockHome } from './support.ts'

let person: string
let home: string
let recording: Recording

beforeEach(async () => {
  person = realpathSync(fresh('section'))
  home = join(person, '.delo')
  await ensureHomeTree(home, 'default')
  recording = { screen: [], asked: [] }
})

afterEach(() => {
  removeScratch()
})

const section = importSection({
  deloBundles: ['@delo/bundle-local'],
  exclusive: (target, profile, run) => withHomeExclusive({ home: target, profile, command: 'setup', instead: '' }, run, { probe: () => async () => 'answered', runtime: brandString<RuntimeVersion>('0.0.0') }),
})

/**
 * What the section may look at.
 * @param env - the environment.
 * @returns the environment of a first run.
 */
function environment(env: Record<string, string | undefined> = { HOME: person }): SectionEnvironment {
  return { env, home, profile: 'default', profileExists: false, profileNameTaken: () => false, checkKey: async () => ({ ok: true }), checkEnvironmentKey: false, portIsFree: async () => true }
}

/**
 * Ask the section's question with a script.
 * @param script - the answers.
 * @param answers - the answers so far.
 * @returns what the section returned.
 */
function ask(script: readonly Answer[], answers: SetupAnswers = SETUP_DEFAULTS): ReturnType<typeof section.ask> {
  const draft: Draft = { phase: 'main', answers, secret: undefined }
  return section.ask(stepIO(scriptedPrompter(script, recording), true), draft, environment())
}

/**
 * The context the section's write runs with.
 * @param env - the environment.
 * @returns the context.
 */
function context(env: Record<string, string | undefined> = { HOME: person }): Parameters<typeof section.apply>[0] {
  return { home, env, directory: profileDirectory(home, 'default'), secret: undefined }
}

const YES = { ...SETUP_DEFAULTS, importStockHome: true }

/** The question the section asks. */
const QUESTION = 'select: Copy your DeepSeek Harness chats, attachments and workspace list? Your DeepSeek Harness folder is only read. You can also do this later with delorun import-home.'

describe('setup\'s import section', () => {
  it('applies only when the stock home is a directory and the Delo home holds no chat', () => {
    expect(section.appliesTo(environment({}))).toBe(false)
    expect(section.appliesTo(environment())).toBe(false)
    put(person, '.dsh', 'a file')
    expect(section.appliesTo(environment())).toBe(false)
    const other = fresh('other')
    stockHome(join(other, '.dsh'))
    expect(section.appliesTo(environment({ HOME: other }))).toBe(true)
    put(home, 'sessions/--p--/s9/session.v4.jsonl.zstd', 'a Delo chat')
    expect(homeHasChats(home)).toBe(true)
    expect(section.appliesTo(environment({ HOME: other }))).toBe(false)
  })

  it('is not offered when the stock home is a link, even to a real stock home', () => {
    const elsewhere = fresh('elsewhere')
    stockHome(elsewhere)
    const linked = fresh('linked')
    symlinkSync(elsewhere, join(linked, '.dsh'))
    expect(section.appliesTo(environment({ HOME: linked }))).toBe(false)
  })

  it('shows the preview of the data, names the command that copies the rest, and asks with no preselected', async () => {
    stockHome(join(person, '.dsh'))
    expect(await ask(['yes'])).toEqual({ answers: { importStockHome: true }, status: 'answered' })
    const screen = recording.screen.join('\n')
    expect(recording.screen).toContain('# Your DeepSeek Harness home')
    expect(screen).toContain('Chats: 2 chats to copy')
    expect(screen).toContain('run delorun import-home to review each and copy what you choose')
    expect(screen).not.toContain('Asked about one by one')
    expect(screen).not.toContain('"web"')
    expect(screen).not.toContain(STOCK_SECRET)
    expect(recording.asked).toEqual([QUESTION])
    expect(recording.screen).toContain('> No')
    expect(recording.screen).not.toContain('> Yes')
    recording = { screen: [], asked: [] }
    // The earlier answer does not preselect yes either: each run asks again with no preselected.
    expect(await ask(['no'], { ...YES, sections: [{ id: 'import', status: 'answered' }] })).toEqual({ answers: { importStockHome: false }, status: 'answered' })
    expect(recording.screen).toContain('> No')
    expect(await ask(['← back'])).toBe(BACK)
  })

  it('shows why a stock home cannot be imported instead of asking', async () => {
    put(person, '.dsh/notes.txt', 'not a stock home')
    expect(await ask([])).toEqual({ answers: { importStockHome: false }, status: 'seen' })
    expect(recording.screen.join('\n')).toContain('cannot be imported (DSH_IMPORT_SOURCE_UNUSABLE)')
    stockHome(join(person, '.dsh'))
    put(home, 'sessions/--other--/s1/session.v4.jsonl.zstd', 'another chat with the same id')
    expect(await ask([])).toEqual({ answers: { importStockHome: false }, status: 'seen' })
    expect(recording.screen.join('\n')).toContain('the Delo home already holds the chat "s1" with other content')
  })

  it('copies the data of the plan it showed and nothing else on a yes, writes nothing on a no, and says what it did', async () => {
    const source = join(person, '.dsh')
    stockHome(source)
    const before = snapshot(source)
    expect(await section.apply(context(), SETUP_DEFAULTS)).toBeUndefined()
    expect(existsSync(join(home, 'sessions'))).toBe(false)
    await ask(['yes'])
    const note = await section.apply(context(), YES)
    expect(note).toContain('Imported 2 chats, 1 attachment file, 1 workspace registration, 0 profiles, 0 documents, 0 skills and 0 stored keys.')
    expect(readFileSync(join(home, 'sessions/--work--/s1/session.v4.jsonl.zstd'))).toEqual(chatLog('s1', '/work'))
    for (const absent of ['.credentials.yaml', 'profiles/web', 'cordis.patch.yml', 'AGENTS.md', 'skills']) expect(existsSync(join(home, absent))).toBe(false)
    expect(snapshot(source)).toEqual(before)
    expect(section.review?.(YES)).toBe('Copy your DeepSeek Harness chats: yes')
    expect(section.review?.(SETUP_DEFAULTS)).toBe('Copy your DeepSeek Harness chats: no')
  })

  it('refuses to write when a stock file changed after the preview, and nothing lands', async () => {
    const source = join(person, '.dsh')
    stockHome(source)
    await ask(['yes'])
    writeFileSync(join(source, 'sessions/--work--/s1/session.v4.jsonl.zstd'), 'chat one, rewritten after the preview')
    const refused = await section.apply(context(), YES).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(CliError)
    expect((refused as CliError).message).toContain('the DeepSeek Harness home was not imported (DSH_IMPORT_SOURCE_CHANGED)')
    expect(existsSync(join(home, 'sessions'))).toBe(false)
    expect(existsSync(join(home, 'storages/workspace.json'))).toBe(false)
  })

  it('refuses to write when the Delo home gained a chat after the preview, rather than merging it unasked', async () => {
    stockHome(join(person, '.dsh'))
    await ask(['yes'])
    put(home, 'sessions/--other--/d1/session.v4.jsonl.zstd', 'a chat started after the preview')
    const refused = await section.apply(context(), YES).catch((error: unknown) => error)
    expect((refused as CliError).message).toContain('the Delo home gained chats after the preview; run delorun import-home --merge')
    expect(existsSync(join(home, 'storages/workspace.json'))).toBe(false)
  })

  it('refuses to write a plan it did not show, as in a resumed run, and one the person answered no to', async () => {
    stockHome(join(person, '.dsh'))
    const resumed = importSection({ deloBundles: ['@delo/bundle-local'] })
    const refused = await resumed.apply(context(), YES).catch((error: unknown) => error)
    expect((refused as CliError).message).toBe('delorun setup: the DeepSeek Harness home was not imported, because this run did not show what it copies; run delorun import-home')
    await ask(['no'])
    expect(((await section.apply(context(), YES).catch((error: unknown) => error)) as CliError).message).toContain('did not show what it copies')
    expect(existsSync(join(home, 'sessions'))).toBe(false)
  })

  it('reports a refused import with its code', async () => {
    stockHome(join(person, '.dsh'))
    await ask(['yes'])
    put(home, 'storages/workspace.json', 'a list the Delo home wrote after the preview')
    const refused = await section.apply(context(), YES).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(CliError)
    expect((refused as CliError).message).toContain('the DeepSeek Harness home was not imported (DSH_IMPORT_TARGET_REFUSED)')
    expect(readFileSync(join(home, 'storages/workspace.json'), 'utf8')).toBe('a list the Delo home wrote after the preview')
    expect(existsSync(join(home, 'sessions/--work--'))).toBe(false)
  })

  it('passes on a failure that is not a refusal', async () => {
    stockHome(join(person, '.dsh'))
    const failing = importSection({ deloBundles: [], exclusive: () => Promise.reject(new Error('the lock failed')) })
    await failing.ask(stepIO(scriptedPrompter(['yes'], recording), true), { phase: 'main', answers: SETUP_DEFAULTS, secret: undefined }, environment())
    await expect(failing.apply(context(), YES)).rejects.toThrow('the lock failed')
  })

  it('sits between the privacy note and the key in the main flow, and copies the chats before the key is asked for', async () => {
    stockHome(join(person, '.dsh'))
    const code = await runSetup({
      home,
      profile: 'default',
      output: { stdout: text => void recording.screen.push(text.trim()), stderr: () => undefined },
      env: { HOME: person, DEEPSEEK_API_KEY: 'env-key' },
      form: { kind: 'interactive', prompter: scriptedPrompter(['local', 'yes', 'deepseek-official', 'environment', 'safer', 'save'], recording) },
      registry: defaultRegistry(),
      keyCheck: async () => ({ ok: true }),
      portIsFree: async () => true,
    })
    expect(code).toBe(EXIT.ok)
    expect(recording.asked.slice(0, 3)).toEqual(['select: How will you use Delorun?', QUESTION, 'select: Which model provider should Delorun use?'])
    expect(readFileSync(join(home, 'sessions/_no-cwd/s2/session.v4.jsonl.zstd'))).toEqual(chatLog('s2', undefined))
    expect(existsSync(join(home, 'profiles/web/package.json'))).toBe(false)
    const record = JSON.parse(readFileSync(join(profileDirectory(home, 'default'), 'setup-answers.json'), 'utf8')) as SetupAnswers
    expect(record.importStockHome).toBe(true)
    expect(record.sections.slice(0, 2)).toEqual([{ id: 'privacy', status: 'seen' }, { id: 'import', status: 'answered' }])
  }, 120_000)
})
