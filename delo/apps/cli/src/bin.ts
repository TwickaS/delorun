/**
 * The `delorun` command's entry point: installs the process's last-resort handler
 * ([last-resort](./last-resort.ts)), then runs {@link main} with the command line and sets its exit code, unless
 * upstream's profile runner owns the process. `--help` and `--version` run without the handler: it loads every
 * describer a failure report can use, which they never reach, and {@link main} reports their own failures itself.
 *
 * @module @delo/cli/bin
 */
import { main } from './main.ts'
import { endQuietlyWhenStdoutCloses } from './stdout.ts'

/** The first arguments that answer from text alone. */
const TEXT_ONLY = new Set(['--help', '-h', 'help', '--version', '-v'])

if (import.meta.main) {
  endQuietlyWhenStdoutCloses()
  const argv = process.argv.slice(2)
  if (!TEXT_ONLY.has(argv[0] ?? '')) (await import('./last-resort.ts')).installCliLastResort(argv)
  const exit = await main(argv)
  if (exit !== undefined) process.exitCode = exit
}
