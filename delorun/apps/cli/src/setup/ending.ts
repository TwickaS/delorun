/**
 * The end of a `delorun setup` run. A run that starts Delorun in this terminal ends with {@link foregroundEnding}; a run
 * that starts nothing (no terminal, `--yes`, `--config`, or a re-run of a finished setup) prints {@link nextSteps}: the
 * studio's address, how to start Delorun and open the studio, where the install guide's first-chat section is, how to
 * finish setup from another device when device access is on, and how to change an answer later. When the launcher (`npx delorun`) started the run, the install of the `delorun` command uses
 * the launcher's exact version (`DELORUN_LAUNCHER_VERSION`), so the installed command is the package the person already
 * ran and not whatever npm serves as newest.
 *
 * @module @delorun/cli/setup/ending
 */
import { join } from 'node:path'
import { DELORUN_LAUNCHER_VERSION_ENV } from '@delorun/contract-home-layout'
import { RELEASE_METADATA_ORIGIN } from '@delorun/contract-release-manifest'
import { SETUP_DEFAULT_PORT, type SetupAnswers } from '@delorun/contract-setup-answers'
import { readReachRowAt } from '@delorun/setup-apply'
import semver from 'semver'
import type { CheckResult } from '../doctor/checks.ts'
import { profileFlag } from '../open/studio.ts'
import { profileDirectory } from '../profile.ts'
import { SETUP_PROVIDERS } from './providers.ts'

/** The documentation site's origin, which {@link FIRST_CHAT_PAGE} extends. */
export const DOCS_ORIGIN = 'https://docs.delorun.com'

/** The install guide's section on the studio and the first chat. */
export const FIRST_CHAT_PAGE = `${DOCS_ORIGIN}/guide/get-started/install#the-studio-and-your-first-chat`

/**
 * The command that installs the `delorun` command: the launcher package at one exact version.
 * @param version - the launcher's version, a semantic version.
 * @returns the command line the person can run.
 */
export function installLine(version: string): string {
  return `npm install -g delorun@${version}`
}

/**
 * The command that installs the `delorun` command from the package file of a launcher built for another release channel.
 * Such a version is not on the npm registry; `npm pack` names the file `delorun-<version>.tgz`.
 * @param version - the launcher's version, a semantic version.
 * @returns the command line, with the path of the file left for the person to correct.
 */
export function localInstallLine(version: string): string {
  return `npm install -g ./delorun-${version}.tgz`
}

/**
 * Whether a launcher's recorded channel origin is the production channel, whose launcher is published to npm.
 * @param channelOrigin - the channel origin recorded for the launcher, or `undefined` when none is recorded.
 * @returns true for no origin and for {@link RELEASE_METADATA_ORIGIN}; false for the origin of any other release channel.
 */
export function isProductionChannel(channelOrigin: string | undefined): boolean {
  return channelOrigin === undefined || channelOrigin.replace(/\/+$/u, '') === RELEASE_METADATA_ORIGIN
}

/**
 * The sentence that follows an install line, for a computer where npm refuses a global install without permission.
 * @param installCommand - the install line it follows.
 * @returns one sentence naming the line with a user prefix and the folder to add to `PATH`.
 */
export function permissionLine(installCommand: string): string {
  return `If npm refuses for lack of permission, run ${installCommand.replace('install -g', 'install -g --prefix ~/.local')} and add ~/.local/bin to your PATH.`
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
  /** The channel origin recorded for the launcher: `undefined` or the production origin for the npm launcher, another origin for a launcher built for another release channel. */
  readonly channelOrigin?: string | undefined
  /** The sandbox check `delorun doctor` has, run at the end of setup on Linux; `undefined` where it does not run. */
  readonly sandbox?: CheckResult | undefined
  /** The address of the studio over Tailscale, from {@link deviceAddress}; `undefined` when device access is off. */
  readonly deviceAddress?: string | undefined
}

/**
 * The address other devices open, which the reach section wrote to the profile's patch when the person chose Yes.
 * @param home - the Delorun home.
 * @param profile - the profile that was set up.
 * @param answers - the answers the run applied.
 * @returns the address; `undefined` when the answers leave device access off.
 */
export function deviceAddress(home: string, profile: string, answers: SetupAnswers): string | undefined {
  if (answers.reach.option === 'none') return undefined
  return readReachRowAt(join(profileDirectory(home, profile), 'cordis.patch.yml')).address
}

/**
 * The ending's lines about other devices.
 * @param address - the studio's address over Tailscale from {@link deviceAddress}; `undefined` when device access is off.
 * @returns where setup can be finished from another device and how it pairs, or that the studio opens on this computer only.
 */
export function deviceLines(address: string | undefined): readonly string[] {
  if (address === undefined) return ['The studio opens on this computer only. Turn on device access later in Settings → General → How Delorun runs, or with delorun setup reach.']
  return [
    ...address === '' ? [] : [`Finish setup here, or on any device signed in to your Tailscale: ${address}`],
    'A new device asks to pair: approve it here at this computer, or unlock it with the PIN.',
  ]
}

/**
 * The key step, when the answers leave Delorun without a key it can use.
 * @param request - the run.
 * @param flag - the `--profile` flag for the profile, or empty.
 * @returns the step's text, or `undefined` when a key is stored or its variable is set.
 */
function keyStep(request: NextStepsRequest, flag: string): string | undefined {
  const provider = request.answers.modelProvider
  if (provider === null) return `Add your model key in the studio (the welcome screen asks for it), or run delorun setup key${flag}.`
  if (provider.credential.source === 'environment' && (request.env[provider.credential.name] ?? '') === '') {
    return `Set ${provider.credential.name} in your terminal, then run delorun stop and delorun start if Delorun is running. It is the ${SETUP_PROVIDERS[provider.id].label} key you chose.`
  }
  return undefined
}

/**
 * The sandbox warning, when the check found the sandbox cannot run.
 * @param sandbox - the check's result.
 * @returns nothing for a pass or no check; a blank line and the check's message with the word it carries otherwise.
 */
function sandboxLines(sandbox: CheckResult | undefined): readonly string[] {
  if (sandbox === undefined || sandbox.status === 'pass') return []
  return ['', `Sandbox: ${sandbox.message}`]
}

/**
 * The studio's address on this computer.
 * @param answers - the answers the run applied.
 * @returns the loopback address with the profile's port: the chosen one, or the default.
 */
export function studioAddress(answers: SetupAnswers): string {
  return `http://127.0.0.1:${String(answers.profile.port ?? SETUP_DEFAULT_PORT)}`
}

/**
 * The text a setup prints when it starts nothing: a run without a terminal, with `--yes` or `--config`, or a re-run of a
 * finished setup.
 * @param request - the profile, the answers and the environment.
 * @returns the text: the studio's address, the numbered next steps, and how to change an answer.
 */
export function nextSteps(request: NextStepsRequest): string {
  const flag = profileFlag(request.profile)
  const { useCase, reach } = request.answers
  const steps: string[][] = []
  const version = launcherVersion(request.env)
  if (version !== undefined) {
    steps.push(isProductionChannel(request.channelOrigin)
      ? ['Install the delorun command, which npx does not keep:', `  ${installLine(version)}`, permissionLine(installLine(version))]
      : [`Keep the delorun command, which npx does not keep: ${version} is not on the npm registry, so install the package file this launcher came from:`, `  ${localInstallLine(version)}`, permissionLine(localInstallLine(version))])
  }
  const key = keyStep(request, flag)
  if (key !== undefined) steps.push([key])
  if (useCase === 'automation') {
    steps.push([`Run a task from a script or CI: delorun headless${flag} "your task"`])
    steps.push([`To use the studio as well, start it any time with delorun${flag}.`])
  } else {
    steps.push([`Start Delorun and open the studio: delorun${flag}`, `Send a first message in a new chat. The install guide's section on your first chat walks through it: ${FIRST_CHAT_PAGE}`])
    if (reach.option !== 'none') steps.push([`Add your phone or another device: delorun devices approve${flag}, then type the code it shows.`])
  }
  return `${[
    'Delorun is set up. Nothing is running yet.',
    `Studio: ${studioAddress(request.answers)}`,
    '',
    'Next:',
    ...steps.flatMap((lines, index) => lines.map((line, position) => position === 0 ? `  ${String(index + 1)}. ${line}` : `     ${line.trimStart()}`)),
    ...useCase === 'automation' ? [] : ['', ...deviceLines(request.deviceAddress)],
    ...sandboxLines(request.sandbox),
    '',
    `Change an answer later: delorun setup <section>${flag} (delorun setup --list shows the sections).`,
    `To start Delorun by itself when you log in: delorun setup autostart${flag}.`,
    `If something looks wrong: delorun doctor${flag}.`,
  ].join('\n')}\n`
}

/**
 * The lines that end a run that started Delorun in this terminal, printed once the questions after the start are answered.
 * @param profile - the profile that was set up.
 * @param sandbox - the sandbox check, shown when it found the sandbox cannot run.
 * @param address - the studio's address over Tailscale from {@link deviceAddress}; `undefined` when device access is off.
 * @returns the lines, short enough for an 80-column terminal except the address line, with a closing line ending.
 */
export function foregroundEnding(profile: string, sandbox: CheckResult | undefined, address: string | undefined): string {
  const flag = profileFlag(profile)
  return `${[
    ...sandboxLines(sandbox),
    '',
    ...deviceLines(address),
    '',
    'Delorun runs in this terminal. Ctrl+C stops it.',
    `To keep it running after you close the terminal: delorun start${flag} --background`,
    '(or Settings → General → How Delorun runs).',
    `Change an answer later: delorun setup <section>${flag} (delorun setup --list)`,
    `To start Delorun by itself when you log in: delorun setup autostart${flag}`,
    `If something looks wrong: delorun doctor${flag}`,
  ].join('\n')}\n`
}
