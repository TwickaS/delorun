/**
 * `delorun export` as a row of the command table: it resolves the home
 * without creating anything and asks the secret question on the terminal.
 *
 * @module @delo/cli/export/command
 */
import { resolveDeloHome } from '@delo/home'
import type { CliCommand } from '../command.ts'
import { takeProfile } from '../trash/command.ts'
import { askOnTerminal } from '../trash/terminal.ts'
import { deloVersion } from '../version.ts'
import { runExport } from './index.ts'

/** `delorun export <chat-or-workspace> --out <file>` (contract C8). */
export const exportCommand: CliCommand = {
  name: 'export',
  summary: 'Write a chat, or a workspace with its chats, as an archive signed by this home',
  async run(args, context) {
    const { rest } = takeProfile(args)
    const home = await resolveDeloHome(context.env)
    return runExport(rest, { home: home.path, version: String(deloVersion()), stdout: context.stdout, ask: askOnTerminal })
  },
}
