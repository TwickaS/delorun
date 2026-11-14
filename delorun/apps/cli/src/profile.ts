/**
 * The CLI profile `delorun` runs (contract C1, "Profiles"): `default`, or the
 * name `--profile` or `DELORUN_PROFILE` selects under C1's profile-name rule,
 * which the launcher applies too. The rule refuses C1's reserved names, the
 * desktop app's `desktop` profile among them, so `delorun` never runs,
 * initialises or changes one as a CLI profile.
 *
 * @module @delorun/cli/profile
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { CLI_PROFILE, DELORUN_PROFILE_ENV, profileNameProblem } from '@delorun/contract-home-layout'
import { CliError, EXIT } from './exit.ts'

/**
 * Select the CLI profile.
 * @param flag - the `--profile` value, which wins over the environment.
 * @param env - the environment, read for `DELORUN_PROFILE`; blank counts as unset.
 * @returns the profile name.
 * @throws {CliError} with the usage code for a name C1's profile-name rule refuses, naming the name and why.
 */
export function selectProfile(flag: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env[DELORUN_PROFILE_ENV]
  const name = flag ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : CLI_PROFILE)
  const source = flag === undefined ? DELORUN_PROFILE_ENV : '--profile'
  // C1's rule, which the launcher applies too; it is narrower than upstream's, so upstream accepts every such name.
  const problem = profileNameProblem(name)
  if (problem !== undefined) throw new CliError(EXIT.usage, `delorun: ${source} is refused: ${problem}; choose another profile name`)
  return name
}

/**
 * Every `--profile` value a command line carries, as `--profile <name>` or `--profile=<name>`, in order; the arguments
 * after `--` are not read.
 * @param args - the command's arguments.
 * @returns the values; a `--profile` with no value after it counts as an empty value.
 */
export function profileOptionValues(args: readonly string[]): string[] {
  const values: string[] = []
  for (let at = 0; at < args.length; at++) {
    const argument = args[at]!
    if (argument === '--') break
    if (argument === '--profile') values.push(args[++at] ?? '')
    else if (argument.startsWith('--profile=')) values.push(argument.slice('--profile='.length))
  }
  return values
}

/**
 * Select the CLI profile of a command that hands its arguments to a parser of its own, such as upstream's `dsh plugin`
 * or `delorun logs`: every `--profile` value the arguments carry goes through C1's profile-name rule, and values that
 * differ are refused, so the profile checked is the profile the parser uses, whichever occurrence it reads.
 * @param command - the command's name, for the refusal.
 * @param args - the command's arguments.
 * @param env - the environment, read for `DELORUN_PROFILE` when no `--profile` is given.
 * @returns the profile name.
 * @throws {CliError} with the usage code for a refused name, or for `--profile` values that differ.
 */
export function selectCommandProfile(command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): string {
  const values = profileOptionValues(args)
  const distinct = [...new Set(values)]
  if (distinct.length > 1) throw new CliError(EXIT.usage, `delorun ${command}: --profile is given more than once with different names (${distinct.map(value => JSON.stringify(value)).join(', ')}); give one profile`)
  return selectProfile(distinct[0], env)
}

/**
 * The directory of a CLI profile under the home.
 * @param home - the Delorun home.
 * @param profile - a name {@link selectProfile} returned.
 * @returns `<home>/profiles/<profile>`.
 */
export function profileDirectory(home: string, profile: string): string {
  return resolveProfileDir(profile, home)
}

/**
 * Whether the home holds the CLI profile, which setup creates in upstream's profile layout.
 * @param home - the Delorun home.
 * @param profile - the CLI profile's name.
 * @returns true when the profile's `package.json` exists.
 */
export function hasCliProfile(home: string, profile: string): boolean {
  return existsSync(join(profileDirectory(home, profile), 'package.json'))
}
