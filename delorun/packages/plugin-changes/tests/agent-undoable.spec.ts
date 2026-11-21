/**
 * The studio shows Undo on an agent's action only when `undoAgentAction` can restore it: the entry holds the profile
 * versions on both sides of the action.
 */
import { writeAgentLog, type ChangeEntry, type ChangeId } from '@delorun/changes'
import { describe, expect, it } from 'vitest'
import { STATE_PATH } from '../src/routes.ts'
import { get, json, routeHome, serveRoutes } from './routes-fixture.ts'

const AT = '2026-11-10T10:00:00.000Z'

/**
 * @param id - the change id.
 * @param versions - the profile versions the action holds.
 * @returns an applied agent action.
 */
function agentAction(id: string, versions: Pick<ChangeEntry, 'historyVersion' | 'historyBefore'>): ChangeEntry {
  return { id: id as ChangeId, kind: 'plugin-setting-change', state: 'applied', subject: { plugin: 'plug' }, summary: `The agent ran ${id}`, createdAt: AT, decidedAt: AT, decidedFrom: 'unreviewed', ...versions }
}

describe('Undo on an agent action', () => {
  it('is offered only for an action that holds the versions before and after it', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    await writeAgentLog(ctx.home, ctx.profile, {
      schema: 'delorun.changes-agent-log/1',
      entries: [
        agentAction('c0000000001', { historyVersion: 'v2', historyBefore: 'v1' }),
        agentAction('c0000000002', {}),
        agentAction('c0000000003', { historyVersion: 'v3' }),
        agentAction('c0000000004', { historyBefore: 'v3' }),
      ],
    })
    const recent = json(await get(server.port, STATE_PATH)).recent as { id: string, undoable: boolean }[]
    expect(Object.fromEntries(recent.map(entry => [entry.id, entry.undoable]))).toEqual({ c0000000001: true, c0000000002: false, c0000000003: false, c0000000004: false })
  })
})
