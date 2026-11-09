/**
 * `delorun recover` (contract C3): the command a person runs when an update failed or a plugin broke the start. It
 * reads the profile's record and history through [`@delo/profile-safety`](../../../packages/profile-safety/README.md) and
 * carries out one action: report where the profile stands (the default), roll back to the snapshot an update took,
 * restore a named history version, start in safe mode, or end safe mode. Only a rollback or a restore writes profile
 * files, and both write only the files the plan listed.
 *
 * The runtime switch is not this command's: switching `current` back is the runtime store's rollback, which
 * `delorun recover` runs in the update work package that owns the store.
 *
 * @module @delo/cli/recover
 */
import { join } from 'node:path'
import { DELO_PROFILE_BUNDLES } from '@delo/bundle-local/profile'
import { isProfileSafetyError, recover, type RecoverAction } from '@delo/profile-safety'
import type { ProfileVersionId } from '@deepseek-ai/dsh-plugin-manager/history'
import { CliError, EXIT } from './exit.ts'
import { parseOptions, prepareHome, type CliCommand, type CommandContext, type CommandResult } from './command.ts'
import { removeSafeModeOverlay } from './safe-mode.ts'

/** The options `delorun recover` takes. */
const RECOVER_OPTIONS = {
  profile: { type: 'string' },
  rollback: { type: 'boolean' },
  restore: { type: 'string' },
  'safe-mode': { type: 'boolean' },
  'exit-safe-mode': { type: 'boolean' },
  reason: { type: 'string' },
  json: { type: 'boolean' },
} as const

/**
 * Read the action from the parsed options.
 * @param values - the parsed options.
 * @returns the action to run; `status` when none is named.
 * @throws {CliError} with the usage code when more than one action is named.
 */
function actionOf(values: ReturnType<typeof parseOptions<typeof RECOVER_OPTIONS>>): RecoverAction {
  const named = [values.rollback === true, values.restore !== undefined, values['safe-mode'] === true, values['exit-safe-mode'] === true]
  if (named.filter(Boolean).length > 1) {
    throw new CliError(EXIT.usage, 'delorun recover: choose one of --rollback, --restore <version>, --safe-mode or --exit-safe-mode')
  }
  if (values.restore !== undefined) return { kind: 'restore', version: values.restore as ProfileVersionId }
  if (values.rollback === true) return { kind: 'rollback' }
  if (values['safe-mode'] === true) return { kind: 'safe-mode', reason: values.reason ?? 'the person asked for safe mode' }
  if (values['exit-safe-mode'] === true) return { kind: 'exit-safe-mode' }
  return { kind: 'status' }
}

/** `delorun recover`: where the profile stands, and the three ways back contract C3 offers. */
export const recoverCommand: CliCommand = {
  name: 'recover',
  summary: 'Where the profile stands after an update, and the way back: --rollback, --restore <version>, --safe-mode, --exit-safe-mode',
  /**
   * Run `delorun recover`.
   * @param args - the arguments after `recover`.
   * @param context - the environment and output.
   * @returns the exit code: 0 when the action ran, 1 when profile safety refused it.
   */
  async run(args: readonly string[], context: CommandContext): Promise<CommandResult> {
    const values = parseOptions('recover', args, RECOVER_OPTIONS)
    const action = actionOf(values)
    const { home, profile } = await prepareHome(context, values.profile)
    try {
      const report = await recover({
        profileDir: join(home.path, 'profiles', profile),
        homeDir: home.path,
        profile,
        action,
        installationBundles: DELO_PROFILE_BUNDLES,
        changedBy: { kind: 'person' },
      })
      // Ending safe mode takes the overlay a safe-mode start wrote with it.
      if (action.kind === 'exit-safe-mode') removeSafeModeOverlay(home.path, profile)
      if (values.json === true) context.stdout(JSON.stringify(report, undefined, 2) + '\n')
      else for (const line of report.lines) context.stdout(`${line}\n`)
      return EXIT.ok
    } catch (error) {
      if (!isProfileSafetyError(error)) throw error
      context.stderr(`delorun recover: ${error.message}\n`)
      if (error.remedies.length > 0) context.stderr(`What you can do: ${error.remedies.join(', ')}.\n`)
      return EXIT.failed
    }
  },
}
