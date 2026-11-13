/**
 * An external-agent consent whose service crashed while its switch is on refuses every external start with a refusal
 * that names the row and how to recover; with the switch off the plugin mounts nothing, as stock. The service's
 * activation is replaced by one that throws.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DelegationConsentService } from '@deepseek-ai/dsh-subagent'
import { Config, apply } from '../src/index.ts'
import { DELEGATION_CONSENT_ROW } from '../src/wire.ts'

vi.mock('../src/service.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/service.ts')>()
  class CrashingConsent extends actual.DeloDelegationConsent {
    protected override async [Service.init](): Promise<void> {
      throw new Error('the grants store lock failed')
    }
  }
  return { ...actual, DeloDelegationConsent: CrashingConsent }
})

let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/**
 * Mount the plugin with a switch and let its fibers settle.
 * @param enabled - the row's switch.
 * @returns the context.
 */
async function mount(enabled: boolean): Promise<Context> {
  ctx = new Context()
  const config = Config({ enabled })
  await ctx.plugin({ name: 'row', apply }, config)
  await new Promise(resolve => setTimeout(resolve, 20))
  return ctx
}

const review = {
  provider: 'claude-code', cwd: '/work', label: 'Review', signal: new AbortController().signal,
  parent: { id: 'chat', session: { id: 'chat', header: { cwd: '/work' } } } as unknown as Agent,
}

describe('a delegation consent row whose service crashed', () => {
  it('refuses every start, naming the row and how to recover, while the switch is on', async () => {
    const running = await mount(true)
    const consent = running.get('delegationConsent') as DelegationConsentService | undefined
    expect(consent).toBeDefined()
    const verdict = await consent!.review(review)
    expect(verdict.kind).toBe('refuse')
    const reason = verdict.kind === 'refuse' ? verdict.reason : ''
    expect(reason).toContain(DELEGATION_CONSENT_ROW)
    expect(reason).toContain('claude-code')
    expect(reason).toContain('the grants store lock failed')
    expect(reason).toMatch(/restart/iu)
    expect(reason).toMatch(/safe mode/iu)
    expect(reason).toMatch(/logs/iu)
  })

  it('mounts nothing while the switch is off', async () => {
    const stopped = await mount(false)
    expect(stopped.get('delegationConsent')).toBeUndefined()
  })
})
