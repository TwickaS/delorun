/**
 * `delorun import` as a row of the command table: it resolves the home
 * and the CLI profile, runs while holding the home lock of every profile,
 * and asks its questions on the terminal.
 *
 * @module @delorun/cli/import/command
 */
import { resolveDelorunHome } from '@delorun/home'
import type { CliCommand } from '../command.ts'
import { withHomeExclusive } from '../home-exclusion.ts'
import { selectProfile } from '../profile.ts'
import { takeProfile } from '../trash/command.ts'
import { requireTerminal } from '../needs-terminal.ts'
import { askOnTerminal } from '../trash/terminal.ts'
import { runImport } from './index.ts'

/** `delorun import <file>` (contract C8). */
export const importCommand: CliCommand = {
  name: 'import',
  summary: 'Check an archive, show who signed it and what it holds, and import it after you confirm',
  async run(args, context) {
    const { profile: flag, rest } = takeProfile(args)
    const profile = selectProfile(flag, context.env)
    const home = await resolveDelorunHome(context.env)
    const exclusive = <T>(run: () => Promise<T>): Promise<T> => withHomeExclusive({ home: home.path, profile, command: 'import', instead: '' }, run)
    return runImport(rest, { home: home.path, stdout: context.stdout, ask: async (question) => { requireTerminal('delorun import'); return askOnTerminal(question) }, exclusive })
  },
}
