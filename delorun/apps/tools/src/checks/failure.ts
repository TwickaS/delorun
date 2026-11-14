/**
 * A failed check's first failure, from its log, for the run's summary and the batch tool's lane reports: the first failing
 * test's name and the assertion or error after it, or else the log's first error lines.
 *
 * @module @delorun/tools/checks/failure
 */
import { stripVTControlCharacters } from 'node:util'

/** The most lines an excerpt keeps, and the most characters per line. */
const EXCERPT_LINES = 8
const LINE_CHARACTERS = 240
const ERROR_LINE = /error|expected|assert|fail|✗|×/i

/**
 * A log's lines without terminal colour sequences.
 * @param log - the log.
 * @returns its lines.
 */
export function plainLines(log: string): string[] {
  return stripVTControlCharacters(log).split('\n').map(line => line.trimEnd())
}

/**
 * A failure's first lines: the first failing test's name and the assertion or error after it, or else the log's first
 * error lines, or else its first lines; never more than {@link EXCERPT_LINES}.
 * @param log - the check's log.
 * @returns the lines, each cut to {@link LINE_CHARACTERS}.
 */
export function excerpt(log: string): string[] {
  const all = plainLines(log)
  const filled = all.filter(line => line.trim().length > 0)
  const nameAt = all.findIndex(line => /\bFAIL\b.*\s>\s/.test(line))
  let chosen: string[]
  if (nameAt >= 0) {
    const errorAt = all.findIndex((line, index) => index > nameAt && ERROR_LINE.test(line))
    chosen = [...all.slice(nameAt, nameAt + 1), ...errorAt < 0 ? [] : all.slice(errorAt, errorAt + 4).filter(line => line.trim().length > 0)]
  } else {
    const errors = filled.filter(line => ERROR_LINE.test(line))
    chosen = errors.length > 0 ? errors : filled
  }
  return chosen.slice(0, EXCERPT_LINES).map(line => line.trim().slice(0, LINE_CHARACTERS))
}
