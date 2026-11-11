/**
 * A request the change log refuses with a value that is not an `Error` is still denied, with that value as the reason.
 */
import { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '../src/index.ts'

vi.mock('@delo/changes/install', () => ({
  recordPluginRequest: () => Promise.reject('the log is busy.'),
}))

// Protection on, so the request is recorded rather than passed to upstream.
vi.mock('@delo/changes', async original => ({ ...await original<typeof import('@delo/changes')>(), readProtection: () => Promise.resolve('on') }))

it('denies with a thrown value that is not an Error as the reason', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('tools', { guard: () => () => {} } as never)
  ctx.provide('profileContext', { name: 'default', dir: '/p', home: '/h' } as never)
  plugin.apply(ctx, { enabled: true, installationBundles: [] })
  const decision: PreToolDecision = await ctx.waterfall('tools/pre-execute', { name: 'plugin_manager', arguments: { action: 'install_bundle', target: 'x' } } as never, () => Promise.resolve({ kind: 'allow' as const }))
  expect(decision).toMatchObject({ kind: 'deny', reason: 'Plugin installs, updates and removals wait for the person\'s review at their computer, and this one could not be recorded: the log is busy. Nothing was changed.' })
})
