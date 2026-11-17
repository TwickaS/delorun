/**
 * Small formatting helpers the commands share for what they print. Marks, colour and spinners are in
 * [style](./style.ts).
 *
 * @module @delorun/cli/output
 */

/** The options {@link readableTime} formats with. */
export interface TimeOptions {
  /** A BCP 47 locale; the process's locale by default. */
  readonly locale?: string
  /** An IANA time zone; the computer's by default. */
  readonly timeZone?: string
}

/**
 * A time as a person reads it, such as `17 Nov 2026, 01:07`.
 * @param time - an ISO 8601 text, a millisecond timestamp or a date.
 * @param options - the locale and time zone.
 * @returns the text; the input as given when it is not a time.
 */
export function readableTime(time: string | number | Date, options: TimeOptions = {}): string {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return String(time)
  return new Intl.DateTimeFormat(options.locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...options.timeZone === undefined ? {} : { timeZone: options.timeZone } }).format(date)
}

/** An ISO 8601 UTC timestamp with milliseconds, as the records write them. */
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu

/**
 * Replace every ISO timestamp in a line with {@link readableTime}.
 * @param line - the text.
 * @param options - the locale and time zone.
 * @returns the text with readable times.
 */
export function withReadableTimes(line: string, options: TimeOptions = {}): string {
  return line.replace(ISO_TIME, iso => readableTime(iso, options))
}

/**
 * An address-like text in groups of four characters, as fingerprints are shown to be compared by eye.
 * @param text - the text without separators.
 * @returns it split into groups of four, joined by spaces.
 */
export function groupsOfFour(text: string): string {
  return text.match(/.{1,4}/gu)?.join(' ') ?? ''
}

/**
 * The edit distance between two words.
 * @param a - one word.
 * @param b - the other.
 * @returns the number of single-character insertions, deletions and substitutions between them.
 */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)))
    row = next
  }
  return row[b.length]!
}

/**
 * The candidate a mistyped word most likely meant.
 * @param word - what the person typed.
 * @param candidates - the words that exist.
 * @returns the closest candidate within two edits, or one that starts with `word`; undefined when none is near.
 */
export function closestMatch(word: string, candidates: readonly string[]): string | undefined {
  const typed = word.toLowerCase()
  const prefixed = word.length >= 2 ? candidates.find(candidate => candidate.startsWith(typed)) : undefined
  if (prefixed !== undefined) return prefixed
  const scored = candidates.map(candidate => ({ candidate, edits: distance(typed, candidate) })).sort((a, b) => a.edits - b.edits)[0]
  return scored !== undefined && scored.edits <= Math.min(2, Math.floor(word.length / 2)) ? scored.candidate : undefined
}
