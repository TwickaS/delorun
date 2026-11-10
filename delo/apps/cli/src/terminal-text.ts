/**
 * Text a command prints that it did not write itself: a chat's label, a file
 * name, a field an archive carries, a plugin's folder, diff or failure, or a
 * refusal that names one. Every C0 and C1 control, DEL, line and paragraph
 * separator, bidirectional control and zero-width or invisible formatting
 * character is written as an escape, so such text cannot move the cursor,
 * clear a line, start a line of its own, reorder what a person reads around it,
 * or hide a character between two that look adjacent. A line longer than
 * {@link LINE_LIMIT} is written as several, each continued one starting with
 * {@link CONTINUED}, so no line runs past what a person reads and nothing is
 * left out.
 *
 * @module @delo/cli/terminal-text
 */

/** The characters a terminal or a bidirectional layout acts on, and the ones that show nothing at all. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu

/** The longest line {@link printableLines} writes, in UTF-16 code units after escaping. */
export const LINE_LIMIT = 200

/** What begins each line {@link printableLines} continues a longer line on. */
export const CONTINUED = '  ↪ '

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

/**
 * One line as a terminal prints it: escaped like {@link printable}, a line break included, and wrapped at `limit`
 * without splitting an escape or a surrogate pair.
 * @param line - the line.
 * @param limit - the longest line; {@link LINE_LIMIT} by default.
 * @returns one line, or several when it is longer than `limit`, the later ones starting with {@link CONTINUED}.
 */
export function printableLines(line: string, limit = LINE_LIMIT): string[] {
  const lines: string[] = []
  let current = ''
  for (const character of line) {
    const shown = printable(character)
    if (current.length + shown.length > limit && current.length > CONTINUED.length) {
      lines.push(current)
      current = CONTINUED
    }
    current += shown
  }
  lines.push(current)
  return lines
}

/**
 * Text of several lines as a terminal prints it: each of its lines through {@link printableLines}.
 * @param text - the text, its lines separated by `\n`.
 * @param limit - the longest line; {@link LINE_LIMIT} by default.
 * @returns the lines.
 */
export function printableText(text: string, limit = LINE_LIMIT): string[] {
  return text.split('\n').flatMap(line => printableLines(line, limit))
}

/**
 * A value as JSON for the terminal: two-space JSON whose strings write every character a terminal acts on as a JSON
 * escape, so it parses to the same value.
 * @param value - the value.
 * @returns the JSON text, without a trailing newline.
 */
export function printableJson(value: unknown): string {
  // JSON.stringify writes C0 controls as escapes and never a raw line break inside a string, so each line is escaped alone.
  return JSON.stringify(value, undefined, 2).split('\n').map(printable).join('\n')
}

/**
 * A value one line of a report carries, such as a failure message a plugin wrote: escaped like {@link printable} and
 * cut at `limit`, saying how much was left out.
 * @param text - the value.
 * @param limit - the longest it is printed; {@link LINE_LIMIT} by default.
 * @returns it escaped, and cut short when longer than `limit`.
 */
export function clipped(text: string, limit = LINE_LIMIT): string {
  const shown = printable(text)
  return shown.length <= limit ? shown : `${shown.slice(0, limit)}… (${String(shown.length - limit)} more characters)`
}
