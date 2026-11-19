/**
 * The home-log check of the installed-release smoke: the lines of one start of the home process that say a plugin, a
 * pack or a protection did not load. Each pattern names a failure an earlier release shipped with. A line that matches
 * a pattern is a problem unless it also matches an entry of {@link BENIGN_LOG_LINES}, a short list of lines a fresh
 * home writes whose cause is outside the release.
 *
 * @module @delorun/release/installed-smoke/home-log
 */

/** One pattern the check refuses, with what it means. */
export interface LogPattern {
  /** The pattern, matched against one line. */
  readonly pattern: RegExp
  /** What a match means, for the report. */
  readonly meaning: string
}

/** The lines a start must not write. */
export const FORBIDDEN_LOG_LINES: readonly LogPattern[] = [
  { pattern: /failed to import/iu, meaning: 'a module failed to import' },
  { pattern: /Cannot find package/u, meaning: 'a package is missing' },
  { pattern: /could not load/iu, meaning: 'something could not be loaded' },
  { pattern: /not this Delorun's own copy/u, meaning: 'a bundle loaded from outside the release' },
  { pattern: /packs: installing .* failed/u, meaning: 'a pack install failed' },
  { pattern: /would boot without protections/u, meaning: 'the start refused a composition without its protections' },
]

/** One allowed line, with why it is harmless. */
export interface BenignLine {
  /** The pattern, matched against a line one of {@link FORBIDDEN_LOG_LINES} matched. */
  readonly pattern: RegExp
  /** Why it is not a release problem. */
  readonly reason: string
}

/** The lines that match a forbidden pattern and are not release problems. Keep this list short and each entry exact. */
export const BENIGN_LOG_LINES: readonly BenignLine[] = [
  { pattern: /could not load hook config "[^"]*\/\.(?:claude\/settings|codex\/hooks)\.json": Error: ENOENT/u, reason: 'a fresh home has no Claude Code or Codex hooks file, so the hooks bundle registers none' },
]

/**
 * The text of one log line: a record's `msg` (contract C20 writes one JSON record per line), or the line itself.
 * @param line - the line.
 * @returns the text the patterns are matched against.
 */
function lineText(line: string): string {
  if (!line.startsWith('{')) return line
  try {
    const record: unknown = JSON.parse(line)
    if (typeof record === 'object' && record !== null && 'msg' in record && typeof record.msg === 'string') return record.msg
  } catch (_partial) {
    // A line cut off at the end of the read is matched as it stands.
  }
  return line
}

/**
 * The problems in the text of one start's log.
 * @param text - the log text the start wrote.
 * @returns one line per refused log line, naming what it means and quoting at most 400 characters of its text.
 */
export function logProblems(text: string): string[] {
  const problems: string[] = []
  for (const line of text.split('\n')) {
    const message = lineText(line.trim())
    const match = FORBIDDEN_LOG_LINES.find(entry => entry.pattern.test(message))
    if (match === undefined || BENIGN_LOG_LINES.some(entry => entry.pattern.test(message))) continue
    problems.push(`${match.meaning}: ${message.slice(0, 400)}`)
  }
  return problems
}
