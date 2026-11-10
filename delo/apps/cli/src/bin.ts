/**
 * The `delorun` command's entry point: installs the process's last-resort handler
 * ([last-resort](./last-resort.ts)), then runs {@link main} with the command line and sets its exit code, unless
 * upstream's profile runner owns the process.
 *
 * @module @delo/cli/bin
 */
import { main } from './main.ts'
import { installCliLastResort } from './last-resort.ts'

if (import.meta.main) {
  const argv = process.argv.slice(2)
  installCliLastResort(argv)
  const exit = await main(argv)
  if (exit !== undefined) process.exitCode = exit
}
