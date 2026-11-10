/**
 * `delorun trash` as a row of the command table: it resolves the home and the
 * CLI profile without creating anything, reads whether the profile's home
 * process runs, and asks its questions on the terminal.
 *
 * @module @delo/cli/trash/command
 */
import { processExists, readHomeLock, resolveDeloHome, runDirectory } from '@delo/home'
import type { CliCommand } from '../command.ts'
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

/**
 * Whether one profile's home process runs now.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns true when its lock names a live process.
 */
export function homeProcessRuns(home: string, profile: string): boolean {
  const record = readHomeLock(runDirectory(home, profile))
  return record !== undefined && processExists(record.pid)
}

/** `delorun trash list | restore <id> | purge <id> | empty` (contract C8). */
export const trashCommand: CliCommand = {
  name: 'trash',
  summary: 'List deleted chats and workspaces; restore one, or delete one or all forever',
  async run(args, context) {
    const { profile: flag, rest } = takeProfile(args)
    const profile = selectProfile(flag, context.env)
    const home = await resolveDeloHome(context.env)
    return runTrash(rest, {
      home: home.path,
      stdout: context.stdout,
      ask: askOnTerminal,
      homeRunning: () => homeProcessRuns(home.path, profile),
      now: Date.now,
    })
  },
}
