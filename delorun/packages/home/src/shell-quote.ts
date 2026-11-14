/**
 * The quoting of a value inside a command Delorun suggests to the person, such as `delorun workspace full-access
 * '<folder>' on`: one single-quoted POSIX shell word, so a folder with spaces, quotes, `$`, backticks or `;` pastes back
 * as the one argument it names and runs nothing.
 *
 * @module @delorun/home/shell-quote
 */

/**
 * Quote one value as a single POSIX shell word.
 * @param value - the value, such as a folder path.
 * @returns the value in single quotes, each single quote inside it written as `'\''`.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}
