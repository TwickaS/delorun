/**
 * The Phone powers choice of `delorun setup` (C14, "Phone powers"): asked with remote access, never without it; `--yes`
 * takes it from `--phone-powers` and a `--config` document from `phonePowers`; every form records it as the person's
 * choice, and a form that names no level leaves the home's level as it is.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { phonePowersPath, readPhonePowers, recordUpgradePhonePowers, writePhonePowers } from '@delorun/home-auth'
import { ensureHomeTree } from '@delorun/home'
import { CliError, EXIT } from '../../src/exit.ts'
import { phonePowersFromFlag, runSetup, type SetupRequest } from '../../src/setup/index.ts'
import { readAnswersDocument } from '../../src/setup/answers.ts'
import { scriptedPrompter, type Answer, type Recording } from './support.ts'

vi.mock('../../src/delorun-bundles.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/delorun-bundles.ts')>(),
  linkDelorunBundles: vi.fn(() => Promise.resolve()),
}))

const PROFILE = 'default'
const TIMEOUT_MS = 60_000
/** A terminal run that turns remote access off under More settings and leaves protection off. */
const NO_REMOTE: readonly Answer[] = ['local', 'deepseek-official', 'environment', 'safer', 'more', 'on', 'yes', 'no', 'no', 'default', '3080', 'save']
const DOCUMENT = { schemaVersion: 4, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' }, baseURL: null, model: null }, prompts: 'safer', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }

let osHome: string
let home: string
let recording: Recording

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-setup-powers-')))
  home = join(osHome, '.delorun')
  await ensureHomeTree(home, PROFILE)
  recording = { screen: [], asked: [] }
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

/**
 * @param form - how setup gets its answers.
 * @param extra - more of the request.
 * @returns the request.
 */
function request(form: SetupRequest['form'], extra: Partial<SetupRequest> = {}): SetupRequest {
  return {
    home, profile: PROFILE, env: { DEEPSEEK_API_KEY: 'env-key' }, form,
    output: { stdout: text => void recording.screen.push(text), stderr: () => undefined },
    keyCheck: () => Promise.resolve({ ok: true }), portIsFree: () => Promise.resolve(true),
    ...extra,
  }
}

/** The home-auth secrets directory. */
const secrets = (): string => join(home, 'secrets', 'home-auth')

describe('the Phone powers choice in setup', { timeout: TIMEOUT_MS }, () => {
  it('is not asked when remote access is off, and the home keeps no level', async () => {
    expect(await runSetup(request({ kind: 'interactive', prompter: scriptedPrompter(NO_REMOTE, recording) }))).toBe(EXIT.ok)
    expect(recording.asked.some(question => question.includes('unlocked phone'))).toBe(false)
    expect(existsSync(phonePowersPath(secrets()))).toBe(false)
  })

  it('--yes records the level --phone-powers names as chosen, and leaves the home as it is without it', async () => {
    expect(await runSetup(request({ kind: 'yes' }))).toBe(EXIT.ok)
    expect(existsSync(phonePowersPath(secrets()))).toBe(false)
    rmSync(join(home, 'profiles', PROFILE), { recursive: true })
    expect(await runSetup(request({ kind: 'yes' }, { phonePowersAnswer: 'full' }))).toBe(EXIT.ok)
    expect(await readPhonePowers(secrets())).toEqual({ level: 'full', chosen: true })
  })

  it('a --config document names the level in phonePowers, and refuses another value', async () => {
    const path = join(osHome, 'answers.json')
    writeFileSync(path, JSON.stringify({ ...DOCUMENT, phonePowers: 'careful' }))
    expect(readAnswersDocument(path).phonePowers).toBe('careful')
    expect(await runSetup(request({ kind: 'config', path }))).toBe(EXIT.ok)
    expect(await readPhonePowers(secrets())).toEqual({ level: 'careful', chosen: true })
    writeFileSync(path, JSON.stringify(DOCUMENT))
    expect(readAnswersDocument(path).phonePowers).toBeNull()
    writeFileSync(path, JSON.stringify({ ...DOCUMENT, phonePowers: 'everything' }))
    expect(() => readAnswersDocument(path)).toThrow('phonePowers is not a value')
  })

  it('an unattended run for a new profile cannot choose Full on a home that already has a level', async () => {
    // Pins the per-home level against a per-profile run: a script must not widen what paired phones may do.
    const other = 'other'
    await ensureHomeTree(home, other)
    mkdirSync(secrets(), { recursive: true, mode: 0o700 })
    const path = join(osHome, 'answers.json')
    writeFileSync(path, JSON.stringify({ ...DOCUMENT, phonePowers: 'full' }))
    const refused = { exit: EXIT.failed, message: expect.stringContaining('run delorun devices powers full in a terminal') }
    for (const write of [() => writePhonePowers(secrets(), 'careful'), () => recordUpgradePhonePowers(secrets(), 'careful')]) {
      rmSync(phonePowersPath(secrets()), { force: true })
      const before = await write()
      await expect(runSetup(request({ kind: 'yes' }, { profile: other, phonePowersAnswer: 'full' }))).rejects.toMatchObject(refused)
      await expect(runSetup(request({ kind: 'config', path }, { profile: other }))).rejects.toMatchObject(refused)
      expect(await readPhonePowers(secrets())).toEqual(before)
    }
    rmSync(phonePowersPath(secrets()))
    writeFileSync(phonePowersPath(secrets()), 'not json', { mode: 0o600 })
    await expect(runSetup(request({ kind: 'yes' }, { profile: other, phonePowersAnswer: 'full' }))).rejects.toMatchObject(refused)
    // Careful never widens, and Full over Full changes nothing.
    rmSync(phonePowersPath(secrets()))
    await writePhonePowers(secrets(), 'full')
    expect(await runSetup(request({ kind: 'yes' }, { profile: other, phonePowersAnswer: 'full' }))).toBe(EXIT.ok)
    expect(await readPhonePowers(secrets())).toEqual({ level: 'full', chosen: true })
    rmSync(join(home, 'profiles', other), { recursive: true })
    expect(await runSetup(request({ kind: 'yes' }, { profile: other, phonePowersAnswer: 'careful' }))).toBe(EXIT.ok)
    expect(await readPhonePowers(secrets())).toEqual({ level: 'careful', chosen: true })
  })

  it('takes --phone-powers only with --yes and only a level', () => {
    expect(phonePowersFromFlag(undefined, true)).toBeUndefined()
    expect(phonePowersFromFlag('full', true)).toBe('full')
    for (const [value, yes, text] of [['full', false, '--phone-powers applies to --yes'], ['everything', true, '--phone-powers takes careful or full']] as const) {
      const error = (() => { try { phonePowersFromFlag(value, yes) } catch (caught) { return caught } return undefined })()
      expect(error).toBeInstanceOf(CliError)
      expect(error).toMatchObject({ exit: EXIT.usage, message: expect.stringContaining(text) })
    }
  })
})
