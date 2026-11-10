/**
 * Upstream's profile commands that `delorun` passes through unchanged:
 * `delorun plugin …` and `delorun headless …` run upstream's `dsh` command
 * line in this process, with the Delo home as `DSH_HOME`. Upstream's parser
 * refuses the desktop app's profile for `plugin`, as it does for `dsh`.
 *
 * `delorun headless` writes chat data beside the home process, so it registers itself as a data user first and
 * refuses while an update, a rollback or a restore of the chat data is in progress
 * ([data users](./update/data-users.ts)); an update's copy and restore refuse while it runs.
 *
 * @module @delo/cli/upstream
 */
import { CliError, EXIT } from './exit.ts'
import { prepareHome, type CliCommand } from './command.ts'
import { assertNoUpdateInProgress, DataInUseError, registerDataUser } from './update/data-users.ts'

/**
 * Run upstream's command line with these arguments.
 * @param argv - the arguments `dsh` would receive.
 */
async function runUpstreamCli(argv: readonly string[]): Promise<void> {
  // Loaded after the launch variables are set, so upstream resolves the Delo home.
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  await runCli({ argv })
}

/**
 * A command that passes its arguments to upstream's command line after its own name.
 * @param name - the command's name, which is also upstream's first argument.
 * @param summary - its line in `delorun --help`.
 * @returns the command.
 */
function passThrough(name: string, summary: string): CliCommand {
  return {
    name,
    summary,
    async run(args, context) {
      const { home } = await prepareHome(context, undefined)
      if (name !== 'headless') {
        await runUpstreamCli([name, ...args])
        return undefined
      }
      const release = registerDataUser(home.path)
      try {
        await assertNoUpdateInProgress(home.path)
      } catch (error) {
        release()
        if (error instanceof DataInUseError) throw new CliError(EXIT.failed, `delorun headless: ${error.detail}`)
        throw error
      }
      process.once('exit', release)
      await runUpstreamCli([name, ...args])
      return undefined
    },
  }
}

/** `delorun plugin --profile <name> <pnpm-args…>`: upstream's plugin management. */
export const pluginCommand = passThrough('plugin', 'Manage a profile\'s plugins, as dsh plugin does')

/** `delorun headless <task>`: upstream's one-task headless profile. */
export const headlessCommand = passThrough('headless', 'Answer one task and exit, as dsh headless does')
