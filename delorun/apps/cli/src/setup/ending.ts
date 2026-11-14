/**
 * The end of every `delorun setup` form: the next steps, and nothing else. Setup starts nothing and opens nothing;
 * the text says how to start Delorun and open the studio, where the install guide's first-chat section is, and how to change an
 * answer later. When the launcher (`npx delorun`) started the run, the first step installs the `delorun` command at the
 * launcher's exact version (`DELORUN_LAUNCHER_VERSION`), so the installed command is the package the person already ran and
 * not whatever npm serves as newest.
 *
 * @module @delorun/cli/setup/ending
 */
import { DELORUN_LAUNCHER_VERSION_ENV } from '@delorun/contract-home-layout'
import type { SetupAnswers } from '@delorun/contract-setup-answers'
import semver from 'semver'
import { profileFlag } from '../open/studio.ts'
import { SETUP_PROVIDERS } from './providers.ts'

/** The documentation site's origin, which {@link FIRST_CHAT_PAGE} extends. */
export const DOCS_ORIGIN = 'https://docs.delorun.com'

/** The install guide's section on the studio and the first chat. */
export const FIRST_CHAT_PAGE = `${DOCS_ORIGIN}/guide/install#the-studio-and-your-first-chat`

/**
 * The command that installs the `delorun` command: the launcher package at one exact version.
 * @param version - the launcher's version, a semantic version.
 * @returns the command line the person can run.
 */
export function installLine(version: string): string {
  return `npm install -g delorun@${version}`
}

/**
 * The version of the launcher that started this run.
 * @param env - the environment `delorun` inherited.
 * @returns the version from `DELORUN_LAUNCHER_VERSION`, or `undefined` when the variable is unset or not a semantic version.
 */
export function launcherVersion(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const version = env[DELORUN_LAUNCHER_VERSION_ENV]
  return version !== undefined && semver.valid(version) === version ? version : undefined
}

/** What the next steps depend on. */
export interface NextStepsRequest {
  /** The profile that was set up. */
  readonly profile: string
  /** The answers the run applied. */
  readonly answers: SetupAnswers
  /** The environment `delorun` inherited, which shows whether a key variable is set and whether the launcher started the run. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * The key step, when the answers leave Delorun without a key it can use.
 * @param request - the run.
 * @param flag - the `--profile` flag for the profile, or empty.
 * @returns the step's text, or `undefined` when a key is stored or its variable is set.
 */
function keyStep(request: NextStepsRequest, flag: string): string | undefined {
  const provider = request.answers.modelProvider
  if (provider === null) return `Add a model key first: delorun setup key${flag}`
  if (provider.credential.source === 'environment' && (request.env[provider.credential.name] ?? '') === '') {
    return `Set ${provider.credential.name} in your terminal, then run delorun stop and delorun start if Delorun is running. It is the ${SETUP_PROVIDERS[provider.id].label} key you chose.`
  }
  return undefined
}

/**
 * The text a finished setup prints.
 * @param request - the profile, the answers and the environment.
 * @returns the text: what is set up, the numbered next steps for the use case, and how to change an answer.
 */
export function nextSteps(request: NextStepsRequest): string {
  const flag = profileFlag(request.profile)
  const { useCase, reach } = request.answers
  const steps: string[][] = []
  const version = launcherVersion(request.env)
  if (version !== undefined) steps.push(['Install the delorun command, which npx does not keep:', `  ${installLine(version)}`])
  const key = keyStep(request, flag)
  if (key !== undefined) steps.push([key])
  if (useCase === 'automation') {
    steps.push([`Run a task from a script or CI: delorun headless${flag} "your task"`])
    steps.push([`To use the studio as well, start it any time with delorun${flag}.`])
  } else {
    steps.push([`Start Delorun and open the studio: delorun${flag}`, `Send a first message in a new chat. The install guide's section on your first chat walks through it: ${FIRST_CHAT_PAGE}`])
    if (useCase === 'remote') {
      steps.push(reach.option === 'none'
        ? ['Remote access is off. Fix what the Tailscale note said, then run delorun reach on tailscale.']
        : [`Add your phone or another device: delorun devices approve${flag}, then type the code it shows.`])
    }
  }
  return `${[
    'Delorun is set up. Nothing is running yet.',
    '',
    'Next:',
    ...steps.flatMap((lines, index) => lines.map((line, position) => position === 0 ? `  ${String(index + 1)}. ${line}` : `     ${line.trimStart()}`)),
    '',
    `Change an answer later: delorun setup <section>${flag} (delorun setup --list shows the sections).`,
    `If something looks wrong: delorun doctor${flag}.`,
  ].join('\n')}\n`
}
