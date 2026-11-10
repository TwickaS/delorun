/**
 * Setup's entry point: `delorun setup`, and `delorun` on a home without a CLI profile. In a terminal it asks the
 * sections of Quick or Full setup ([sections](./sections.ts)), or it reads `--yes` or `--config`; then it runs its
 * steps: create the CLI profile and make Delo's bundles importable in it ({@link linkDeloBundles}), then each
 * section's writes in order (the model key, the prompts rows, the studio port), and record the run. The three forms
 * produce the same answers and so the same writes. An interrupted run resumes at the first step that did not finish.
 * Setup never replaces an existing profile. A terminal run then offers to install the command, starts Delorun and
 * opens the studio ([ending](./ending.ts)). `delorun setup <section>` runs one section again; `--list` lists them.
 *
 * @module @delo/cli/setup
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createRuntimeResolution, initProfile, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { DELO_PROFILE_BUNDLES } from '@delo/bundle-local/profile'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { prepareHome, type CliCommand, type CommandOutput } from '../command.ts'
import { parseArgs } from 'node:util'
import { linkDeloBundles, type BundleLinking } from '../delo-bundles.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { runDirectory } from '@delo/home'
import { SETUP_DEFAULTS, type SetupAnswers } from '@delo/contract-setup-answers'
import { answersSchema, readAnswersDocument, yesAnswers } from './answers.ts'
import { computerEnding, finishSetup, type Ending } from './ending.ts'
import { askAnswers } from './interactive.ts'
import { liveKeyCheck, type KeyCheck } from './key-check.ts'
import { ANSWERS_FILENAME, PROFILE_STEP, readProgress, removeProgress, sectionStep, writeAnswersRecord, writeProgress, type SetupProgress, type SetupStep } from './progress.ts'
import { defaultRegistry, statementLines, unattendedRecord, withRecord, type Draft, type SectionEnvironment, type SectionRegistry, type SetupSection } from './sections.ts'
import { terminalPrompter, type Prompter } from './prompts.ts'
import { BACK, stepIO } from './steps.ts'
import { shippedPackageManager } from '../package-manager.ts'

/** How setup gets its answers. */
export type SetupForm =
  /** The questions. Tests pass a prompter; a terminal run leaves it to setup. */
  | { readonly kind: 'interactive'; readonly prompter?: Prompter }
  /** Every default, with the model key from the environment. */
  | { readonly kind: 'yes' }
  /** An answers document. */
  | { readonly kind: 'config'; readonly path: string }

/** Test seams: a hook that runs after each step is recorded. Production leaves it unset. */
export interface SetupHooks {
  /**
   * Called once a step is recorded in the run record.
   * @param step - the step that finished.
   */
  readonly afterStep?: (step: SetupStep) => void
}

/** What setup runs against. */
export interface SetupRequest {
  /** The Delo home, already prepared and set as `DSH_HOME`. */
  readonly home: string
  /** The CLI profile to set up. */
  readonly profile: string
  /** Where setup writes. */
  readonly output: CommandOutput
  /** The environment `delorun` inherited; `--yes` reads the model key from it. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** How the answers are given. */
  readonly form: SetupForm
  /** Test seams. */
  readonly hooks?: SetupHooks
  /** The sections; this build's by default. */
  readonly registry?: SectionRegistry
  /** The live key check; one request to the provider by default. */
  readonly keyCheck?: KeyCheck
  /** Whether a key read from the environment is checked too (`--check-key`). */
  readonly checkEnvironmentKey?: boolean
  /** Whether a local port is free; a listen on the loopback address by default. */
  readonly portIsFree?: (port: number) => Promise<boolean>
  /** What the end of a terminal run does on the computer; install, start and open on this computer by default. */
  readonly ending?: Ending
}

/**
 * Upstream's resolution and plugin operation for a profile under the home; the operation runs an installed Delo's own
 * pnpm ([package manager](../package-manager.ts)).
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns what {@link linkDeloBundles} uses.
 */
export async function upstreamLinking(home: string, profile: string): Promise<BundleLinking> {
  // Loaded after the launch variables are set, so upstream resolves the Delo home.
  const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
  const { runPluginCommand } = await import('@deepseek-ai/dsh-plugin-manager/operations')
  return {
    installAnchor: INSTALL_ANCHOR,
    async resolve() {
      const loaded = loadProfile('delorun', profile, INSTALL_ANCHOR, home)
      return { profile: loaded, resolution: await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile: loaded, home }) }
    },
    runPluginCommand: (context, args, options) => runPluginCommand(context, args, { ...options, ...shippedPackageManager() }),
  }
}

/**
 * @param form - the interactive form.
 * @returns the form's prompter, or the terminal's.
 * @throws {CliError} `EXIT.usage` when the questions need a terminal and stdin is not one.
 */
function prompterFor(form: { readonly prompter?: Prompter }): Prompter {
  if (form.prompter !== undefined) return form.prompter
  if (process.stdin.isTTY !== true) {
    throw new CliError(EXIT.usage, 'delorun setup: the questions need a terminal; run delorun setup in one, or with --yes, or with --config <file>')
  }
  return terminalPrompter()
}

/**
 * Whether nothing listens on a local port.
 * @param port - the port.
 * @returns true when a listen on the loopback address succeeds.
 */
export function loopbackPortIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.listen(port, '127.0.0.1', () => { server.close(() => { resolve(true) }) })
  })
}

/**
 * What the sections of a run may look at.
 * @param request - the run.
 * @param profileExists - whether the profile exists already.
 * @returns the environment.
 */
function sectionEnvironment(request: SetupRequest, profileExists: boolean): SectionEnvironment {
  return {
    env: request.env,
    home: request.home,
    profile: request.profile,
    profileExists,
    profileNameTaken: name => hasCliProfile(request.home, name),
    checkKey: request.keyCheck ?? liveKeyCheck(request.env),
    checkEnvironmentKey: request.checkEnvironmentKey === true,
    portIsFree: request.portIsFree ?? loopbackPortIsFree,
  }
}

/**
 * Check the key an unattended run reads from the environment, when `--check-key` asks for it.
 * @param request - the run.
 * @param answers - the answers, whose credential names the variable.
 * @throws {CliError} `EXIT.failed` when the provider does not accept the key; the message never holds it.
 */
async function checkUnattendedKey(request: SetupRequest, answers: SetupAnswers): Promise<void> {
  if (request.checkEnvironmentKey !== true || answers.modelProvider.credential.source !== 'environment') return
  const result = await (request.keyCheck ?? liveKeyCheck(request.env))(request.env[answers.modelProvider.credential.name] as string)
  if (!result.ok) throw new CliError(EXIT.failed, `delorun setup: the key in ${answers.modelProvider.credential.name} was not accepted: ${result.reason}`)
}

/**
 * Get the answers for a run that has none recorded yet.
 * @param request - the run.
 * @param registry - the sections.
 * @returns the answers and the typed key, if any.
 */
async function collectAnswers(request: SetupRequest, registry: SectionRegistry): Promise<{ answers: SetupAnswers, secret: string | undefined }> {
  const { form, env } = request
  if (form.kind === 'yes') {
    const answers = { ...yesAnswers(env), sections: unattendedRecord(registry.all()) }
    await checkUnattendedKey(request, answers)
    return { answers, secret: undefined }
  }
  if (form.kind === 'config') {
    const document = readAnswersDocument(form.path)
    const credential = document.modelProvider.credential
    if (credential.source === 'environment' && (env[credential.name] ?? '') === '') {
      throw new CliError(EXIT.failed, `delorun setup: ${credential.name} is not set; set it to the model key`)
    }
    const answers = { ...document, sections: unattendedRecord(registry.all()) }
    await checkUnattendedKey(request, answers)
    return { answers, secret: undefined }
  }
  return askAnswers(prompterFor(form), registry, sectionEnvironment(request, false))
}

/**
 * Run one step. Each writes the same values when it runs again.
 * @param step - the step.
 * @param request - the request.
 * @param registry - the sections.
 * @param profile - the profile being set up.
 * @param progress - the run record, for the answers the step applies.
 * @param secret - the typed key, needed by the key section when its answer is a prompt.
 * @returns a note for the person about what the step did not write, if any.
 */
async function runStep(step: SetupStep, request: SetupRequest, registry: SectionRegistry, profile: string, progress: SetupProgress, secret: string | undefined): Promise<string | undefined> {
  const directory = profileDirectory(request.home, profile)
  if (step === PROFILE_STEP) {
    if (!hasCliProfile(request.home, profile)) {
      try {
        initProfile(directory, DELO_PROFILE_BUNDLES)
      } catch (error) {
        throw new CliError(EXIT.failed, `delorun setup: could not create the CLI profile ${profile} at ${directory}: ${String(Reflect.get(Object(error), 'message'))}`)
      }
    }
    // Runs again when an interrupted run resumes this step; a bundle already importable is left alone.
    await linkDeloBundles(request.home, profile, DELO_PROFILE_BUNDLES, await upstreamLinking(request.home, profile), (text) => { request.output.stderr(text) })
    return undefined
  }
  const section = registry.all().find(candidate => sectionStep(candidate.id) === step) as SetupSection
  return section.apply({ home: request.home, env: request.env, directory, secret }, progress.answers)
}

/**
 * The steps of a run, in order.
 * @param registry - the sections.
 * @returns the profile step, then one step per section.
 */
function stepsOf(registry: SectionRegistry): SetupStep[] {
  return [PROFILE_STEP, ...registry.all().map(section => sectionStep(section.id))]
}

/**
 * Run setup for a CLI profile. A finished setup leaves the profile unchanged. A run that
 * was interrupted resumes from its record.
 * @param request - the home, profile, output, environment and form.
 * @returns the exit code.
 * @throws {CliError} for a refused answer, a missing key or a failed step.
 */
export async function runSetup(request: SetupRequest): Promise<ExitCode> {
  const registry = request.registry ?? defaultRegistry()
  const runDir = runDirectory(request.home, request.profile)
  let progress = readProgress(runDir)
  if (progress === undefined && hasCliProfile(request.home, request.profile)) {
    request.output.stdout(`The CLI profile ${request.profile} is already set up at ${profileDirectory(request.home, request.profile)}.\n`)
    return EXIT.ok
  }
  let secret: string | undefined
  if (request.form.kind !== 'interactive') request.output.stdout(`${statementLines().join('\n')}\n`)
  if (progress === undefined) {
    const collected = await collectAnswers(request, registry)
    progress = { answers: collected.answers, completed: [] }
    writeProgress(runDir, progress)
    secret = collected.secret
  } else {
    if (progress.answers.modelProvider.credential.source === 'prompt' && !progress.completed.includes(sectionStep('key'))) {
      if (request.form.kind !== 'interactive') throw new CliError(EXIT.failed, `delorun setup: the setup run for ${request.profile} is unfinished and needs the model key; run delorun setup in a terminal to finish it`)
      secret = await prompterFor(request.form).secret('DeepSeek API key')
    }
    request.output.stdout(`Resuming the setup of ${request.profile}.\n`)
  }

  const profile = progress.answers.profile.name ?? request.profile
  for (const step of stepsOf(registry)) {
    if (progress.completed.includes(step)) continue
    const note = await runStep(step, request, registry, profile, progress, secret)
    if (note !== undefined) request.output.stdout(`${note}\n`)
    const next: SetupProgress = { answers: progress.answers, completed: [...progress.completed, step] }
    writeProgress(runDir, next)
    progress = next
    request.hooks?.afterStep?.(step)
  }
  const directory = profileDirectory(request.home, profile)
  writeAnswersRecord(directory, progress.answers)
  removeProgress(runDir)
  request.output.stdout(`Set up the CLI profile ${profile} at ${directory}.\n`)
  if (request.form.kind !== 'interactive') {
    request.output.stdout(`Run delorun${profile === 'default' ? '' : ` --profile ${profile}`} to start Delo and open the studio.\n`)
    return EXIT.ok
  }
  return finishSetup(prompterFor(request.form), request.ending ?? computerEnding(request.home, profile, request.output, request.env), { profile, background: progress.answers.background, output: request.output })
}

/**
 * The answers a finished setup recorded for a profile.
 * @param directory - the profile's directory.
 * @returns the recorded answers, or the defaults when there is no usable record.
 */
function recordedAnswers(directory: string): SetupAnswers {
  const path = join(directory, ANSWERS_FILENAME)
  if (!existsSync(path)) return SETUP_DEFAULTS
  try {
    const { version: _version, ...answers } = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const checked = answersSchema.safeParse(answers)
    return checked.success ? checked.data : SETUP_DEFAULTS
  } catch {
    // An unreadable record is rewritten by the section that runs now; the defaults stand in for it.
    return SETUP_DEFAULTS
  }
}

/**
 * Run one section again on a profile that is set up: ask its question, write its changes and update the answers
 * record.
 * @param request - the home, profile, output, environment and prompter; its form is the interactive one.
 * @param id - the section id.
 * @returns the exit code.
 * @throws {CliError} `EXIT.usage` for an unknown section, `EXIT.failed` for a section that does not apply or a profile that is not set up.
 */
export async function runSection(request: SetupRequest, id: string): Promise<ExitCode> {
  const registry = request.registry ?? defaultRegistry()
  const section = registry.find(id)
  if (section === undefined) throw new CliError(EXIT.usage, `delorun setup: there is no section ${JSON.stringify(id)}; delorun setup --list shows them`)
  if (!hasCliProfile(request.home, request.profile)) {
    throw new CliError(EXIT.failed, `delorun setup: the CLI profile ${request.profile} is not set up; run delorun setup first`)
  }
  const environment = sectionEnvironment(request, true)
  if (!section.appliesTo(environment)) throw new CliError(EXIT.failed, `delorun setup: the ${id} section does not apply on this computer`)
  if (request.form.kind !== 'interactive') throw new CliError(EXIT.usage, 'delorun setup: a section asks its question in a terminal; --yes and --config do not apply to it')
  const prompter = prompterFor(request.form)
  const directory = profileDirectory(request.home, request.profile)
  const draft: Draft = { mode: 'full', answers: recordedAnswers(directory), secret: undefined }
  const given = await section.ask(stepIO(prompter, false), draft, environment) as Exclude<Awaited<ReturnType<SetupSection['ask']>>, typeof BACK>
  const answers: SetupAnswers = { ...draft.answers, ...given.answers, sections: withRecord(draft.answers.sections, section.id, given.status) }
  const note = await section.apply({ home: request.home, env: request.env, directory, secret: given.secret }, answers)
  if (note !== undefined) request.output.stdout(`${note}\n`)
  writeAnswersRecord(directory, answers)
  request.output.stdout(`Updated the ${id} section of the profile ${request.profile}. If Delorun is running, restart it for the change to take effect: delorun stop, then delorun start.\n`)
  return EXIT.ok
}

/**
 * The `--list` text.
 * @param registry - the sections.
 * @returns one line per section.
 */
export function sectionList(registry: SectionRegistry): string {
  const sections = registry.all()
  const width = Math.max(...sections.map(section => section.id.length))
  return `${[
    'Sections (delorun setup <section> runs one again):',
    ...sections.map(section => `  ${section.id.padEnd(width)}  ${section.title} (${section.mode === 'quick' ? 'Quick and Full' : 'Full'})`),
  ].join('\n')}\n`
}

/** `delorun setup [<section>] [--profile <name>] [--yes | --config <file>] [--check-key] [--list]`. */
export const setupCommand: CliCommand = {
  name: 'setup',
  summary: 'Set up Delorun (Quick or Full), or run one section again: delorun setup <section>; --list lists them',
  async run(args, context) {
    const { values, positionals } = (() => {
      try {
        return parseArgs({ args: [...args], options: { profile: { type: 'string' }, yes: { type: 'boolean', default: false }, config: { type: 'string' }, 'check-key': { type: 'boolean', default: false }, list: { type: 'boolean', default: false } }, strict: true, allowPositionals: true })
      } catch (error) {
        // parseArgs throws a TypeError with an ERR_PARSE_ARGS_* code for an unknown or malformed option.
        throw new CliError(EXIT.usage, `delorun setup: ${String(Reflect.get(Object(error), 'message'))}`)
      }
    })()
    const registry = defaultRegistry()
    if (values.list) {
      context.stdout(sectionList(registry))
      return EXIT.ok
    }
    if (positionals.length > 1) throw new CliError(EXIT.usage, 'delorun setup: give one section, or none')
    if (values.yes && values.config !== undefined) throw new CliError(EXIT.usage, 'delorun setup: --yes and --config are two forms of the same answers; give one')
    const { home, profile } = await prepareHome(context, values.profile)
    const form = formFromFlags(values.yes, values.config)
    const request: SetupRequest = { home: home.path, profile, output: context, env: context.env, form, registry, checkEnvironmentKey: values['check-key'] }
    const [section] = positionals
    return section === undefined ? runSetup(request) : runSection(request, section)
  },
}

/**
 * The form a `delorun setup` command line names: `--yes`, `--config <file>`, or the questions when neither is given.
 * @param yes - whether `--yes` was given.
 * @param config - the `--config` path, if given.
 * @returns the form.
 * @throws {CliError} `EXIT.failed` when the `--config` file does not exist.
 */
export function formFromFlags(yes: boolean, config: string | undefined): SetupForm {
  if (yes) return { kind: 'yes' }
  if (config !== undefined) {
    if (!existsSync(config)) throw new CliError(EXIT.failed, `delorun setup --config: ${config} does not exist`)
    return { kind: 'config', path: config }
  }
  return { kind: 'interactive' }
}
