/**
 * C20's denial tests on the production path of the home process's secrets: the Host starts through `runHost` with the
 * home log attached, `HomeAuthService` mounts under that Host's root context and reads `ctx.deloSecrets` itself, and the
 * studio link is minted by `hostStudioLink`. Nothing here passes a sink to a store by hand, so each wiring line
 * (`runHost`'s preparation hook and its environment registration, the service's `secrets` option) is what these tests
 * fail without.
 */
import { Context } from '@deepseek-ai/cordis'
import type { BootedProfile } from '../../../../apps/cli/src/start.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_LIMITS, type StudioAddress } from '@delo/contract-admission'
import type { Base64Url } from '@delo/contract-device-approval'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostStudioLink } from '../../../../apps/cli/src/open/host-link.ts'
import { runHost } from '../../../../apps/cli/src/start.ts'
import type { HomeAuth } from '../../../home-auth/src/home-auth.ts'
import { matchCode, formatMatchCode } from '../../../home-auth/src/match-code.ts'
import { deviceIdOf } from '../../../home-auth/src/records.ts'
import { HomeAuthService } from '../../../home-auth/src/service.ts'
import { claimOf, keyOf } from '../../../home-auth/tests/fixtures/home.ts'
import { openHomeLog, type HomeLog } from '../../../home-process/src/index.ts'
import { newStartId } from '@delo/home'
import { encodings, logTexts, tempHome, type TempHome } from '../support.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
const LINK_TOKEN = 'delo-canary-launch-token-abcdef0123'
const ENV_KEY = 'delo-canary-dotenv-model-key-4242'

let context: Context | undefined
let temp: TempHome | undefined
let homeLog: HomeLog | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  homeLog?.log.close()
  homeLog = undefined
  temp?.remove()
  temp = undefined
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** What a mounted production path gives a spec. */
interface Mounted {
  readonly ctx: Context
  readonly home: string
  readonly log: HomeLog
  readonly core: HomeAuth
  readonly service: HomeAuthService
}

/**
 * Start the Host the way the home process does, and mount home-auth under its root context.
 * @returns the mounted path.
 */
async function mountProduction(): Promise<Mounted> {
  temp = tempHome()
  const log = homeLog = openHomeLog({ home: temp.home, profile: 'default', startId: newStartId(), level: 'debug', onFailure: () => {} })
  vi.stubEnv('OPENAI_API_KEY', ENV_KEY)
  let root: Context | undefined
  await runHost({
    loadEnvironment: () => ({ get: () => undefined, getFrom: () => undefined }),
    runProfile: (options) => {
      root = new Context()
      options.prepare?.(root)
      return Promise.resolve({} as BootedProfile)
    },
  }, log, { profile: 'default', resolvedProfile: {} as never, patchFiles: [], args: [] })
  if (root === undefined) throw new Error('the Host did not start')
  const ctx = context = root
  const server = {
    host: '127.0.0.1',
    port: 3080,
    protocol: 'http:',
    getOrigin: () => 'http://127.0.0.1:3080',
    register: () => () => undefined,
  }
  ctx.provide('webServer', server as never)
  ctx.provide('connection', { authenticatedUrl: (url: string) => `${url}?token=${LINK_TOKEN}`, oneTimeLaunchTokens: false, closeReachConnections: () => 0 } as never)
  await ctx.plugin(HomeAuthService, { secretsDirectory: join(temp.home, 'secrets', 'home-auth') })
  const service = ctx.get('homeAuth')
  if (service === undefined) throw new Error('home-auth did not mount')
  const core: HomeAuth = Reflect.get(service, 'core')
  return { ctx, home: temp.home, log, core, service }
}

describe('log-canary-every-surface: the production path of the home process', () => {
  it('redacts every secret kind the Host\'s own plugins mint, end to end', async () => {
    const started = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(started)
    const { ctx, home, log, core, service } = await mountProduction()
    const planted = new Map<string, string[]>()
    const note = (name: string, ...values: string[]): void => { planted.set(name, values) }

    // The environment, launch variables included, registered by `runHost`.
    note('environment key', ENV_KEY)

    // The studio link's launch token, registered by `hostStudioLink`.
    const link = hostStudioLink(ctx, undefined)
    expect(link.kind).toBe('link')
    note('launch token', LINK_TOKEN)

    // The owner code, a session token and its rolled successor, minted by the mounted service's stores.
    service.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', elevationMinutes: 20 })
    const issued = await service.issueOwnerCode()
    note('owner code', issued.code)
    await service.claim(claimOf(issued.code, { address: ADDRESS }))
    const opened = await service.openSession({ deviceId: deviceIdOf(keyOf(1)), listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: SESSION_LIMITS.reach.absoluteMs })
    note('session token', opened.token)
    // An idle session ends after 12 hours, so each step keeps it in use until the day after which it rolls.
    const step = 11 * 60 * 60 * 1000
    for (let at = step; at < SESSION_LIMITS.reach.rollAfterMs; at += step) {
      vi.setSystemTime(started + at)
      expect(core.admitToken(opened.token, LISTENER).kind).toBe('admitted')
    }
    vi.setSystemTime(started + SESSION_LIMITS.reach.rollAfterMs + 1000)
    const admitted = core.admitToken(opened.token, LISTENER, { roll: true })
    if (admitted.kind !== 'admitted' || admitted.rolled === undefined) throw new Error('the session did not roll')
    note('rolled session token', admitted.rolled.token)

    // An elevation request's 8-digit code in each spelling.
    const elevation = service.requestElevation(admitted.sessionId, admitted.session)
    if (elevation.kind !== 'pending') throw new Error('no elevation request is waiting')
    note('elevation code', elevation.code, formatMatchCode(elevation.code), `${elevation.code.slice(0, 4)}-${elevation.code.slice(4)}`)

    // A pairing request's secret and match code.
    await service.openApprovalWindow()
    const phone = keyOf(2)
    const deviceNonce = brandString<Base64Url>(Buffer.alloc(16, 2).toString('base64url'))
    const accepted = await core.requestApproval({ devicePublicKey: phone, deviceId: deviceIdOf(phone), deviceNonce, label: 'Phone', platform: 'iOS' }, { listener: LISTENER, source: '127.0.0.1' })
    const code = matchCode({ homePublicKey: Buffer.from(accepted.homePublicKey, 'base64url'), deviceId: deviceIdOf(phone), homeNonce: accepted.homeNonce, deviceNonce, address: ADDRESS })
    note('pairing secret', accepted.requestSecret)
    note('pairing code', code, formatMatchCode(code), `${code.slice(0, 4)}-${code.slice(4)}`)

    // The home key body, loaded when the service started.
    const pem = readFileSync(join(home, 'secrets', 'home-auth', 'home-key.pem'), 'utf8')
    note('home key', ...pem.split('\n').filter(line => line !== '' && !line.startsWith('-----')))

    for (const [name, values] of planted) {
      for (const value of values) {
        for (const form of encodings(value)) expect(log.redactor.text(`x ${form} y`), `${name}: ${form}`).not.toContain(form)
      }
    }
    const all = [...planted.values()].flat()
    for (const value of all) for (const form of encodings(value)) log.logger.info(`loaded ${form}`, { data: { note: form } })
    log.log.close()
    for (const { path, text } of logTexts(home)) {
      for (const value of all) for (const form of encodings(value)) expect(text.includes(form), `${form} in ${path}`).toBe(false)
    }
  })
})
