/**
 * The `delorun` command's entry point: runs {@link main} with the command line
 * and sets its exit code, unless upstream's profile runner owns the process.
 *
 * @module @delo/cli/bin
 */
import { main } from './main.ts'

if (import.meta.main) {
  const exit = await main(process.argv.slice(2))
  if (exit !== undefined) process.exitCode = exit
}
