/**
 * `delorun open [--print] [--port <n>] [--profile <name>]` (contract C19, `studio.open-token`): open the studio in the
 * browser with a fresh sign-in link from the running home process. `--print` prints the link once instead, for a
 * computer with no browser or one reached through an SSH port forward; with Delorun's composition it signs in once,
 * within one minute. A link signs in only at the address it names, so `--port` makes it for a loopback port that
 * forwards to the studio, such as the local end of `ssh -L`. Without `--print`, nothing the command writes contains
 * the link.
 *
 * Exit codes: 0 when the browser took the link or the link was printed, 3 when no home process runs for the
 * profile, 1 when the home process refused or did not answer, or no browser took the link; 2 for a port outside 1 to
 * 65535.
 *
 * @module @delorun/cli/open/command
 */
import { resolveDelorunHome } from '@delorun/home'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import { parseOptions, type CliCommand, type CommandContext } from '../command.ts'
import { selectProfile } from '../profile.ts'
import { computerOpener, describeOpening, openStudio, profileFlag, type OpenOutcome, type StudioOpener } from './studio.ts'

/**
 * The exit code of an attempt to open the studio.
 * @param outcome - what happened.
 * @returns {@link EXIT.ok} when the browser took the link, {@link EXIT.notRunning} without a home process, otherwise
 *   {@link EXIT.failed}.
 */
function exitOf(outcome: OpenOutcome): ExitCode {
  if (outcome.kind === 'opened') return EXIT.ok
  return outcome.kind === 'not-running' ? EXIT.notRunning : EXIT.failed
}

/**
 * Read `--port`: a decimal port from 1 to 65535.
 * @param text - the option's value, if given.
 * @returns the port, or `undefined` when the option was not given.
 * @throws {CliError} {@link EXIT.usage} for any other value.
 */
function parsePort(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const port = /^\d{1,5}$/u.test(text) ? Number(text) : 0
  if (port < 1 || port > 65_535) throw new CliError(EXIT.usage, `delorun open: --port takes a port from 1 to 65535, not ${JSON.stringify(text)}`)
  return port
}

/**
 * Run `delorun open`.
 * @param args - the arguments after `open`.
 * @param context - the environment and output.
 * @param opener - how the link is obtained and opened; this computer's by default.
 * @returns the exit code.
 * @throws {CliError} {@link EXIT.usage} for an unknown option or a port outside 1 to 65535.
 */
export async function runOpen(args: readonly string[], context: CommandContext, opener: StudioOpener = computerOpener(context.env)): Promise<ExitCode> {
  const values = parseOptions('open', args, { print: { type: 'boolean', default: false }, port: { type: 'string' }, profile: { type: 'string' } })
  const port = parsePort(values.port)
  const profile = selectProfile(values.profile, context.env)
  const home = (await resolveDelorunHome(context.env)).path
  if (values.print !== true) {
    const outcome = await openStudio(home, profile, opener, port)
    if (outcome.kind === 'opened') context.stdout(describeOpening(outcome, profile))
    else context.stderr(describeOpening(outcome, profile))
    return exitOf(outcome)
  }
  const answer = await opener.link(home, profile, port)
  if (answer.kind !== 'link') {
    context.stderr(describeOpening(answer, profile))
    return exitOf(answer)
  }
  context.stdout(`${answer.link.url}\n`)
  context.stdout(answer.link.oneTime
    ? `This link signs in to the studio once, within one minute; run delorun open --print${profileFlag(profile)} again for another.\n`
    : 'This link signs in to the studio for as long as Delorun runs; anyone who has it can use it, so keep it to yourself.\n')
  return EXIT.ok
}

/** `delorun open [--print] [--profile <name>]`. */
export const openCommand: CliCommand = {
  name: 'open',
  summary: 'Open the studio in your browser, or print a link that signs in once with --print (--port for a forwarded port)',
  run: (args, context) => runOpen(args, context),
}
