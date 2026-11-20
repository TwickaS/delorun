/**
 * How the flow writes paths and times: the home folder as `~`, a folder's name, and how long ago a workspace was used.
 * @module @delorun/plugin-new-workspace/client/paths
 */
import type { Translate } from './locales.ts'

/**
 * The separator a path uses, from the path itself.
 * @param path - an absolute path.
 * @returns a backslash for a Windows path, otherwise a slash.
 */
function separatorOf(path: string): '/' | '\\' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/**
 * The folder a name makes inside another.
 * @param parent - the containing folder.
 * @param name - the child's name.
 * @returns the child's path.
 */
export function joinPath(parent: string, name: string): string {
  const separator = separatorOf(parent)
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`
}

/**
 * A path as the person reads it: the home folder is `~`, and nothing else about the computer is added.
 * @param path - an absolute path.
 * @param home - the home folder.
 * @returns `~`, `~/…` for a path inside the home folder, otherwise the path unchanged.
 */
export function displayPath(path: string, home: string): string {
  if (path === home) return '~'
  const separator = separatorOf(home)
  return path.startsWith(`${home}${separator}`) ? `~${path.slice(home.length)}` : path
}

/**
 * The last part of a path.
 * @param path - an absolute path.
 * @returns the folder's name, or the path itself for a root.
 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/u, '')
  return trimmed.replace(/^.*[/\\]/u, '') || path
}

/** The longest span, in milliseconds, each unit of {@link relativeTime} is used for, and its length. */
const UNITS = [
  { key: 'minutes', ms: 60_000, upTo: 3_600_000 },
  { key: 'hours', ms: 3_600_000, upTo: 86_400_000 },
  { key: 'days', ms: 86_400_000, upTo: 7 * 86_400_000 },
  { key: 'weeks', ms: 7 * 86_400_000, upTo: 30 * 86_400_000 },
  { key: 'months', ms: 30 * 86_400_000, upTo: 365 * 86_400_000 },
  { key: 'years', ms: 365 * 86_400_000, upTo: Infinity },
] as const

/**
 * How long ago a time was.
 * @param iso - an ISO-8601 time.
 * @param now - the current time in milliseconds.
 * @param t - this plugin's copy.
 * @returns the phrase, or undefined when the time cannot be read.
 */
export function relativeTime(iso: string, now: number, t: Translate): string | undefined {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return undefined
  const span = Math.max(0, now - then)
  if (span < 60_000) return t('time.now')
  const unit = UNITS.find(candidate => span < candidate.upTo)
  // The last unit has no upper bound, so a unit is always found.
  if (unit === undefined) return undefined
  const count = Math.floor(span / unit.ms)
  return t(count === 1 ? `time.${unit.key}.one` : `time.${unit.key}.other`, { n: count })
}

/** The units of {@link formatSize}, each 1024 times the one before. */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * A file size as a person reads it.
 * @param bytes - the size in bytes.
 * @returns the size with one unit and at most one decimal place, such as `512 B` or `1.5 MB`.
 */
export function formatSize(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, '')
  return `${text} ${SIZE_UNITS[unit]}`
}
