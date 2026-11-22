/**
 * Setup's entry point: `delorun setup`, and `delorun` on a home without a CLI profile. In a terminal it asks the
 * sections the main flow asks ([sections](./sections.ts)); with `--yes`, with `--config`, or when standard input is not a
 * terminal it asks nothing and takes the defaults, the document or the flags ([unattended](./unattended.ts)); then it runs its
 * steps: create the CLI profile and make Delorun's bundles importable in it ({@link linkDelorunBundles}), with the plugin
 * operation's output in the profile's `home-<profile>` operational log and one progress line on the terminal, then each
 * section's writes in order (the release-check row, the model provider and its key, the prompts rows, the studio port), and record the
 * run. Every write lands before Delorun first starts, so a release check turned off here never runs. The three forms
 * produce the same answers and so the same writes. An interrupted run resumes at the first step that did not finish.
 * Setup never replaces an existing profile; a finished one is asked again in a terminal ([current answers](./current.ts)). A fresh terminal run
 * then starts Delorun in this terminal and opens the studio, and asks the PIN and keep-the-command questions while it runs
 * ([foreground](./foreground.ts)); every other run prints the next steps and starts nothing ([ending](./ending.ts)). `delorun setup <section>` runs one section again; `--list` lists them.
 *
 * @module @delorun/cli/setup
 */
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRuntimeResolution, initProfile, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { DELORUN_PROFILE_BUNDLES } from '@delorun/bundle-local/profile'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { prepareHome, type CliCommand, type CommandOutput, type CommandResult } from '../command.ts'
import { parseArgs } from 'node:util'
import { linkDelorunBundles, type BundleLinking } from '../delorun-bundles.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { runDirectory } from '@delorun/home'
import { Redactor, resolveSurface, SurfaceLog } from '@delorun/logs'
import { PROMPTS_OPTIONS, SETUP_DEFAULT_PORT, SETUP_DEFAULTS, type ModelProviderAnswer, type PromptsAnswer, type SetupAnswers } from '@delorun/contract-setup-answers'
import { baseURLWarning, checkCatalogModel, chosenProvider, readAnswersDocument, yesAnswers, type ProviderChoice } from './answers.ts'
import { currentAnswers } from './current.ts'
import { promptsFromFlags } from './dangerous.ts'
import { channelOriginOf } from './channel-origin.ts'
import { checkSandboxHere } from '../doctor/sandbox.ts'
import type { CheckResult } from '../doctor/checks.ts'
import { nextSteps } from './ending.ts'
import { runForeground, terminalForeground, type ForegroundDependencies } from './foreground.ts'
import { styleOf } from '../style.ts'
import { delorunVersion } from '../version.ts'
import { askAnswers } from './interactive.ts'
import { applyAnswerFlags, flagDefaults, portFromFlag, type AnswerFlags } from './unattended.ts'
import { liveKeyCheck, type KeyCheck } from './key-check.ts'
import { keyTarget } from './provider-section.ts'
import { installedCatalog, SETUP_PROVIDERS, type ProviderCatalog } from './providers.ts'
import { PROFILE_STEP, readProgress, removeProgress, sectionStep, writeAnswersRecord, writeProgress, type SetupProgress, type SetupStep } from './progress.ts'
import { defaultRegistry, statementLines, unattendedRecord, withRecord, type Draft, type SectionEnvironment, type SectionRegistry, type SetupSection } from './sections.ts'
import { SetupCancelled, terminalPrompter, type Prompter } from './prompts.ts'
import type { BACK } from './steps.ts'
import { stepIO } from './steps.ts'
import { hasStoredCredential } from './writes.ts'
import { shippedPackageManager } from '../package-manager.ts'
import { brandUpstreamOutput } from '../upstream-output.ts'

/** How setup gets its answers. */
export type SetupForm =
  /** The questions. Tests pass a prompter; a terminal run leaves it to setup. */
  | { readonly kind: 'interactive'; readonly prompter?: Prompter }
  /** Every default, with the provider `--provider` names and its key from the environment, or no provider. */
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
  /** The Delorun home, already prepared and set as `DSH_HOME`. */
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
  /** The installed catalogs the provider answers are checked against; the adapters' own by default. */
  readonly catalog?: () => Promise<ProviderCatalog>
  /** The provider `--provider` and its flags name, for `--yes` and for `delorun setup key`. */
  readonly providerChoice?: ProviderChoice
  /** The prompts answer `--prompts` names for `--yes`; `--yes` keeps setup's default without it, and never selects `dangerous` on its own. */
  readonly promptsAnswer?: PromptsAnswer
  /** Whether a key read from the environment is checked too (`--check-key`). */
  readonly checkEnvironmentKey?: boolean
  /** Whether the release check is turned off whatever the form says (`--no-update-check`); Full asks with No preselected. */
  readonly noUpdateCheck?: boolean
  /** The flags `--phone`, `--import-dsh` and `--port`: answers that pre-select a question, or take it without one. */
  readonly answerFlags?: AnswerFlags
  /** Whether a local port is free; a listen on the loopback address by default. */
  readonly portIsFree?: (port: number) => Promise<boolean>
  /** The sandbox check printed at the end of setup; `delorun doctor`'s check on Linux by default, nothing elsewhere. */
  readonly sandboxCheck?: () => Promise<CheckResult | undefined>
  /**
   * What a fresh terminal run starts Delorun with. Without it the run starts nothing and prints the next steps, as a run
   * without a terminal does; `delorun` and `delorun setup` pass {@link terminalForeground}.
   */
  readonly foreground?: ForegroundDependencies
}

/**
 * Upstream's resolution and plugin operation for a profile under the home; the operation runs an installed Delorun's own
 * pnpm ([package manager](../package-manager.ts)).
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @returns what {@link linkDelorunBundles} uses.
 */
export async function upstreamLinking(home: string, profile: string): Promise<BundleLinking> {
  // Loaded after the launch variables are set, so upstream resolves the Delorun home.
  const { INSTALL_ANCHOR } = await import('@deepseek-ai/dsh/profile-boot')
  const { runPluginCommand } = await import('@deepseek-ai/dsh-plugin-manager/operations')
  return {
    installAnchor: INSTALL_ANCHOR,
    async resolve() {
      const loaded = loadProfile('delorun', profile, INSTALL_ANCHOR, home)
      return { profile: loaded, resolution: await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, profile: loaded, home }) }
    },
    runPluginCommand: (context, args, options) => {
      const { onOutput } = options
      return runPluginCommand(context, args, { ...options, ...shippedPackageManager(), ...onOutput === undefined ? {} : { onOutput: (text, stream) => { onOutput(brandUpstreamOutput(text), stream) } } })
    },
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
    hasSavedKey: name => hasStoredCredential(request.home, name),
  }
}

/** An unattended form that names its provider without a question. */
interface UnattendedForm {
  /** The command, which starts a refusal's message. */
  readonly source: string
  /** Where the form names its provider and model: the flags, or the document's `modelProvider`. */
  readonly provider: string
  /** The flag or document field that names the model. */
  readonly modelField: string
}

/** The flags of `--yes` and `delorun setup key`. */
const FLAGS_FORM = (source: string): UnattendedForm => ({ source, provider: 'with --provider', modelField: '--model' })

/** The `--config` document. */
const CONFIG_FORM: UnattendedForm = { source: 'delorun setup --config', provider: 'in the document\'s modelProvider', modelField: 'modelProvider.model' }

/**
 * Check a provider answer of an unattended form: its model against the installed catalog, its base URL, and, when
 * `--check-key` asks for it, the key it reads from the environment. A base URL that reaches another computer over plain
 * `http` is accepted with a warning on standard error.
 * @param request - the run.
 * @param answer - the provider answer, or `null`.
 * @param form - the form, which shapes the messages.
 * @throws {CliError} `EXIT.usage` for `--check-key` without a provider; `EXIT.failed` for a model the catalog does not
 *   list, an unset variable, or a key the provider does not accept; the message never holds the key.
 */
async function checkUnattendedProvider(request: SetupRequest, answer: ModelProviderAnswer | null, form: UnattendedForm): Promise<void> {
  if (answer === null) {
    if (request.checkEnvironmentKey === true) throw new CliError(EXIT.usage, `${form.source}: --check-key checks the chosen provider's key; name a provider ${form.provider}`)
    return
  }
  const catalog = await (request.catalog ?? installedCatalog)()
  checkCatalogModel(answer, catalog, form.source, form.modelField)
  const warning = answer.baseURL === null ? undefined : baseURLWarning(answer.baseURL)
  if (warning !== undefined) request.output.stderr(`${form.source}: warning: ${warning}\n`)
  if (answer.credential.source !== 'environment') return
  const name = answer.credential.name
  const key = request.env[name] ?? ''
  if (key === '') throw new CliError(EXIT.failed, `${form.source}: ${name} is not set; set it to the ${SETUP_PROVIDERS[answer.id].label} key`)
  if (request.checkEnvironmentKey !== true) return
  const result = await (request.keyCheck ?? liveKeyCheck(request.env))(keyTarget(SETUP_PROVIDERS[answer.id], answer.baseURL, catalog), key)
  if (!result.ok) throw new CliError(EXIT.failed, `delorun setup: the key in ${name} was not accepted: ${result.reason}`)
}

/**
 * Get the answers for a run that has none recorded yet.
 * @param request - the run.
 * @param registry - the sections.
 * @param current - the answers a finished profile holds, for a re-run: every question starts on them.
 * @returns the answers, the typed key if any, and whether the run keeps the saved key.
 */
async function collectAnswers(request: SetupRequest, registry: SectionRegistry, current?: SetupAnswers): Promise<{ answers: SetupAnswers, secret: string | undefined, keepSavedKey: boolean }> {
  const { form, env } = request
  const flags: Partial<SetupAnswers> = request.noUpdateCheck === true ? { updateCheck: false } : {}
  const answerFlags = request.answerFlags ?? {}
  if (form.kind === 'yes') {
    const base = { ...yesAnswers(env, request.providerChoice), ...request.promptsAnswer === undefined ? {} : { prompts: request.promptsAnswer }, ...flags, sections: unattendedRecord(registry.all()) }
    await checkUnattendedProvider(request, base.modelProvider, FLAGS_FORM('delorun setup --yes'))
    const answers = await applyAnswerFlags(answerFlags, base, registry, sectionEnvironment(request, false), request.output)
    return { answers, secret: undefined, keepSavedKey: false }
  }
  if (form.kind === 'config') {
    const document = readAnswersDocument(form.path, (line) => { request.output.stderr(`${line}\n`) })
    const answers = { ...document, ...flags, sections: unattendedRecord(registry.all()) }
    await checkUnattendedProvider(request, answers.modelProvider, CONFIG_FORM)
    return { answers, secret: undefined, keepSavedKey: false }
  }
  // The model key is the studio's first-open question, so a first run starts with no provider chosen.
  const asked = await askAnswers(prompterFor(form), registry, sectionEnvironment(request, current !== undefined), { ...current ?? { ...SETUP_DEFAULTS, modelProvider: null }, ...flagDefaults(answerFlags), ...flags })
  // A re-run does not ask for the key, so the key saved under the provider's variable stays the one the profile uses.
  const provider = asked.answers.modelProvider
  const keepsSaved = current !== undefined && provider?.credential.source === 'prompt' && hasStoredCredential(request.home, SETUP_PROVIDERS[provider.id].keyVariable)
  return { ...asked, keepSavedKey: asked.keepSavedKey || keepsSaved }
}

/**
 * The line above the first question: the product, its version and where the new home will be.
 * @param home - the Delorun home.
 * @param env - the environment, which decides the colour and names the user's home folder.
 * @returns the line with its line ending.
 */
function setupHeader(home: string, env: Readonly<Record<string, string | undefined>>): string {
  const style = styleOf(env)
  const version = String(delorunVersion())
  const user = env.HOME
  const shown = user !== undefined && user !== '' && home.startsWith(`${user}/`) ? `~${home.slice(user.length)}` : home
  return `${style.badge()} ${version === '0.0.0' ? 'source build' : version} ${style.dim(`· new home in ${shown}`)}\n`
}

/** How many ports after the default {@link settlePort} tries before it gives up. */
const PORT_SEARCH = 100

/**
 * Keep the default studio port only when it is free: otherwise pick the next free one and say so. A port the person chose
 * is left to the profile section, which checks it when it asks.
 * @param request - the run.
 * @param answers - the collected answers.
 * @returns the answers, with `profile.port` set to the next free port when the default one is in use.
 * @throws {CliError} when no port in the search range is free.
 */
async function settlePort(request: SetupRequest, answers: SetupAnswers): Promise<SetupAnswers> {
  if (answers.profile.port !== null) return answers
  const isFree = request.portIsFree ?? loopbackPortIsFree
  if (await isFree(SETUP_DEFAULT_PORT)) return answers
  for (let port = SETUP_DEFAULT_PORT + 1; port <= SETUP_DEFAULT_PORT + PORT_SEARCH; port++) {
    if (!await isFree(port)) continue
    request.output.stdout(`! Port ${String(SETUP_DEFAULT_PORT)} is in use, so the studio will use ${String(port)}. Change it later with: delorun setup profile\n`)
    return { ...answers, profile: { ...answers.profile, port } }
  }
  throw new CliError(EXIT.failed, `delorun setup: ports ${String(SETUP_DEFAULT_PORT)} to ${String(SETUP_DEFAULT_PORT + PORT_SEARCH)} are all in use on this computer; free one, or choose a port with delorun setup profile`)
}

/** The most detailed level setup writes to the operational log; the home process's log uses the same. */
const SETUP_LOG_LEVEL = 'info'

/**
 * Open the profile's `home-<profile>` operational log (contract C20) for setup's records, as no home process writes it
 * yet: the output of the plugin operation that links Delorun's bundles goes there instead of the terminal.
 * @param home - the Delorun home.
 * @param profile - the profile being set up.
 * @returns the open log; the caller closes it.
 * @throws {HomeLayoutError} when the log directory or file is laxer than C1 allows.
 * @throws {LogsError} `PROFILE_INVALID` for a profile name the log's directory cannot carry.
 */
export function openSetupLog(home: string, profile: string): SurfaceLog {
  return SurfaceLog.open({
    location: resolveSurface({ kind: 'home', home, profile }),
    redactor: new Redactor(),
    pid: process.pid,
    level: SETUP_LOG_LEVEL,
    // A record the writer cannot write is dropped, as the home process's own log drops it; the link's outcome still reaches the terminal.
    onFailure: () => {},
    now: Date.now,
  })
}

/**
 * Run one step. Each writes the same values when it runs again.
 * @param step - the step.
 * @param request - the request.
 * @param registry - the sections.
 * @param profile - the profile being set up.
 * @param progress - the run record, for the answers the step applies.
 * @param secret - the typed key, needed by the key section when its answer is a prompt.
 * @param keepSavedKey - whether the key section keeps the key saved in the home.
 * @returns a note for the person about what the step did not write, if any.
 */
async function runStep(step: SetupStep, request: SetupRequest, registry: SectionRegistry, profile: string, progress: SetupProgress, secret: string | undefined, keepSavedKey: boolean): Promise<string | undefined> {
  const directory = profileDirectory(request.home, profile)
  if (step === PROFILE_STEP) {
    if (!hasCliProfile(request.home, profile)) {
      try {
        initProfile(directory, DELORUN_PROFILE_BUNDLES)
      } catch (error) {
        throw new CliError(EXIT.failed, `delorun setup: could not create the CLI profile ${profile} at ${directory}: ${String(Reflect.get(Object(error), 'message'))}`)
      }
    }
    // Runs again when an interrupted run resumes this step; a bundle already importable is left alone.
    const log = openSetupLog(request.home, profile)
    try {
      await linkDelorunBundles(request.home, profile, DELORUN_PROFILE_BUNDLES, await upstreamLinking(request.home, profile), { log, progress: (text) => { request.output.stdout(text) } })
    } finally {
      log.close()
    }
    return undefined
  }
  const section = registry.all().find(candidate => sectionStep(candidate.id) === step) as SetupSection
  return section.apply({ home: request.home, env: request.env, directory, secret, keepSavedKey }, progress.answers)
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
 * Whether the questions can be asked now: a prompter was given, or stdin is a terminal.
 * @param form - the interactive form.
 * @returns true when {@link prompterFor} would not refuse.
 */
function canAsk(form: { readonly prompter?: Prompter }): boolean {
  return form.prompter !== undefined || process.stdin.isTTY === true
}

/** What a re-run says before its first question. */
const RERUN_LINE = (profile: string): string => `Delorun is already set up${profile === 'default' ? '' : ` for the profile ${profile}`}. This run asks every question again with your current choices selected, and changes only the answers you change.\n`

/**
 * Run setup for a CLI profile. A run that was interrupted resumes from its record. A finished setup run in a terminal
 * asks every question again with the profile's current choices selected and writes only the sections whose answer
 * changed; with `--yes` or `--config` it leaves the profile unchanged.
 * @param given - the home, profile, output, environment and form; an interactive form without a prompter on a standard input that is not a terminal runs as `--yes`.
 * @returns the exit code; `undefined` when a fresh terminal run started Delorun, whose profile runner then owns the exit code.
 * @throws {CliError} for a refused answer, a missing key or a failed step.
 */
export async function runSetup(given: SetupRequest): Promise<CommandResult> {
  // Without a terminal there is nobody to ask: the run takes the defaults and the flags, as `--yes` does.
  const request: SetupRequest = given.form.kind === 'interactive' && !canAsk(given.form) ? { ...given, form: { kind: 'yes' } } : given
  const registry = request.registry ?? defaultRegistry(request.catalog)
  const runDir = runDirectory(request.home, request.profile)
  let progress = readProgress(runDir)
  const finished = progress === undefined && hasCliProfile(request.home, request.profile)
  if (finished && request.form.kind !== 'interactive') {
    request.output.stdout(`Delorun is already set up${request.profile === 'default' ? '' : ` for the profile ${request.profile}`}. Change one answer with delorun setup <section> (delorun setup --list shows them), or start with delorun.\n`)
    return EXIT.ok
  }
  let secret: string | undefined
  let keepSavedKey = false
  // The answers a re-run started from, which decide the sections it leaves alone.
  let before: SetupAnswers | undefined
  if (request.form.kind !== 'interactive') request.output.stdout(`${statementLines(await channelOriginOf(request.home)).join('\n')}\n`)
  if (progress === undefined) {
    if (finished) {
      request.output.stdout(RERUN_LINE(request.profile))
      // The run records the sections it asks itself.
      before = { ...currentAnswers(profileDirectory(request.home, request.profile)), sections: [] }
    }
    if (request.form.kind === 'interactive' && !finished) request.output.stdout(setupHeader(request.home, request.env))
    const collected = await collectAnswers(request, registry, before)
    // A re-run changes the existing profile, whatever name the answers carry.
    const named = finished ? { ...collected.answers, profile: { ...collected.answers.profile, name: null } } : collected.answers
    const answers = finished ? named : await settlePort(request, named)
    progress = { answers, completed: finished ? [PROFILE_STEP] : [], ...collected.keepSavedKey ? { credentialSource: 'keep' } : {} }
    writeProgress(runDir, progress)
    secret = collected.secret
    keepSavedKey = collected.keepSavedKey
  } else {
    const provider = progress.answers.modelProvider
    // The saved key is read at the key step, never held in the record; a key removed since the interruption is asked for again.
    keepSavedKey = provider !== null && progress.credentialSource === 'keep' && hasStoredCredential(request.home, SETUP_PROVIDERS[provider.id].keyVariable)
    if (provider?.credential.source === 'prompt' && !keepSavedKey && !progress.completed.includes(sectionStep('key'))) {
      if (request.form.kind !== 'interactive') throw new CliError(EXIT.failed, `delorun setup: the setup run for ${request.profile} is unfinished and needs the model key; run delorun setup in a terminal to finish it`)
      try {
        secret = await prompterFor(request.form).secret(`${SETUP_PROVIDERS[provider.id].label} API key`)
      } catch (error) {
        if (error instanceof SetupCancelled) throw new SetupCancelled(`The answers of the earlier run are kept for ${request.profile}.`)
        throw error
      }
    }
    request.output.stdout(`Resuming the setup of ${request.profile}.\n`)
  }

  const profile = finished ? request.profile : progress.answers.profile.name ?? request.profile
  const kept: string[] = []
  for (const step of stepsOf(registry)) {
    if (progress.completed.includes(step)) continue
    const section = registry.all().find(candidate => sectionStep(candidate.id) === step)
    if (before !== undefined && section?.unchanged?.(before, progress.answers, secret !== undefined) === true) {
      kept.push(section.title.toLowerCase())
    } else {
      const note = await runStep(step, request, registry, profile, progress, secret, keepSavedKey)
      if (note !== undefined) request.output.stdout(`${note}\n`)
    }
    const next: SetupProgress = { ...progress, completed: [...progress.completed, step] }
    writeProgress(runDir, next)
    progress = next
    request.hooks?.afterStep?.(step)
  }
  if (kept.length > 0) request.output.stdout(`Kept as they were: ${kept.join(', ')}.\n`)
  const directory = profileDirectory(request.home, profile)
  writeAnswersRecord(directory, progress.answers)
  removeProgress(runDir)
  const sandbox = await (request.sandboxCheck ?? (() => process.platform === 'linux' ? checkSandboxHere(request.env.PATH) : Promise.resolve(undefined)))()
  const channelOrigin = await channelOriginOf(request.home)
  if (request.foreground !== undefined && request.form.kind === 'interactive' && !finished) {
    return runForeground({ home: request.home, profile, output: request.output, env: request.env, answers: progress.answers, prompter: prompterFor(request.form), channelOrigin, sandbox, dependencies: request.foreground })
  }
  request.output.stdout(nextSteps({ profile, answers: progress.answers, env: request.env, channelOrigin, sandbox }))
  return EXIT.ok
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
  const registry = request.registry ?? defaultRegistry(request.catalog)
  const section = registry.find(id)
  if (section === undefined) throw new CliError(EXIT.usage, `delorun setup: there is no section ${JSON.stringify(id)}; delorun setup --list shows them`)
  if (!hasCliProfile(request.home, request.profile)) {
    throw new CliError(EXIT.failed, `delorun setup: the CLI profile ${request.profile} is not set up; run delorun setup first`)
  }
  const environment = sectionEnvironment(request, true)
  if (!section.appliesTo(environment)) throw new CliError(EXIT.failed, `delorun setup: the ${id} section does not apply on this computer`)
  if (request.form.kind !== 'interactive') throw new CliError(EXIT.usage, 'delorun setup: a section asks its question in a terminal; --yes and --config do not apply to it')
  const directory = profileDirectory(request.home, request.profile)
  const draft: Draft = { phase: 'single', answers: currentAnswers(directory), secret: undefined, keyCheckFailure: undefined }
  let given: Exclude<Awaited<ReturnType<SetupSection['ask']>>, typeof BACK>
  if (request.providerChoice === undefined) {
    given = await section.ask(stepIO(prompterFor(request.form), false), draft, environment) as typeof given
  } else {
    // The flags answer the section's questions, so it runs without a terminal; the key is read from the environment.
    const answer = chosenProvider(request.providerChoice)
    await checkUnattendedProvider(request, answer, FLAGS_FORM('delorun setup key'))
    given = { answers: { modelProvider: answer }, status: 'answered' }
  }
  const answers: SetupAnswers = { ...draft.answers, ...given.answers, sections: withRecord(draft.answers.sections, section.id, given.status) }
  const note = await section.apply({ home: request.home, env: request.env, directory, secret: given.secret, keepSavedKey: given.keepSavedKey === true }, answers)
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
    ...sections.map(section => `  ${section.id.padEnd(width)}  ${section.title}`),
  ].join('\n')}\n`
}

/** The flags that name a provider, which apply to `--yes` and to `delorun setup key`. */
const PROVIDER_FLAGS = ['provider', 'model', 'base-url', 'key-env'] as const

/**
 * The provider a command line names.
 * @param values - the parsed flags.
 * @param section - the section the command line names, if any.
 * @param yes - whether `--yes` was given.
 * @returns the choice, or `undefined` when no provider flag was given.
 * @throws {CliError} `EXIT.usage` for a provider flag without `--provider`, or outside `--yes` and `delorun setup key`.
 */
export function providerChoiceFromFlags(values: Readonly<Partial<Record<(typeof PROVIDER_FLAGS)[number], string>>>, section: string | undefined, yes: boolean): ProviderChoice | undefined {
  const given = PROVIDER_FLAGS.filter(flag => values[flag] !== undefined)
  if (given.length === 0) return undefined
  if (!yes && section !== 'key') throw new CliError(EXIT.usage, `delorun setup: --${given.join(', --')} ${given.length === 1 ? 'applies' : 'apply'} to --yes and to delorun setup key; a --config document names its provider in modelProvider`)
  if (values.provider === undefined) throw new CliError(EXIT.usage, `delorun setup: --${given.join(', --')} ${given.length === 1 ? 'needs' : 'need'} --provider`)
  return { id: values.provider, model: values.model, baseURL: values['base-url'], keyEnv: values['key-env'] }
}

/**
 * `delorun setup [<section>] [--profile <name>] [--yes | --config <file>] [--phone] [--import-dsh] [--port <n>] [--provider <id> [--model <id>] [--base-url <url>] [--key-env <NAME>]] [--prompts <safer|stock|dangerous> [--accept-dangerous-mode]] [--check-key] [--no-update-check] [--list]`.
 * Without `--config`, `--yes` or a section, a standard input that is not a terminal makes the run take the defaults, as `--yes` does.
 * `--phone`, `--import-dsh` and `--port` answer a question of the whole setup: they pre-select it in a terminal and take it
 * without questions otherwise.
 */
export const setupCommand: CliCommand = {
  name: 'setup',
  summary: 'Set up Delorun, or run one section again: delorun setup <section>; --list lists them; export and import move a setup between computers',
  async run(args, context) {
    // `export` and `import` are not sections: they move a whole setup between computers.
    if (args[0] === 'export' || args[0] === 'import') return (await import('../changes/setup-transfer.ts')).runSetupTransfer(args, context)
    const { values, positionals } = (() => {
      try {
        return parseArgs({ args: [...args], options: {
          'profile': { type: 'string' }, 'yes': { type: 'boolean', default: false }, 'config': { type: 'string' }, 'check-key': { type: 'boolean', default: false },
          'no-update-check': { type: 'boolean', default: false }, 'list': { type: 'boolean', default: false },
          'provider': { type: 'string' }, 'model': { type: 'string' }, 'base-url': { type: 'string' }, 'key-env': { type: 'string' },
          'prompts': { type: 'string' }, 'accept-dangerous-mode': { type: 'boolean', default: false },
          'phone': { type: 'boolean', default: false }, 'import-dsh': { type: 'boolean', default: false }, 'port': { type: 'string' },
        }, strict: true, allowPositionals: true })
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
    if (values['no-update-check'] && positionals.length > 0) throw new CliError(EXIT.usage, 'delorun setup: --no-update-check applies to a whole setup; delorun setup privacy asks about the release check')
    const [section] = positionals
    const answerFlags: AnswerFlags = { ...values.phone ? { phone: true } : {}, ...values['import-dsh'] ? { importDsh: true } : {}, ...values.port === undefined ? {} : { port: portFromFlag(values.port) } }
    if (Object.keys(answerFlags).length > 0 && section !== undefined) throw new CliError(EXIT.usage, 'delorun setup: --phone, --import-dsh and --port apply to a whole setup; delorun setup reach, import and profile ask the same questions')
    if (Object.keys(answerFlags).length > 0 && values.config !== undefined) throw new CliError(EXIT.usage, 'delorun setup: --phone, --import-dsh and --port apply to --yes and to a terminal run; a --config document holds its own answers')
    // A whole setup without a terminal takes the defaults, so the flags that apply to `--yes` apply to it.
    const unattended = values.yes || (section === undefined && values.config === undefined && process.stdin.isTTY !== true)
    const providerChoice = providerChoiceFromFlags(values, section, unattended)
    const promptsAnswer = promptsFromFlags({ prompts: values.prompts, acceptDangerousMode: values['accept-dangerous-mode'] }, unattended, PROMPTS_OPTIONS)
    const { home, profile } = await prepareHome(context, values.profile, false)
    const form = formFromFlags(unattended, values.config)
    const request: SetupRequest = {
      home: home.path, profile, output: context, env: context.env, form, registry, checkEnvironmentKey: values['check-key'], noUpdateCheck: values['no-update-check'], answerFlags,
      ...providerChoice === undefined ? {} : { providerChoice },
      ...promptsAnswer === undefined ? {} : { promptsAnswer },
      ...section === undefined && !unattended ? { foreground: terminalForeground() } : {},
    }
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
