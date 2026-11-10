/**
 * The sections of `delorun setup`. A section is one topic of the terminal flow with its question, its review line
 * and the writes it produces, and the registry lists them in order. Quick runs the sections marked `quick`; Full runs
 * every section. Each section is also `delorun setup <id>`. Later packages add their sections through
 * {@link SectionRegistry.register}; this module registers privacy, the stock-home import, key, prompts, background
 * and profile.
 *
 * @module @delo/cli/setup/sections
 */
import { join } from 'node:path'
import {
  SETUP_DEFAULT_CREDENTIAL_VARIABLE,
  SETUP_DEFAULT_PORT,
  type PromptsAnswer,
  type SectionRecord,
  type SectionStatus,
  type SetupAnswers,
} from '@delo/contract-setup-answers'
import { LOCAL_BUNDLE } from '@delo/bundle-local/profile'
import { en } from '@delo/bundle-local/statements'
import { profileNameProblem } from '@delo/contract-home-layout'
import { importSection } from '../import-home/section.ts'
import { CliError, EXIT } from '../exit.ts'
import type { KeyCheck } from './key-check.ts'
import { writePromptRows } from './prompt-switches.ts'
import { BACK, type Back, type StepIO } from './steps.ts'
import { setPatchRow, storeCredential } from './writes.ts'
import { systemTailscale } from '@delo/reach'
import { REACH_SECTION_ORDER, reachSection } from '../reach/setup-section.ts'

/** The run's mode: Quick asks the `quick` sections, Full asks every section. */
export type SetupMode = 'quick' | 'full'

/** The answers collected so far in an interactive run. */
export interface Draft {
  readonly mode: SetupMode
  readonly answers: SetupAnswers
  /** The typed key, kept in memory until the key section's write; never in the answers. */
  readonly secret: string | undefined
}

/** What a section's question returns. */
export interface SectionAnswer {
  /** The answers the section sets. */
  readonly answers: Partial<Omit<SetupAnswers, 'schemaVersion' | 'sections'>>
  /** The typed key, when the section took one. */
  readonly secret?: string
  /** `answered` for a question asked, `seen` for a note shown. */
  readonly status: SectionStatus
}

/** What a section may look at while it asks or applies. */
export interface SectionEnvironment {
  /** The environment `delorun` inherited. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The Delo home. */
  readonly home: string
  /** The CLI profile the command line selected. */
  readonly profile: string
  /** Whether that profile already exists, as when one section runs again. */
  readonly profileExists: boolean
  /** Whether a CLI profile of another name exists in the home. */
  readonly profileNameTaken: (name: string) => boolean
  /** Checks a typed key with one live request. */
  readonly checkKey: KeyCheck
  /** Whether the key in the environment is checked too (`--check-key`). */
  readonly checkEnvironmentKey: boolean
  /** Whether a local port is free to listen on. */
  readonly portIsFree: (port: number) => Promise<boolean>
}

/** What a section's writes run against. */
export interface ApplyContext {
  /** The Delo home. */
  readonly home: string
  /** The environment `delorun` inherited. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The profile directory the writes go to. */
  readonly directory: string
  /** The typed key, when the run has one. */
  readonly secret: string | undefined
}

/** One section of the setup flow. */
export interface SetupSection {
  /** The id `delorun setup <id>` takes. */
  readonly id: string
  /** The heading shown by `delorun setup --list`. */
  readonly title: string
  /** `quick` sections run in both modes, `full` sections only in Full. */
  readonly mode: SetupMode
  /** Whether the section asks a question; a section that only shows a note is passed over when going back. */
  readonly asks: boolean
  /**
   * @param environment - what the section may look at.
   * @returns whether the section applies on this computer.
   */
  appliesTo(environment: SectionEnvironment): boolean
  /**
   * Ask the section's question.
   * @param io - the questions, with the way back.
   * @param draft - the answers so far.
   * @param environment - what the section may look at.
   * @returns the section's answers, or {@link BACK}.
   */
  ask(io: StepIO, draft: Draft, environment: SectionEnvironment): Promise<SectionAnswer | Back>
  /**
   * @param answers - the answers.
   * @returns the section's line of the review screen. A section without one omits the method.
   */
  review?(answers: SetupAnswers): string
  /**
   * Make the section's writes. A run that repeats a write leaves the same values.
   * @param context - the home, profile directory and typed key.
   * @param answers - the answers.
   * @returns a note for the person, if any.
   */
  apply(context: ApplyContext, answers: SetupAnswers): Promise<string | undefined>
}

/** Where a section sits in the flow, and for which mode. */
export interface SectionPlacement {
  /** Sections run in ascending order; ties keep registration order. */
  readonly order: number
}

/** The registry of sections. */
export class SectionRegistry {
  private readonly entries: { readonly section: SetupSection, readonly order: number, readonly sequence: number }[] = []
  private sequence = 0

  /**
   * Add a section.
   * @param section - the section.
   * @param placement - its place in the flow.
   * @returns the disposer that removes it.
   * @throws {Error} when a section with the id exists.
   */
  register(section: SetupSection, placement: SectionPlacement): () => void {
    if (this.entries.some(entry => entry.section.id === section.id)) throw new Error(`delorun setup: section ${section.id} is registered twice`)
    const entry = { section, order: placement.order, sequence: this.sequence++ }
    this.entries.push(entry)
    return () => {
      this.entries.splice(this.entries.indexOf(entry), 1)
    }
  }

  /**
   * List the sections.
   * @returns every section, in flow order.
   */
  all(): readonly SetupSection[] {
    return [...this.entries]
      .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
      .map(entry => entry.section)
  }

  /**
   * Look up a section.
   * @param id - a section id.
   * @returns the section, or `undefined`.
   */
  find(id: string): SetupSection | undefined {
    return this.all().find(section => section.id === id)
  }
}

/**
 * Set one section's status in the record, keeping the record in flow order.
 * @param records - the record so far.
 * @param id - the section.
 * @param status - what happened to it.
 * @returns the new record.
 */
export function withRecord(records: readonly SectionRecord[], id: string, status: SectionStatus): readonly SectionRecord[] {
  return [...records.filter(record => record.id !== id), { id, status }]
}

/**
 * The record of a run that asked nothing: the privacy note was shown, every other section took its default.
 * @param sections - every registered section.
 * @returns the record.
 */
export function unattendedRecord(sections: readonly SetupSection[]): readonly SectionRecord[] {
  return sections.map(section => ({ id: section.id, status: section.asks ? 'skipped' : 'seen' }))
}

/**
 * The statements setup makes about privacy, from the Privacy section's copy.
 * @returns one line per statement.
 */
export function statementLines(): string[] {
  return [en['statement.delo'], en['statement.optIns'], en['statement.feedback']]
}

/** The privacy section: the note, and where the two upstream opt-ins are changed. */
export const privacySection: SetupSection = {
  id: 'privacy',
  title: 'Privacy',
  mode: 'quick',
  asks: false,
  appliesTo: () => true,
  ask(io) {
    io.note(statementLines().join('\n'), en.title)
    return Promise.resolve({ answers: {}, status: 'seen' })
  },
  apply: () => Promise.resolve(undefined),
}

/**
 * Ask the key, and on a failed check say why and let the person enter it again or continue.
 * @param io - the questions.
 * @param environment - what the section may look at.
 * @returns the key, or {@link BACK}.
 */
async function askTypedKey(io: StepIO, environment: SectionEnvironment): Promise<string | Back> {
  for (;;) {
    const key = await io.secret('DeepSeek API key')
    if (key === BACK) return BACK
    const result = await environment.checkKey(key)
    if (result.ok) return key
    io.note(`The key was not checked successfully: ${result.reason}\nA wrong key means the model cannot answer; you can change it later with delorun setup key.`, 'Key check')
    const next = await io.select('What now?', [
      { value: 'again', label: 'Enter the key again' },
      { value: 'continue', label: 'Continue without a successful check' },
    ], 'again')
    if (next === BACK) return BACK
    if (next === 'continue') return key
  }
}

/** The key section: where the model key comes from and, for a typed key, one live check before it is stored. */
export const keySection: SetupSection = {
  id: 'key',
  title: 'Model key',
  mode: 'quick',
  asks: true,
  appliesTo: () => true,
  async ask(io, draft, environment) {
    const source = await io.select('Where does the DeepSeek API key come from?', [
      { value: 'prompt', label: 'Enter the key now', hint: 'stored in the home\'s credentials document' },
      { value: 'environment', label: `Read ${SETUP_DEFAULT_CREDENTIAL_VARIABLE} from the environment at each start` },
    ], draft.answers.modelProvider.credential.source)
    if (source === BACK) return BACK
    if (source === 'environment') {
      const value = environment.env[SETUP_DEFAULT_CREDENTIAL_VARIABLE] ?? ''
      if (environment.checkEnvironmentKey && value !== '') {
        const result = await environment.checkKey(value)
        if (!result.ok) io.note(`The key in ${SETUP_DEFAULT_CREDENTIAL_VARIABLE} was not checked successfully: ${result.reason}`, 'Key check')
      }
      return { answers: { modelProvider: { id: draft.answers.modelProvider.id, credential: { source: 'environment', name: SETUP_DEFAULT_CREDENTIAL_VARIABLE } } }, status: 'answered' }
    }
    const key = await askTypedKey(io, environment)
    if (key === BACK) return BACK
    return { answers: { modelProvider: { id: draft.answers.modelProvider.id, credential: { source: 'prompt' } } }, secret: key, status: 'answered' }
  },
  review: answers => `DeepSeek API key: ${answers.modelProvider.credential.source === 'prompt' ? 'key entered now' : `read from ${answers.modelProvider.credential.name} at each start`}`,
  apply(context, answers) {
    if (answers.modelProvider.credential.source === 'prompt') {
      if (context.secret === undefined) throw new CliError(EXIT.failed, 'delorun setup: the model key was not entered; run delorun setup in a terminal to finish')
      return storeCredential(context.home, SETUP_DEFAULT_CREDENTIAL_VARIABLE, context.secret).then(() => undefined)
    }
    return Promise.resolve(undefined)
  },
}

const PROMPT_LABELS: Readonly<Record<PromptsAnswer, string>> = { safer: 'Safer prompts', stock: 'Same as stock' }

/** The prompts section: Delo's consent and permission defaults, or upstream's. */
export const promptsSection: SetupSection = {
  id: 'prompts',
  title: 'Prompts',
  mode: 'quick',
  asks: true,
  appliesTo: () => true,
  async ask(io, draft) {
    const choice = await io.select<PromptsAnswer>('How should Delorun ask before it changes things?', [
      { value: 'safer', label: PROMPT_LABELS.safer, hint: 'asks before instruction edits, new MCP servers, scheduled work and full access' },
      { value: 'stock', label: PROMPT_LABELS.stock, hint: 'behaves as DeepSeek Harness does' },
    ], draft.answers.prompts)
    return choice === BACK ? BACK : { answers: { prompts: choice }, status: 'answered' }
  },
  review: answers => `Prompts: ${PROMPT_LABELS[answers.prompts]}`,
  apply(context, answers) {
    writePromptRows(join(context.directory, 'cordis.patch.yml'), answers.prompts)
    return Promise.resolve(undefined)
  },
}

/** The background section: whether Delorun keeps running after the terminal closes. */
export const backgroundSection: SetupSection = {
  id: 'background',
  title: 'Background',
  mode: 'full',
  asks: true,
  appliesTo: () => true,
  async ask(io, draft) {
    const keep = await io.confirm('Keep Delorun running in the background after the terminal closes?', draft.answers.background)
    return keep === BACK ? BACK : { answers: { background: keep }, status: 'answered' }
  },
  review: answers => `Keep running in the background: ${answers.background ? 'yes' : 'no'}`,
  // The answer is read from the answers record that setup writes at its end.
  apply: () => Promise.resolve(undefined),
}

/**
 * The profile name's check.
 * @param value - the entry.
 * @param environment - what the section may look at.
 * @returns the message to show, or `undefined` for a usable name.
 */
function nameProblem(value: string, environment: SectionEnvironment): string | undefined {
  // C1's rule, which `selectProfile` applies to `--profile` and `DELO_PROFILE`.
  const problem = profileNameProblem(value)
  if (problem !== undefined) return `Choose another name: ${problem}.`
  return value !== environment.profile && environment.profileNameTaken(value) ? `A profile named ${value} already exists.` : undefined
}

/**
 * The port's check.
 * @param value - the entry.
 * @returns the message to show, or `undefined` for a usable port.
 */
function portProblem(value: string): string | undefined {
  const port = Number(value)
  return /^\d{1,5}$/u.test(value) && port >= 1024 && port <= 65535 ? undefined : 'Enter a port from 1024 to 65535.'
}

/** The profile section: the profile's name and the studio's port, which must be free. */
export const profileSection: SetupSection = {
  id: 'profile',
  title: 'Profile name and port',
  mode: 'full',
  asks: true,
  appliesTo: () => true,
  async ask(io, draft, environment) {
    let name: string | null = draft.answers.profile.name
    if (!environment.profileExists) {
      const entered = await io.text('Profile name', name ?? environment.profile, value => nameProblem(value, environment))
      if (entered === BACK) return BACK
      name = entered === environment.profile ? null : entered
    }
    for (;;) {
      const entered = await io.text('Port for the studio', String(draft.answers.profile.port ?? SETUP_DEFAULT_PORT), portProblem)
      if (entered === BACK) return BACK
      const port = Number(entered)
      if (await environment.portIsFree(port)) return { answers: { profile: { name, port: port === SETUP_DEFAULT_PORT ? null : port } }, status: 'answered' }
      io.note(`Port ${entered} is in use on this computer. Choose another.`, 'Port')
    }
  },
  review: answers => `Profile: ${answers.profile.name ?? 'default name'}, port ${String(answers.profile.port ?? SETUP_DEFAULT_PORT)}`,
  apply(context, answers) {
    if (answers.profile.port !== null) {
      // The patch replaces the web server row's config, so its other keys are restated from the Web bundle.
      setPatchRow(join(context.directory, 'cordis.patch.yml'), { id: 'webserver', config: { host: '127.0.0.1', port: answers.profile.port, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
    }
    return Promise.resolve(undefined)
  },
}

/**
 * The registry of the sections this build ships. Later packages register theirs into it.
 * @returns a registry holding privacy, the stock-home import, key, prompts, background, remote access and profile.
 */
export function defaultRegistry(): SectionRegistry {
  const registry = new SectionRegistry()
  registry.register(privacySection, { order: 10 })
  registry.register(importSection({ deloBundles: [LOCAL_BUNDLE] }), { order: 15 })
  registry.register(keySection, { order: 20 })
  registry.register(promptsSection, { order: 30 })
  registry.register(backgroundSection, { order: 40 })
  registry.register(reachSection(systemTailscale()), { order: REACH_SECTION_ORDER })
  registry.register(profileSection, { order: 50 })
  return registry
}
