/**
 * Denial test for the problem report's details route: the real `delorun-report` row registers its Fetch route behind
 * the unlock gate, so a paired phone that is locked reads nothing (`403 ELEVATION_REQUIRED`) before the handler reads the
 * log, and a Peer that is no reach device is refused at the peer check. The excerpt can name paths of the home, so the
 * route stays behind an unlock. The same refusal is proven end to end for a device request in
 * `apps/cli/tests/denial/reach/reach-paths.integration.spec.ts`.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as Report from '../../../bundle-local/src/report.ts'
import { REPORT_ROUTE } from '../../../bundle-local/src/client/report-api.ts'

describe('the report details route', () => {
  it('refuses a locked reach device with ELEVATION_REQUIRED, a Peer that is no reach device at the peer check, and runs for an unlocked one', async () => {
    const routes: Record<string, unknown>[] = []
    const ctx = new Context()
    ctx.provide('connection', { fetch: { register: (route: Record<string, unknown>) => { routes.push(route); return () => {} } } } as never)
    await ctx.plugin(Report, { issueUrl: Report.REPORT_DEFAULTS.issueUrl, template: Report.REPORT_DEFAULTS.template }).await()
    expect(routes.map(route => route['path'])).toEqual([REPORT_ROUTE])
    expect(routes[0]!['methods']).toEqual(['GET'])
    const route = routes[0] as { admitPeer: (request: Request, peer: object) => boolean, fetch: (request: Request) => Promise<Response> }
    const request = () => new Request('http://localhost/api/delorunReport.details')
    let holdsUnlock = false
    ctx.provide('homeAuth', { passkeysEnabled: () => false, elevationOf: () => (holdsUnlock ? { id: 'e' } : undefined), pageUnlockOf: () => undefined } as never)
    const asDevice = async (unlocked: boolean) => {
      holdsUnlock = unlocked
      const call = request()
      expect(route.admitPeer(call, { principal: { kind: 'reach-device', deviceId: 'phone', listener: 'reach-tailscale-private' } })).toBe(true)
      return route.fetch(call)
    }
    // Pins the unlock gate: a locked device is admitted to the route and refused by it, before the log is read.
    const locked = await asDevice(false)
    expect([locked.status, await locked.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
    expect(route.admitPeer(request(), { principal: { kind: 'sdk' } })).toBe(false)
    expect((await asDevice(true)).status).toBe(200)
    await ctx.fiber.dispose()
  })
})
