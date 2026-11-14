/**
 * Consistency findings of a stored workspace registry: the pure rules the registry applies at startup
 * (it throws on a finding that is not quarantined) and the `delorun doctor` check reuses to describe a
 * damaged store without starting the registry.
 * @module @deepseek-ai/dsh-workspace/src/inspect
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { workspaceDomainState, workspaceRecord } from './spec.ts'
import type { WorkspaceRecord } from './spec.ts'
import type { WorkspaceId } from './types.ts'

/** The stored registry state the findings are computed over. */
export interface StoredRegistry {
  /** Whether the history bootstrap completed; an unbootstrapped registry may hold records outside its order. */
  readonly initialized: boolean
  /** The display order. */
  readonly workspaceIds: readonly WorkspaceId[]
  /** The workspace records by id. */
  readonly records: ReadonlyMap<WorkspaceId, WorkspaceRecord>
}

/** One inconsistency of a stored registry, tagged by `kind`. */
export type RegistryFinding =
  | { readonly kind: 'order-repeats'; readonly id: WorkspaceId }
  | { readonly kind: 'order-missing-record'; readonly id: WorkspaceId }
  | { readonly kind: 'record-absent-from-order'; readonly id: WorkspaceId }
  | { readonly kind: 'path-claimed-twice'; readonly id: WorkspaceId; readonly holder: WorkspaceId; readonly path: string }
  | { readonly kind: 'session-accounted-twice'; readonly id: WorkspaceId; readonly holder: WorkspaceId; readonly sessionId: SessionId }

/**
 * Describe a finding in the words the registry throws and logs.
 * @param finding - The finding.
 * @returns the message, prefixed `workspace domain is inconsistent`.
 */
export function describeFinding(finding: RegistryFinding): string {
  const head = 'workspace domain is inconsistent:'
  switch (finding.kind) {
    case 'order-repeats':
      return `${head} registry order repeats workspace '${finding.id}'`
    case 'order-missing-record':
      return `${head} registry order references missing workspace '${finding.id}'`
    case 'record-absent-from-order':
      return `${head} workspace '${finding.id}' is absent from registry order`
    case 'path-claimed-twice':
      return `${head} path '${finding.path}' is claimed by both workspace '${finding.holder}' and workspace '${finding.id}'`
    case 'session-accounted-twice':
      return `${head} session '${finding.sessionId}' is accounted by both workspace '${finding.holder}' and workspace '${finding.id}'`
    /* v8 ignore next 4 -- Closed finding union; the compiler checks exhaustiveness. */
    default: {
      const never: never = finding
      return never
    }
  }
}

/**
 * Find every inconsistency of a stored registry, order findings first.
 * @param stored - The stored state.
 * @returns the findings; empty for a consistent registry.
 */
export function findInconsistencies(stored: StoredRegistry): RegistryFinding[] {
  const findings: RegistryFinding[] = []
  const order = new Set<WorkspaceId>()
  for (const id of stored.workspaceIds) {
    if (order.has(id)) {
      findings.push({ kind: 'order-repeats', id })
      continue
    }
    if (!stored.records.has(id)) {
      findings.push({ kind: 'order-missing-record', id })
      continue
    }
    order.add(id)
  }
  if (stored.initialized) {
    for (const id of stored.records.keys()) {
      if (!order.has(id)) findings.push({ kind: 'record-absent-from-order', id })
    }
  }

  const paths = new Map<string, WorkspaceId>()
  const accounted = new Map<SessionId, WorkspaceId>()
  for (const [id, record] of stored.records) {
    const pathHolder = paths.get(record.path)
    if (pathHolder !== undefined) {
      findings.push({ kind: 'path-claimed-twice', id, holder: pathHolder, path: record.path })
    } else {
      paths.set(record.path, id)
    }
    for (const sessionId of record.sessionIds) {
      const holder = accounted.get(sessionId)
      if (holder !== undefined) findings.push({ kind: 'session-accounted-twice', id, holder, sessionId })
      else accounted.set(sessionId, id)
    }
  }
  return findings
}

/** The outcome of {@link repairRegistry}. */
export interface RegistryRepair {
  /** The cleaned display order. */
  readonly workspaceIds: readonly WorkspaceId[]
  /** Records removed whole, with the finding that removed each. */
  readonly dropped: ReadonlyMap<WorkspaceId, RegistryFinding>
  /** Records kept with a session claim removed, by workspace id. */
  readonly trimmed: ReadonlyMap<WorkspaceId, readonly SessionId[]>
  /** Findings that changed the order only (a repeated or dangling entry). */
  readonly orderOnly: readonly RegistryFinding[]
}

/**
 * Plan the repair of an inconsistent registry that keeps every record that is consistent: a record
 * outside the order, or whose path another record already holds, is dropped; a repeated or dangling
 * order entry is removed; the later claim on a session is removed from its record.
 * @param stored - The stored state.
 * @returns what to drop, trim and reorder.
 */
export function repairRegistry(stored: StoredRegistry): RegistryRepair {
  const records = new Map(stored.records)
  const dropped = new Map<WorkspaceId, RegistryFinding>()
  const trimmed = new Map<WorkspaceId, SessionId[]>()
  const orderOnly: RegistryFinding[] = []
  let ids = [...stored.workspaceIds]
  for (;;) {
    const [finding] = findInconsistencies({ ...stored, workspaceIds: ids, records })
    if (finding === undefined) break
    switch (finding.kind) {
      case 'order-repeats':
        ids = ids.filter((id, index) => id !== finding.id || ids.indexOf(id) === index)
        orderOnly.push(finding)
        break
      case 'order-missing-record':
        ids = ids.filter(id => id !== finding.id)
        orderOnly.push(finding)
        break
      case 'record-absent-from-order':
      case 'path-claimed-twice':
        records.delete(finding.id)
        ids = ids.filter(id => id !== finding.id)
        dropped.set(finding.id, finding)
        break
      case 'session-accounted-twice': {
        const record = records.get(finding.id) as WorkspaceRecord
        records.set(finding.id, { ...record, sessionIds: record.sessionIds.filter(id => id !== finding.sessionId) })
        trimmed.set(finding.id, [...trimmed.get(finding.id) ?? [], finding.sessionId])
        break
      }
      /* v8 ignore next 4 -- Closed finding union; the compiler checks exhaustiveness. */
      default: {
        const never: never = finding
        return never
      }
    }
  }
  return { workspaceIds: ids, dropped, trimmed, orderOnly }
}

/** What {@link inspectRegistryText} found in a registry file. */
export type RegistryInspection =
  | { readonly state: 'unreadable'; readonly reason: string }
  | { readonly state: 'readable'; readonly workspaces: number; readonly problems: readonly string[] }

/**
 * Inspect the text of a registry file without starting the registry or changing anything: parse it as a
 * unit document, check each record and the state against their schemas, then run
 * {@link findInconsistencies}.
 * @param text - The registry file's content.
 * @returns `unreadable` with the reason when the file is not a registry document, otherwise the workspace
 * count and one message per damaged record or inconsistency.
 */
export function inspectRegistryText(text: string): RegistryInspection {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { state: 'unreadable', reason: `the file is not valid JSON (${(error as Error).message})` }
  }
  const root = document as { unit?: { name?: unknown }; global?: unknown; tables?: { workspaces?: unknown } } | null
  if (typeof root !== 'object' || root === null || typeof root.unit !== 'object' || root.unit === null
    || root.unit.name !== 'workspace') {
    return { state: 'unreadable', reason: 'the file is not a workspace registry document' }
  }
  const table = root.tables?.workspaces ?? {}
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    return { state: 'unreadable', reason: 'the workspaces table is not an object' }
  }
  const problems: string[] = []
  const records = new Map<WorkspaceId, WorkspaceRecord>()
  for (const [key, raw] of Object.entries(table)) {
    const parsed = workspaceRecord.safeParse(raw)
    if (parsed.success) records.set(key as WorkspaceId, parsed.data)
    else problems.push(`record '${key}' does not match the record format`)
  }
  const state = root.global === null || root.global === undefined
    ? { initialized: false, workspaceIds: [] as WorkspaceId[] }
    : workspaceDomainState.safeParse(root.global)
  if ('success' in state && !state.success) {
    problems.push('the registry order and state do not match the state format')
    return { state: 'readable', workspaces: records.size, problems }
  }
  const stored = 'success' in state ? state.data : state
  for (const finding of findInconsistencies({ initialized: stored.initialized, workspaceIds: stored.workspaceIds, records })) {
    problems.push(describeFinding(finding))
  }
  return { state: 'readable', workspaces: records.size, problems }
}
