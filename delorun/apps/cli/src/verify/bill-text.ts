/**
 * The bill of materials `delorun verify` prints after its check lines, from a trust bill ([bill](./bill.ts)): the
 * release, the start check, the release log, plugins, changes, patch rows and `!!js` values, skill roots and MCP servers,
 * then a `Your changes` line: the person's own changes as a neutral count, followed by every row that is failed, needs
 * attention, unchecked or unknown, so the count never reads as a complete review. Every name, path and detail read from a
 * file goes through [terminal text](../terminal-text.ts). The summary line gains the badge's state, which is `verified`
 * only when every row is; the person's own changes never change it.
 *
 * @module @delorun/cli/verify/bill-text
 */
import { trustBadge, trustRows, type TrustBill, type TrustCheckResult, type TrustRowId, type TrustState } from '@delorun/bundle-local/trust-bill'
import { printable } from '../terminal-text.ts'

/** Contract C15's statement that every report makes about the checks' access. */
export const ACCESS_LINE = 'These checks run with your access, and a program running with your access can change them.\n'

/** How a row reads on the `Not reviewed` line. */
const ROW_WORDS: Readonly<Record<TrustRowId, string>> = { release: 'release', releaseLog: 'release log', plugins: 'plugins', changes: 'changes' }

/** How a state reads. */
const STATE_WORDS: Readonly<Record<TrustState, string>> = {
  'verified': 'verified',
  'checked-at-start': 'checked at start only',
  'checked-in-studio': 'checked inside the studio only',
  'checking': 'signature verified, checking files',
  'waiting': 'waiting for your review',
  'attention': 'needs attention',
  'failed': 'failed',
  'unchecked': 'unchecked',
  'unknown': 'unknown',
}

/** How a check result reads. */
const RESULT_WORDS: Readonly<Record<TrustCheckResult, string>> = { pass: 'passed', fail: 'failed', unknown: 'not checked' }

/**
 * A value read from a file, made safe for the terminal, or a word for its absence.
 * @param value - the value.
 * @param absent - the words when it is `null`.
 * @returns the text.
 */
function shown(value: string | null, absent: string): string {
  return value === null ? absent : printable(value)
}

/**
 * The release lines.
 * @param bill - the bill.
 * @returns the lines.
 */
function releaseLines(bill: TrustBill): string[] {
  const { release } = bill
  const root = release.root === null
    ? 'none read'
    : `version ${String(release.root.version)}, root key ${release.root.keyIds.map(key => printable(key.slice(0, 16))).join(', ')}, anchored on ${release.root.anchored === 'shipped' ? 'the launcher\'s shipped roots' : 'the stored root only'}`
  const start = release.startCheck === null
    ? 'none handed over by the launcher'
    : `${release.startCheck.checkedBy === 'runtime' ? 'the updated release checked its own files, ' : ''}${release.startCheck.at}, ${release.startCheck.full ? 'every file hashed' : 'files the identity record vouched for were not hashed'}: ${String(release.startCheck.hashed)} of ${String(release.startCheck.files)} files hashed`
  return [
    `  Release: ${shown(release.version, 'unknown version')}, commit ${shown(release.commit, 'unknown')}; signature ${RESULT_WORDS[release.signature]}, files ${RESULT_WORDS[release.files]}${release.detail === undefined ? '' : ` (${printable(release.detail)})`}`,
    `    manifest SHA-256 ${shown(release.manifestSha256, 'unknown')}; file list SHA-256 ${shown(release.fileListSha256, 'unknown')}`,
    `    trusted root: ${root}`,
    `    launcher: version ${shown(release.launcher.version, 'unknown')}, at ${shown(release.launcher.path, 'an unknown path')}`,
    `    last full hash of every runtime file: ${release.lastFullHashAt ?? 'unknown'}`,
    `  Start check: ${start}`,
  ]
}

/**
 * The release-log line.
 * @param bill - the bill.
 * @returns the line.
 */
function releaseLogLine(bill: TrustBill): string {
  const log = bill.releaseLog
  const since = log.uncheckedSince === null ? '' : ` since ${log.uncheckedSince}`
  const attempt = log.lastAttempt === null ? '' : `, last attempt ${log.lastAttempt}`
  return `  Release log: ${log.state}${since}${attempt}${log.detail === undefined ? '' : ` (${printable(log.detail)})`}`
}

/**
 * The plugin lines.
 * @param bill - the bill.
 * @returns the lines.
 */
function pluginLines(bill: TrustBill): string[] {
  const { plugins } = bill
  const head = `  Plugins: ${String(plugins.entries.length)}${plugins.status === 'unknown' ? `, unknown (${printable(plugins.reason ?? 'no reason given')})` : ''}`
  return [head, ...plugins.entries.map(plugin => {
    const pinned = plugin.commit === null ? `integrity ${shown(plugin.integrity, 'none recorded')}` : `commit ${printable(plugin.commit)}`
    const warnings = plugin.warnings.length === 0 ? '' : `; warnings: ${plugin.warnings.map(printable).join('; ')}`
    const advisories = plugin.criticalAdvisories.length === 0 ? '' : `; critical advisories: ${plugin.criticalAdvisories.map(printable).join(', ')}`
    return `    ${printable(plugin.name)} ${shown(plugin.version, 'version unknown')}, source ${plugin.source}, ${pinned}, install record ${plugin.match}${warnings}${advisories}`
  })]
}

/**
 * The changes lines.
 * @param bill - the bill.
 * @returns the lines.
 */
function changeLines(bill: TrustBill): string[] {
  const { changes } = bill
  if (changes.status === 'unknown') return [`  Changes: unknown (${printable(changes.reason ?? 'no reason given')})`]
  return [
    `  Changes: ${String(changes.harnessEdits.length)} approved harness files, ${String(changes.approvedPlugins.length)} approved plugin versions, ${String(changes.notReviewed)} waiting for your review`,
    ...changes.harnessEdits.map(edit => `    harness edit: ${printable(edit.file)}`),
    ...changes.approvedPlugins.map(plugin => `    approved: ${printable(plugin.plugin)} ${shown(plugin.version, 'version unknown')} from ${printable(plugin.source)}`),
  ]
}

/**
 * The patch lines.
 * @param bill - the bill.
 * @returns the lines.
 */
function patchLines(bill: TrustBill): string[] {
  const { patches } = bill
  const unknown = patches.status === 'unknown' ? `; unknown (${printable(patches.reason ?? 'no reason given')})` : ''
  return [
    `  Patches: ${String(patches.rows.length)} rows added in your patch layers, ${String(patches.jsValues)} !!js values${unknown}`,
    ...patches.rows.map(row => `    ${printable(row.layer)}: ${shown(row.id, 'no id')} (${shown(row.name, 'no plugin name')})`),
  ]
}

/**
 * The skill-root and MCP lines.
 * @param bill - the bill.
 * @returns the lines.
 */
function skillAndMcpLines(bill: TrustBill): string[] {
  const { mcp } = bill
  return [
    `  Skill roots: ${String(bill.skills.roots.length)}`,
    ...bill.skills.roots.map(root => `    ${printable(root.source)}: ${printable(root.path)}`),
    `  MCP servers: ${String(mcp.servers.length)}${mcp.status === 'unknown' ? `, unknown (${printable(mcp.reason ?? 'no reason given')})` : ''}`,
    ...mcp.servers.map(server => `    ${printable(server.name)} (${shown(server.transport, 'transport unknown')})`),
  ]
}

/**
 * The `Your changes` line: the person's own changes as a neutral count, by kind, then each row that is failed, needs
 * attention, unchecked or unknown, so the count never reads as a complete review.
 * @param bill - the bill.
 * @returns the line, ending with a newline.
 */
export function ownChangesLine(bill: TrustBill): string {
  const rows = trustRows(bill)
  const count = rows.reduce((sum, row) => sum + row.ownChanges, 0)
  const { changes, patches } = bill
  const kinds = `${String(changes.harnessEdits.length)} approved harness files, ${String(changes.approvedPlugins.length)} approved plugin versions, ${String(changes.notReviewed)} waiting for your review, ${String(patches.rows.length)} patch rows`
  const groups = (['failed', 'attention', 'unchecked', 'unknown', 'checked-in-studio', 'checked-at-start', 'waiting'] as const)
    .map(state => ({ state, names: rows.filter(row => row.state === state).map(row => ROW_WORDS[row.id]) }))
    .filter(group => group.names.length > 0)
    .map(group => `; ${STATE_WORDS[group.state]}: ${group.names.join(', ')}`)
  return `Your changes: ${String(count)} (${kinds})${groups.join('')}.\n`
}

/**
 * The bill of materials block.
 * @param bill - the bill.
 * @returns the lines, each ending with a newline, the `Your changes` line last.
 */
export function billLines(bill: TrustBill): string {
  const lines = [
    `Bill of materials (${bill.stage} stage, ${bill.generatedAt}):`,
    ...releaseLines(bill),
    releaseLogLine(bill),
    ...pluginLines(bill),
    ...changeLines(bill),
    ...patchLines(bill),
    ...skillAndMcpLines(bill),
  ]
  return `${lines.map(line => `${line}\n`).join('')}${ownChangesLine(bill)}`
}

/**
 * The words the summary line gains from a bill: the badge's state, which reads `verified` only when every row is, and
 * the neutral count of the person's own changes.
 * @param bill - the bill, when the run built one.
 * @returns a `; …` clause; empty without a bill.
 */
export function billSuffix(bill: TrustBill | undefined): string {
  if (bill === undefined) return ''
  const badge = trustBadge(trustRows(bill))
  return `; this Delorun reads ${STATE_WORDS[badge.state]}${badge.ownChanges > 0 ? `, with ${String(badge.ownChanges)} of your changes` : ''}`
}
