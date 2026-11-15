/**
 * Denial test for the problem report's details route: the real `delorun-report` row registers its Fetch route with
 * no `admitPeer`, so upstream's connection refuses every reach device (paired phone), locked or unlocked, before the
 * handler reads the log. Giving the route an `admitPeer` makes this fail. The same refusal is proven end to end for a
 * device request in `apps/cli/tests/denial/reach/reach-paths.integration.spec.ts`.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as Report from '../../../bundle-local/src/report.ts'
import { REPORT_ROUTE } from '../../../bundle-local/src/client/report-api.ts'

describe('the report details route', () => {
  it('admits no reach device: its registration names no admitPeer', async () => {
    const routes: Record<string, unknown>[] = []
    const ctx = new Context()
    ctx.provide('connection', { fetch: { register: (route: Record<string, unknown>) => { routes.push(route); return () => {} } } } as never)
    await ctx.plugin(Report, { issueUrl: Report.REPORT_DEFAULTS.issueUrl, template: Report.REPORT_DEFAULTS.template }).await()
    expect(routes.map(route => route['path'])).toEqual([REPORT_ROUTE])
    expect(routes[0]).not.toHaveProperty('admitPeer')
    expect(routes[0]!['methods']).toEqual(['GET'])
    await ctx.fiber.dispose()
  })
})
