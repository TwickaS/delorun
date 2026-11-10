/**
 * The `homeAuth` service as a mounted Cordis plugin: the routes it registers with the web server, their removal when the
 * plugin is disposed, and the reach closer it reads from `ctx.connection` when a device is revoked.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delo/contract-admission'
import type { Base64Url, DevicePublicKeyJwk } from '@delo/contract-device-approval'
import type { HomeAuth } from '../src/home-auth.ts'
import { HomeAuthService, loopbackCredentialOf } from '../src/service.ts'
import { DEVICE_REMOVE_PATH, DEVICES_PATH, OWNER_CLAIM_PATH } from '../src/routes.ts'
import { REACH_PATHS } from '../src/reach-routes.ts'

/** Every route the service registers, in registration order. */
const ROUTES: readonly (readonly [string, string])[] = [
  ['exact', OWNER_CLAIM_PATH],
  ['exact', DEVICES_PATH],
  ['exact', DEVICE_REMOVE_PATH],
  ['exact', REACH_PATHS.signIn],
  ['prefix', REACH_PATHS.assets],
  ['exact', REACH_PATHS.request],
  ['prefix', REACH_PATHS.request],
  ['exact', REACH_PATHS.challenge],
  ['exact', REACH_PATHS.session],
  ['exact', REACH_PATHS.window],
  ['exact', REACH_PATHS.pending],
  ['exact', REACH_PATHS.approve],
]
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
  it('mounts under its name and registers the claim, device and reach routes', async () => {
    const mounted = await mount()
    try {
      expect(mounted.ctx.get('homeAuth')).toBeInstanceOf(HomeAuthService)
      expect(mounted.registered.map(route => [route.kind, route.path])).toEqual(ROUTES)
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
      expect(mounted.unregistered).toEqual(ROUTES.map(([, path]) => path))
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
      await service.openSession({ deviceId: deviceIdOf(keyOf(1)), listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR })
      await expect(service.revokeDevice(deviceIdOf(keyOf(1)))).resolves.toMatchObject({ sessions: 1, connections: 2 })
      // Pins the closer wiring: without `ctx.get('connection')` a revoked device's streams and upgraded sockets stay
      // open, and the sessions that admitted them are gone.
      expect(closed).toEqual([{ deviceId: deviceIdOf(keyOf(1)) }])
    } finally {
      await mounted.fiber.dispose()
      await rm(mounted.directory, { recursive: true, force: true })
    }
  })

  it('serves a reach listener, announces each policy change and runs the window and the local approval', async () => {
    const mounted = await mount()
    const announced: string[] = []
    mounted.ctx.on('authenticator/policy', (listener) => { announced.push(listener) })
    try {
      const service = mounted.ctx.homeAuth
      const address = brandString<StudioAddress>('https://home.example.ts.net')
      const off = service.serve({ listener: 'reach-tailscale-private', address, factor: 'tailnet-membership' })
      expect(service.servedListener('reach-tailscale-private')).toMatchObject({ address })
      expect(service.admitToken('unknown', 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
      expect(service.approvalWindowOpenUntil()).toBeUndefined()
      await service.openApprovalWindow()
      expect(service.approvalWindowOpenUntil()).toBeGreaterThan(Date.now())
      expect(service.pendingApprovals()).toEqual([])
      await expect(service.approveLocally('unknown', '12345678')).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
      const removed: string[] = []
      const stop = service.onDeviceRemoved((deviceId) => { removed.push(deviceId) })
      await service.revokeDevice(deviceIdOf(keyOf(5)))
      stop()
      expect(removed).toEqual([deviceIdOf(keyOf(5))])
      off()
      // Pins the announcements: a reach listener rereads its policy only when the provider announces a change.
      expect(announced).toEqual(['reach-tailscale-private', 'reach-tailscale-private'])
      expect(service.servedListener('reach-tailscale-private')).toBeUndefined()
    } finally {
      await mounted.fiber.dispose()
      await rm(mounted.directory, { recursive: true, force: true })
    }
  })

  it('reads the studio credential from upstream\'s connection service, and refuses every request without one', () => {
    const ctx = new Context()
    const request = new IncomingMessage(new Socket())
    // Pins the fail-closed default: without the connection service a device route answers no request.
    expect(loopbackCredentialOf(ctx)(request)).toBe(401)
    const asked: unknown[] = []
    ctx.provide('connection', { requestRejection: (seen: unknown) => { asked.push(seen); return asked.length === 1 ? undefined : 403 } } as never)
    expect(loopbackCredentialOf(ctx)(request)).toBeUndefined()
    expect(loopbackCredentialOf(ctx)(request)).toBe(403)
    expect(asked).toEqual([request, request])
  })

  it('admits nothing before it started, and refuses every other call', () => {
    const ctx = new Context()
    const service = new HomeAuthService(ctx, { secretsDirectory: '/nowhere' })
    expect(service.admitToken('x', 'reach-tailscale-private')).toEqual({ kind: 'refused', code: 'NOT_SIGNED_IN' })
    // Pins the fail-closed arrival: before the home started, a request names no listener, so no route treats it as loopback.
    expect(service.arrivalOf({ headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: 3080 } }))
      .toEqual({ listener: undefined, host: '127.0.0.1:3080', source: 'unknown' })
    expect(service.servedListener('reach-tailscale-private')).toBeUndefined()
    expect(() => service.owner()).toThrow(/has not started/)
    expect(() => service.cancelApproval('request')).toThrow(/has not started/)
  })

  it('cancels a pending approval request at the home\'s own computer', async () => {
    const mounted = await mount()
    try {
      const service = mounted.ctx.homeAuth
      const address = brandString<StudioAddress>('https://home.example.ts.net')
      service.serve({ listener: 'reach-tailscale-private', address, factor: 'tailnet-membership' })
      await service.openApprovalWindow()
      const exported = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' })
      const devicePublicKey: DevicePublicKeyJwk = { kty: 'EC', crv: 'P-256', x: brandString<Base64Url>(exported.x ?? ''), y: brandString<Base64Url>(exported.y ?? '') }
      // The service has no request method of its own: a request arrives through the reach route, which calls the core.
      const core = Reflect.get(service, 'core') as HomeAuth
      const accepted = await core.requestApproval(
        { devicePublicKey, deviceId: deviceIdOf(devicePublicKey), deviceNonce: brandString<Base64Url>(Buffer.alloc(16, 3).toString('base64url')), label: 'Phone', platform: 'iOS' },
        { listener: 'reach-tailscale-private', source: '127.0.0.1' },
      )
      expect(service.pendingApprovals()).toHaveLength(1)
      service.cancelApproval(accepted.requestId)
      // Pins the delegation to the approval window: without it the request stays pending and keeps its place.
      expect(service.pendingApprovals()).toEqual([])
      expect(() => { service.cancelApproval(accepted.requestId) }).toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
    } finally {
      await mounted.fiber.dispose()
      await rm(mounted.directory, { recursive: true, force: true })
    }
  })

  it('answers the owner, the device list, the code and a session through the service', async () => {
    const mounted = await mount()
    try {
      const service = mounted.ctx.homeAuth
      await expect(service.assertOwner()).rejects.toMatchObject({ code: 'NO_OWNER' })
      expect(service.arrivalOf({ headers: { host: 'x' }, socket: { remoteAddress: '127.0.0.1' } })).toEqual({ listener: undefined, host: 'x', source: '127.0.0.1' })
      const issued = await service.issueOwnerCode()
      await expect(service.ownerCodeOutstanding()).resolves.toBe(true)
      await service.claim(claimOf(issued.code, { address: ADDRESS }))
      await expect(service.devices()).resolves.toMatchObject({ devices: [{ id: deviceIdOf(keyOf(1)) }] })
      const opened = await service.openSession({ deviceId: deviceIdOf(keyOf(1)), listener: 'reach-tailscale-private', address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: HOUR })
      await expect(service.sessionOf(opened.token)).resolves.toMatchObject({ factor: 'tailnet-membership' })
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
