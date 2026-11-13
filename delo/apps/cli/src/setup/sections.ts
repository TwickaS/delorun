/**
 * The sections of `delorun setup`. A section is one topic of the terminal flow with its question, its review line
 * and the writes it produces, and the registry lists them in order. Quick runs the sections marked `quick`; Full runs
 * every section. Each section is also `delorun setup <id>`. Later packages add their sections through
 * {@link SectionRegistry.register}; this module registers privacy, the stock-home import, the model provider and key
 * ([provider section](./provider-section.ts)), prompts, background and profile. Privacy shows the note in both modes and asks about the release check in Full.
 *
 * @module @delo/cli/setup/sections
 */
import { join } from 'node:path'
import {
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
import { providerSection } from './provider-section.ts'
import { installedCatalog, type ProviderCatalog } from './providers.ts'
import { writePromptRows } from './prompt-switches.ts'
import { BACK, type Back, type StepIO } from './steps.ts'
import { writeUpdateCheckRow } from './update-check.ts'
import { readPatchRow, setPatchRow } from './writes.ts'
import { systemTailscale } from '@delo/reach'
import { homeRuns } from '../reach/command.ts'
import { REACH_SECTION_ORDER, reachSection } from '../reach/setup-section.ts'

/** The run's mode: Quick asks the `quick` sections, Full asks every section. */
export type SetupMode = 'quick' | 'full'

/** The answers collected so far in an interactive run. */
export interface Draft {
  readonly mode: SetupMode
  readonly answers: SetupAnswers
  /** The typed key, kept in memory until the key section's write; never in the answers. */
  readonly secret: string | undefined
  /** Why the live check of the key failed when the person continued without a successful check; never the key. */
  readonly keyCheckFailure?: string | undefined
}

/** What a section's question returns. */
export interface SectionAnswer {
  /** The answers the section sets. */
  readonly answers: Partial<Omit<SetupAnswers, 'schemaVersion' | 'sections'>>
  /** The typed key, when the section took one. */
  readonly secret?: string
  /** Why the live check of the key failed, when the person continued without a successful check. */
  readonly keyCheckFailure?: string
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
  /** Checks a key with one live request. */
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
  /**
   * Whether the section asks a question in a run of a mode; a section that only shows a note is passed over when going back.
   * @param mode - the run's mode.
   * @returns true when the section asks in that mode.
   */
  asks(mode: SetupMode): boolean
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
   * @param draft - the run's answers so far, with what the questions found, such as a failed key check.
   * @returns the section's line of the review screen. A section without one omits the method.
   */
  review?(answers: SetupAnswers, draft?: Draft): string
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
 * The record of a run that asked nothing: a section that asks nothing in Quick shows only its note, which the run
 * printed, and every other section took its default.
 * @param sections - every registered section.
 * @returns the record.
 */
export function unattendedRecord(sections: readonly SetupSection[]): readonly SectionRecord[] {
  return sections.map(section => ({ id: section.id, status: section.asks('quick') ? 'skipped' : 'seen' }))
}

/**
 * @returns true: a section that asks in every mode it runs in.
 */
const asksWhenRun = (): boolean => true

/**
 * The statements setup makes about privacy, from the Privacy section's copy.
 * @returns one line per statement.
 */
export function statementLines(): string[] {
  return [en['statement.delo'], en['statement.optIns'], en['statement.feedback'], en['statement.updateCheck']]
}

/** The line Quick adds to the privacy note, by the release-check answer: Quick does not ask, so the line says how to reach the question before Delorun starts. */
export const QUICK_UPDATE_CHECK_LINES: Readonly<Record<'on' | 'off', string>> = {
  on: 'Quick setup keeps the release check on. To turn it off before Delorun first starts, choose ← Back at the next question, then Full.',
  off: 'This setup turns the release check off, so Delorun makes no release check request.',
}

/**
 * The privacy section: the note, where the two upstream opt-ins are changed, and the update check. Full, and
 * `delorun setup privacy`, ask whether to check for new releases; turned off, the check's row is disabled before
 * Delorun first starts, so no check request is made.
 */
export const privacySection: SetupSection = {
  id: 'privacy',
  title: 'Privacy',
  mode: 'quick',
  asks: mode => mode === 'full',
  appliesTo: () => true,
  async ask(io, draft) {
    if (draft.mode === 'quick') {
      io.note([...statementLines(), QUICK_UPDATE_CHECK_LINES[draft.answers.updateCheck ? 'on' : 'off']].join('\n'), en.title)
      return { answers: {}, status: 'seen' }
    }
    io.note(statementLines().join('\n'), en.title)
    const check = await io.select('Check for new releases?', [
      { value: 'on', label: 'Yes', hint: 'once a day Delo fetches signed release files from releases.delorun.com and GitHub; it sends nothing about this installation, and those hosts see this computer\'s address' },
      { value: 'off', label: 'No', hint: 'no release check request is made; turn it on later in Settings → General → Updates or with delorun setup privacy' },
    ], draft.answers.updateCheck ? 'on' : 'off')
    return check === BACK ? BACK : { answers: { updateCheck: check === 'on' }, status: 'answered' }
  },
  review: answers => `Check for new releases: ${answers.updateCheck ? 'yes' : 'no'}`,
  apply(context, answers) {
    writeUpdateCheckRow(join(context.directory, 'cordis.patch.yml'), answers.updateCheck)
    return Promise.resolve(undefined)
  },
}

const PROMPT_LABELS: Readonly<Record<PromptsAnswer, string>> = { safer: 'Safer prompts', stock: 'Same as stock' }

/** The prompts section: Delo's consent and permission defaults, or upstream's. */
export const promptsSection: SetupSection = {
  id: 'prompts',
  title: 'Prompts',
  mode: 'quick',
  asks: asksWhenRun,
  appliesTo: () => true,
  async ask(io, draft) {
    const choice = await io.select<PromptsAnswer>('How should Delorun ask before it changes things?', [
      { value: 'safer', label: PROMPT_LABELS.safer, hint: 'asks before giving full access or starting a new MCP server, and before instruction edits and scheduled work' },
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
  asks: asksWhenRun,
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

/** The id of the Web bundle's web server row, whose `port` the profile section sets. */
export const STUDIO_ROW_ID = 'webserver'

/**
 * The studio port a profile's own patch sets, as the profile section writes it.
 * @param directory - the profile's directory.
 * @param command - the command that starts a refusal's message.
 * @returns the port, 0 when the patch asks the system for a free port at each start, or `undefined` when the patch sets none.
 * @throws {CliError} `EXIT.failed` when the patch is not a YAML patch list, or its web server row's `port` is not an integer from 0 to 65535.
 */
export function profileStudioPort(directory: string, command: string): number | undefined {
  const path = join(directory, 'cordis.patch.yml')
  const port = readPatchRow(path, STUDIO_ROW_ID, command)?.['port']
  if (port === undefined) return undefined
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(EXIT.failed, `${command}: the ${STUDIO_ROW_ID} row of ${path} sets port to ${JSON.stringify(port)}, which is not a port number from 0 to 65535`)
  }
  return port
}

/** The profile section: the profile's name and the studio's port, which must be free. */
export const profileSection: SetupSection = {
  id: 'profile',
  title: 'Profile name and port',
  mode: 'full',
  asks: asksWhenRun,
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
      setPatchRow(join(context.directory, 'cordis.patch.yml'), { id: STUDIO_ROW_ID, config: { host: '127.0.0.1', port: answers.profile.port, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } })
    }
    return Promise.resolve(undefined)
  },
}

/**
 * Load a catalog once, on first use.
 * @param load - loads the catalog.
 * @returns a loader that keeps the first load's promise.
 */
function once(load: () => Promise<ProviderCatalog>): () => Promise<ProviderCatalog> {
  let loaded: Promise<ProviderCatalog> | undefined
  return () => (loaded ??= load())
}

/**
 * The registry of the sections this build ships. Later packages register theirs into it.
 * @param catalog - the installed catalogs the provider section lists models from; the adapters' own by default.
 * @returns a registry holding privacy, the stock-home import, the model provider and key, prompts, background, remote access and profile.
 */
export function defaultRegistry(catalog: () => Promise<ProviderCatalog> = installedCatalog): SectionRegistry {
  const registry = new SectionRegistry()
  registry.register(privacySection, { order: 10 })
  registry.register(importSection({ deloBundles: [LOCAL_BUNDLE] }), { order: 15 })
  registry.register(providerSection(once(catalog)), { order: 20 })
  registry.register(promptsSection, { order: 30 })
  registry.register(backgroundSection, { order: 40 })
  registry.register(reachSection(systemTailscale(), homeRuns), { order: REACH_SECTION_ORDER })
  registry.register(profileSection, { order: 50 })
  return registry
}
