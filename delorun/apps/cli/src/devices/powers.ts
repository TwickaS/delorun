/**
 * `delorun devices powers [careful | full]` (C14, "Phone powers"): show or choose how much an unlocked phone may do.
 * The choice is written to the home-auth record at this computer; a running home reads it at its next check, so no
 * restart is needed. Choosing Full needs a terminal, so a script cannot widen what a phone may do; choosing Careful
 * does not.
 *
 * @module @delorun/cli/devices/powers
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HomeAuthError, isPhonePowersLevel, readPhonePowers, writePhonePowers, type PhonePowers } from '@delorun/home-auth'
import { CliError, EXIT, type ExitCode } from '../exit.ts'
import type { CommandContext } from '../command.ts'
import { requireTerminal } from '../needs-terminal.ts'

/** The usage line. */
export const POWERS_USAGE = 'Usage: delorun devices powers [careful | full]'

/** What each level lets an unlocked phone do, as the command prints it. */
const LEVEL_LINES = {
  careful: 'Careful: an unlocked phone can do what this computer can except open a terminal, turn protection off, apply or switch plugin changes and change Delorun\'s own files; it can still undo or discard a change and turn protection on.',
  full: 'Full: an unlocked phone can do everything this computer can, the terminal included, each time with an unlock you entered on the phone. The 15 minutes after you approve a phone never count.',
} as const

/**
 * Run `delorun devices powers`.
 * @param home - the Delorun home.
 * @param positional - the level to choose, if any.
 * @param context - the output.
 * @param input - standard input, which must be a terminal to choose Full.
 * @returns the exit code.
 * @throws {CliError} `EXIT.usage` for an unknown level or a second argument; `EXIT.failed` when Full is chosen without a terminal.
 */
export async function runPowers(home: string, positional: readonly string[], context: CommandContext, input: { readonly isTTY?: boolean } = process.stdin): Promise<ExitCode> {
  const directory = join(home, 'secrets', 'home-auth')
  const [level, extra] = positional
  if (extra !== undefined || (level !== undefined && !isPhonePowersLevel(level))) throw new CliError(EXIT.usage, `delorun devices powers: choose careful or full\n${POWERS_USAGE}`)
  if (level === undefined) {
    let powers: PhonePowers
    try {
      powers = await readPhonePowers(directory)
    } catch (error) {
      if (!(error instanceof HomeAuthError)) throw error
      context.stderr(`delorun devices powers: ${error.detail}; Careful applies until you choose again.\n`)
      return EXIT.failed
    }
    context.stdout(`Phone powers: ${powers.level === 'full' ? 'Full' : 'Careful'}${powers.chosen ? '' : ' (not chosen yet)'}\n${LEVEL_LINES[powers.level]}\nChoose with delorun devices powers careful or delorun devices powers full.\n`)
    return EXIT.ok
  }
  if (level === 'full') requireTerminal('delorun devices powers full', undefined, input)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const powers = await writePhonePowers(directory, level)
  context.stdout(`Phone powers set to ${powers.level === 'full' ? 'Full' : 'Careful'}.\n${LEVEL_LINES[powers.level]}\n`)
  return EXIT.ok
}
