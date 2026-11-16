/**
 * The failure a command raises when it needs a person at a terminal and none is there. A program that reads the
 * terminal waits for keystrokes forever on a standard input that is not one; the command asks {@link requireTerminal}
 * first so it ends with a {@link CliError} instead.
 *
 * @module @delorun/cli/needs-terminal
 */
import { CliError, EXIT } from './exit.ts'

/**
 * What the failure says to do instead.
 * @param command - the command's name as a person types it, for example `delorun agents login`.
 * @param flag - the option that answers without a terminal, when the command has one.
 * @returns the one-line message.
 */
export function needsTerminalMessage(command: string, flag?: string): string {
  return `${command}: this needs you at a terminal to answer; run it in one${flag === undefined ? '.' : `, or pass ${flag}.`}`
}

/**
 * Refuse to go on when standard input is not a terminal.
 * @param command - the command's name as a person types it.
 * @param flag - the option that answers without a terminal, when the command has one.
 * @param input - the stream the question reads; the process's standard input unless a test supplies one.
 * @throws {CliError} `EXIT.failed` when `input` is not a terminal.
 */
export function requireTerminal(command: string, flag?: string, input: { readonly isTTY?: boolean } = process.stdin): void {
  if (input.isTTY !== true) throw new CliError(EXIT.failed, needsTerminalMessage(command, flag))
}
