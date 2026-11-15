/**
 * Denial test for the release check's switch: the real `delorun-update-check` row registers its switch with the real
 * `HomeAuthService`, whose registry the reach policy reads, and upstream's real remote access service decides a
 * device's `settings/*` writes. A signed-in device, locked, unlocked by an elevation or unlocked by a PIN page, cannot
 * turn `delorun-update-check.enabled` off through any settings write; the home's own computer (the owner) can.
 */
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access/types'
import { createReachAccessPolicy, reachDevicePrincipal, REACH_DEVICE } from '../../src/reach-access.ts'
import { HomeAuthService } from '../../src/service.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as UpdateCheck from '../../../bundle-local/src/update-check.ts'
import { UPDATE_CHECK_DEFAULTS } from '../../../bundle-local/src/update-check.ts'

const NS = 'delorun-update-check'
const LISTENER = 'reach-tailscale-private'
const ELEVATION = { id: 'elevation-1' }

let context: Context | undefined
let home = ''
let accessContext: Context | undefined
afterEach(async () => {
  rmSync(home, { recursive: true, force: true })
  await context?.fiber.dispose()
  await accessContext?.fiber.dispose()
  context = undefined
})

/**
 * Mount the row over the real home-auth registry and decide a settings write for a principal.
 * @param withRow - whether the update-check row mounts; false shows the policy without its registration.
 * @returns a function deciding one write for a device or the owner.
 */
async function mounted(withRow: boolean) {
  home = mkdtempSync(join(tmpdir(), 'update-check-switch-'))
  const ctx = context = new Context()
  ctx.provide('webServer', { host: '127.0.0.1', port: 3080, protocol: 'http:', getOrigin: () => 'http://127.0.0.1:3080', register: () => () => undefined } as never)
  ctx.provide('connection', { authenticatedUrl: (url: string) => url, oneTimeLaunchTokens: false, closeReachConnections: () => 0, fetch: { register: () => () => undefined } } as never)
  await ctx.plugin(HomeAuthService, { secretsDirectory: join(home, 'secrets', 'home-auth') }).await()
  if (withRow) await ctx.plugin(UpdateCheck, { ...UPDATE_CHECK_DEFAULTS, enabled: false }).await()
  const homeAuth = ctx.get('homeAuth')
  if (homeAuth === undefined) throw new Error('home-auth did not mount')
  // A second context holds the remote access service, so the home's own policy (which admits only live Peers) does not register.
  const access = new Context()
  await access.plugin(RemoteAccessService)
  accessContext = access
  access.remoteAccess.registerPolicy(REACH_DEVICE, createReachAccessPolicy({
    admitted: () => true, workspaces: () => [], liveSessions: () => [], workspaceRootOf: () => undefined, delorunHome: '/nowhere',
    elevationOf: () => ELEVATION as never, pageUnlockOf: () => ({}) as never, logElevated: () => {},
    liftedSettings: () => undefined, pinLiftedSettings: () => undefined,
    computerOnlySwitches: () => homeAuth.computerOnlySwitches(),
    protectedEntryIds: () => new Set(), defaultPermission: () => undefined, dangerousMode: () => false,
  }))
  return (principal: Parameters<RemoteAccessService['decide']>[0]['principal'], action: RemoteAccessAction, args: Record<string, unknown>) =>
    access.remoteAccess.decide({ principal, action, resources: [{ kind: 'global' }], args })
}

const WRITES: [RemoteAccessAction, Record<string, unknown>][] = [
  ['settings/mutate', { ns: NS, ops: [{ op: 'set', path: ['enabled'], value: false }] }],
  ['settings/mutate', { ns: NS, ops: [{ op: 'unset', path: ['enabled'] }] }],
  ['settings/update', { ns: NS, patch: { enabled: false } }],
  ['settings/replace', { ns: NS, section: { enabled: false } }],
]

describe('who may turn the release check off', () => {
  it('refuses an approved device a write that turns it off, whatever the unlock facts say (the facts always report an elevation and a PIN page), and lets the computer do it', async () => {
    const decide = await mounted(true)
    const principals = [reachDevicePrincipal('device-1', LISTENER), reachDevicePrincipal('device-1', LISTENER, 'unlock-1')]
    for (const principal of principals) {
      for (const [action, args] of WRITES) {
        expect({ action, args, decision: decide(principal, action, args) })
          .toEqual({ action, args, decision: { kind: 'deny', reason: 'loopback-required: turning the release check off' } })
      }
    }
    for (const [action, args] of WRITES) expect(decide({ kind: 'owner' }, action, args)).toEqual({ kind: 'allow' })
  })

  it('still lets a device keep the check on', async () => {
    const decide = await mounted(true)
    const device = reachDevicePrincipal('device-1', LISTENER)
    expect(decide(device, 'settings/update', { ns: NS, patch: { enabled: true } })).toEqual({ kind: 'allow' })
  })
})
