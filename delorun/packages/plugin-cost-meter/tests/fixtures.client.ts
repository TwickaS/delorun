/** Cost values, Session rows and the hooks the pill reads, for the client specs. */
import type { SessionListState, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent/client'
import { en } from '../src/client/locales.ts'
import { sumRows, type CostMeterView, type CostModelRow } from '../src/view.ts'

/** The English dictionary as the slot's `t`. */
export const t = makeTranslate(en)

/** A model row with one request per `requests` and the given cost; tokens are 1000 input and 100 output per request. */
export function row(model: string, usd: number, requests = 1, unpriced = 0): CostModelRow {
  return { provider: 'p', model, requests, input: 1000 * requests, output: 100 * requests, cacheRead: 0, cacheWrite: 0, usd, unpriced }
}

/** A cost of the given rows. */
export const cost = (...rows: CostModelRow[]): CostMeterView => sumRows(rows)

/** A Session id. */
export const sid = (id: string): SessionId => SessionId(id)

/** A catalog entry of a continuable agent. */
export const agent = (id: string, label: string): SubagentCatalogEntry => ({ id: sid(id), createdAt: 1, mode: 'continuable', label })

/** A Session list row. */
export function listRow(id: string, extra: Partial<SessionListState['byId'][SessionId]> = {}): SessionListState['byId'][SessionId] {
  return { id: sid(id), displayTitle: `Title ${id}`, running: false, retainedBy: {}, blank: false, updatedAt: 1, ...extra }
}

/** Live hooks over the open chat's projection values and the Session list, with setters a test calls. */
export function hooks(values: Partial<SessionProjectionMap>, list: Partial<SessionListState> = {}) {
  const projections = createSnapshotStore<Partial<SessionProjectionMap>>(values)
  const sessions = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {}, ...list })
  const useValues = bindSnapshotSelector(projections)
  const useProjection = ((key: keyof SessionProjectionMap) => useValues(current => current[key])) as UseProjection
  const useSessions: UseSessions = bindSnapshotSelector(sessions)
  return { useProjection, useSessions, projections, sessions }
}
