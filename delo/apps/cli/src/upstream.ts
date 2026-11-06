/**
 * Upstream's profile commands that `delorun` passes through unchanged:
 * `delorun plugin …` and `delorun headless …` run upstream's `dsh` command
 * line in this process, with the Delo home as `DSH_HOME`. Upstream's parser
 * refuses the desktop app's profile for `plugin`, as it does for `dsh`.
 *
 * @module @delo/cli/upstream
 */
import { prepareHome, type CliCommand } from './command.ts'

/**
 * Run upstream's command line with these arguments. Upstream reads its
 * arguments from `process.argv`, and this process runs nothing else after it,
 * so the arguments after the script are replaced before it starts.
 * @param args - the arguments `dsh` would receive.
 */
async function runUpstreamCli(args: readonly string[]): Promise<void> {
  process.argv = [...process.argv.slice(0, 2), ...args]
  // Loaded after the launch variables are set, so upstream resolves the Delo home.
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  await runCli()
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
      await prepareHome(context, undefined)
      await runUpstreamCli([name, ...args])
      return undefined
    },
  }
}

/** `delorun plugin --profile <name> <pnpm-args…>`: upstream's plugin management. */
export const pluginCommand = passThrough('plugin', 'Manage a profile\'s plugins, as dsh plugin does')

/** `delorun headless <task>`: upstream's one-task headless profile. */
export const headlessCommand = passThrough('headless', 'Answer one task and exit, as dsh headless does')
