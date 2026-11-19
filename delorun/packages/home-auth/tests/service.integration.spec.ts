/**
 * The `homeAuth` service as a mounted Cordis plugin: the routes it registers with the web server, their removal when the
 * plugin is disposed, and the reach closer it reads from `ctx.connection` when a device is revoked.
 *
 * Each test's comment names the check whose removal makes that test fail, so the suite is also the mutation record.
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delorun/contract-admission'
import type { Base64Url, DevicePublicKeyJwk } from '@delorun/contract-device-approval'
import type { HomeAuth } from '../src/home-auth.ts'
import { Config, HomeAuthService, loopbackCredentialOf } from '../src/service.ts'
import { DEVICE_REMOVE_PATH, DEVICES_PATH, OWNER_CLAIM_PATH } from '../src/routes.ts'
import { REACH_PATHS } from '../src/reach-routes.ts'

/** Every route the service registers, in registration order. */
const ROUTES: readonly (readonly [string, string])[] = [
  ['exact', OWNER_CLAIM_PATH],
  ['exact', DEVICES_PATH],
  ['exact', DEVICE_REMOVE_PATH],
  ['exact', REACH_PATHS.signIn],
  ['exact', REACH_PATHS.brandingIcon],
  ['prefix', REACH_PATHS.assets],
  ['exact', REACH_PATHS.request],
  ['prefix', REACH_PATHS.request],
  ['exact', REACH_PATHS.challenge],
  ['exact', REACH_PATHS.session],
  ['exact', REACH_PATHS.window],
  ['exact', REACH_PATHS.pending],
  ['exact', REACH_PATHS.approve],
  ['exact', REACH_PATHS.cancel],
  ['exact', ELEVATION_PATHS.state],
  ['exact', ELEVATION_PATHS.request],
  ['exact', ELEVATION_PATHS.lock],
  ['exact', ELEVATION_PATHS.endGrace],
  ['exact', ELEVATION_PATHS.pending],
  ['exact', ELEVATION_PATHS.approve],
  ['exact', ELEVATION_PATHS.revoke],
  ['exact', PIN_PATHS.state],
  ['exact', PIN_PATHS.unlock],
  ['exact', PIN_PATHS.touch],
  ['exact', PIN_PATHS.lock],
  ['exact', PIN_PATHS.mode],
  ['exact', PIN_PATHS.set],
  ['exact', PIN_PATHS.off],
  ['exact', PIN_PATHS.options],
  ['exact', PIN_PATHS.resume],
  ...Object.values(PASSKEY_PATHS).map((path): ['exact', string] => ['exact', path]),
]
import { ELEVATION_PATHS } from '../src/elevation-routes.ts'
import { PASSKEY_PATHS } from '../src/passkey-routes.ts'
import { PIN_PATHS } from '../src/pin-routes.ts'
import { deviceIdOf } from '../src/records.ts'

/** One settings field a PIN page loosened, as the PIN set-back ledger records it. */
interface PinLift { readonly ns: string; readonly field: string; readonly written: unknown }

/**
 * Record PIN-mode settings lifts the way a page unlock did, so the set-back on PIN mode turning off is exercised.
 * @param ctx - the context whose `homeAuth` service holds the ledger.
 * @param lifts - the fields and the values they were set to.
 */
function seedPinLift(ctx: Context, lifts: readonly PinLift[]): void {
  const ledger: { record: (lifts: readonly PinLift[], previousOf: (ns: string, field: string) => unknown) => void } | undefined = ctx.homeAuth['pinLifts']
  if (ledger === undefined) throw new Error('the PIN set-back ledger is not loaded')
  ledger.record(lifts, (ns, field) => ctx.homeAuth['settingsFields']().read(ns, field))
}
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
 * @param extra - what else to provide on the context, such as a connection service, and extra plugin configuration.
 * @returns the mount.
 */
async function mount(extra: { readonly connection?: unknown, readonly config?: Readonly<Record<string, unknown>> } = {}): Promise<Mount> {
  const directory = await mkdtemp(join(tmpdir(), 'delorun-home-auth-service-'))
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
  const fiber = await ctx.plugin(HomeAuthService, { ...extra.config, secretsDirectory: join(directory, 'secrets', 'home-auth') })
  return { ctx, fiber, registered, unregistered, directory }
}

const TAILNET = brandString<StudioAddress>('https://home.example.ts.net')

describe('the homeAuth service', () => {
  it('mounts under its name and registers the claim, device and reach routes', async () => {
    const mounted = await mount()
    try {
      expect(mounted.ctx.get('homeAuth')).toBeInstanceOf(HomeAuthService)
      expect(mounted.registered.map(route => [route.kind, route.path])).toEqual(ROUTES)
      // The Phone powers route is gone: nothing answers it, so a request for it is a 404 (A2, owner decision L92).
      expect(mounted.registered.map(route => route.path)).not.toContain('/auth/phone-powers')
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

  it('serves elevation to a device and to the computer, and logs each start and ending', async () => {
    const mounted = await mount()
    const lines: string[] = []
    try {
      const service = mounted.ctx.get('homeAuth') as HomeAuthService
      mounted.ctx.logger.info = (line: string) => { lines.push(line) }
      expect(service.elevationOf('nobody', 'reach-tailscale-private')).toBeUndefined()
      service.serve({ listener: 'reach-tailscale-private', address: TAILNET, factor: 'tailnet-membership' })
      const issued = await service.issueOwnerCode()
      await service.claim(claimOf(issued.code, { address: TAILNET }))
      const deviceId = deviceIdOf(keyOf(1))
      const opened = await service.openSession({ deviceId, listener: 'reach-tailscale-private', address: TAILNET, factor: 'tailnet-membership', lifetimeMs: HOUR })
      const admitted = service.admitToken(opened.token, 'reach-tailscale-private')
      if (admitted.kind !== 'admitted') throw new Error('the device was not admitted')
      const changes: string[] = []
      const off = service.onElevationChange((change) => { changes.push(change.kind) })
      const state = service.requestElevation(admitted.sessionId, admitted.session)
      if (state.kind !== 'pending') throw new Error('no request is waiting')
      expect(service.elevationState(deviceId, 'reach-tailscale-private')).toEqual(state)
      expect(service.elevationsAtComputer().pending).toHaveLength(1)
      const record = service.approveElevation(state.requestId, state.code)
      expect(service.elevationOf(deviceId, 'reach-tailscale-private')).toEqual(record)
      service.lockElevation(deviceId, 'reach-tailscale-private')
      const again = service.requestElevation(admitted.sessionId, admitted.session)
      if (again.kind !== 'pending') throw new Error('no request is waiting')
      expect(service.revokeElevation(again.requestId)).toBe(true)
      off()
      expect(changes).toEqual(['started', 'ended'])
      // Pins the log line: the device, the listener and the elevation, and who ended it.
      expect(lines).toEqual([
        `home-auth: elevation started until ${new Date(record.endsAt).toISOString()}: device=${deviceId} listener=reach-tailscale-private elevation=${record.id}`,
        `home-auth: elevation ended (locked-from-device): device=${deviceId} listener=reach-tailscale-private elevation=${record.id}`,
      ])
    } finally {
      await mounted.fiber.dispose()
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
    const service = new HomeAuthService(ctx, Config({ secretsDirectory: '/nowhere' }))
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

  it('sets back through the settings service what a device loosened, when the first read finds the mode ended', async () => {
    const { ctx, fiber, directory } = await mount()
    try {
      let mode = true
      const values: Record<string, unknown> = { enabled: true }
      const calls: unknown[] = []
      ctx.provide('reachFullAccessGrants', { dangerousMode: () => mode, onDangerousModeEnd: () => () => {} } as never)
      ctx.provide('settings', {
        describe: () => [{ ns: 'delorun-delegation-consent', value: values }],
        update: (_ns: string, patch: Record<string, unknown>) => { calls.push(patch); Object.assign(values, patch); return Promise.resolve() },
      } as never)
      // The device turns the consent off under the mode; the policy records it before the write.
      ctx.homeAuth.recordLifts([{ ns: 'delorun-delegation-consent', field: 'enabled', written: false }])
      values.enabled = false
      // Pins the mode check: while it holds, a read of the mode reverts nothing.
      expect(ctx.homeAuth.dangerousMode()).toBe(true)
      expect(calls).toEqual([])
      mode = false
      expect(ctx.homeAuth.dangerousMode()).toBe(false)
      await ctx.homeAuth.endDangerousSettings()
      expect(calls).toEqual([{ enabled: true }])
      expect(values.enabled).toBe(true)
    } finally {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sets back what an unlocked PIN page loosened when PIN mode turns off, and keeps the record at 0600', async () => {
    const { ctx, fiber, directory } = await mount()
    try {
      const values: Record<string, unknown> = { enabled: true }
      const calls: unknown[] = []
      ctx.provide('settings', {
        describe: () => [{ ns: 'delorun-delegation-consent', value: values }],
        update: (_ns: string, patch: Record<string, unknown>) => { calls.push(patch); Object.assign(values, patch); return Promise.resolve() },
      } as never)
      await ctx.homeAuth.setPin('739150', {})
      // A record a PIN page unlock left before the window was removed (A483); nothing records one now.
      seedPinLift(ctx, [{ ns: 'delorun-delegation-consent', field: 'enabled', written: false }])
      values.enabled = false
      const file = join(directory, 'secrets', 'home-auth', 'reach-pin-settings.json')
      // Pins the file and its mode: the record is a protected write like the other reach files.
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(calls).toEqual([])
      await ctx.homeAuth.turnPinOff()
      await vi.waitFor(() => { expect(calls).toEqual([{ enabled: true }]) })
      expect(values.enabled).toBe(true)
    } finally {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a PIN lift whose settings row is not described, and sets it back when the row appears', async () => {
    const { ctx, fiber, directory } = await mount({ config: { pinSetBackRetrySeconds: 1 } })
    try {
      const values: Record<string, unknown> = { enabled: true }
      let rows: { ns: string; value: unknown }[] = [{ ns: 'delorun-delegation-consent', value: values }]
      ctx.provide('settings', {
        describe: () => rows,
        update: (_ns: string, patch: Record<string, unknown>) => { Object.assign(values, patch); return Promise.resolve() },
      } as never)
      await ctx.homeAuth.setPin('739150', {})
      // A record a PIN page unlock left before the window was removed (A483); nothing records one now.
      seedPinLift(ctx, [{ ns: 'delorun-delegation-consent', field: 'enabled', written: false }])
      values.enabled = false
      rows = []
      await ctx.homeAuth.turnPinOff()
      await ctx.homeAuth.endPinSettings()
      // Pins the kept lift: an absent row cannot show the person's change, so the lift is not dropped unwritten.
      expect(values.enabled).toBe(false)
      rows = [{ ns: 'delorun-delegation-consent', value: values }]
      // Pins the timer: once the row is described, the next tick writes the value back with no request to read the mode.
      await vi.waitFor(() => { expect(values.enabled).toBe(true) }, { timeout: 5000 })
    } finally {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries a failed PIN set-back on a timer, warns per failed lift without the value, and reports it as waiting', async () => {
    const { ctx, fiber, directory } = await mount({ config: { pinSetBackRetrySeconds: 1 } })
    const warnings: string[] = []
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
    try {
      const values: Record<string, unknown> = { enabled: true }
      let failing = true
      const settings = {
        describe: () => [{ ns: 'delorun-delegation-consent', value: values }],
        update: (_ns: string, patch: Record<string, unknown>) => {
          if (failing) return Promise.reject(new Error('plugin reloading'))
          Object.assign(values, patch)
          return Promise.resolve()
        },
      }
      ctx.provide('settings', settings as never)
      await ctx.homeAuth.setPin('739150', {})
      // A record a PIN page unlock left before the window was removed (A483); nothing records one now.
      seedPinLift(ctx, [{ ns: 'delorun-delegation-consent', field: 'enabled', written: false }])
      values.enabled = false
      await ctx.homeAuth.turnPinOff()
      await ctx.homeAuth.endPinSettings()
      expect(values.enabled).toBe(false)
      // Pins the report: the computer sees what waits, by field, and the log names the field and no value.
      expect(ctx.homeAuth.pinSetBackWaiting()).toEqual([{ ns: 'delorun-delegation-consent', field: 'enabled' }])
      expect(warnings.some(line => line.includes('delorun-delegation-consent.enabled'))).toBe(true)
      expect(warnings.join('\n')).not.toContain('plugin reloading')
      failing = false
      // Pins the timer: no request reads the mode, and the failed write still retries.
      await vi.waitFor(() => { expect(values.enabled).toBe(true) }, { timeout: 5000 })
      await vi.waitFor(() => { expect(ctx.homeAuth.pinSetBackWaiting()).toEqual([]) })
    } finally {
      warn.mockRestore()
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not describe the settings on a read of the mode while a PIN lift waits', async () => {
    const { ctx, fiber, directory } = await mount({ config: { pinSetBackRetrySeconds: 3600 } })
    try {
      const values = { enabled: true }
      const describe = vi.fn(() => [{ ns: 'delorun-delegation-consent', value: values }])
      ctx.provide('settings', { describe, update: () => Promise.reject(new Error('down')) } as never)
      await ctx.homeAuth.setPin('739150', {})
      // A record a PIN page unlock left before the window was removed (A483); nothing records one now.
      seedPinLift(ctx, [{ ns: 'delorun-delegation-consent', field: 'enabled', written: false }])
      values.enabled = false
      await ctx.homeAuth.turnPinOff()
      await ctx.homeAuth.endPinSettings()
      const before = describe.mock.calls.length
      // Pins P3: a reach request's read of the mode starts no settings pass.
      for (let i = 0; i < 5; i++) ctx.homeAuth.pinEnabled()
      await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
      expect(describe.mock.calls.length).toBe(before)
    } finally {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('arms one unref\'d retry timer while a PIN lift waits and clears it on dispose', async () => {
    const { ctx, fiber, directory } = await mount({ config: { pinSetBackRetrySeconds: 3600 } })
    const set = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    try {
      const values = { enabled: true }
      ctx.provide('settings', { describe: () => [{ ns: 'delorun-delegation-consent', value: values }], update: () => Promise.reject(new Error('down')) } as never)
      await ctx.homeAuth.setPin('739150', {})
      // A record a PIN page unlock left before the window was removed (A483); nothing records one now.
      seedPinLift(ctx, [{ ns: 'delorun-delegation-consent', field: 'enabled', written: false }])
      values.enabled = false
      await ctx.homeAuth.turnPinOff()
      await ctx.homeAuth.endPinSettings()
      await ctx.homeAuth.endPinSettings()
      // Pins the single timer, its period from the config and that it never keeps the process alive.
      expect(set).toHaveBeenCalledTimes(1)
      expect(set.mock.calls[0]![1]).toBe(3_600_000)
      expect(set.mock.results[0]!.value.hasRef()).toBe(false)
      expect(cleared).not.toHaveBeenCalled()
      await fiber.dispose()
      // Pins the disposer: the timer does not outlive the plugin.
      expect(cleared).toHaveBeenCalledTimes(1)
    } finally {
      set.mockRestore()
      cleared.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sets back a PIN lift a previous run left once the settings service mounts', async () => {
    const { ctx, fiber, directory } = await mount()
    try {
      await fiber.dispose()
      const secrets = join(directory, 'secrets', 'home-auth')
      await writeFile(join(secrets, 'reach-pin-settings.json'), JSON.stringify({ v: 1, lifts: [{ ns: 'delorun-delegation-consent', field: 'enabled', previous: true, set: false }] }), { mode: 0o600 })
      const restarted = await ctx.plugin(HomeAuthService, { secretsDirectory: secrets })
      try {
        const values: Record<string, unknown> = { enabled: false }
        // Pins the start without the service: the lift stays on disk and the later mount of the settings service writes it back.
        ctx.provide('settings', {
          describe: () => [{ ns: 'delorun-delegation-consent', value: values }],
          update: (_ns: string, patch: Record<string, unknown>) => { Object.assign(values, patch); return Promise.resolve() },
        } as never)
        await vi.waitFor(() => { expect(values.enabled).toBe(true) })
      } finally {
        await restarted.dispose()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sets back what a device loosened as soon as the mode ends, with no device call and no restart', async () => {
    const { ctx, fiber, directory } = await mount()
    try {
      let mode = true
      const ended = new Set<() => void>()
      const values: Record<string, unknown> = { enabled: true }
      ctx.provide('reachFullAccessGrants', { dangerousMode: () => mode, onDangerousModeEnd: (listener: () => void) => { ended.add(listener); return () => { ended.delete(listener) } } } as never)
      ctx.provide('settings', {
        describe: () => [{ ns: 'delorun-delegation-consent', value: values }],
        update: (_ns: string, patch: Record<string, unknown>) => { Object.assign(values, patch); return Promise.resolve() },
      } as never)
      expect(ctx.homeAuth.recordLifts([{ ns: 'delorun-delegation-consent', field: 'enabled', written: false }])).toBeUndefined()
      values.enabled = false
      // Pins the subscription: without it nothing reads the mode here, so the consent stays off.
      await vi.waitFor(() => { expect(ended.size).toBe(1) })
      mode = false
      for (const listener of ended) listener()
      await vi.waitFor(() => { expect(values.enabled).toBe(true) })
    } finally {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sets back what a device loosened when the permission-defaults service is injected again with the mode off', async () => {
    const { ctx, fiber, directory } = await mount()
    try {
      const values: Record<string, unknown> = { enabled: true }
      ctx.provide('settings', {
        describe: () => [{ ns: 'delorun-delegation-consent', value: values }],
        update: (_ns: string, patch: Record<string, unknown>) => { Object.assign(values, patch); return Promise.resolve() },
      } as never)
      expect(ctx.homeAuth.recordLifts([{ ns: 'delorun-delegation-consent', field: 'enabled', written: false }])).toBeUndefined()
      values.enabled = false
      // Pins the reconcile on injection: the new provider never fires an ending, and no device call follows.
      ctx.provide('reachFullAccessGrants', { dangerousMode: () => false, onDangerousModeEnd: () => () => {} } as never)
      await vi.waitFor(() => { expect(values.enabled).toBe(true) })
    } finally {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses to record a lift when the record cannot be saved', async () => {
    const { ctx, fiber, directory } = await mount()
    try {
      await rm(directory, { recursive: true, force: true })
      // Pins the fail-closed save: without it the device's write would proceed unrecorded.
      expect(ctx.homeAuth.recordLifts([{ ns: 'delorun-delegation-consent', field: 'enabled', written: false }])).toMatch(/^loopback-required: the home could not record/)
    } finally {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses a secrets directory that is not absolute', async () => {
    const ctx = new Context()
    ctx.provide('webServer', { register: () => () => {} } as never)
    // Pins the path check: a relative directory would create the store where the process happens to run.
    await expect(ctx.plugin(HomeAuthService, { secretsDirectory: 'secrets/home-auth' })).rejects.toThrow(/absolute path/)
    await ctx.fiber.dispose()
  })

  it('validates the sign-in challenge limits at load and fills Delorun\'s defaults', () => {
    // Pins the bounds: a limit of 0 would refuse every sign-in, one above 600 is no limit.
    expect(() => Config({ secretsDirectory: '/nowhere', challenges: { perDevicePerMinute: 0 } })).toThrow()
    expect(() => Config({ secretsDirectory: '/nowhere', challenges: { perSourcePerMinute: 601 } })).toThrow()
    expect(Config({ secretsDirectory: '/nowhere' }).challenges).toEqual({ perSourcePerMinute: 60, perDevicePerMinute: 10 })
  })

  it('refuses a secrets directory outside a Delorun home, and names the home it lies in', async () => {
    const ctx = new Context()
    ctx.provide('webServer', { register: () => () => {} } as never)
    // Pins the layout check: the home a device's workspace-file read never reaches is derived from this directory.
    await expect(ctx.plugin(HomeAuthService, { secretsDirectory: '/elsewhere/home-auth' })).rejects.toThrow(/Delorun home's secrets directory/)
    await ctx.fiber.dispose()
    expect(new HomeAuthService(new Context(), Config({ secretsDirectory: '/home/someone/.delorun/secrets/home-auth' })).delorunHome).toBe('/home/someone/.delorun')
  })
})
