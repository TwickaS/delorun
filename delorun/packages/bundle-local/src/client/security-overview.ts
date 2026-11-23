/**
 * The security overview's rows (A628, L197): five questions a person asks about their studio, in a fixed order, each
 * answered with a status that comes from its cause. The model is pure: {@link overviewRows} takes the facts the studio
 * read from the Host's routes and returns each row's status and cause; the panel words them through its dictionaries.
 *
 * - `green`: the default protection is on and checked.
 * - `chosen`: amber, quiet; the person chose it (Full access, phone access on, a plugin from a folder).
 * - `look`: amber, stronger; something needs a look (a device unseen for weeks, the release log not checked, a fact
 *   that could not be read).
 * - `red`: protection is off or failing (dangerous mode, a failed signature, an advisory or a changed plugin, an undo that cannot work).
 *
 * A plugin row never says safe: plugins are not confined (A558), so its green reads "reviewed, no advisory".
 *
 * Browser-safe.
 *
 * @module @delorun/bundle-local/client/security-overview
 */
import { trustRows, type TrustBill, type TrustChecks } from './trust-bill.ts'

/** The five rows, in the order the panel shows them. */
export const OVERVIEW_ROW_IDS = ['agent', 'undo', 'reach', 'addons', 'copy'] as const

/** One of {@link OVERVIEW_ROW_IDS}. */
export type OverviewRowId = (typeof OVERVIEW_ROW_IDS)[number]

/** A row's status, from its cause. */
export type OverviewStatus = 'green' | 'chosen' | 'look' | 'red'

/** How loud each status is, loudest first; the headline takes the loudest row's. */
export const OVERVIEW_STATUS_ORDER: readonly OverviewStatus[] = ['red', 'look', 'chosen', 'green']

/** How long a paired device may go unseen before its row asks for a look, in milliseconds: three weeks. */
export const DEVICE_UNSEEN_MS = 21 * 24 * 60 * 60 * 1000

/** The facts the overview is built from; each is `null` when its route could not be read from this studio. */
export interface OverviewFacts {
  /** The run settings: dangerous mode and phone access. */
  readonly run: { readonly dangerous: 'off' | 'on' | 'inactive', readonly prompts: string, readonly reach: { readonly on: boolean } } | null
  /** Dangerous mode as the permission defaults hold it. */
  readonly everywhere: { readonly on: boolean, readonly grantedAt?: string } | null
  /** Workspaces the person gave a preset, with when. */
  readonly workspaces: readonly { readonly workspace: string, readonly title?: string, readonly preset: string, readonly grantedAt: number | null }[] | null
  /**
   * Undo of changes to Delorun and its plugins, from Changes' state: whether review before loading is on, how many records
   * Changes cannot read, and how many applied agent changes it recorded without the saved version an undo needs.
   */
  readonly undo: { readonly protection: 'on' | 'off', readonly unreadable: number, readonly unversioned: number } | null
  /** The paired devices, with when each last signed in (milliseconds since the epoch). */
  readonly devices: readonly { readonly id: string, readonly label: string, readonly approvedAt: number, readonly lastSignInAt: number | null }[] | null
  /** PIN mode on devices. */
  readonly pin: { readonly on: boolean } | null
  /** The trust bill and how fresh each of its rows is. */
  readonly bill: TrustBill | null
  readonly checks: TrustChecks | null
  /** MCP servers waiting for the person's decision. */
  readonly mcpWaiting: number | null
  /** External agents and the level each runs at. */
  readonly agentLevels: readonly { readonly provider: string, readonly level: string }[] | null
  /** A newer release, and whether it is a security release; `null` when none is known. */
  readonly update: { readonly version: string, readonly security: boolean } | null
  /** The clock, in milliseconds since the epoch. */
  readonly now: number
}

/** What a row's one fixing button does. */
export type OverviewAction =
  | { readonly kind: 'open-section', readonly section: string }
  | { readonly kind: 'check-now' }
  | { readonly kind: 'protection-on' }

/** The causes of each row's status, green ones first; the panel words each one. */
export const OVERVIEW_GREEN_CAUSES = [
  'agent.standard', 'undo.on', 'undo.recorded', 'reach.private', 'reach.devices-off', 'addons.none', 'addons.reviewed', 'copy.verified', 'copy.checking',
] as const

/** The causes of a row that is not green, each with its meaning, its reason and its action's words. */
export const OVERVIEW_OPEN_CAUSES = [
  'agent.full-access', 'agent.dangerous', 'agent.unread',
  'undo.broken', 'undo.unread',
  'reach.phone', 'reach.unseen', 'reach.unread',
  'addons.unlisted', 'addons.unrestricted', 'addons.mcp-waiting', 'addons.unchecked', 'addons.advisory', 'addons.changed', 'addons.unread',
  'copy.not-full', 'copy.log', 'copy.security-update', 'copy.failed', 'copy.unread',
] as const

/** The cause of a row's status. */
export type OverviewCause = (typeof OVERVIEW_GREEN_CAUSES)[number] | (typeof OVERVIEW_OPEN_CAUSES)[number]

/** One row. */
export interface OverviewRow {
  readonly id: OverviewRowId
  readonly status: OverviewStatus
  readonly cause: OverviewCause
  /** Numbers and names the row's words use, such as a count or the workspace a choice was made for. */
  readonly params: Readonly<Record<string, string | number>>
  /** When the person made the choice, in milliseconds since the epoch; absent when unknown or not a choice. */
  readonly chosenAt?: number
  /** For a row that is not green: whether it is the person's choice or a fault. */
  readonly kind?: 'choice' | 'fault'
  /** For a row that is not green: the one action that fixes it. */
  readonly action?: OverviewAction
}

/** The settings sections the rows' buttons open. */
export const OVERVIEW_SECTIONS = {
  permissions: 'delorun-permissions',
  changes: 'delorun-changes',
  devices: 'delorun-devices',
  pluginInstalls: 'delorun-plugin-installs',
  externalAgents: 'delorun-external-agents',
  update: 'delorun-update',
} as const

/** The preset that gives a workspace Full access. */
const FULL_ACCESS = 'danger-full-access'

/**
 * A row.
 * @param id - the row.
 * @param status - its status.
 * @param cause - its cause.
 * @param extra - its params, choice time, kind and action.
 * @returns the row.
 */
function row(id: OverviewRowId, status: OverviewStatus, cause: OverviewCause, extra: Omit<OverviewRow, 'id' | 'status' | 'cause' | 'params'> & { readonly params?: OverviewRow['params'] } = {}): OverviewRow {
  return { id, status, cause, params: extra.params ?? {}, ...extra.chosenAt === undefined ? {} : { chosenAt: extra.chosenAt }, ...extra.kind === undefined ? {} : { kind: extra.kind }, ...extra.action === undefined ? {} : { action: extra.action } }
}

/**
 * What the agent can do: red in dangerous mode, a quiet choice for Full access in some workspaces, green otherwise.
 * @param facts - the facts.
 * @returns the row.
 */
function agentRow(facts: OverviewFacts): OverviewRow {
  const open: OverviewAction = { kind: 'open-section', section: OVERVIEW_SECTIONS.permissions }
  if (facts.run?.dangerous === 'on' || facts.everywhere?.on === true) {
    const grantedAt = facts.everywhere?.grantedAt === undefined ? Number.NaN : Date.parse(facts.everywhere.grantedAt)
    return row('agent', 'red', 'agent.dangerous', { kind: 'choice', action: open, ...Number.isNaN(grantedAt) ? {} : { chosenAt: grantedAt } })
  }
  // Dangerous mode is known only from both settings, and Full access only from the workspaces: any of them unread asks for a look.
  if (facts.run === null || facts.everywhere === null || facts.workspaces === null) return row('agent', 'look', 'agent.unread', { kind: 'fault', action: open })
  const full = facts.workspaces.filter(entry => entry.preset === FULL_ACCESS)
  if (full.length > 0) {
    const latest = full.reduce((last, entry) => ((entry.grantedAt ?? 0) > (last.grantedAt ?? 0) ? entry : last))
    return row('agent', 'chosen', 'agent.full-access', { kind: 'choice', action: open, ...latest.grantedAt === null ? {} : { chosenAt: latest.grantedAt }, params: { count: full.length, workspace: latest.title ?? latest.workspace } })
  }
  return row('agent', 'green', 'agent.standard')
}

/**
 * Undo of changes to Delorun and its plugins (contract C21). Review before loading is optional: with it off, the
 * default, every change still loads as a recorded change the person can undo in Changes, so both settings are green.
 * Red only when undo cannot work: Changes reports records it cannot read, or an applied change recorded without the
 * saved version its undo needs. A state that does not read asks for a look.
 * @param facts - the facts.
 * @returns the row.
 */
function undoRow(facts: OverviewFacts): OverviewRow {
  const open: OverviewAction = { kind: 'open-section', section: OVERVIEW_SECTIONS.changes }
  if (facts.undo === null) return row('undo', 'look', 'undo.unread', { kind: 'fault', action: open })
  const { protection, unreadable, unversioned } = facts.undo
  if (unreadable > 0 || unversioned > 0) return row('undo', 'red', 'undo.broken', { kind: 'fault', action: open })
  return protection === 'on' ? row('undo', 'green', 'undo.on') : row('undo', 'green', 'undo.recorded')
}

/**
 * Who can reach this studio: a look for a device unseen for weeks, a quiet choice while phone access is on, green while
 * only this computer can open it.
 * @param facts - the facts.
 * @returns the row.
 */
function reachRow(facts: OverviewFacts): OverviewRow {
  const open: OverviewAction = { kind: 'open-section', section: OVERVIEW_SECTIONS.devices }
  if (facts.run === null) return row('reach', 'look', 'reach.unread', { kind: 'fault', action: open })
  // Phone access off keeps every device out, whatever the device list says; on, the devices and PIN mode must read.
  if (facts.run.reach.on && (facts.devices === null || facts.pin === null)) return row('reach', 'look', 'reach.unread', { kind: 'fault', action: open })
  const devices = facts.devices ?? []
  const unseen = devices.filter(device => facts.now - (device.lastSignInAt ?? device.approvedAt) > DEVICE_UNSEEN_MS)
  const [firstUnseen] = unseen
  if (facts.run.reach.on && firstUnseen !== undefined) {
    return row('reach', 'look', 'reach.unseen', { kind: 'fault', action: open, params: { count: unseen.length, device: firstUnseen.label } })
  }
  if (facts.run.reach.on) return row('reach', 'chosen', 'reach.phone', { kind: 'choice', action: open, params: { count: devices.length, pin: facts.pin?.on === true ? 'on' : 'off' } })
  if (facts.devices === null) return row('reach', 'green', 'reach.private')
  if (devices.length > 0) return row('reach', 'green', 'reach.devices-off', { params: { count: devices.length } })
  return row('reach', 'green', 'reach.private')
}

/**
 * Add-ons: red for an advisory or a plugin changed after its install, a look for an MCP server waiting or a check that
 * could not run, a quiet choice for a plugin from a folder or an external agent without limits, green otherwise.
 * @param facts - the facts.
 * @returns the row.
 */
function addonsRow(facts: OverviewFacts): OverviewRow {
  const open: OverviewAction = { kind: 'open-section', section: OVERVIEW_SECTIONS.pluginInstalls }
  const bill = facts.bill
  if (bill === null) return row('addons', 'look', 'addons.unread', { kind: 'fault', action: open })
  const entries = bill.plugins.entries
  const advised = entries.find(entry => entry.criticalAdvisories.length > 0)
  if (advised !== undefined) return row('addons', 'red', 'addons.advisory', { kind: 'fault', action: open, params: { plugin: advised.name } })
  const changed = entries.find(entry => entry.match === 'mismatch')
  if (changed !== undefined) return row('addons', 'red', 'addons.changed', { kind: 'fault', action: open, params: { plugin: changed.name } })
  if (facts.mcpWaiting !== null && facts.mcpWaiting > 0) return row('addons', 'look', 'addons.mcp-waiting', { kind: 'fault', action: open, params: { count: facts.mcpWaiting } })
  if (facts.mcpWaiting === null || facts.agentLevels === null) return row('addons', 'look', 'addons.unread', { kind: 'fault', action: open })
  if (bill.plugins.status === 'unknown') return row('addons', 'look', 'addons.unchecked', { kind: 'fault', action: open })
  const unlisted = entries.filter(entry => entry.match === 'unrecorded')
  const [firstUnlisted] = unlisted
  if (firstUnlisted !== undefined) return row('addons', 'chosen', 'addons.unlisted', { kind: 'choice', action: open, params: { count: unlisted.length, plugin: firstUnlisted.name } })
  const unrestricted = facts.agentLevels.find(entry => entry.level === 'unrestricted')
  if (unrestricted !== undefined) {
    return row('addons', 'chosen', 'addons.unrestricted', { kind: 'choice', action: { kind: 'open-section', section: OVERVIEW_SECTIONS.externalAgents }, params: { agent: unrestricted.provider } })
  }
  const count = entries.length + bill.mcp.servers.length
  return count === 0 ? row('addons', 'green', 'addons.none') : row('addons', 'green', 'addons.reviewed', { params: { count } })
}

/**
 * This copy of Delorun: red when the signature, the files or the release log failed; a look when the log could not
 * check it, when only part of the files were hashed and no full check can run, or for a security update; green while
 * the full check waits or runs and once it passed.
 * @param facts - the facts.
 * @returns the row.
 */
function copyRow(facts: OverviewFacts): OverviewRow {
  const bill = facts.bill
  const check: OverviewAction = { kind: 'check-now' }
  if (bill === null) return row('copy', 'look', 'copy.unread', { kind: 'fault', action: check })
  const [release, log] = trustRows(bill, facts.checks)
  if (release?.state === 'failed' || log?.state === 'failed') return row('copy', 'red', 'copy.failed', { kind: 'fault', action: check })
  if (release?.state === 'unknown' || release?.state === 'checked-at-start' || release?.state === 'checked-in-studio') {
    return row('copy', 'look', 'copy.not-full', { kind: 'fault', action: check })
  }
  if (log?.state !== 'verified') return row('copy', 'look', 'copy.log', { kind: 'fault', action: check })
  if (facts.update?.security === true) {
    return row('copy', 'look', 'copy.security-update', { kind: 'fault', action: { kind: 'open-section', section: OVERVIEW_SECTIONS.update }, params: { version: facts.update.version } })
  }
  const version = bill.release.version ?? ''
  return release?.state === 'checking' ? row('copy', 'green', 'copy.checking', { params: { version } }) : row('copy', 'green', 'copy.verified', { params: { version } })
}

/**
 * The overview's five rows.
 * @param facts - the facts the studio read.
 * @returns the rows in {@link OVERVIEW_ROW_IDS} order.
 */
export function overviewRows(facts: OverviewFacts): readonly OverviewRow[] {
  return [agentRow(facts), undoRow(facts), reachRow(facts), addonsRow(facts), copyRow(facts)]
}

/** The overview's headline: a row's status, or `checking` while every row is green but this copy's files are still to be hashed. */
export type OverviewHeadline = OverviewStatus | 'checking'

/**
 * The overview's headline: the loudest row's status. "Protected as Delorun intends" needs every check done, so a
 * release whose full check still waits or runs reads `checking` instead of `green`.
 * @param rows - the rows.
 * @returns the loudest status; `checking` or `green` when every row is green.
 */
export function overviewHeadline(rows: readonly OverviewRow[]): OverviewHeadline {
  const loudest = OVERVIEW_STATUS_ORDER.find(status => rows.some(entry => entry.status === status)) ?? 'green'
  return loudest === 'green' && rows.some(entry => entry.cause === 'copy.checking') ? 'checking' : loudest
}
