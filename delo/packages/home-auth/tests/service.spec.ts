/**
 * The `homeAuth` service as a mounted Cordis plugin: the routes it registers with the web server, their removal when the
 * plugin is disposed, and the reach closer it reads from `ctx.connection` when a device is revoked.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import { HomeAuthService } from '../src/service.ts'
import { DEVICE_REMOVE_PATH, DEVICES_PATH, OWNER_CLAIM_PATH } from '../src/routes.ts'
import { deviceIdOf } from '../src/records.ts'
import { claimOf, keyOf } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('http://127.0.0.1:3080')
const HOUR = 60 * 60 * 1000

/** One route the fake web server was given. */
interface Registered {
  readonly kind: string
  readonly path: string
}

/** A mounted service and what its fake web server saw. */
interface Mount {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly registered: Registered[]
  readonly unregistered: string[]
  readonly directory: string
}

/**
 * Mount the service over a temporary secrets directory and a fake web server.
 * @param extra - what else to provide on the context, such as a connection service.
 * @returns the mount.
 */
async function mount(extra: { readonly connection?: unknown } = {}): Promise<Mount> {
  const directory = await mkdtemp(join(tmpdir(), 'delo-home-auth-service-'))
  const ctx = new Context()
  const registered: Registered[] = []
  const unregistered: string[] = []
  ctx.provide('webServer', {
    register: (route: Registered) => {
      registered.push(route)
      return () => { unregistered.push(route.path) }
    },
  } as never)
  if (extra.connection !== undefined) ctx.provide('connection', extra.connection as never)
  const fiber = await ctx.plugin(HomeAuthService, { secretsDirectory: join(directory, 'home-auth') })
  return { ctx, fiber, registered, unregistered, directory }
}

describe('the homeAuth service', () => {
  it('mounts under its name and registers the claim and device routes', async () => {
    const mounted = await mount()
    try {
      expect(mounted.ctx.get('homeAuth')).toBeInstanceOf(HomeAuthService)
      expect(mounted.registered.map(route => [route.kind, route.path])).toEqual([
        ['exact', OWNER_CLAIM_PATH],
        ['exact', DEVICES_PATH],
        ['exact', DEVICE_REMOVE_PATH],
      ])
    } finally {
      await mounted.fiber.dispose()
      await rm(mounted.directory, { recursive: true, force: true })
    }
  })

  it('unregisters the routes when the plugin is disposed', async () => {
    const mounted = await mount()
    await mounted.fiber.dispose()
    try {
      // Pins the routes living inside `ctx.effect()`: a registration made outside it outlives the plugin and answers
      // requests with a store that is gone.
      expect(mounted.unregistered).toEqual([OWNER_CLAIM_PATH, DEVICES_PATH, DEVICE_REMOVE_PATH])
      expect(mounted.ctx.get('homeAuth')).toBeUndefined()
    } finally {
      await rm(mounted.directory, { recursive: true, force: true })
    }
  })

  it('ends the reach connections of a revoked device through `ctx.connection`', async () => {
    const closed: { readonly deviceId?: string }[] = []
    const mounted = await mount({ connection: { closeReachConnections: (match: { readonly deviceId?: string }) => { closed.push(match); return 2 } } })
    try {
      const service = mounted.ctx.get('homeAuth') as HomeAuthService
      const issued = await service.issueOwnerCode()
      await service.claim(claimOf(issued.code, { address: ADDRESS }))
      await service.openSession({ deviceId: deviceIdOf(keyOf(1)), address: ADDRESS, lifetimeMs: HOUR })
      await expect(service.revokeDevice(deviceIdOf(keyOf(1)))).resolves.toMatchObject({ sessions: 1, connections: 2 })
      // Pins the closer wiring: without `ctx.get('connection')` a revoked device's streams and upgraded sockets stay
      // open, and the sessions that admitted them are gone.
      expect(closed).toEqual([{ deviceId: deviceIdOf(keyOf(1)) }])
    } finally {
      await mounted.fiber.dispose()
      await rm(mounted.directory, { recursive: true, force: true })
    }
  })

  it('refuses a secrets directory that is not absolute', async () => {
    const ctx = new Context()
    ctx.provide('webServer', { register: () => () => {} } as never)
    // Pins the path check: a relative directory would create the store where the process happens to run.
    await expect(ctx.plugin(HomeAuthService, { secretsDirectory: 'secrets/home-auth' })).rejects.toThrow(/absolute path/)
    await ctx.fiber.dispose()
  })
})
