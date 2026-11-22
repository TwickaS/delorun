/**
 * Setup's `import` section: asked only when the stock home is a directory and
 * not a link to one, and the Delorun home holds no chat; its question shown after
 * a summary of what copies and what stays behind, with Yes, Later and the full list; its
 * answer applied by carrying out exactly the plan that summary came from, with the
 * data alone; and a refusal reported with its code. A setup run with a stock home asks it
 * after the phone question.
 */
import { chmodSync, existsSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SETUP_DEFAULTS, type SetupAnswers } from '@delorun/contract-setup-answers'
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { ensureHomeTree } from '@delorun/home'
import { CliError, EXIT } from '../../src/exit.ts'
import { withHomeExclusive } from '../../src/home-exclusion.ts'
import { homeHasChats, importSection } from '../../src/import-home/section.ts'
import { profileDirectory } from '../../src/profile.ts'
import { runSetup } from '../../src/setup/index.ts'
import { defaultRegistry, type Draft, type SectionEnvironment } from '../../src/setup/sections.ts'
import { BACK, stepIO } from '../../src/setup/steps.ts'
import { scriptedPrompter, type Answer, type Recording } from '../setup/support.ts'
import { chat, chatLog, fresh, put, removeScratch, snapshot, STOCK_SECRET, stockHome } from './support.ts'

let person: string
let home: string
let recording: Recording

beforeEach(async () => {
  person = realpathSync(fresh('section'))
  home = join(person, '.delorun')
  await ensureHomeTree(home, 'default')
  recording = { screen: [], asked: [] }
})

afterEach(() => {
  removeScratch()
})

const section = importSection({
  delorunBundles: ['@delorun/bundle-local'],
  exclusive: (target, profile, run) => withHomeExclusive({ home: target, profile, command: 'setup', instead: '' }, run, { probe: () => async () => 'answered', runtime: brandString<RuntimeVersion>('0.0.0') }),
})

/**
 * What the section may look at.
 * @param env - the environment.
 * @returns the environment of a first run.
 */
function environment(env: Record<string, string | undefined> = { HOME: person }): SectionEnvironment {
  return { env, home, profile: 'default', profileExists: false, profileNameTaken: () => false, checkKey: async () => ({ ok: true }), checkEnvironmentKey: false, portIsFree: async () => true, hasSavedKey: () => false }
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

/** The question the section asks about the two chats of the fixture. */
const QUESTION = 'select: Copy your 2 DeepSeek Harness chats?'

describe('setup\'s import section', () => {
  it('applies only when the stock home is a directory and the Delorun home holds no chat', () => {
    expect(section.appliesTo(environment({}))).toBe(false)
    expect(section.appliesTo(environment())).toBe(false)
    put(person, '.dsh', 'a file')
    expect(section.appliesTo(environment())).toBe(false)
    const other = fresh('other')
    stockHome(join(other, '.dsh'))
    expect(section.appliesTo(environment({ HOME: other }))).toBe(true)
    put(home, 'sessions/--p--/s9/session.v4.jsonl.zstd', 'a Delorun chat')
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

  it('shows a summary of what copies and what stays behind, and asks Copy your N chats? with Yes preselected', async () => {
    const source = join(person, '.dsh')
    stockHome(source)
    chat(source, '--work--', 's3', '/work', true)
    expect(await ask(['yes'])).toEqual({ answers: { importStockHome: true }, status: 'answered' })
    const screen = recording.screen.join('\n')
    expect(recording.screen).toContain('# Your DeepSeek Harness home')
    expect(screen).toContain('  Will copy:    2 chats · 1 attachment · 1 workspace\n')
    expect(screen).toMatch(/ {2}Stays behind: 1 unfinished chat · \d+ locks, caches and packages\n/u)
    expect(screen).toContain('  Your DeepSeek Harness folder is only read.\n')
    expect(screen).toContain(`  Full list: ${join(home, 'import-preview.txt')}\n`)
    expect(screen).not.toContain('"web"')
    expect(screen).not.toContain(STOCK_SECRET)
    expect(recording.asked).toEqual([QUESTION])
    expect(recording.screen).toContain('? Copy your 2 DeepSeek Harness chats?')
    expect(recording.screen).toContain('> Yes')
    expect(recording.screen).toContain('  Later (delorun import-home)')
    expect(recording.screen).toContain('  Show what stays behind')
    expect(await ask(['← back'])).toBe(BACK)
  })

  it('writes the full list to import-preview.txt in the Delorun home, readable by the person alone', async () => {
    stockHome(join(person, '.dsh'))
    await ask(['later'])
    const file = join(home, 'import-preview.txt')
    expect(readFileSync(file, 'utf8')).toContain('Chats: 2 chats to copy')
    expect(readFileSync(file, 'utf8')).toContain('What stays behind, and why:')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    writeFileSync(file, 'an earlier list', { mode: 0o644 })
    chmodSync(file, 0o644)
    await ask(['later'])
    expect(readFileSync(file, 'utf8')).toContain('Chats: 2 chats to copy')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('says Stays behind: nothing when the stock home leaves nothing out', async () => {
    const source = join(person, '.dsh')
    chat(source, '--work--', 's1', '/work')
    await ask(['later'])
    expect(recording.screen.join('\n')).toContain('  Stays behind: nothing\n')
  })

  it('answers no and copies nothing on Later, and says where the command is', async () => {
    stockHome(join(person, '.dsh'))
    expect(await ask(['later'])).toEqual({ answers: { importStockHome: false }, status: 'answered' })
    expect(recording.screen).toContain('  Later (delorun import-home)')
    expect(await section.apply(context(), SETUP_DEFAULTS)).toBeUndefined()
    expect(existsSync(join(home, 'sessions'))).toBe(false)
  })

  it('shows the full list on Show what stays behind and then asks the same question again', async () => {
    stockHome(join(person, '.dsh'))
    expect(await ask(['show', 'yes'])).toEqual({ answers: { importStockHome: true }, status: 'answered' })
    expect(recording.asked).toEqual([QUESTION, QUESTION])
    expect(recording.screen).toContain('# Everything the import covers')
    expect(recording.screen.join('\n')).toContain('  What stays behind, and why:')
  })

  it('shows why a stock home cannot be imported instead of asking', async () => {
    put(person, '.dsh/notes.txt', 'not a stock home')
    expect(await ask([])).toEqual({ answers: { importStockHome: false }, status: 'seen' })
    expect(recording.screen.join('\n')).toContain('cannot be imported (DSH_IMPORT_SOURCE_UNUSABLE)')
    stockHome(join(person, '.dsh'))
    put(home, 'sessions/--other--/s1/session.v4.jsonl.zstd', 'another chat with the same id')
    expect(await ask([])).toEqual({ answers: { importStockHome: false }, status: 'seen' })
    expect(recording.screen.join('\n')).toContain('the Delorun home already holds the chat "s1" with other content')
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

  it('refuses to write when the Delorun home gained a chat after the preview, rather than merging it unasked', async () => {
    stockHome(join(person, '.dsh'))
    await ask(['yes'])
    put(home, 'sessions/--other--/d1/session.v4.jsonl.zstd', 'a chat started after the preview')
    const refused = await section.apply(context(), YES).catch((error: unknown) => error)
    expect((refused as CliError).message).toContain('the Delorun home gained chats after the preview; run delorun import-home --merge')
    expect(existsSync(join(home, 'storages/workspace.json'))).toBe(false)
  })

  it('refuses to write a plan it did not show, as in a resumed run, and one the person answered no to', async () => {
    stockHome(join(person, '.dsh'))
    const resumed = importSection({ delorunBundles: ['@delorun/bundle-local'] })
    const refused = await resumed.apply(context(), YES).catch((error: unknown) => error)
    expect((refused as CliError).message).toBe('delorun setup: the DeepSeek Harness home was not imported, because this run did not show what it copies; run delorun import-home')
    await ask(['later'])
    expect(((await section.apply(context(), YES).catch((error: unknown) => error)) as CliError).message).toContain('did not show what it copies')
    expect(existsSync(join(home, 'sessions'))).toBe(false)
  })

  it('reports a refused import with its code', async () => {
    stockHome(join(person, '.dsh'))
    await ask(['yes'])
    put(home, 'storages/workspace.json', 'a list the Delorun home wrote after the preview')
    const refused = await section.apply(context(), YES).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(CliError)
    expect((refused as CliError).message).toContain('the DeepSeek Harness home was not imported (DSH_IMPORT_TARGET_REFUSED)')
    expect(readFileSync(join(home, 'storages/workspace.json'), 'utf8')).toBe('a list the Delorun home wrote after the preview')
    expect(existsSync(join(home, 'sessions/--work--'))).toBe(false)
  })

  it('passes on a failure that is not a refusal', async () => {
    stockHome(join(person, '.dsh'))
    const failing = importSection({ delorunBundles: [], exclusive: () => Promise.reject(new Error('the lock failed')) })
    await failing.ask(stepIO(scriptedPrompter(['yes'], recording), true), { phase: 'main', answers: SETUP_DEFAULTS, secret: undefined }, environment())
    await expect(failing.apply(context(), YES)).rejects.toThrow('the lock failed')
  })

  it('is asked after the phone question in the main flow and copies the chats before the profile is written', async () => {
    stockHome(join(person, '.dsh'))
    const code = await runSetup({
      home,
      profile: 'default',
      output: { stdout: text => void recording.screen.push(text.trim()), stderr: () => undefined },
      env: { HOME: person, DEEPSEEK_API_KEY: 'env-key' },
      form: { kind: 'interactive', prompter: scriptedPrompter(['no', 'yes'], recording) },
      registry: defaultRegistry(),
      keyCheck: async () => ({ ok: true }),
      portIsFree: async () => true,
    })
    expect(code).toBe(EXIT.ok)
    expect(recording.asked).toEqual(['select: Use it from your phone too?', QUESTION])
    expect(readFileSync(join(home, 'sessions/_no-cwd/s2/session.v4.jsonl.zstd'))).toEqual(chatLog('s2', undefined))
    expect(existsSync(join(home, 'profiles/web/package.json'))).toBe(false)
    const record = JSON.parse(readFileSync(join(profileDirectory(home, 'default'), 'setup-answers.json'), 'utf8')) as SetupAnswers
    expect(record.importStockHome).toBe(true)
    expect(record.sections.slice(0, 3)).toEqual([{ id: 'privacy', status: 'seen' }, { id: 'reach', status: 'answered' }, { id: 'changes-protection', status: 'skipped' }])
    expect(record.sections).toContainEqual({ id: 'import', status: 'answered' })
  }, 120_000)
})
