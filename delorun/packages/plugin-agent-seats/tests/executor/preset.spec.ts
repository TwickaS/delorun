/** The seat preset definition and the executor row it names. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { apply, Config, inject, recordPrefixOf, SEAT_EXECUTOR_MODULE, seatPreset } from '../../src/executor/index.ts'
import { Config as SeatsConfig } from '../../src/config.ts'
import { FakePrograms } from './helpers.ts'

const [claude, codex] = SeatsConfig({ seats: undefined } as never).seats

describe('seatPreset', () => {
  it('composes a bare persona and the seat executor, and nothing else', () => {
    const preset = seatPreset(claude!)
    expect(preset.id).toBe('claude-code-seat')
    expect(preset.plugins.map(row => row.name)).toEqual(['@deepseek-ai/dsh-persona', SEAT_EXECUTOR_MODULE])
    expect(preset.plugins[0]?.config).toMatchObject({ complete: true, includeRuntimeContext: false })
    expect(String((preset.plugins[0]?.config as { prefix: string }).prefix).split('\n')).toHaveLength(1)
    expect(preset.plugins[1]?.config).toEqual({ recordPrefix: 'claude_code.' })
  })

  it('names each seat\'s records by its hand-off tool', () => {
    expect(recordPrefixOf(codex!)).toBe('codex.')
    expect(seatPreset(codex!).plugins[1]?.config).toEqual({ recordPrefix: 'codex.' })
  })
})

describe('executor row', () => {
  it('accepts a dotted lower-case prefix only', () => {
    expect(Config({ recordPrefix: 'claude_code.' })).toEqual({ recordPrefix: 'claude_code.' })
    expect(() => Config({ recordPrefix: 'Claude' })).toThrow()
    expect(() => Config({} as never)).toThrow()
  })

  it('mounts the executor in the scope, and a second mount in that scope fails', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    ctx.provide('seatPrograms')
    ctx.set('seatPrograms', new FakePrograms())
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { preset: 'row' }) }, { inject: [...inject] }))
    apply(scope.ctx, { recordPrefix: 'claude_code.' })
    expect(() => apply(scope.ctx, { recordPrefix: 'claude_code.' })).toThrow(/Only one tool executor/)
    await ctx.fiber.dispose()
  })
})
