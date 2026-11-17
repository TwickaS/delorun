import { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { SubagentProvider, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ExternalAgentDriver, ExternalAgentsGate } from '@delorun/external-agents'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { CodexDriver } from '../src/index.ts'

interface Mounted {
  readonly ctx: Context
  /** Every driver the gate holds now. */
  readonly registered: Set<ExternalAgentDriver>
  /** Every registration ever made. */
  readonly registrations: ExternalAgentDriver[]
  addProvider(name: string): void
  removeProvider(name: string): void
}

const mounted: Context[] = []

afterEach(async () => {
  for (const ctx of mounted.splice(0)) await ctx.fiber.dispose()
})

/** Load the plugin beside a stand-in gate, provider registry and profile; `providers` are registered before load. */
async function mount(providers: readonly string[] = []): Promise<Mounted> {
  const ctx = new Context()
  mounted.push(ctx)
  const names = new Set(providers)
  const registered = new Set<ExternalAgentDriver>()
  const registrations: ExternalAgentDriver[] = []
  const gate: Partial<ExternalAgentsGate> = {
    registerDriver: (driver) => {
      registered.add(driver)
      registrations.push(driver)
      return () => { registered.delete(driver) }
    },
  }
  const subagents: Partial<SubagentRuntime> = { getProvider: name => (names.has(name) ? provider(name) : undefined) }
  const profile: Partial<ProfileContext> = { name: 'default', dir: '/nonexistent/profiles/default' }
  ctx.provide('externalAgents', gate as ExternalAgentsGate)
  ctx.provide('subagents', subagents as SubagentRuntime)
  ctx.provide('profileContext', profile as ProfileContext)
  await ctx.plugin(plugin, {})
  return {
    ctx,
    registered,
    registrations,
    addProvider: (name) => {
      names.add(name)
      ctx.emit('subagent/provider-added', provider(name))
    },
    removeProvider: (name) => {
      names.delete(name)
      ctx.emit('subagent/provider-removed', name)
    },
  }
}

function provider(name: string): SubagentProvider {
  const stand: Partial<SubagentProvider> = { name }
  return stand as SubagentProvider
}

describe('the agent-codex plugin', () => {
  it('registers the Codex driver when upstream\'s codex provider is already registered', async () => {
    const m = await mount(['codex'])
    expect([...m.registered]).toEqual([expect.any(CodexDriver)])
    expect([...m.registered][0]?.provider).toBe('codex')
  })

  it('stays dormant without the Codex pack, and ignores other providers', async () => {
    const m = await mount(['claude-code'])
    m.addProvider('deepseek')
    expect(m.registrations).toEqual([])
  })

  it('follows the codex provider as the pack is added, removed and added again', async () => {
    const m = await mount()
    m.addProvider('codex')
    expect(m.registered.size).toBe(1)
    m.removeProvider('codex')
    expect(m.registered.size).toBe(0)
    m.addProvider('codex')
    expect(m.registered.size).toBe(1)
    expect(m.registrations).toHaveLength(2)
  })

  it('withdraws the driver when the plugin is unloaded', async () => {
    const m = await mount(['codex'])
    await m.ctx.fiber.dispose()
    expect(m.registered.size).toBe(0)
  })
})

describe('Config', () => {
  it('fills the shipped defaults', () => {
    expect(plugin.Config({})).toEqual({ requestTimeoutSeconds: 120, closeWaitSeconds: 5 })
  })

  it('refuses a zero or fractional wait at load', () => {
    expect(() => plugin.Config({ requestTimeoutSeconds: 0 })).toThrow()
    expect(() => plugin.Config({ closeWaitSeconds: 1.5 })).toThrow()
  })
})
