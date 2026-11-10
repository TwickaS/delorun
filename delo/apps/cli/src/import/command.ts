/**
 * `delorun import` as a row of the command table: it resolves the home
 * without creating anything and asks its questions on the terminal.
 *
 * @module @delo/cli/import/command
 */
import { resolveDeloHome } from '@delo/home'
import type { CliCommand } from '../command.ts'
import { takeProfile } from '../trash/command.ts'
import { askOnTerminal } from '../trash/terminal.ts'
import { runImport } from './index.ts'

/** `delorun import <file>` (contract C8). */
export const importCommand: CliCommand = {
  name: 'import',
  summary: 'Check an archive, show who signed it and what it holds, and import it after you confirm',
  async run(args, context) {
    const { rest } = takeProfile(args)
    const home = await resolveDeloHome(context.env)
    return runImport(rest, { home: home.path, stdout: context.stdout, ask: askOnTerminal })
  },
}
