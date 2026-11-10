/**
 * Text a command prints that it did not write itself: a chat's label, a file
 * name, a field an archive carries, or a refusal that names one. Every C0 and
 * C1 control, DEL, line and paragraph separator and bidirectional control is
 * written as an escape, so such text cannot move the cursor, clear a line or
 * reorder what a person reads around it.
 *
 * @module @delo/cli/terminal-text
 */

/** The characters a terminal or a bidirectional layout acts on. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu

/**
 * Escape every character a terminal acts on.
 * @param text - the string.
 * @returns it with each such character written as `\uXXXX`.
 */
export function printable(text: string): string {
  return text.replace(UNSAFE, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * Quote one string for the terminal.
 * @param text - the string.
 * @returns it as a JSON string, with every character a terminal acts on written as an escape.
 */
export function quoted(text: string): string {
  return printable(JSON.stringify(text))
}
