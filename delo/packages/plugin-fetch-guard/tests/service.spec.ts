/**
 * The `fetchGuard` service as a mounted Cordis plugin: its switch, its typed
 * refusal, and what mounting and unmounting do to the service the provider
 * reads with `ctx.get()`. No network runs here; the checks take addresses as
 * fixtures.
 */
import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { Config, FetchGuardService } from '../src/index.ts'
import { FetchGuardRefusedError } from '../src/guard.ts'

/** One refused address: RFC1918 private. */
const PRIVATE = { address: '10.0.0.5', family: 4 } as const
/** One public-looking address the matrix allows. */
const PUBLIC = { address: '203.0.113.10', family: 4 } as const

interface Mount {
  readonly ctx: Context
  readonly guard: FetchGuardService
  readonly fiber: Fiber
}

async function mount(enabled: boolean): Promise<Mount> {
  const ctx = new Context()
  const fiber = await ctx.plugin(FetchGuardService, { enabled })
  return { ctx, guard: ctx.get('fetchGuard') as FetchGuardService, fiber }
}

describe('the fetchGuard service', () => {
  it('mounts under its name and reports its switch', async () => {
    const { guard, fiber } = await mount(true)
    expect(guard).toBeInstanceOf(FetchGuardService)
    expect(guard.enabled).toBe(true)
    await fiber.dispose()
  })

  it('refuses a refused address with the typed refusal naming the host', async () => {
    const { guard, fiber } = await mount(true)
    const refusal = guard.check(new URL('http://guard-private.test:8080/'), [PRIVATE])
    await expect(refusal).rejects.toBeInstanceOf(FetchGuardRefusedError)
    await refusal.catch((error: unknown) => {
      expect((error as FetchGuardRefusedError).code).toBe('private')
      expect((error as FetchGuardRefusedError).host).toBe('guard-private.test')
      expect((error as FetchGuardRefusedError).message).toBe('web fetch refused: the host "guard-private.test" is a private-network address, which web_fetch does not fetch')
    })
    await fiber.dispose()
  })

  it('refuses when any resolved address is refused and allows a public-looking one', async () => {
    const { guard, fiber } = await mount(true)
    await expect(guard.check(new URL('http://guard-private.test/'), [PUBLIC, PRIVATE])).rejects.toThrow(FetchGuardRefusedError)
    await expect(guard.check(new URL('http://guard-public.test/'), [PUBLIC])).resolves.toBeUndefined()
    await expect(guard.check(new URL('http://guard-public.test/'), [{ address: '2001:db8::10', family: 6 }])).resolves.toBeUndefined()
    await fiber.dispose()
  })

  it('with the switch off it refuses nothing, not even a refused address', async () => {
    const { guard, fiber } = await mount(false)
    expect(guard.enabled).toBe(false)
    await expect(guard.check(new URL('http://guard-private.test/'), [PRIVATE])).resolves.toBeUndefined()
    await fiber.dispose()
  })

  it('defaults the switch to false, the parity value', () => {
    expect((Config({} as never) as Config).enabled).toBe(false)
  })

  it('unmounting removes the service the next request would read', async () => {
    const { ctx, fiber } = await mount(true)
    expect(ctx.get('fetchGuard')).toBeInstanceOf(FetchGuardService)
    await fiber.dispose()
    expect(ctx.get('fetchGuard')).toBeUndefined()
  })
})
