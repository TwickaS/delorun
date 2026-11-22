/**
 * Turns the text a failing stage produced into what a card records: a normalised error signature (so the same failure
 * on two runs or two plugins reads the same), the cause from `causes.json` and the fix class. Classification is a list
 * of rules read in order over the evidence lines; a stage with no matching rule gets the stage's own default cause, and
 * an agent or Consul may reclassify by editing the card (new causes are added to `causes.json` by Consul).
 *
 * @module @delorun/tools/compat-bench/classify
 */
import { loadCauses, type StageFailure } from './card.ts'
import type { StageName } from './observer.ts'

/**
 * Normalise an error line so two occurrences of one failure compare equal.
 * @param line - an error line.
 * @returns the line with paths, numbers, hashes, ports and timestamps replaced by placeholders, cut to 160 characters.
 */
export function normaliseSignature(line: string): string {
  return line
    .replace(/\u001B\[[0-9;]*m/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<time>')
    .replace(/(?:\/[\w.@+~-]+){2,}/g, '<path>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hash>')
    .replace(/:\d{2,5}\b/g, ':<n>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|MB|KB|B)\b/g, '<n>$2')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/** One classification rule. */
interface Rule {
  /** The cause id. */
  readonly cause: string
  /** What the evidence has to match. */
  readonly pattern: RegExp
  /** The stages the rule applies to; every stage when absent. */
  readonly stages?: readonly StageName[]
}

/** The rules, most specific first. */
const RULES: readonly Rule[] = [
  { cause: 'version-range', pattern: /engines?\b.*(satisf|incompatible|not supported|requires|refus)|does not satisfy|unsupported engine|requires (dsh|delorun)\b|installation rejected:.*(engines|version range)|incompatible with (dsh|delorun)/i },
  { cause: 'platform', pattern: /\bwin32\b|windows only|only (supports|works on) (windows|macos|darwin)|reg\.exe|EBADPLATFORM|unsupported platform/i },
  { cause: 'needs-account', pattern: /sign.?in required|please log ?in|not logged in|login required|no account|requires an account|api key (is )?(missing|required)|\b401\b.*unauthori[sz]ed/i },
  { cause: 'needs-real-model', pattern: /real model|requires a live model|mock response recovered.*unexpected/i },
  { cause: 'files-in-home', pattern: /HOME_IN_WRITABLE_ROOT|protected home|EACCES|EROFS|permission denied.*(delorun|\.delorun|changes)|ENOENT.*(changes\/|profiles\/)/i },
  { cause: 'load-error', pattern: /failed to import|failed to load|Cannot find (module|package)|ERR_MODULE_NOT_FOUND|ValidationError|SyntaxError|ReferenceError|TypeError.*(apply|plugin)|plugin.*(threw|failed)/i, stages: ['install', 'start', 'restart', 'update'] },
  { cause: 'ui-error', pattern: /console error|pageerror|Unhandled (page )?exception|ChunkLoadError|Minified React error/i, stages: ['screens', 'feature', 'restart', 'update', 'clashes'] },
]

/** The cause a stage gets when no rule matches. */
const STAGE_DEFAULT: Readonly<Record<StageName, string>> = {
  install: 'load-error',
  start: 'load-error',
  harness: 'harness-broken',
  screens: 'ui-error',
  feature: 'ui-error',
  restart: 'load-error',
  update: 'load-error',
  clashes: 'studio-overlap',
  cost: 'ui-error',
  uninstall: 'files-in-home',
}

/**
 * Classify one failure.
 * @param stage - the stage that failed.
 * @param evidence - the log or console lines behind it, most telling first.
 * @param location - the plugin's file and line when the evidence names one.
 * @returns the failure a card records.
 */
export function classifyFailure(stage: StageName, evidence: readonly string[], location?: string): StageFailure {
  const text = evidence.join('\n')
  const rule = RULES.find(each => (each.stages === undefined || each.stages.includes(stage)) && each.pattern.test(text))
  const cause = rule?.cause ?? STAGE_DEFAULT[stage]
  const fixClass = loadCauses().find(each => each.id === cause)?.fixClass ?? 'upstream'
  const first = evidence.find(line => line.trim() !== '') ?? `${stage} failed`
  return { signature: normaliseSignature(first), evidence: evidence.map(line => line.slice(0, 400)).slice(0, 20), cause, fixClass, ...(location === undefined ? {} : { location }) }
}

/**
 * The first line of a plugin's file and line in a stack trace or log, as `file:line`.
 * @param text - log text.
 * @returns the location, or undefined when the text names none outside Delorun's own tree.
 */
export function findPluginLocation(text: string): string | undefined {
  for (const match of text.matchAll(/(?:file:\/\/)?((?:\/[\w.@+~-]+)+\.(?:js|mjs|cjs|ts|tsx)):(\d+)(?::\d+)?/g)) {
    const path = match[1] ?? ''
    if (path.includes('/node_modules/') && !path.includes('/profiles/')) continue
    if (path.startsWith('/opt/delorun/') || path.startsWith('/opt/bench/')) continue
    return `${path.replace(/^.*\/profiles\/[^/]+\/node_modules\//, '')}:${match[2] ?? ''}`
  }
  return undefined
}
