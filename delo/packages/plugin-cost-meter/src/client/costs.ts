/**
 * The agent roll-up and the number formats of the studio half. A chat's subagents and teammates run in their own
 * Sessions, so their costs come from each Session's summary or loaded projections, found through the parent's
 * `subagentCatalog` and each Session row's `parentId`.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import { sumRows, type CostMeterView } from '../view.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the deloCostMeter namespace merge.
import type {} from './locales.ts'

/** The projection values the roll-up reads from a Session. */
export interface AgentValues {
  /** The Session's cost. */
  readonly costMeter?: CostMeterView | undefined
  /** The agents the Session started. */
  readonly subagentCatalog?: readonly SubagentCatalogEntry[] | undefined
}

/** The fields of a Session list row the roll-up reads. */
export interface AgentSessionRow {
  /** The Session that started this one, for a subagent or teammate. */
  readonly parentId?: SessionId | undefined
  /** The durable title. */
  readonly title?: string | undefined
  /** The title the list shows. */
  readonly displayTitle: string
  /** The row's summary projection values. */
  readonly projectionValues?: AgentValues | undefined
}

/** The projection values the page loaded for one Session. */
export interface LoadedValues {
  /** The loaded values. */
  readonly values: AgentValues
}

/** One direct agent of the open chat, with the cost of everything it started included. */
export interface AgentCost {
  /** The agent's Session. */
  readonly id: SessionId
  /** The agent's label, from the catalog or its Session's title. */
  readonly label: string | undefined
  /** The agent's cost, its own agents' costs included. */
  readonly cost: CostMeterView
}

/** The open chat's agents. */
export interface AgentTree {
  /** The direct agents, costliest first. */
  readonly agents: readonly AgentCost[]
  /** Local agents whose cost is not on the page yet. */
  readonly missing: readonly SessionId[]
  /** Agents with no local Session, such as external coding agents. */
  readonly external: number
}

/** An empty cost. */
export const NO_COST: CostMeterView = sumRows([])

/**
 * Add several costs together, merging the rows of the same provider and model.
 * @param values - the costs.
 * @returns the sum.
 */
export function addCosts(values: readonly CostMeterView[]): CostMeterView {
  return sumRows(values.flatMap(value => value.models))
}

/**
 * Collect the open chat's descendant agents. Each direct agent carries the summed cost of its own subtree; an agent
 * that two parents name counts once, under the first one reached.
 * @param rootId - the open chat.
 * @param rootCatalog - the open chat's `subagentCatalog`.
 * @param byId - the Session list rows.
 * @param loaded - the projection values the page loaded, by Session.
 * @returns the agents, the local agents whose cost is missing and the count of external agents.
 */
export function collectAgents(
  rootId: SessionId,
  rootCatalog: readonly SubagentCatalogEntry[] | undefined,
  byId: Readonly<Record<SessionId, AgentSessionRow>>,
  loaded: Readonly<Record<SessionId, LoadedValues | undefined>>,
): AgentTree {
  const childrenByParent = new Map<SessionId, SessionId[]>()
  for (const [id, row] of Object.entries(byId) as [SessionId, AgentSessionRow][]) {
    if (row.parentId === undefined) continue
    childrenByParent.set(row.parentId, [...childrenByParent.get(row.parentId) ?? [], id])
  }
  const valuesOf = (id: SessionId): AgentValues | undefined => loaded[id]?.values ?? byId[id]?.projectionValues
  const childrenOf = (id: SessionId, catalog: readonly SubagentCatalogEntry[] | undefined): Map<SessionId, { label: string | undefined; external: boolean }> => {
    const children = new Map<SessionId, { label: string | undefined; external: boolean }>()
    for (const entry of catalog ?? []) children.set(entry.id, { label: entry.label, external: entry.mode === 'external' })
    for (const childId of childrenByParent.get(id) ?? []) if (!children.has(childId)) children.set(childId, { label: undefined, external: false })
    return children
  }
  const visited = new Set<SessionId>([rootId])
  const missing: SessionId[] = []
  let external = 0
  // Visits each child once; returns the costs to add for the agents not visited before.
  const visit = (id: SessionId, catalog: readonly SubagentCatalogEntry[] | undefined, each: (childId: SessionId, label: string | undefined) => void): void => {
    for (const [childId, child] of childrenOf(id, catalog)) {
      if (visited.has(childId)) continue
      visited.add(childId)
      if (child.external) external += 1
      else each(childId, child.label)
    }
  }
  const subtree = (id: SessionId): CostMeterView => {
    const values = valuesOf(id)
    const costs: CostMeterView[] = []
    if (values?.costMeter === undefined) missing.push(id)
    else costs.push(values.costMeter)
    visit(id, values?.subagentCatalog, (childId) => { costs.push(subtree(childId)) })
    return addCosts(costs)
  }
  const agents: AgentCost[] = []
  visit(rootId, rootCatalog, (childId, label) => {
    const row = byId[childId]
    agents.push({ id: childId, label: label ?? row?.title ?? row?.displayTitle, cost: subtree(childId) })
  })
  agents.sort((left, right) => right.cost.usd - left.cost.usd)
  return { agents, missing, external }
}

/** A translation function over this plugin's keys. */
export type Translate = TranslateNS<'deloCostMeter'>

/**
 * Format a cost in US dollars: two decimals, more for amounts under a dollar so a small cost does not read as zero.
 * @param usd - the amount.
 * @returns the amount with its currency sign.
 */
export function formatCost(usd: number): string {
  const digits = usd === 0 ? 2 : usd < 0.01 ? 4 : usd < 1 ? 3 : 2
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: digits }).format(usd)
}

/**
 * Format a token count compactly: 950, 12.3K, 4.5M.
 * @param count - the tokens.
 * @param t - the dictionary.
 * @returns the count.
 */
export function formatTokens(count: number, t: Translate): string {
  const scaled = (value: number): string => String(value >= 100 ? Math.round(value) : Math.round(value * 10) / 10)
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return t('tokens.thousand', { value: scaled(count / 1_000) })
  return t('tokens.million', { value: scaled(count / 1_000_000) })
}

/**
 * Format an exact count with grouping.
 * @param count - the count.
 * @returns the grouped count.
 */
export function formatExact(count: number): string {
  return new Intl.NumberFormat('en-US').format(count)
}

/**
 * A counted note: the `.one` form for one, the plain form with `{count}` otherwise.
 * @param t - the dictionary.
 * @param key - the plain form's key.
 * @param count - the count.
 * @returns the note.
 */
export function counted(t: Translate, key: 'note.unpriced' | 'note.loading' | 'note.external', count: number): string {
  return count === 1 ? t(`${key}.one`) : t(key, { count })
}
