/**
 * The questions of `delorun setup` in a terminal (contract C11, "Questions"). The answers come back as one
 * {@link SetupAnswers}, the same value the `--yes` and `--config` forms produce, so the two forms write
 * identical profiles. Reach is not asked: its screen comes with contract C7's reach providers, and setup records
 * it as off.
 *
 * @module @delo/cli/setup/interactive
 */
import { en } from '@delo/bundle-local/statements'
import {
  SETUP_DEFAULTS,
  SETUP_DEFAULT_CREDENTIAL_VARIABLE,
  RESOURCE_PRESETS,
  DOCKER_SHAPES,
  type RuntimeAnswer,
  type SetupAnswers,
} from '@delo/contract-setup-answers'
import type { AliasCoverage } from '@deepseek-ai/dsh-sandbox-local'
import type { SandboxDialect } from './dialect.ts'
import { dockerConnectEnforced } from './dialect.ts'
import { SetupCancelled, type Prompter } from './prompts.ts'

/** Contract C1's label for Docker mode on a system whose dialect cannot enforce `docker-connect`. */
export const DOCKER_NOT_ENFORCED_LABEL = 'On this system, commands in native workspaces can connect to Docker, which can start containers with this computer\'s files mounted.'

/** What the interactive form returns: the answers, and the model key the person typed, which is never stored in them. */
export interface InteractiveAnswers {
  /** The answers, the same value `--yes` and `--config` produce for the same choices. */
  readonly answers: SetupAnswers
  /** The typed key, when the credential question chose a prompt; `undefined` otherwise. */
  readonly secret: string | undefined
}

/**
 * The statements setup makes before its questions and on the review screen, from the Privacy section's copy.
 * @returns one line per statement.
 */
export function statementLines(): string[] {
  return [en['statement.delo'], en['statement.optIns'], en['statement.feedback']]
}

/**
 * Show the statements in a note.
 * @param prompter - the prompter that shows the note.
 */
export function showStatements(prompter: Prompter): void {
  prompter.note(statementLines().join('\n'), en.title)
}

/**
 * Ask every question and return the answers.
 * @param prompter - the prompter.
 * @param dialect - the system's sandbox dialect, which decides whether Docker mode carries its label.
 * @param dockerCoverage - whether the Docker socket's other mounts can be found; when not, Docker mode is labelled.
 * @returns the answers and the typed key.
 * @throws {SetupCancelled} when the person cancels a question or declines the review.
 */
export async function askAnswers(prompter: Prompter, dialect: SandboxDialect, dockerCoverage: AliasCoverage): Promise<InteractiveAnswers> {
  const credential = await prompter.select('Where does the DeepSeek API key come from?', [
    { value: 'prompt', label: 'Enter the key now', hint: 'stored in the home\'s credentials document' },
    { value: 'environment', label: `Read ${SETUP_DEFAULT_CREDENTIAL_VARIABLE} from the environment at each start` },
  ], 'prompt')
  let secret: string | undefined
  if (credential === 'prompt') secret = await prompter.secret('DeepSeek API key')

  const runtime = await askRuntime(prompter, dialect, dockerCoverage)

  const studioAdditions = await prompter.confirm('Turn on the Delo additions to the studio?', SETUP_DEFAULTS.studioAdditions)
  const helpSetUpModels = await prompter.confirm('Help me set up other models?', SETUP_DEFAULTS.helpSetUpModels)

  prompter.note(en['analytics.confirm.body'], en['analytics.confirm.title'])
  const desktopAnalytics = await prompter.confirm(`${en['analytics.confirm.title']} (no by default)`, SETUP_DEFAULTS.desktopAnalytics)
  prompter.note(en['sessionLog.confirm.body'], en['sessionLog.confirm.title'])
  const sessionLogUpload = await prompter.confirm(`${en['sessionLog.confirm.title']} (no by default)`, SETUP_DEFAULTS.sessionLogUpload)

  const answers: SetupAnswers = {
    ...SETUP_DEFAULTS,
    modelProvider: {
      id: SETUP_DEFAULTS.modelProvider.id,
      credential: credential === 'prompt' ? { source: 'prompt' } : { source: 'environment', name: SETUP_DEFAULT_CREDENTIAL_VARIABLE },
    },
    runtime,
    studioAdditions,
    helpSetUpModels,
    desktopAnalytics,
    sessionLogUpload,
  }
  prompter.note(review(answers), 'Review')
  showStatements(prompter)
  const confirmed = await prompter.confirm('Save these answers and set up Delo?', true)
  if (!confirmed) throw new SetupCancelled()
  return { answers, secret }
}

/**
 * The runtime question: native, or Docker with a shape and a preset. Docker carries C1's label on a dialect that
 * cannot enforce `docker-connect`.
 * @param prompter - the prompter.
 * @param dialect - the system's sandbox dialect.
 * @param dockerCoverage - whether the Docker socket's other mounts can be found.
 * @returns the runtime answer.
 */
async function askRuntime(prompter: Prompter, dialect: SandboxDialect, dockerCoverage: AliasCoverage): Promise<RuntimeAnswer> {
  const kind = await prompter.select('Where do commands run?', [
    { value: 'native', label: 'On this computer' },
    { value: 'docker', label: 'In Docker containers', hint: dockerConnectEnforced(dialect, dockerCoverage) ? undefined : DOCKER_NOT_ENFORCED_LABEL },
  ], 'native')
  if (kind === 'native') return { kind: 'native' }
  const shape = await prompter.select('Container shape', DOCKER_SHAPES.map(value => ({ value, label: value })), 'S2')
  const preset = await prompter.select('Resource preset', RESOURCE_PRESETS.map(value => ({ value, label: value })), 'small')
  return { kind: 'docker', shape, preset }
}

/**
 * The answers as the review screen lists them, without any credential value.
 * @param answers - the answers.
 * @returns one line per answer.
 */
export function review(answers: SetupAnswers): string {
  const credential = answers.modelProvider.credential.source === 'prompt'
    ? 'key entered now'
    : `read from ${answers.modelProvider.credential.name} at each start`
  const runtime = answers.runtime.kind === 'native' ? 'native' : `docker, ${answers.runtime.shape}, ${answers.runtime.preset}`
  return [
    `DeepSeek API key: ${credential}`,
    `Runtime: ${runtime}`,
    `Delo additions to the studio: ${onOff(answers.studioAdditions)}`,
    `Help me set up other models: ${onOff(answers.helpSetUpModels)}`,
    `Desktop analytics: ${onOff(answers.desktopAnalytics)}`,
    `DeepSeek session-log upload: ${onOff(answers.sessionLogUpload)}`,
    'Reach from anywhere: off (set up later)',
  ].join('\n')
}

/**
 * @param value - a switch.
 * @returns `on` or `off`.
 */
function onOff(value: boolean): string {
  return value ? 'on' : 'off'
}
