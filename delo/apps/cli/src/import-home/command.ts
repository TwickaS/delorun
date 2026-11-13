/**
 * `delorun import-home` as a row of the command table: it resolves the home
 * and the CLI profile, runs while holding the home lock of every profile, and
 * asks its questions on the terminal.
 *
 * @module @delo/cli/import-home/command
 */
import { LOCAL_BUNDLE } from '@delo/bundle-local/profile'
import { resolveDeloHome } from '@delo/home'
import type { CliCommand } from '../command.ts'
import { withHomeExclusive } from '../home-exclusion.ts'
import { selectProfile } from '../profile.ts'
import { takeProfile } from '../trash/command.ts'
import { askOnTerminal } from '../trash/terminal.ts'
import { runImportHome } from './index.ts'

/** `delorun import-home` (contract C8). */
export const importHomeCommand: CliCommand = {
  name: 'import-home',
  summary: 'Copy a DeepSeek Harness home (~/.dsh) into this Delorun home after a preview; --dry-run only shows it',
  async run(args, context) {
    const { profile: flag, rest } = takeProfile(args)
    const profile = selectProfile(flag, context.env)
    const home = await resolveDeloHome(context.env)
    const exclusive = <T>(run: () => Promise<T>): Promise<T> => withHomeExclusive({ home: home.path, profile, command: 'import-home', instead: '' }, run)
    return runImportHome(rest, { home: home.path, profile, env: context.env, deloBundles: [LOCAL_BUNDLE], stdout: context.stdout, ask: askOnTerminal, exclusive })
  },
}
