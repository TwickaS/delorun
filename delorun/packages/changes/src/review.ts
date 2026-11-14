/**
 * The risk summary of a change and the lines a terminal prints for it. The summary is a help to read a change, never
 * a protection: plugin code has the harness's full authority whatever the summary says.
 *
 * @module @delorun/changes/review
 */
import { BUILT_IN_CHECKS } from './risk.ts'
import { RISK_KINDS, type ReviewInput, type RiskCheck, type RiskFinding, type RiskKind, type RiskSummary } from './types.ts'

/** The first line of every printed summary. */
export const RISK_NOTICE = "This summary is a help to read the change, not a protection: a plugin's code can do anything Delorun can."

/** The line printed after {@link RISK_NOTICE} when no check found anything. */
export const NOTHING_FOUND = 'Nothing in the change matched the checks.'

/** How many locations one printed line names before it counts the rest. */
export const LOCATIONS_PER_LINE = 3

/** What each kind means, as the printed line begins. */
const KIND_PHRASES: Readonly<Record<RiskKind, string>> = {
  'consent-guard-sandbox': 'Changes a consent, a guard or the sandbox policy',
  'answers-approvals': 'Answers approval prompts itself',
  'manages-plugins': 'Installs, removes or loads plugins itself',
  'model-tool': 'Adds a tool the model can call',
  commands: 'Runs commands or other programs',
  network: 'Opens network connections',
  'home-read': 'Reads files under the Delorun home',
  'dependency-or-build': 'Adds or changes a dependency, or an install or build script',
  'not-shown': 'Has content the diff does not show',
}

/**
 * @param left - a string.
 * @param right - another.
 * @returns their order by UTF-16 code units.
 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * @param left - a finding.
 * @param right - another.
 * @returns their order: by kind in `RISK_KINDS` order, file, line (findings without a line first), check and excerpt.
 */
function compareFindings(left: RiskFinding, right: RiskFinding): number {
  return RISK_KINDS.indexOf(left.kind) - RISK_KINDS.indexOf(right.kind)
    || compareText(left.file, right.file)
    || (left.line ?? 0) - (right.line ?? 0)
    || compareText(left.check, right.check)
    || compareText(left.excerpt, right.excerpt)
}

/**
 * Run the checks over a change and summarize what they found. A later registration of checks passes them after
 * {@link BUILT_IN_CHECKS} through `checks`.
 * @param input - the change.
 * @param checks - the checks to run; the built-in ones by default.
 * @returns the findings sorted by kind, file and line with identical ones once, the kinds found, and whether applying
 * asks a second confirmation.
 */
export function reviewChange(input: ReviewInput, checks: readonly RiskCheck[] = BUILT_IN_CHECKS): RiskSummary {
  const seen = new Set<string>()
  const findings = checks
    .flatMap(check => check.check(input))
    .sort(compareFindings)
    .filter(finding => {
      const key = JSON.stringify([finding.kind, finding.check, finding.file, finding.line ?? null, finding.excerpt])
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const kinds = RISK_KINDS.filter(kind => findings.some(finding => finding.kind === kind))
  return { findings, kinds, needsSecondConfirmation: findings.length > 0 }
}

/**
 * @param kind - a risk kind.
 * @returns what it means, as a printed line begins, such as `Runs commands or other programs`.
 */
export function riskKindPhrase(kind: RiskKind): string {
  return KIND_PHRASES[kind]
}

/**
 * @param finding - a finding.
 * @returns where it is: `file:line`, or the file alone.
 */
function locationOf(finding: RiskFinding): string {
  return finding.line === undefined ? finding.file : `${finding.file}:${String(finding.line)}`
}

/**
 * The lines a terminal prints for a summary: {@link RISK_NOTICE}, then one line per kind found naming at most
 * {@link LOCATIONS_PER_LINE} distinct locations and counting the rest, or {@link NOTHING_FOUND}.
 * @param summary - the summary.
 * @returns the lines, without line endings.
 */
export function riskLines(summary: RiskSummary): string[] {
  if (summary.kinds.length === 0) return [RISK_NOTICE, NOTHING_FOUND]
  return [RISK_NOTICE, ...summary.kinds.map(kind => {
    const locations = [...new Set(summary.findings.filter(finding => finding.kind === kind).map(locationOf))]
    const shown = locations.slice(0, LOCATIONS_PER_LINE).join(', ')
    const more = locations.length - LOCATIONS_PER_LINE
    return `${riskKindPhrase(kind)} (${shown}${more > 0 ? ` and ${String(more)} more` : ''})`
  })]
}
