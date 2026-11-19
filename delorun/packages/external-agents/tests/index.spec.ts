import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('the package entry', () => {
  it('mounts the gate and, on it, the account store, with every agent not added', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-gate-entry-')))
    const previous = process.env['DELORUN_HOME']
    process.env['DELORUN_HOME'] = home
    cleanups.push(() => {
      if (previous === undefined) delete process.env['DELORUN_HOME']
      else process.env['DELORUN_HOME'] = previous
      rmSync(home, { recursive: true, force: true })
    })
    const ctx = new Context()
    ctx.provide('subprocess', { spawn: () => { throw new Error('no process starts in this spec') } } as never)
    const routes: string[] = []
    ctx.provide('connection', { fetch: { register: (route: { path: string }) => { routes.push(route.path); return () => {} } } } as never)
    const fiber = ctx.plugin(plugin, { maxLivePrograms: 4, graceMs: 3_000, probeMinIntervalMinutes: 30, probeTriggers: ['pack-added', 'signed-in', 'check-now'], limitRefusal: true })
    cleanups.push(() => fiber.dispose())
    await fiber
    await expect.poll(() => ctx.get('agentAccounts')).toBeDefined()
    expect(ctx.get('externalAgents')?.hasDriver('claude-code')).toBe(false)
    const { accounts } = await ctx.get('agentAccounts')!.readAll()
    expect(accounts.map(account => [account.provider, account.installed])).toEqual([['claude-code', false], ['codex', false]])
    expect(routes).toEqual(['/api/delorunExternalAgents.accounts', '/api/delorunExternalAgents.refresh'])
    // The gate's start-up reap writes the program records; the home is removed only after that write.
    await expect.poll(() => existsSync(join(home, 'secrets', 'external-agents', 'programs.json'))).toBe(true)
  })
})
