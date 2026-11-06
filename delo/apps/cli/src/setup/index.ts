/**
 * Setup's entry point: `delorun setup`, and `delorun` on a home without a CLI
 * profile. This module is the hand-off point the setup screen fills; until then
 * it only creates the CLI profile, in upstream's profile layout, with
 * `@delo/bundle-local`'s bundle list (upstream's `web` template followed by
 * `@delo/bundle-local`), and asks nothing. It never replaces an existing profile.
 *
 * @module @delo/cli/setup
 */
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { DELO_PROFILE_BUNDLES } from '@delo/bundle-local/profile'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandOutput } from '../command.ts'
import { hasCliProfile, profileDirectory } from '../profile.ts'

/** What setup runs against. */
export interface SetupRequest {
  /** The Delo home, already prepared and set as `DSH_HOME`. */
  readonly home: string
  /** The CLI profile to set up. */
  readonly profile: string
  /** Where setup writes. */
  readonly output: CommandOutput
}

/**
 * Run setup for a CLI profile. A profile that exists is left unchanged.
 * @param request - the home, profile and output.
 * @returns the exit code.
 */
export function runSetup(request: SetupRequest): Promise<ExitCode> {
  const directory = profileDirectory(request.home, request.profile)
  if (hasCliProfile(request.home, request.profile)) {
    request.output.stdout(`The CLI profile ${request.profile} is already set up at ${directory}.\n`)
    return Promise.resolve(EXIT.ok)
  }
  try {
    initProfile(directory, DELO_PROFILE_BUNDLES)
  } catch (error) {
    return Promise.reject(new CliError(EXIT.failed, `delorun setup: could not create the CLI profile ${request.profile} at ${directory}: ${error instanceof Error ? error.message : String(error)}`))
  }
  request.output.stdout(`Set up the CLI profile ${request.profile} at ${directory}.\nRun delorun to start Delo and open the studio.\n`)
  return Promise.resolve(EXIT.ok)
}

/** `delorun setup [--profile <name>]`. */
export const setupCommand: CliCommand = {
  name: 'setup',
  summary: 'Set up the Delo home and its CLI profile',
  async run(args, context) {
    const values = parseOptions('setup', args, { profile: { type: 'string' } })
    const { home, profile } = await prepareHome(context, values.profile)
    return runSetup({ home: home.path, profile, output: context })
  },
}
