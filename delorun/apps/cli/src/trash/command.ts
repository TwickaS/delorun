/**
 * `delorun trash` as a row of the command table: it resolves the home and the
 * CLI profile, runs every change while holding the home lock of every profile,
 * and asks its questions on the terminal. A listing creates nothing and takes
 * no lock.
 *
 * @module @delorun/cli/trash/command
 */
import { resolveDelorunHome } from '@delorun/home'
import type { CliCommand } from '../command.ts'
import { withHomeExclusive } from '../home-exclusion.ts'
import { selectProfile } from '../profile.ts'
import { runTrash } from './index.ts'
import { askOnTerminal } from './terminal.ts'

/**
 * Split `--profile <name>` or `--profile=<name>` out of a command's arguments.
 * @param args - the arguments.
 * @returns the profile flag, if given, and the other arguments.
 */
export function takeProfile(args: readonly string[]): { readonly profile: string | undefined, readonly rest: readonly string[] } {
  const rest: string[] = []
  let profile: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--profile') profile = args[++index]
    else if (arg.startsWith('--profile=')) profile = arg.slice('--profile='.length)
    else rest.push(arg)
  }
  return { profile, rest }
}

/** `delorun trash list | restore <id> | purge <id> | empty` (contract C8). */
export const trashCommand: CliCommand = {
  name: 'trash',
  summary: 'List deleted chats and workspaces; restore a chat, or delete one item or all forever',
  async run(args, context) {
    const { profile: flag, rest } = takeProfile(args)
    const profile = selectProfile(flag, context.env)
    const home = await resolveDelorunHome(context.env)
    return runTrash(rest, {
      home: home.path,
      stdout: context.stdout,
      ask: askOnTerminal,
      exclusive: run => withHomeExclusive({ home: home.path, profile, command: 'trash', instead: 'use the Trash section in the studio\'s Settings' }, run),
      now: Date.now,
    })
  },
}
