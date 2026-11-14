/**
 * The `delorun` command's exit codes, which scripts can rely on, and the error
 * that carries one to the entry point.
 *
 * @module @delorun/cli/exit
 */

/** Every exit code `delorun` uses. */
export const EXIT = {
  /** The command did what it was asked, or found it already done. */
  ok: 0,
  /** The command failed; standard error says why. */
  failed: 1,
  /** The command line is wrong: an unknown command, option or value. */
  usage: 2,
  /** The command needs a running home process, and none runs for the profile. */
  notRunning: 3,
  /** The person interrupted the command (Ctrl-C); 128 plus signal 2, as shells report it. */
  interrupted: 130,
  /**
   * A home process `delorun start` started detached did not start and left the newest change out; its starter starts
   * it once more without that change ([retry](./changes/retry.ts)).
   */
  changeLeftOut: 4,
} as const

/** One of {@link EXIT}'s codes. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** A failure the entry point reports on standard error and exits with. */
export class CliError extends Error {
  /** The code to exit with. */
  readonly exit: ExitCode

  /**
   * @param exit - the code to exit with.
   * @param message - what went wrong and what to do.
   */
  constructor(exit: ExitCode, message: string) {
    super(message)
    this.exit = exit
    this.name = 'CliError'
  }
}
