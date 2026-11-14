/**
 * The cost meter in a real Delorun CLI profile: upstream's loader composes the profile from Delorun's bundles, where the row
 * is present and disabled; the row the person turns on in the sidebar's Plugins page (a `disabled: false` override in the
 * profile's own patch) composes enabled, resolves to this package from `@delorun/bundle-studio`, and boots with its
 * composed config beside upstream's real Session store and projection registry, serving the chat's cost.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, initProfile, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DELORUN_PROFILE_BUNDLES, LOCAL_BUNDLE, STUDIO_BUNDLE } from '@delorun/bundle-local/profile'
import * as CostMeter from '../src/index.ts'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const PACKAGES = join(REPO, 'delorun/packages')
const INSTALL_ANCHOR = join(REPO, 'apps/cli/package.json')
const PACKAGE_NAME = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name

const home = mkdtempSync(join(tmpdir(), 'delorun-cost-meter-'))
const profile = join(home, 'profiles', 'default')
initProfile(profile, DELORUN_PROFILE_BUNDLES)
for (const [name, dir] of [[LOCAL_BUNDLE, 'bundle-local'], [STUDIO_BUNDLE, 'bundle-studio']] as const) {
  const link = join(profile, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(join(PACKAGES, dir), link, 'junction')
}

afterAll(() => { rmSync(home, { recursive: true, force: true }) })

const costRow = () => composeEntries(loadProfileDirectory('dsh', profile, INSTALL_ANCHOR).layers.map(layer => layer.patches))
  .find(row => row.id === CostMeter.COST_METER_ROW_ID)

describe('the cost meter in a Delorun CLI profile', () => {
  it('is present and off by default', () => {
    expect(costRow()).toMatchObject({ name: PACKAGE_NAME, disabled: true })
  })

  it('boots from its row config to serve the chat\'s cost, and resolves its module from the bundle', async () => {
    const row = costRow()
    expect(row).toMatchObject({ name: PACKAGE_NAME, disabled: true })
    // The loader resolves the row's module from the bundle that inserts it.
    const resolved = createRequire(join(PACKAGES, 'bundle-studio/package.json')).resolve(`${PACKAGE_NAME}/package.json`)
    expect(resolved).toBe(join(PACKAGES, 'plugin-cost-meter/package.json'))

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(CostMeter, interpolate({}, row?.config ?? {}))
    const session = ctx.sessions.create()
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'anthropic', model: 'claude-sonnet-5-5' } } })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 100_000 } } }] })
    expect(ctx.sessionProjections.snapshot(session).values.costMeter).toMatchObject({ usd: 3, requests: 1, unpriced: 0 })
    await ctx.fiber.dispose()
  })
})
