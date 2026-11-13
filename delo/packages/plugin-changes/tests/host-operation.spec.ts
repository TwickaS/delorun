/**
 * The plugin operation the studio's Apply of an agent's plugin request runs in the Host: `@delo/changes`' shared
 * operation, from the Host's directory with the installation anchor and pnpm the profile launcher names, its output in
 * the Host's log.
 */
import { Context } from '@deepseek-ai/cordis'
import type { PluginOperationSettings, UpstreamChecks } from '@delo/changes/plugin-operation'
import { expect, it, onTestFinished, vi } from 'vitest'
import { hostPluginOperation } from '../src/index.ts'

const shared = vi.hoisted(() => ({ settings: [] as PluginOperationSettings[], checks: {} as UpstreamChecks }))

vi.mock('@delo/changes/plugin-operation', () => ({
  loadUpstreamChecks: () => Promise.resolve(shared.checks),
  upstreamPluginOperation: (_ctx: unknown, settings: PluginOperationSettings) => {
    shared.settings.push(settings)
    return () => Promise.resolve({ exitCode: 0 })
  },
}))

const CHANGES = { home: '/h', profile: 'default', profileDir: '/h/profiles/default' }

it('runs the shared operation with the launcher\'s anchor, directory and pnpm, and logs pnpm\'s output', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const packageManager = { command: '/app/node', args: ['/app/pnpm.cjs'], env: {} }
  ctx.provide('profileContext', { name: 'default', dir: CHANGES.profileDir, home: '/h', installAnchor: '/app/package.json', cwd: '/work', packageManager } as never)
  const logged: string[] = []
  ctx.logger.info = (message: string) => { logged.push(`info ${message}`) }
  ctx.logger.warn = (message: string) => { logged.push(`warn ${message}`) }
  expect(await hostPluginOperation(ctx, CHANGES)(['add', 'x'])).toEqual({ exitCode: 0 })
  const [settings] = shared.settings.splice(0)
  expect(settings).toMatchObject({ cwd: '/work', packageManager })
  settings!.output('added 1\n', 'stdout')
  settings!.output('warning\n', 'stderr')
  expect(logged).toEqual(['info added 1', 'warn warning'])
  expect(await settings!.upstream()).toEqual({ installAnchor: '/app/package.json', ...shared.checks })
})

it('runs pnpm from PATH when the launcher names none, and has no operation without a profile', () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  expect(() => hostPluginOperation(ctx, CHANGES)).toThrow(/runs no profile launched by dsh/)
  ctx.provide('profileContext', { name: 'default', dir: CHANGES.profileDir, home: '/h', installAnchor: '/a', cwd: '/w' } as never)
  hostPluginOperation(ctx, CHANGES)
  expect(shared.settings.splice(0)[0]).not.toHaveProperty('packageManager')
})
