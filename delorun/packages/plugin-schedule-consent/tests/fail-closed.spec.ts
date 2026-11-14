/**
 * A scheduled-task consent whose service crashed while its switch is on refuses every delivery with a reason that names
 * the row and how to recover; with the switch off nothing is mounted, as stock. The service's activation is replaced by
 * one that throws.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ScheduleDeliveryReview } from '@deepseek-ai/dsh-schedule'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, ScheduleConsent } from '../src/index.ts'

const delivery: ScheduleDeliveryReview = { creationPreset: 'standard', currentPreset: 'standard', targetSessionId: 'chat-1' } as ScheduleDeliveryReview

beforeEach(() => {
  Object.defineProperty(ScheduleConsent.prototype, Service.init, {
    configurable: true,
    value: () => Promise.reject(new Error('the activation crashed')),
  })
})

afterEach(() => {
  Reflect.deleteProperty(ScheduleConsent.prototype, Service.init)
})

/**
 * Mount the plugin with a switch and let its fibers settle.
 * @param enabled - the row's switch.
 * @returns the context.
 */
async function mount(enabled: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({ apply }, { enabled })
  await new Promise(resolve => setTimeout(resolve, 20))
  return ctx
}

describe('a schedule consent row whose service crashed', () => {
  it('refuses every delivery, naming the row and how to recover, while the switch is on', async () => {
    const ctx = await mount(true)
    const consent = ctx.get('scheduleConsent')
    expect(consent).toBeDefined()
    expect(Reflect.get(consent!, Symbol.for('delorun.fail-closed-stub'))).toBe(true)
    const verdict = consent?.reviewDelivery(delivery)
    expect(verdict?.kind).toBe('refuse')
    const reason = verdict?.kind === 'refuse' ? verdict.reason : ''
    expect(reason).toContain('delorun-schedule-consent')
    expect(reason).toContain('the activation crashed')
    expect(reason).toMatch(/restart/iu)
    expect(reason).toMatch(/safe mode/iu)
    expect(reason).toMatch(/logs/iu)
    await ctx.fiber.dispose()
  })

  it('mounts nothing while the switch is off', async () => {
    const ctx = await mount(false)
    expect(ctx.get('scheduleConsent')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
