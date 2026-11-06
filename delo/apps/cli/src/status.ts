/**
 * `delorun status`: the home, the CLI profile, whether a home process holds
 * the profile's lock, and an inherited `DSH_HOME` that `delorun` ignored
 * (contract C1, "The home directory"). It reads the lock record and creates
 * nothing. Exit codes follow contract C19: 0 when a home process runs, 3 when
 * none runs, 1 on an error.
 *
 * Until the update channel exists, the state comes from the lock record and
 * whether its process exists, not from the home process's `status` answer.
 *
 * @module @delo/cli/status
 */
import { DSH_HOME_ENV } from '@delo/contract-home-layout'
import { EXIT } from './exit.ts'
import { parseOptions, type CliCommand } from './command.ts'
import { processExists, readHomeLock, resolveDeloHome, runDirectory } from '@delo/home'
import { selectProfile } from './profile.ts'

/** `delorun status [--profile <name>]`. */
export const statusCommand: CliCommand = {
  name: 'status',
  summary: 'Show the home, the CLI profile and whether its home process runs',
  async run(args, context) {
    const values = parseOptions('status', args, { profile: { type: 'string' } })
    const profile = selectProfile(values.profile, context.env)
    const home = await resolveDeloHome(context.env)
    context.stdout(`home: ${home.path}\nprofile: ${profile}\n`)
    if (home.ignoredDshHome !== undefined) {
      context.stdout(`note: ${DSH_HOME_ENV} is set to ${home.ignoredDshHome}; delorun ignores it and runs with ${DSH_HOME_ENV}=${home.path}\n`)
    }
    const record = readHomeLock(runDirectory(home.path, profile))
    if (record === undefined) {
      context.stdout('state: not running\n')
      return EXIT.notRunning
    }
    if (!processExists(record.pid)) {
      context.stdout(`state: not running (a lock left by process ${String(record.pid)}, which has exited, is replaced at the next start)\n`)
      return EXIT.notRunning
    }
    context.stdout(`state: running\npid: ${String(record.pid)}\nstartId: ${record.startId}\nruntime: ${record.runtime}\nstartedAt: ${record.startedAt}\n`)
    return EXIT.ok
  },
}
