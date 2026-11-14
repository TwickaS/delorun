/**
 * `delorun export` as a row of the command table: it resolves the home
 * and the CLI profile, runs while holding the home lock of every profile,
 * and asks the secret question on the terminal.
 *
 * @module @delorun/cli/export/command
 */
import { resolveDelorunHome } from '@delorun/home'
import type { CliCommand } from '../command.ts'
import { withHomeExclusive } from '../home-exclusion.ts'
import { selectProfile } from '../profile.ts'
import { takeProfile } from '../trash/command.ts'
import { askOnTerminal } from '../trash/terminal.ts'
import { delorunVersion } from '../version.ts'
import { runExport } from './index.ts'

/** `delorun export <chat-or-workspace> --out <file>` (contract C8). */
export const exportCommand: CliCommand = {
  name: 'export',
  summary: 'Write a chat, or a workspace with its chats, as an archive signed by this home',
  async run(args, context) {
    const { profile: flag, rest } = takeProfile(args)
    const profile = selectProfile(flag, context.env)
    const home = await resolveDelorunHome(context.env)
    const exclusive = <T>(run: () => Promise<T>): Promise<T> => withHomeExclusive({ home: home.path, profile, command: 'export', instead: '' }, run)
    return runExport(rest, { home: home.path, version: String(delorunVersion()), stdout: context.stdout, ask: askOnTerminal, exclusive })
  },
}
