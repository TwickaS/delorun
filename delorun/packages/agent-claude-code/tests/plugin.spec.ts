import { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { ExternalAgentDriver } from '@delorun/external-agents/contract'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A scope with a stand-in gate that records registered drivers and a stand-in subagent registry. */
async function mounted(providerPresent: boolean) {
  const ctx = new Context()
  contexts.push(ctx)
  const providers = new Map<string, SubagentProvider>()
  const registered = new Set<ExternalAgentDriver>()
  const claude = { name: 'claude-code' } as never as SubagentProvider
  if (providerPresent) providers.set('claude-code', claude)
  ctx.provide('externalAgents', {
    registerDriver: (driver: ExternalAgentDriver) => { registered.add(driver); return () => { registered.delete(driver) } },
  } as never)
  ctx.provide('subagents', { getProvider: (name: string) => providers.get(name) } as never)
  await ctx.plugin(plugin, plugin.Config({ harnessToolTimeoutSeconds: 900 }))
  const add = (): void => { providers.set('claude-code', claude); ctx.emit('subagent/provider-added', claude) }
  const remove = (): void => { providers.delete('claude-code'); ctx.emit('subagent/provider-removed', 'claude-code') }
  return { ctx, registered, add, remove }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('the Claude Code driver plugin', () => {
  it('stays dormant while upstream\'s Claude Code provider is not registered', async () => {
    const { registered } = await mounted(false)
    await settle()
    expect(registered.size).toBe(0)
  })

  it('registers the driver while the provider is registered and withdraws it when the provider leaves', async () => {
    const { registered, add, remove } = await mounted(false)
    add()
    await settle()
    expect([...registered].map(driver => driver.provider)).toEqual(['claude-code'])
    remove()
    await settle()
    expect(registered.size).toBe(0)
    add()
    await settle()
    expect(registered.size).toBe(1)
  })

  it('registers at once when the provider is already registered, and ignores other providers', async () => {
    const { ctx, registered } = await mounted(true)
    await settle()
    expect(registered.size).toBe(1)
    ctx.emit('subagent/provider-removed', 'codex')
    await settle()
    expect(registered.size).toBe(1)
  })

  it('refuses a harness tool wait limit below one second', () => {
    expect(plugin.Config({ harnessToolTimeoutSeconds: 1 }).harnessToolTimeoutSeconds).toBe(1)
    expect(() => plugin.Config({ harnessToolTimeoutSeconds: 0 })).toThrow()
  })
})
