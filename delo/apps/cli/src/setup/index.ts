/**
 * Setup's entry point: `delorun setup`, and `delorun` on a home without a CLI profile. It asks the questions of
 * contract C11 in a terminal, or reads `--yes` or `--config`, then runs its steps: create the CLI profile and make
 * Delo's bundles importable in it ({@link linkDeloBundles}), store the model key, write the profile's opt-in rows and
 * record the run. The three forms produce the same answers and
 * so the same writes. An interrupted run resumes at the first step that did not finish. Setup never replaces an
 * existing profile.
 *
 * @module @delo/cli/setup
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntimeResolution, initProfile, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { DELO_PROFILE_BUNDLES } from '@delo/bundle-local/profile'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandOutput } from '../command.ts'
import { linkDeloBundles, type BundleLinking } from '../delo-bundles.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'
import { runDirectory } from '@delo/home'
import { SETUP_DEFAULT_CREDENTIAL_VARIABLE, type SetupAnswers } from '@delo/contract-setup-answers'
import { readAnswersDocument, yesAnswers } from './answers.ts'
import type { AliasCoverage } from '@deepseek-ai/dsh-sandbox-local'
import { probeDockerAliasCoverage, probeSandboxDialect, type SandboxDialect } from './dialect.ts'
import { askAnswers, showStatements, statementLines } from './interactive.ts'
import { readProgress, removeProgress, SETUP_STEPS, writeAnswersRecord, writeProgress, type SetupProgress, type SetupStep } from './progress.ts'
import { setPatchRow, storeCredential } from './writes.ts'
import { terminalPrompter, type Prompter } from './prompts.ts'

/** The upstream opt-in row for DeepSeek's session-log upload, which the CLI profile's patch sets. */
const SESSION_LOG_ROW = 'session-log-deepseek'

/** How setup gets its answers. */
export type SetupForm =
  /** The questions. Tests pass a prompter, a dialect and the Docker socket's alias coverage; a terminal run leaves them to setup. */
  | { readonly kind: 'interactive'; readonly prompter?: Prompter; readonly dialect?: SandboxDialect; readonly dockerCoverage?: AliasCoverage }
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
}

/**
 * Upstream's resolution and plugin operation for a profile under the home.
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
    runPluginCommand,
  }
}

/**
 * The prompter of an interactive form.
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
 * Get the answers for a run that has none recorded yet.
 * @param form - how the answers are given.
 * @param env - the environment.
 * @returns the answers and the typed key, if any.
 */
async function collectAnswers(form: SetupForm, env: Readonly<Record<string, string | undefined>>): Promise<{ answers: SetupAnswers, secret: string | undefined }> {
  if (form.kind === 'yes') return { answers: yesAnswers(env), secret: undefined }
  if (form.kind === 'config') {
    const answers = readAnswersDocument(form.path)
    const credential = answers.modelProvider.credential
    if (credential.source === 'environment' && (env[credential.name] ?? '') === '') {
      throw new CliError(EXIT.failed, `delorun setup: ${credential.name} is not set; set it to the model key`)
    }
    return { answers, secret: undefined }
  }
  const dialect = form.dialect ?? probeSandboxDialect(process.platform, process.env['PATH'])
  const dockerCoverage = form.dockerCoverage ?? probeDockerAliasCoverage(process.env['XDG_RUNTIME_DIR'])
  const { answers, secret } = await askAnswers(prompterFor(form), dialect, dockerCoverage)
  return { answers, secret }
}

/**
 * Run one step. Each writes the same values when it runs again.
 * @param step - the step.
 * @param request - the request; its profile directory is where the profile steps write.
 * @param progress - the run record, for the answers the step applies.
 * @param secret - the typed key, needed by the credential step when its answer is a prompt.
 * @returns a note for the person about what the step did not write, if any.
 */
async function runStep(step: SetupStep, request: SetupRequest, progress: SetupProgress, secret: string | undefined): Promise<string | undefined> {
  const directory = profileDirectory(request.home, request.profile)
  const { answers } = progress
  switch (step) {
    case 'profile': {
      if (!hasCliProfile(request.home, request.profile)) {
        try {
          initProfile(directory, DELO_PROFILE_BUNDLES)
        } catch (error) {
          throw new CliError(EXIT.failed, `delorun setup: could not create the CLI profile ${request.profile} at ${directory}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // Runs again when an interrupted run resumes this step; a bundle already importable is left alone.
      await linkDeloBundles(request.home, request.profile, DELO_PROFILE_BUNDLES, await upstreamLinking(request.home, request.profile), (text) => { request.output.stderr(text) })
      return undefined
    }
    case 'credential': {
      const credential = answers.modelProvider.credential
      if (credential.source === 'environment') return undefined
      if (secret === undefined) throw new CliError(EXIT.failed, 'delorun setup: the model key was not entered; run delorun setup in a terminal to finish')
      storeCredential(request.home, SETUP_DEFAULT_CREDENTIAL_VARIABLE, secret)
      return undefined
    }
    case 'profile-rows':
      setPatchRow(join(directory, 'cordis.patch.yml'), { id: SESSION_LOG_ROW, config: { enabled: answers.sessionLogUpload } })
      return undefined
    case 'desktop-row':
      // Recorded, not written: the desktop app keeps its own profile until it composes Delo's bundle.
      return `Desktop analytics is recorded as ${answers.desktopAnalytics ? 'on' : 'off'}. Setup does not write the desktop app's profile; the desktop app applies the answer once it composes Delo's bundle.`
  }
  return assertNever(step)
}

/**
 * The compile-time guard that every step has a case.
 * @param value - a value that must be `never`.
 * @throws Error always; reaching it means a step has no case.
 */
function assertNever(value: never): never {
  throw new Error(`delorun setup: no case for step ${String(value)}`)
}

/**
 * Run setup for a CLI profile. A finished setup leaves the profile unchanged. A run that
 * was interrupted resumes from its record.
 * @param request - the home, profile, output, environment and form.
 * @returns the exit code.
 * @throws {CliError} for a refused answer, a missing key or a failed step.
 */
export async function runSetup(request: SetupRequest): Promise<ExitCode> {
  const runDir = runDirectory(request.home, request.profile)
  const directory = profileDirectory(request.home, request.profile)
  let progress = readProgress(runDir)
  if (progress === undefined && hasCliProfile(request.home, request.profile)) {
    request.output.stdout(`The CLI profile ${request.profile} is already set up at ${directory}.\n`)
    return EXIT.ok
  }
  let secret: string | undefined
  if (request.form.kind === 'interactive') showStatements(prompterFor(request.form))
  else request.output.stdout(`${statementLines().join('\n')}\n`)
  if (progress === undefined) {
    const collected = await collectAnswers(request.form, request.env)
    progress = { answers: collected.answers, completed: [] }
    writeProgress(runDir, progress)
    secret = collected.secret
  } else {
    if (progress.answers.modelProvider.credential.source === 'prompt' && !progress.completed.includes('credential')) {
      if (request.form.kind !== 'interactive') throw new CliError(EXIT.failed, `delorun setup: the setup run for ${request.profile} is unfinished and needs the model key; run delorun setup in a terminal to finish it`)
      secret = await prompterFor(request.form).secret('DeepSeek API key')
    }
    request.output.stdout(`Resuming the setup of ${request.profile}.\n`)
  }

  for (const step of SETUP_STEPS) {
    if (progress.completed.includes(step)) continue
    const note = await runStep(step, request, progress, secret)
    if (note !== undefined) request.output.stdout(`${note}\n`)
    const next: SetupProgress = { answers: progress.answers, completed: [...progress.completed, step] }
    writeProgress(runDir, next)
    progress = next
    request.hooks?.afterStep?.(step)
  }
  writeAnswersRecord(directory, progress.answers)
  removeProgress(runDir)
  request.output.stdout(`Set up the CLI profile ${request.profile} at ${directory}.\nRun delorun to start Delo and open the studio.\n`)
  return EXIT.ok
}

/** `delorun setup [--profile <name>] [--yes | --config <file>]`. */
export const setupCommand: CliCommand = {
  name: 'setup',
  summary: 'Set up the Delo home and its CLI profile',
  async run(args, context) {
    const values = parseOptions('setup', args, { profile: { type: 'string' }, yes: { type: 'boolean', default: false }, config: { type: 'string' } })
    if (values.yes === true && values.config !== undefined) throw new CliError(EXIT.usage, 'delorun setup: --yes and --config are two forms of the same answers; give one')
    const { home, profile } = await prepareHome(context, values.profile)
    const form = formFromFlags(values.yes === true, values.config)
    return runSetup({ home: home.path, profile, output: context, env: context.env, form })
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
