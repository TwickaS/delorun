import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureHomeTree } from '@delorun/home'
import { DANGEROUS_PHRASE, PROMPTS_OPTIONS } from '@delorun/contract-setup-answers'
import { dangerousModeCheck } from '../../src/doctor/index.ts'
import { CliError, EXIT } from '../../src/exit.ts'
import { hasCliProfile, profileDirectory } from '../../src/profile.ts'
import { DANGEROUS_WARNING_VERSION, dangerousGrantPath, removeDangerousGrant, writeDangerousGrant } from '@delorun/plugin-permission-defaults/store'
import { DANGEROUS_ON_LINE, DANGEROUS_WARNING_LINES, dangerousModeLine, dangerousModeState, promptsFromFlags } from '../../src/setup/dangerous.ts'
import { readAnswersDocument } from '../../src/setup/answers.ts'
import { runSection, runSetup, type SetupRequest } from '../../src/setup/index.ts'
import { statusCommand } from '../../src/status.ts'
import { scriptedPrompter, type Answer, type Recording } from './support.ts'

vi.mock('../../src/delorun-bundles.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/delorun-bundles.ts')>(),
  linkDelorunBundles: vi.fn(() => Promise.resolve()),
}))

const PROFILE = 'default'
const DS = 'deepseek-official'
const TIMEOUT_MS = 60_000
const POSIX = process.platform !== 'win32'

let osHome: string
let home: string
let recording: Recording

/**
 * Set up the profile with the main flow's own answer, no phone.
 * @returns the exit code.
 */
async function setUp(): Promise<number> {
  return runSetup({
    home,
    profile: PROFILE,
    output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: text => void recording.screen.push(`stderr: ${text.trim()}`) },
    env: {},
    form: { kind: 'interactive', prompter: scriptedPrompter(['no'], recording) },
    keyCheck: () => Promise.resolve({ ok: true }),
    portIsFree: () => Promise.resolve(true),
  })
}

/**
 * Set up the profile when it is not, then answer the prompts section.
 * @param script - the answers of the prompts section, in order.
 * @returns the exit code.
 */
async function interactive(script: readonly Answer[]): Promise<number> {
  if (!hasCliProfile(home, PROFILE)) await setUp()
  recording = { screen: [], asked: [] }
  return again(script)
}

/**
 * Run one section again on the profile that is set up.
 * @param script - the answers in order.
 * @returns the exit code.
 */
async function again(script: readonly Answer[]): Promise<number> {
  const request: SetupRequest = {
    home, profile: PROFILE, env: {}, output: { stdout: text => void recording.screen.push(text.trim()), stderr: () => undefined },
    form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) },
  }
  return runSection(request, 'prompts')
}

/**
 * Run `--yes` with the prompts answer its flags chose.
 * @param promptsAnswer - the answer the flags gave, if any.
 * @returns the exit code.
 */
async function yes(promptsAnswer?: SetupRequest['promptsAnswer']): Promise<number> {
  return runSetup({
    home, profile: PROFILE, output: { stdout: () => undefined, stderr: () => undefined }, env: {}, form: { kind: 'yes' }, portIsFree: () => Promise.resolve(true),
    ...promptsAnswer === undefined ? {} : { promptsAnswer },
  })
}

/** @returns the profile's patch rows by id. */
function rows(): Map<string, Record<string, unknown>> {
  const patch = parse(readFileSync(join(profileDirectory(home, PROFILE), 'cordis.patch.yml'), 'utf8')) as { id: string, config: Record<string, unknown> }[]
  return new Map(patch.map(row => [row.id, row.config]))
}

/** @returns the recorded prompts answer. */
function recordedPrompts(): string {
  return (JSON.parse(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8')) as { prompts: string }).prompts
}

/** @returns the screen as one text. */
function screen(): string {
  return recording.screen.join('\n')
}

/**
 * Write a document as the answers file of `--config`.
 * @param document - the document's fields beyond the base ones.
 * @returns the path.
 */
function configFile(document: Record<string, unknown>): string {
  const path = join(osHome, 'answers.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 5,
    modelProvider: { id: DS, credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' }, baseURL: null, model: null },
    prompts: 'safer', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false,
    ...document,
  }))
  return path
}

const ACCEPT_DANGEROUS: readonly Answer[] = ['dangerous', 'yes', DANGEROUS_PHRASE]

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-dangerous-')))
  home = join(osHome, '.delorun')
  await ensureHomeTree(home, PROFILE)
  recording = { screen: [], asked: [] }
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(osHome, { recursive: true, force: true })
})

describe('the refusals of dangerous mode', { timeout: TIMEOUT_MS }, () => {
  it('writes no grant and no dangerous row when the person declines at the first step', async () => {
    expect(await interactive(['dangerous', 'no'])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
    expect(recordedPrompts()).toBe('safer')
    expect(rows().get('delorun-permission-defaults')).toEqual({ enabled: true, fullAccessEverywhere: false })
    expect(screen()).toContain('Dangerous mode is off: it was not confirmed. Prompts stay on Ask me first.')
    expect(recording.asked).not.toContain(`text: To confirm, type ${DANGEROUS_PHRASE} (leave empty to go back)`)
  })

  it.each([
    ['a different case', 'Full access everywhere'],
    ['a trailing space', `${DANGEROUS_PHRASE} `],
    ['a yes', 'yes'],
  ])('writes no grant when the phrase is %s', async (_name, typed) => {
    expect(await interactive(['dangerous', 'yes', typed])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
    expect(recordedPrompts()).toBe('safer')
    expect(rows().get('delorun-permission-defaults')).toEqual({ enabled: true, fullAccessEverywhere: false })
  })

  it('starts the first step on No', async () => {
    await interactive(['dangerous', 'no'])
    expect(screen()).toMatch(/\? Allow any chat to switch to full access without asking\?\n {2}Yes\n> No\n/u)
  })

  it('refuses a root user before the warning, writing nothing', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    await expect(interactive(['dangerous'])).rejects.toThrow('dangerous mode is refused when running as root')
    expect(screen()).not.toContain('Dangerous mode lets any chat')
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
  })

  it('refuses a root user again when the dangerous answer reaches the writes', async () => {
    expect(await setUp()).toBe(EXIT.ok)
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const request = (): SetupRequest => ({ home, profile: PROFILE, env: {}, output: { stdout: () => undefined, stderr: () => undefined }, form: { kind: 'interactive', prompter: scriptedPrompter(['dangerous'], recording) } })
    await expect(runSection(request(), 'prompts')).rejects.toThrow('refused when running as root')
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
  })

  it('refuses --prompts dangerous without --accept-dangerous-mode, naming the flag', () => {
    const error = (() => { try { promptsFromFlags({ prompts: 'dangerous' }, true, PROMPTS_OPTIONS) } catch (caught) { return caught } return undefined })()
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exit).toBe(EXIT.usage)
    expect((error as CliError).message).toContain('--prompts dangerous needs --accept-dangerous-mode')
  })

  it.each([
    [{ acceptDangerousMode: true }, true, '--accept-dangerous-mode needs --prompts dangerous'],
    [{ prompts: 'stock', acceptDangerousMode: true }, true, 'applies to --prompts dangerous only'],
    [{ prompts: 'dangerous', acceptDangerousMode: true }, false, 'apply to --yes'],
    [{ prompts: 'stock' }, false, 'apply to --yes'],
    [{ prompts: 'reckless' }, true, '--prompts must be one of safer, stock, dangerous'],
  ])('refuses the flags %j (yes: %s) with the usage code', (flags, yesFlag, text) => {
    expect(() => promptsFromFlags(flags, yesFlag, PROMPTS_OPTIONS)).toThrow(text)
  })

  it('refuses --prompts dangerous --accept-dangerous-mode for a root user', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    expect(() => promptsFromFlags({ prompts: 'dangerous', acceptDangerousMode: true }, true, PROMPTS_OPTIONS)).toThrow('refused when running as root')
  })

  it('keeps --yes on Ask me first and writes no grant', async () => {
    expect(await yes()).toBe(EXIT.ok)
    expect(recordedPrompts()).toBe('safer')
    expect(rows().get('delorun-permission-defaults')).toEqual({ enabled: true, fullAccessEverywhere: false })
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
  })

  it('refuses a document with prompts "dangerous" and no acceptDangerousMode, naming the field', () => {
    expect(() => readAnswersDocument(configFile({ prompts: 'dangerous' }))).toThrow('delorun setup --config: acceptDangerousMode must be true when prompts is "dangerous"')
    expect(() => readAnswersDocument(configFile({ prompts: 'dangerous', acceptDangerousMode: false }))).toThrow('acceptDangerousMode must be true')
  })

  it('refuses acceptDangerousMode on a document that does not choose dangerous, and a root user', () => {
    expect(() => readAnswersDocument(configFile({ acceptDangerousMode: true }))).toThrow('acceptDangerousMode applies to prompts "dangerous" only')
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    expect(() => readAnswersDocument(configFile({ prompts: 'dangerous', acceptDangerousMode: true }))).toThrow('refused when running as root')
  })

  it('refuses a version-3 document that carries dangerous, which has no field to accept it', () => {
    const path = join(osHome, 'v3.json')
    writeFileSync(path, JSON.stringify({ schemaVersion: 3, modelProvider: { id: DS, credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'dangerous', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false }))
    expect(() => readAnswersDocument(path)).toThrow('acceptDangerousMode must be true')
  })
})

describe('the accepted path', { timeout: TIMEOUT_MS }, () => {
  it('shows the warning, then writes the rows and the grant file', async () => {
    expect(await interactive(ACCEPT_DANGEROUS)).toBe(EXIT.ok)
    expect(rows().get('delorun-permission-defaults')).toEqual({ enabled: true, fullAccessEverywhere: true })
    expect(rows().get('delorun-instruction-consent')).toEqual({ enabled: false, approvedPluginWrites: false })
    for (const id of ['delorun-mcp-consent', 'delorun-schedule-consent']) expect(rows().get(id)).toEqual({ enabled: false })
    expect(recordedPrompts()).toBe('dangerous')
    const grant = JSON.parse(readFileSync(dangerousGrantPath(home), 'utf8')) as Record<string, unknown>
    expect(Object.keys(grant)).toEqual(['v', 'grantedAt', 'warning'])
    expect(grant).toMatchObject({ v: 1, warning: DANGEROUS_WARNING_VERSION })
    expect(new Date(grant['grantedAt'] as string).toISOString()).toBe(grant['grantedAt'])
    if (POSIX) expect(lstatSync(dangerousGrantPath(home)).mode & 0o777).toBe(0o600)
    expect(screen()).toContain('# Dangerous mode')
    for (const line of DANGEROUS_WARNING_LINES) expect(screen()).toContain(line)
  })

  it('writes the rows before the grant', async () => {
    expect(await interactive(ACCEPT_DANGEROUS)).toBe(EXIT.ok)
    const rowsTime = lstatSync(join(profileDirectory(home, PROFILE), 'cordis.patch.yml')).mtimeMs
    expect(lstatSync(dangerousGrantPath(home)).mtimeMs).toBeGreaterThanOrEqual(rowsTime)
  })

  it('accepts --yes with --prompts dangerous --accept-dangerous-mode', async () => {
    const answer = promptsFromFlags({ prompts: 'dangerous', acceptDangerousMode: true }, true, PROMPTS_OPTIONS)
    expect(await yes(answer)).toBe(EXIT.ok)
    expect(recordedPrompts()).toBe('dangerous')
    expect(existsSync(dangerousGrantPath(home))).toBe(true)
  })

  it('accepts a document with prompts "dangerous" and acceptDangerousMode true, recording neither the flag nor a different answer', async () => {
    const answers = readAnswersDocument(configFile({ prompts: 'dangerous', acceptDangerousMode: true }))
    expect(answers.prompts).toBe('dangerous')
    expect('acceptDangerousMode' in answers).toBe(false)
    expect(await runSetup({ home, profile: PROFILE, output: { stdout: () => undefined, stderr: () => undefined }, env: { DEEPSEEK_API_KEY: 'k' }, form: { kind: 'config', path: configFile({ prompts: 'dangerous', acceptDangerousMode: true }) } })).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(true)
    expect(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8')).not.toContain('acceptDangerousMode')
  })

  it('removes the grant when the person later chooses Ask me first or Ask less (like DeepSeek Harness)', async () => {
    expect(await interactive(ACCEPT_DANGEROUS)).toBe(EXIT.ok)
    expect(await again(['stock'])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
    expect(rows().get('delorun-permission-defaults')).toEqual({ enabled: false, fullAccessEverywhere: false })
    expect(await again(['dangerous', 'yes', DANGEROUS_PHRASE])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(true)
    expect(await again(['safer'])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
    expect(recordedPrompts()).toBe('safer')
  })

  it('skips the consent while the mode stays on and its grant is valid', async () => {
    expect(await interactive(ACCEPT_DANGEROUS)).toBe(EXIT.ok)
    const granted = readFileSync(dangerousGrantPath(home), 'utf8')
    recording.asked.length = 0
    expect(await again(['dangerous'])).toBe(EXIT.ok)
    expect(recording.asked.some(question => question.includes('Allow any chat'))).toBe(false)
    expect(readFileSync(dangerousGrantPath(home), 'utf8')).toBe(granted)
    expect(recordedPrompts()).toBe('dangerous')
  })

  it.each([
    ['the first confirmation', ['dangerous', 'no']],
    ['the phrase', ['dangerous', 'yes', 'nothing']],
  ])('leaves the mode off and writes no grant when %s is declined after Ask me first', async (_name, script) => {
    expect(await setUp()).toBe(EXIT.ok)
    expect(await again(script)).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
    expect(recordedPrompts()).toBe('safer')
    expect(rows().get('delorun-permission-defaults')).toEqual({ enabled: true, fullAccessEverywhere: false })
    expect(screen()).toContain('Dangerous mode is off: it was not confirmed. Prompts stay on Ask me first.')
  })

  it('writes no grant when the grant was turned off meanwhile and the consent is declined', async () => {
    expect(await interactive(ACCEPT_DANGEROUS)).toBe(EXIT.ok)
    await removeDangerousGrant(home)
    expect(await again(['dangerous', 'yes', 'nothing'])).toBe(EXIT.ok)
    expect(existsSync(dangerousGrantPath(home))).toBe(false)
    expect(recordedPrompts()).toBe('dangerous')
  })

  it('releases the permission store lock after writing and after removing the grant, and leaves a home without one alone', async () => {
    expect(await removeDangerousGrant(home)).toBe(false)
    await writeDangerousGrant(home)
    expect(existsSync(join(home, 'secrets', 'permission-defaults', 'workspaces.json.lock'))).toBe(false)
    expect(await removeDangerousGrant(home)).toBe(true)
    expect(existsSync(join(home, 'secrets', 'permission-defaults', 'workspaces.json.lock'))).toBe(false)
  })

  it.skipIf(!POSIX)('removes a symbolic link in place of the grant as a link', async () => {
    const target = join(osHome, 'elsewhere.json')
    writeFileSync(target, 'kept')
    mkdirSync(join(home, 'secrets', 'permission-defaults'), { recursive: true })
    symlinkSync(target, dangerousGrantPath(home))
    expect(await removeDangerousGrant(home)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('kept')
  })
})

describe('what start, status and doctor show', { timeout: TIMEOUT_MS }, () => {
  /** Choose dangerous mode and return the profile's directory. */
  async function chooseDangerous(): Promise<string> {
    expect(await interactive(ACCEPT_DANGEROUS)).toBe(EXIT.ok)
    return profileDirectory(home, PROFILE)
  }

  it('shows nothing while the answer is not dangerous', async () => {
    expect(await yes()).toBe(EXIT.ok)
    const directory = profileDirectory(home, PROFILE)
    expect(await dangerousModeState(home, directory)).toEqual({ kind: 'off' })
    expect(await dangerousModeLine(home, directory)).toBeUndefined()
    expect(await dangerousModeCheck({ env: { DELORUN_HOME: home }, stdout: () => undefined, stderr: () => undefined }, PROFILE)).toBeUndefined()
  })

  it('shows the one line while the answer is dangerous and the grant is valid', async () => {
    const directory = await chooseDangerous()
    expect(await dangerousModeState(home, directory)).toMatchObject({ kind: 'on' })
    expect(await dangerousModeLine(home, directory)).toBe('Dangerous mode is on: any chat can switch to full access without asking. Turn it off with `delorun setup prompts`.')
    expect(DANGEROUS_ON_LINE).toBe(await dangerousModeLine(home, directory))
  })

  it('prints the line in delorun status and a doctor warning', async () => {
    await chooseDangerous()
    const out: string[] = []
    const context = { env: { DELORUN_HOME: home }, stdout: (text: string) => void out.push(text), stderr: () => undefined }
    await statusCommand.run([], context)
    expect(out.join('')).toContain(`${DANGEROUS_ON_LINE}\n● Delorun isn't running`)
    expect(await dangerousModeCheck(context, PROFILE)).toEqual({ name: 'dangerous-mode', status: 'warn', message: DANGEROUS_ON_LINE })
  })

  it('says it is chosen but not active when the grant is missing, and names a refused grant file', async () => {
    const directory = await chooseDangerous()
    await removeDangerousGrant(home)
    expect(await dangerousModeState(home, directory)).toEqual({ kind: 'inactive', problem: 'its grant file is missing' })
    expect(await dangerousModeLine(home, directory)).toContain('Dangerous mode is chosen but not active: its grant file is missing')
    writeFileSync(dangerousGrantPath(home), '{ "v": 2 }', { mode: 0o600 })
    expect(await dangerousModeState(home, directory)).toEqual({ kind: 'inactive', problem: 'its grant file is not in the format this version reads' })
    writeFileSync(dangerousGrantPath(home), 'not json', { mode: 0o600 })
    expect(await dangerousModeState(home, directory)).toEqual({ kind: 'inactive', problem: 'its grant file holds no JSON document' })
    writeFileSync(dangerousGrantPath(home), JSON.stringify({ v: 1, grantedAt: 'yesterday', warning: DANGEROUS_WARNING_VERSION }), { mode: 0o600 })
    expect(await dangerousModeState(home, directory)).toMatchObject({ kind: 'inactive' })
    const check = await dangerousModeCheck({ env: { DELORUN_HOME: home }, stdout: () => undefined, stderr: () => undefined }, PROFILE)
    expect(check?.status).toBe('warn')
  })

  it.skipIf(!POSIX)('refuses a grant file laxer than 0600 or a symbolic link', async () => {
    const directory = await chooseDangerous()
    const path = dangerousGrantPath(home)
    const text = readFileSync(path, 'utf8')
    rmSync(path)
    writeFileSync(path, text, { mode: 0o644 })
    expect(await dangerousModeState(home, directory)).toMatchObject({ kind: 'inactive', problem: expect.stringContaining('its grant file is refused') })
    rmSync(path)
    const target = join(osHome, 'grant-elsewhere.json')
    writeFileSync(target, text, { mode: 0o600 })
    symlinkSync(target, path)
    expect(await dangerousModeState(home, directory)).toMatchObject({ kind: 'inactive', problem: expect.stringContaining('its grant file is refused') })
  })
})
