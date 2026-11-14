/**
 * How the `reach-device` policy scales with the chats it binds: the access snapshot a reach page opens with (its JSON
 * size and the time to compute it) and the time of one remote access decision, through upstream's real remote access
 * service. It measures and prints; it asserts only that each figure was taken. It is skipped unless
 * `DELORUN_REACH_SCALE=1`, because its timings depend on the machine.
 *
 * Run: `DELORUN_REACH_SCALE=1 node_modules/.bin/vitest run --config delorun/vitest.config.ts
 * delorun/packages/home-auth/tests/denial/reach/reach-access-scale.spec.ts`
 */
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { createReachAccessPolicy, reachDevicePrincipal, REACH_DEVICE } from '../../../src/reach-access.ts'

/** The chat counts measured; the lead's question is about 1,000. */
const COUNTS = [100, 1_000, 2_000] as const
/** Chats per Workspace, so 1,000 chats sit in 50 Workspaces. */
const PER_WORKSPACE = 20
/** Decisions timed per measurement. */
const DECISIONS = 500

const DEVICE = reachDevicePrincipal('device-scale', 'reach-tailscale-private')

/**
 * The median of several timings of one operation, in milliseconds.
 * @param runs - how many times to run it.
 * @param operation - the operation.
 * @returns the median duration.
 */
function median(runs: number, operation: () => void): number {
  const times: number[] = []
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now()
    operation()
    times.push(performance.now() - start)
  }
  times.sort((left, right) => left - right)
  return times[Math.floor(times.length / 2)] ?? Number.NaN
}

/**
 * Remote access with the `reach-device` policy over `count` chats, all in Workspaces.
 * @param count - the chats the policy binds.
 * @returns the service and one bound chat.
 */
async function serviceWith(count: number): Promise<{ readonly access: RemoteAccessService; readonly dispose: () => Promise<void>; readonly sessionId: SessionId }> {
  const ctx = new Context()
  await ctx.plugin(RemoteAccessService)
  const workspaces = Array.from({ length: Math.ceil(count / PER_WORKSPACE) }, (_, index) => ({
    id: brandString<WorkspaceId>(`workspace-${String(index)}`),
    path: `/nowhere/workspace-${String(index)}`,
    sessionIds: Array.from({ length: Math.min(PER_WORKSPACE, count - index * PER_WORKSPACE) },
      (__, offset) => brandString<SessionId>(`session-${String(index * PER_WORKSPACE + offset)}`)),
  }))
  ctx.remoteAccess.registerPolicy(REACH_DEVICE, createReachAccessPolicy({ admitted: () => true, workspaces: () => workspaces, liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere', elevationOf: () => undefined, pageUnlockOf: () => undefined, logElevated: () => {}, liftedSettings: () => undefined, pinLiftedSettings: () => undefined, computerOnlySwitches: () => [], protectedEntryIds: () => new Set(), defaultPermission: () => undefined, dangerousMode: () => false }))
  return { access: ctx.remoteAccess, dispose: () => ctx.fiber.dispose(), sessionId: brandString<SessionId>(`session-${String(Math.floor(count / 2))}`) }
}

describe.runIf(process.env.DELORUN_REACH_SCALE === '1')('the reach-device policy at scale', () => {
  it('reports the snapshot size and time and the decision time for each chat count', { timeout: 600_000 }, async () => {
    const rows: string[] = []
    for (const count of COUNTS) {
      const { access, dispose, sessionId } = await serviceWith(count)
      try {
        let json = ''
        const snapshotMs = median(3, () => { json = JSON.stringify(access.snapshotFor(DEVICE)) })
        const decide = (action: RemoteAccessAction, resource: Parameters<RemoteAccessService['decide']>[0]['resources'][number]): number =>
          median(DECISIONS, () => { access.decide({ principal: DEVICE, action, resources: [resource] }) })
        const sessionMs = decide('session/prompt', { kind: 'session', id: sessionId })
        const globalMs = decide('session/list', { kind: 'global' })
        const deniedMs = decide('session/prompt', { kind: 'session', id: brandString<SessionId>('session-unbound') })
        // `session/list` filters its rows through one `allows()` per row, each the cost of one decision.
        const listMs = median(3, () => {
          for (let index = 0; index < count; index += 1) {
            access.decide({ principal: DEVICE, action: 'session/list', resources: [{ kind: 'session', id: brandString<SessionId>(`session-${String(index)}`) }] })
          }
        })
        expect(access.decide({ principal: DEVICE, action: 'session/prompt', resources: [{ kind: 'session', id: sessionId }] })).toEqual({ kind: 'allow' })
        expect(json.length).toBeGreaterThan(0)
        rows.push(`${String(count)} chats: snapshot ${String(Buffer.byteLength(json))} bytes in ${snapshotMs.toFixed(1)} ms; `
          + `decide session ${sessionMs.toFixed(3)} ms, global ${globalMs.toFixed(3)} ms, unbound session ${deniedMs.toFixed(3)} ms; one decision per chat ${listMs.toFixed(1)} ms`)
      } finally {
        await dispose()
      }
    }
    process.stdout.write(`${rows.join('\n')}\n`)
  })
})
