import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changesDirectory, protectionPath } from '@delorun/changes'
import { SETUP_DEFAULTS } from '@delorun/contract-setup-answers'
import { ensureHomeTree, HomeLayoutError, runDirectory } from '@delorun/home'
import { CliError, EXIT } from '../../src/exit.ts'
import { profileDirectory } from '../../src/profile.ts'
import { changesProtectionSection, PROTECTION_QUESTION, type TerminalStreams } from '../../src/changes/setup-section.ts'
import { runSection, runSetup, type SetupRequest } from '../../src/setup/index.ts'
import { readProgress } from '../../src/setup/progress.ts'
import { reachSection } from '../../src/reach/setup-section.ts'
import { defaultRegistry, SectionRegistry } from '../../src/setup/sections.ts'
import { BACK_CHOICE } from '../../src/setup/steps.ts'
import { fakeTailscale } from '../fixtures/fake-tailscale.ts'
import { scriptedPrompter, type Answer, type Recording } from './support.ts'

vi.mock('../../src/delorun-bundles.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/delorun-bundles.ts')>(),
  linkDelorunBundles: vi.fn(() => Promise.resolve()),
}))

const PROFILE = 'default'
const TIMEOUT_MS = 60_000
const AT_TERMINAL: TerminalStreams = { stdin: { isTTY: true }, stdout: { isTTY: true } }
const REDIRECTED: TerminalStreams = { stdin: { isTTY: true }, stdout: { isTTY: false } }
const ON_NOTE = 'Changes protection is on: changes to your plugins and to Delorun itself wait for your review in delorun changes list.'

/** The answer that brings the protection question: phone access over a Tailscale the fake reports ready. */
const PHONE_YES: readonly Answer[] = ['yes']
/** The answers of a run with no phone, which never asks the protection question. */
const PHONE_NO: readonly Answer[] = ['no']
const HOST = 'home.example.ts.net'

let osHome: string
let home: string
let recording: Recording

/**
 * This build's sections, with the protection section reading the given streams and the reach section a Tailscale that is ready.
 * @param streams - the streams its terminal proof reads.
 * @param tailscale - the `tailscale` the reach section runs.
 * @returns the registry.
 */
function registryWith(streams: TerminalStreams, tailscale = fakeTailscale(HOST).run): SectionRegistry {
  const registry = new SectionRegistry()
  for (const [order, section] of defaultRegistry().all().entries()) {
    const replaced = section.id === 'changes-protection' ? changesProtectionSection(streams) : section.id === 'reach' ? reachSection(tailscale, () => false) : section
    registry.register(replaced, { order })
  }
  return registry
}

/**
 * @param script - the answers in order.
 * @param streams - the streams the protection section's proof reads.
 * @returns the request of a terminal run.
 */
function request(script: readonly Answer[], streams: TerminalStreams = AT_TERMINAL, registry = registryWith(streams)): SetupRequest {
  return {
    home,
    profile: PROFILE,
    output: { stdout: text => void recording.screen.push(...text.replace(/\n$/u, '').split('\n')), stderr: () => undefined },
    env: {},
    form: { kind: 'interactive', prompter: scriptedPrompter(script, recording) },
    registry,
    keyCheck: () => Promise.resolve({ ok: true }),
    portIsFree: () => Promise.resolve(true),
  }
}

/** @returns the protection record, or undefined when the home has none. */
function protectionRecord(): { level: string, setAt: string } | undefined {
  return existsSync(protectionPath(home)) ? JSON.parse(readFileSync(protectionPath(home), 'utf8')) as { level: string, setAt: string } : undefined
}

/** @returns the profile's recorded answer. */
function recordedAnswer(): unknown {
  return (JSON.parse(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8')) as { protectChanges: unknown }).protectChanges
}

/**
 * @param id - a section id.
 * @returns what the profile's answers record says happened to the section.
 */
function sectionStatus(id: string): string | undefined {
  return (JSON.parse(readFileSync(join(profileDirectory(home, PROFILE), 'setup-answers.json'), 'utf8')) as { sections: { id: string, status: string }[] }).sections.find(record => record.id === id)?.status
}

/** @returns the screen as one text. */
function screen(): string {
  return recording.screen.join('\n')
}

/**
 * Turn protection on through the section's write at a terminal.
 * @returns the record written.
 */
async function turnedOn(): Promise<{ level: string, setAt: string }> {
  await registryWith(AT_TERMINAL).find('changes-protection')?.apply({ home, env: {}, directory: home, secret: undefined }, { ...SETUP_DEFAULTS, protectChanges: true })
  return protectionRecord() as { level: string, setAt: string }
}

beforeEach(async () => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-protection-')))
  home = join(osHome, '.delorun')
  await ensureHomeTree(home, PROFILE)
  recording = { screen: [], asked: [] }
})

afterEach(() => {
  rmSync(osHome, { recursive: true, force: true })
})

describe('the changes protection question', { timeout: TIMEOUT_MS }, () => {
  it('is asked right after a phone Yes, with no preselected, after a one-line explanation', async () => {
    expect(await runSetup(request([...PHONE_YES, 'no']))).toBe(EXIT.ok)
    expect(recording.asked.slice(0, 2)).toEqual(['select: Use it from your phone too?', `select: ${PROTECTION_QUESTION}`])
    expect(screen()).toContain([
      '# Changes protection',
      '  Off by default: changes load at once and are recorded, so you can undo them with delorun changes list.',
      `? ${PROTECTION_QUESTION}`,
      '  Yes',
      '> No',
      '  ← Back',
      '= No',
    ].join('\n'))
  })

  it('turns protection on at a terminal: the record says on, at 0600 under a 0700 changes directory', async () => {
    expect(await runSetup(request([...PHONE_YES, 'yes']))).toBe(EXIT.ok)
    expect(protectionRecord()?.level).toBe('on')
    expect(statSync(protectionPath(home)).mode & 0o777).toBe(0o600)
    expect(statSync(changesDirectory(home)).mode & 0o777).toBe(0o700)
    expect(screen()).toContain(ON_NOTE)
    expect(recordedAnswer()).toBe(true)
  })

  it('writes nothing when the answer is no', async () => {
    expect(await runSetup(request([...PHONE_YES, 'no']))).toBe(EXIT.ok)
    expect(existsSync(protectionPath(home))).toBe(false)
    expect(recordedAnswer()).toBe(false)
  })

  it('is not asked after a phone No, which leaves the home at the default', async () => {
    expect(await runSetup(request(PHONE_NO))).toBe(EXIT.ok)
    expect(recording.asked).toEqual(['select: Use it from your phone too?'])
    expect(screen()).not.toContain('# Changes protection')
    expect(existsSync(protectionPath(home))).toBe(false)
    expect(sectionStatus('changes-protection')).toBe('skipped')
  })

  it('is not asked when the phone check fails and leaves phone access off', async () => {
    const funnel = fakeTailscale(HOST)
    funnel.config = { AllowFunnel: { [`${HOST}:443`]: true } }
    expect(await runSetup(request(PHONE_YES, AT_TERMINAL, registryWith(AT_TERMINAL, funnel.run)))).toBe(EXIT.ok)
    expect(recording.asked).toEqual(['select: Use it from your phone too?'])
    expect(screen()).toContain('Remote access stays off')
    expect(sectionStatus('changes-protection')).toBe('skipped')
  })

  it('goes back to the phone question', async () => {
    expect(await runSetup(request([...PHONE_YES, BACK_CHOICE, 'yes', 'yes']))).toBe(EXIT.ok)
    expect(recording.asked.filter(asked => asked === 'select: Use it from your phone too?')).toHaveLength(2)
    expect(protectionRecord()?.level).toBe('on')
  })
})

describe('a home whose protection is on', { timeout: TIMEOUT_MS }, () => {
  it('preselects yes, says that no leaves it on, and rewrites nothing for either answer', async () => {
    const before = await turnedOn()
    expect(await runSetup(request([...PHONE_YES, 'no']))).toBe(EXIT.ok)
    expect(screen()).toContain('  On for this home: changes wait for your review in delorun changes list. Answering no leaves it on; delorun changes protection off turns it off.')
    expect(screen()).toContain(`? ${PROTECTION_QUESTION}\n> Yes\n  No`)
    expect(protectionRecord()).toEqual(before)
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    expect(await runSetup(request([...PHONE_YES, 'yes']))).toBe(EXIT.ok)
    expect(protectionRecord()).toEqual(before)
    expect(screen()).not.toContain(ON_NOTE)
  })
})

describe('without a terminal proof', { timeout: TIMEOUT_MS }, () => {
  it('stops a yes before it writes, naming how to finish, and a run at a terminal resumes it', async () => {
    const error = await runSetup(request([...PHONE_YES, 'yes'], REDIRECTED)).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toBe('delorun setup: turning changes protection on needs you at a terminal; run delorun setup in one to finish, or delorun changes protection on')
    expect(existsSync(protectionPath(home))).toBe(false)
    expect(readProgress(runDirectory(home, PROFILE))?.completed).not.toContain('section:changes-protection')
    expect(await runSetup(request([]))).toBe(EXIT.ok)
    expect(protectionRecord()?.level).toBe('on')
  })

  it('--yes and a --config document leave the setting as it is and record the section as skipped', async () => {
    const unattended = (form: SetupRequest['form']): Promise<number | undefined> => runSetup({ ...request([]), env: { DEEPSEEK_API_KEY: 'env-key' }, form })
    expect(await unattended({ kind: 'yes' })).toBe(EXIT.ok)
    expect(existsSync(protectionPath(home))).toBe(false)
    expect(recordedAnswer()).toBe(false)
    rmSync(profileDirectory(home, PROFILE), { recursive: true })
    const document = join(osHome, 'answers.json')
    writeFileSync(document, JSON.stringify({ schemaVersion: 2, modelProvider: { id: 'deepseek-official', credential: { source: 'environment', name: 'DEEPSEEK_API_KEY' } }, prompts: 'safer', background: true, profile: { name: null, port: null }, reach: { option: 'none', identityFactor: null }, importStockHome: false, protectChanges: true }))
    await expect(unattended({ kind: 'config', path: document })).rejects.toThrow('protectChanges must be false in --config')
    expect(existsSync(protectionPath(home))).toBe(false)
  })
})

describe('delorun setup changes-protection', { timeout: TIMEOUT_MS }, () => {
  it('asks again on a profile that is set up, turns protection on and records the answer', async () => {
    expect(await runSetup(request(PHONE_NO))).toBe(EXIT.ok)
    expect(await runSection(request([true]), 'changes-protection')).toBe(EXIT.ok)
    expect(protectionRecord()?.level).toBe('on')
    expect(recordedAnswer()).toBe(true)
    expect(screen()).toContain(ON_NOTE)
  })
})

describe('a protection record setup cannot use', { timeout: TIMEOUT_MS }, () => {
  it('stops the question with the record\'s refusal', async () => {
    mkdirSync(changesDirectory(home), { recursive: true, mode: 0o700 })
    writeFileSync(protectionPath(home), 'not json', { mode: 0o600 })
    const error = await runSetup(request([...PHONE_YES, 'yes'])).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toMatch(/^delorun setup: /u)
    expect((error as CliError).message).toContain('protection.json')
  })

  it('passes on a changes directory that others can read, which the write refuses', async () => {
    mkdirSync(changesDirectory(home), { recursive: true })
    chmodSync(changesDirectory(home), 0o755)
    const error = await runSetup(request([...PHONE_YES, 'yes'])).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HomeLayoutError)
    expect(existsSync(protectionPath(home))).toBe(false)
  })
})
