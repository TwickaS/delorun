/**
 * The sections of `delorun setup`. A section is one topic of the terminal flow with its question and the writes it
 * produces, and the registry lists them in order. Each section says whether the main flow asks it, shows its note, or
 * leaves it to `delorun setup <id>` ({@link MainFlowPlacement}). Later packages add their sections through
 * {@link SectionRegistry.register}; this module registers privacy, the stock-home import, the model provider and key
 * ([provider section](./provider-section.ts)), prompts, background, remote access, changes protection and profile.
 * Privacy shows a one-line note in the main flow and asks about the release check only as `delorun setup privacy`.
 *
 * @module @delorun/cli/setup/sections
 */
import { join } from 'node:path'
import {
  SETUP_DEFAULT_PORT,
  type PromptsAnswer,
  type SectionRecord,
  type SectionStatus,
  type SetupAnswers,
} from '@delorun/contract-setup-answers'
import { LOCAL_BUNDLE } from '@delorun/bundle-local/profile'
import { en } from '@delorun/bundle-local/statements'
import { profileNameProblem } from '@delorun/contract-home-layout'
import { importSection } from '../import-home/section.ts'
import { CliError, EXIT } from '../exit.ts'
import type { KeyCheck } from './key-check.ts'
import { providerSection } from './provider-section.ts'
import { installedCatalog, type ProviderCatalog } from './providers.ts'
import { removeDangerousGrant, writeDangerousGrant } from '@delorun/plugin-permission-defaults/store'
import { askDangerousConsent, hasDangerousGrant, refuseDangerousAsRoot } from './dangerous.ts'
import { BACK, type Back, type StepIO } from './steps.ts'
import { writeUpdateCheckRow } from './update-check.ts'
import { channelOriginOf } from './channel-origin.ts'
import { isProductionChannel } from './ending.ts'
import { choiceNote, RECOMMENDED, type ChoiceText } from './choices.ts'
import { systemTailscale } from '@delorun/reach'
import { readPatchRow, setPatchRow, STUDIO_ROW_ID, studioRow, writePromptRows } from '@delorun/setup-apply'
import { homeRuns } from '../reach/command.ts'
import { REACH_SECTION_ORDER, reachSection } from '../reach/setup-section.ts'
import { CHANGES_PROTECTION_SECTION_ORDER, changesProtectionSection } from '../changes/setup-section.ts'

/** Where a section's question is asked: `main` is the flow of `delorun setup`, and `single` a section run again with `delorun setup <section>`. */
export type SetupPhase = 'main' | 'single'

/**
 * What the main flow does with a section: `asked` asks it, `note` shows its note without a question, and `never`
 * leaves it to `delorun setup <section>`.
 */
export type MainFlowPlacement = 'asked' | 'note' | 'never'

/** The answers collected so far in an interactive run. */
export interface Draft {
  /** Where the section that is asking is being asked. */
  readonly phase: SetupPhase
  readonly answers: SetupAnswers
  /** The typed key, kept in memory until the key section's write; never in the answers. */
  readonly secret: string | undefined
  /** Why the live check of the key failed when the person continued without a successful check; never the key. */
  readonly keyCheckFailure?: string | undefined
  /** Whether the key section kept the key saved in the home instead of taking a new one. */
  readonly keepSavedKey?: boolean | undefined
}

/** What a section's question returns. */
export interface SectionAnswer {
  /** The answers the section sets. */
  readonly answers: Partial<Omit<SetupAnswers, 'schemaVersion' | 'sections'>>
  /** The typed key, when the section took one. */
  readonly secret?: string
  /** Why the live check of the key failed, when the person continued without a successful check. */
  readonly keyCheckFailure?: string
  /** True when the section kept the key saved in the home; the key is not read, shown or stored again. */
  readonly keepSavedKey?: boolean
  /** `answered` for a question asked, `seen` for a note shown. */
  readonly status: SectionStatus
}

/** What a section may look at while it asks or applies. */
export interface SectionEnvironment {
  /** The environment `delorun` inherited. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The Delorun home. */
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
  /** Whether the home's credentials hold a key under a reference; the key itself is never read. */
  readonly hasSavedKey: (name: string) => boolean
}

/** What a section's writes run against. */
export interface ApplyContext {
  /** The Delorun home. */
  readonly home: string
  /** The environment `delorun` inherited. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The profile directory the writes go to. */
  readonly directory: string
  /** The typed key, when the run has one. */
  readonly secret: string | undefined
  /** True when the run keeps the key already saved under the provider's reference. */
  readonly keepSavedKey?: boolean
}

/** One section of the setup flow. */
export interface SetupSection {
  /** The id `delorun setup <id>` takes. */
  readonly id: string
  /** The heading shown by `delorun setup --list`. */
  readonly title: string
  /**
   * What the main flow does with the section: one value, or a function of the answers so far for a section that
   * depends on an earlier answer.
   */
  readonly inMainFlow: MainFlowPlacement | ((draft: Draft) => MainFlowPlacement)
  /**
   * Whether the section asks a question in a phase; a section that only shows a note is passed over when going back.
   * @param phase - where the section is asked.
   * @returns true when the section asks in that phase.
   */
  asks(phase: SetupPhase): boolean
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
   * Whether a re-run changes nothing the section writes, so the run reports it as kept and writes nothing.
   * A section without the method always writes.
   * @param before - the answers the profile holds now.
   * @param after - the answers of the run.
   * @param typedKey - whether the run took a new model key.
   * @returns true when the section's answer is the one the profile holds.
   */
  unchanged?(before: SetupAnswers, after: SetupAnswers, typedKey: boolean): boolean
  /**
   * Make the section's writes. A run that repeats a write leaves the same values.
   * @param context - the home, profile directory and typed key.
   * @param answers - the answers.
   * @returns a note for the person, if any.
   */
  apply(context: ApplyContext, answers: SetupAnswers): Promise<string | undefined>
}

/**
 * What the main flow does with a section for the answers so far.
 * @param section - the section.
 * @param draft - the answers so far.
 * @returns the section's placement.
 */
export function placementOf(section: SetupSection, draft: Draft): MainFlowPlacement {
  return typeof section.inMainFlow === 'function' ? section.inMainFlow(draft) : section.inMainFlow
}

/** Where a section sits in the flow. */
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
 * The record of a run that asked nothing: a section that asks nothing in the main flow shows only its note, which the
 * run printed, and every other section took its default.
 * @param sections - every registered section.
 * @returns the record.
 */
export function unattendedRecord(sections: readonly SetupSection[]): readonly SectionRecord[] {
  return sections.map(section => ({ id: section.id, status: section.asks('main') ? 'skipped' : 'seen' }))
}

/**
 * @returns true: a section that asks in every phase it runs in.
 */
const asksWhenRun = (): boolean => true

/**
 * The update-check statement on the production channel: the check reads files from releases.delorun.com, and the newest
 * release's manifest and log record from GitHub, once a day and at start when a day has passed; those hosts see this
 * computer's address and receive nothing else.
 */
export const PRODUCTION_UPDATE_STATEMENT = 'About once a day Delorun checks releases.delorun.com and GitHub for a newer release. It sends nothing about you or your plugins; those sites see this computer\'s address. Turn it off in Settings → General → Updates.'

/**
 * The statements setup makes about privacy, from the Privacy section's copy.
 * @param channelOrigin - the recorded channel origin; absent or the production origin for the npm launcher, another origin for a launcher built for another release channel.
 * @returns one line per statement.
 */
export function statementLines(channelOrigin?: string): string[] {
  return [en['statement.delorun'], en['statement.optIns'], en['statement.feedback'], isProductionChannel(channelOrigin) ? PRODUCTION_UPDATE_STATEMENT : localUpdateStatement(channelOrigin as string)]
}

/**
 * The update-check statement for a launcher built with another channel origin: that origin serves the timestamp, the
 * root file, the manifest and the log record, and the check reaches no other host.
 * @param channelOrigin - the recorded channel origin.
 * @returns the statement, naming the origin's host.
 */
export function localUpdateStatement(channelOrigin: string): string {
  const host = new URL(channelOrigin).host
  return `Once a day, and at start when a day has passed, Delorun checks whether a newer release exists: it fetches timestamp.json, a new root file when Delorun's signing keys change, and the newest release's manifest and log record, all from ${host}, the release channel this launcher was built for. It sends nothing about this installation or its plugins; that host sees this computer's address. Turn it off in Settings → General → Updates.`
}

/** The privacy note of the main flow: one line and the page that holds the facts. */
export const MAIN_PRIVACY_LINE = 'Delorun sends nothing about you. Details: https://delorun.com/privacy'

/**
 * What the release-check question's choices mean.
 * @param channelOrigin - the recorded channel origin of a launcher built for another channel, or `undefined` for the production channel.
 * @returns the two choices.
 */
function updateCheckText(channelOrigin?: string): readonly ChoiceText[] {
  const host = isProductionChannel(channelOrigin) ? 'releases.delorun.com' : new URL(channelOrigin as string).host
  return [
    { label: `Yes${RECOMMENDED}`, lines: [`Once a day Delorun asks ${host} whether a newer version exists. You hear about security fixes.`, 'Change later: delorun setup privacy.'] },
    { label: 'No', lines: ['Delorun makes no release check request. You update by hand with npx delorun.', 'Change later: delorun setup privacy.'] },
  ]
}

/**
 * The privacy section: the note, where the two upstream opt-ins are changed, and the update check. The main flow shows
 * one line; `delorun setup privacy` shows the statements and asks whether to check for new releases. Turned off, the
 * check's row is disabled before Delorun first starts, so no check request is made.
 */
export const privacySection: SetupSection = {
  id: 'privacy',
  title: 'Privacy',
  inMainFlow: 'note',
  asks: phase => phase !== 'main',
  appliesTo: () => true,
  async ask(io, draft, environment) {
    if (draft.phase === 'main') {
      io.note(MAIN_PRIVACY_LINE, en.title)
      return { answers: {}, status: 'seen' }
    }
    if (draft.phase === 'single') io.note(statementLines(await channelOriginOf(environment.home)).join('\n'), en.title)
    io.note(choiceNote(updateCheckText(await channelOriginOf(environment.home))), 'Release check')
    const check = await io.select('Check for new releases?', [
      { value: 'on', label: `Yes${RECOMMENDED}` },
      { value: 'off', label: 'No' },
    ], draft.answers.updateCheck ? 'on' : 'off')
    return check === BACK ? BACK : { answers: { updateCheck: check === 'on' }, status: 'answered' }
  },
  unchanged: (before, after) => before.updateCheck === after.updateCheck,
  apply(context, answers) {
    writeUpdateCheckRow(join(context.directory, 'cordis.patch.yml'), answers.updateCheck)
    return Promise.resolve(undefined)
  },
}

/** The name of each prompts answer, in the question, the review and the notes. */
export const PROMPT_LABELS: Readonly<Record<PromptsAnswer, string>> = { safer: 'Ask me first', stock: 'Ask less (like DeepSeek Harness)', dangerous: 'Never ask (dangerous)' }

/** What each prompts answer does, in the order the question lists them. */
const PROMPTS_TEXT: readonly ChoiceText[] = [
  { label: `${PROMPT_LABELS.safer}${RECOMMENDED}`, lines: ['Delorun asks before a chat gets full access to a folder, adds a tool server, edits its own instructions or schedules work. You can allow each once.', 'Change later: delorun setup prompts.'] },
  { label: PROMPT_LABELS.stock, lines: ['Behaves like DeepSeek Harness: few questions, and commands still run in a sandbox.', 'Change later: delorun setup prompts.'] },
  { label: PROMPT_LABELS.dangerous, lines: ['Any chat can switch to full access with no question, from the studio, a phone, a scheduled task or a script. You confirm twice.', 'Change later: delorun setup prompts.'] },
]

/** The prompts section: Delorun's consent and permission defaults, or upstream's. */
export const promptsSection: SetupSection = {
  id: 'prompts',
  title: 'Prompts',
  inMainFlow: 'never',
  asks: asksWhenRun,
  appliesTo: () => true,
  async ask(io, draft, environment) {
    for (;;) {
      io.note(choiceNote(PROMPTS_TEXT), 'How much Delorun asks')
      const choice = await io.select<PromptsAnswer>('How much should Delorun ask before it changes things?', [
        { value: 'safer', label: `${PROMPT_LABELS.safer}${RECOMMENDED}` },
        { value: 'stock', label: PROMPT_LABELS.stock },
        { value: 'dangerous', label: PROMPT_LABELS.dangerous },
      ], draft.answers.prompts)
      if (choice === BACK) return BACK
      if (choice !== 'dangerous') return { answers: { prompts: choice }, status: 'answered' }
      // Staying on dangerous mode needs no second consent while its grant is valid.
      if (draft.answers.prompts === 'dangerous' && environment.profileExists && await hasDangerousGrant(environment.home)) return { answers: { prompts: choice }, status: 'answered' }
      const accepted = await askDangerousConsent(io)
      // Back from the confirmation returns to this question, not to the one before it.
      if (accepted === BACK) continue
      if (!accepted) {
        io.note(`Dangerous mode is off: it was not confirmed. Prompts stay on ${PROMPT_LABELS[draft.answers.prompts]}.`, 'Prompts')
        // A declined consent is no answer: `seen` lets `apply` leave a grant that an earlier consent wrote, and never write one.
        return { answers: { prompts: draft.answers.prompts }, status: 'seen' }
      }
      return { answers: { prompts: choice }, status: 'answered' }
    }
  },
  unchanged: (before, after) => before.prompts === after.prompts,
  async apply(context, answers) {
    refuseDangerousAsRoot(answers.prompts, 'delorun setup')
    writePromptRows(join(context.directory, 'cordis.patch.yml'), answers.prompts)
    // The grant follows the rows, so a failed row write never leaves a grant behind; any other answer withdraws it.
    // A `seen` record on a dangerous answer is a declined consent, which keeps the earlier answer and writes no grant.
    if (answers.prompts !== 'dangerous') await removeDangerousGrant(context.home)
    else if (answers.sections.find(record => record.id === 'prompts')?.status !== 'seen' && !await hasDangerousGrant(context.home)) await writeDangerousGrant(context.home)
    return undefined
  },
}

/** What the background question's choices mean. */
const BACKGROUND_TEXT: readonly ChoiceText[] = [
  { label: `Yes${RECOMMENDED}`, lines: ['Delorun keeps running after you close this terminal and starts again with delorun start.', 'Change later: delorun setup background.'] },
  { label: 'No', lines: ['Delorun stops when you close the terminal.', 'Change later: delorun setup background.'] },
]

/** The background section: whether Delorun keeps running after the terminal closes. */
export const backgroundSection: SetupSection = {
  id: 'background',
  title: 'Background',
  inMainFlow: 'never',
  asks: asksWhenRun,
  appliesTo: () => true,
  async ask(io, draft) {
    io.note(choiceNote(BACKGROUND_TEXT), 'Running in the background')
    const keep = await io.confirm('Keep Delorun running in the background after the terminal closes?', draft.answers.background)
    return keep === BACK ? BACK : { answers: { background: keep }, status: 'answered' }
  },
  unchanged: (before, after) => before.background === after.background,
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
  // C1's rule, which `selectProfile` applies to `--profile` and `DELORUN_PROFILE`.
  const problem = profileNameProblem(value)
  if (problem !== undefined) return `Choose another name: ${problem}.`
  return value !== environment.profile && environment.profileNameTaken(value) ? `A profile named ${value} already exists.` : undefined
}

/**
 * The port's check.
 * @param value - the entry.
 * @returns the message to show, or `undefined` for a usable port.
 */
export function portProblem(value: string): string | undefined {
  const port = Number(value)
  return /^\d{1,5}$/u.test(value) && port >= 1024 && port <= 65535 ? undefined : 'Enter a port from 1024 to 65535; ports under 1024 need administrator rights.'
}

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

/** How many ports after a busy one the profile section looks through for the one it offers. */
const OFFERED_PORT_SEARCH = 100

/**
 * The first free port after a busy one.
 * @param after - the busy port.
 * @param environment - what the section may look at.
 * @returns the port, or `undefined` when none in the search range is free.
 */
async function nextFreePort(after: number, environment: SectionEnvironment): Promise<number | undefined> {
  for (let port = after + 1; port <= Math.min(after + OFFERED_PORT_SEARCH, 65535); port++) {
    if (await environment.portIsFree(port)) return port
  }
  return undefined
}

/**
 * Ask for a free port until the person enters one.
 * @param io - the questions.
 * @param initial - the port offered at first.
 * @param environment - what the section may look at.
 * @returns the port, or {@link BACK}.
 */
async function enteredPort(io: StepIO, initial: number, environment: SectionEnvironment): Promise<number | Back> {
  for (;;) {
    const entered = await io.text('Port for the studio', String(initial), portProblem)
    if (entered === BACK) return BACK
    if (await environment.portIsFree(Number(entered))) return Number(entered)
    io.note(`Port ${entered} is in use on this computer. Choose another.`, 'Port')
  }
}

/**
 * The profile section: the profile's name and the studio's port, which must be free. The main flow asks only when the
 * port is busy, and not at all for a profile that is set up, whose own studio may be using it.
 */
export const profileSection: SetupSection = {
  id: 'profile',
  title: 'Profile name and port',
  inMainFlow: 'asked',
  asks: asksWhenRun,
  appliesTo: () => true,
  async ask(io, draft, environment) {
    if (draft.phase === 'main') {
      const wanted = draft.answers.profile.port ?? SETUP_DEFAULT_PORT
      if (environment.profileExists || await environment.portIsFree(wanted)) return { answers: {}, status: 'skipped' }
      const offered = await nextFreePort(wanted, environment)
      const choice = offered === undefined ? 'other' : await io.select(`Port ${String(wanted)} is in use. Use ${String(offered)}?`, [
        { value: 'use', label: 'Yes' },
        { value: 'other', label: 'Enter another port' },
      ], 'use')
      if (choice === BACK) return BACK
      if (choice === 'use') return { answers: { profile: { name: draft.answers.profile.name, port: offered as number } }, status: 'answered' }
      io.note(`Port ${String(wanted)} is in use on this computer.`, 'Port')
      const port = await enteredPort(io, offered ?? wanted, environment)
      return port === BACK ? BACK : { answers: { profile: { name: draft.answers.profile.name, port: port === SETUP_DEFAULT_PORT ? null : port } }, status: 'answered' }
    }
    let name: string | null = draft.answers.profile.name
    if (!environment.profileExists) {
      io.note('Keep "default" unless you want a second, separate Delorun on this computer, for example for work. The name cannot change after setup.', 'Name for this setup')
      const entered = await io.text('Name for this setup', name ?? environment.profile, value => nameProblem(value, environment))
      if (entered === BACK) return BACK
      name = entered === environment.profile ? null : entered
    }
    io.note('The studio runs at 127.0.0.1 on this port. 3080 is fine unless another program uses it.\nChange later: delorun setup profile.', 'Port')
    const port = await enteredPort(io, draft.answers.profile.port ?? SETUP_DEFAULT_PORT, environment)
    return port === BACK ? BACK : { answers: { profile: { name, port: port === SETUP_DEFAULT_PORT ? null : port } }, status: 'answered' }
  },
  unchanged: (before, after) => before.profile.port === after.profile.port,
  apply(context, answers) {
    if (answers.profile.port !== null) {
      setPatchRow(join(context.directory, 'cordis.patch.yml'), studioRow(answers.profile.port))
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
  registry.register(reachSection(systemTailscale(), homeRuns), { order: REACH_SECTION_ORDER })
  registry.register(importSection({ delorunBundles: [LOCAL_BUNDLE] }), { order: 15 })
  registry.register(providerSection(once(catalog)), { order: 20 })
  registry.register(promptsSection, { order: 30 })
  registry.register(backgroundSection, { order: 40 })
  registry.register(changesProtectionSection(process), { order: CHANGES_PROTECTION_SECTION_ORDER })
  registry.register(profileSection, { order: 50 })
  return registry
}
