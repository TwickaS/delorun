/**
 * Denial test for PIN mode on the home process's production path: the Host starts through `runHost` with the home log
 * attached, `HomeAuthService` reads `ctx.delorunSecrets` itself (the real registry, which refuses a value under 8
 * characters), and `delorun devices pin set` and the device unlock route run against it. A 6-digit PIN and a wrong guess
 * must be registered nowhere and appear in no log file, secrets file, output or response body, in any common encoding.
 */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_LIMITS, REACH_SESSION_COOKIE, type StudioAddress } from '@delorun/contract-admission'
import { newStartId } from '@delorun/home'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevicesCommand } from '../../../../apps/cli/src/devices/command.ts'
import { EXIT } from '../../../../apps/cli/src/exit.ts'
import type { CommandContext } from '../../../../apps/cli/src/command.ts'
import { runHost, type BootedProfile } from '../../../../apps/cli/src/start.ts'
import { stampListener } from '../../../home-auth/src/index.ts'
import { deviceIdOf } from '../../../home-auth/src/records.ts'
import { HomeAuthService } from '../../../home-auth/src/service.ts'
import { claimOf, keyOf } from '../../../home-auth/tests/fixtures/home.ts'
import { changePin, openHomeLog, type HomeLog, type PinApproval, type ResponseLine, type UnsignedRequest } from '../../../home-process/src/index.ts'
import { encodings, filesUnder, logTexts, tempHome, type TempHome } from '../support.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const LISTENER = 'reach-tailscale-private'
const PIN = '482193'
const WRONG = '582193'

let context: Context | undefined
let temp: TempHome | undefined
let homeLog: HomeLog | undefined
let server: Server | undefined
afterEach(async () => {
  server?.close()
  server = undefined
  await context?.fiber.dispose()
  context = undefined
  homeLog?.log.close()
  homeLog = undefined
  temp?.remove()
  temp = undefined
  vi.unstubAllEnvs()
})

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

describe('PIN mode on the production path of the home process', () => {
  it('registers and logs no 6-digit PIN or wrong guess, in any file, output or response', async () => {
    temp = tempHome()
    const { home } = temp
    const log = homeLog = openHomeLog({ home, profile: 'default', startId: newStartId(), level: 'debug', onFailure: () => {} })
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
    const handlers = new Map<string, Handler>()
    ctx.provide('webServer', {
      host: '127.0.0.1', port: 3080, protocol: 'http:', getOrigin: () => 'http://127.0.0.1:3080',
      register: (route: { path: string; handler: Handler }) => { handlers.set(route.path, route.handler); return () => undefined },
    } as never)
    ctx.provide('connection', { authenticatedUrl: (url: string) => url, oneTimeLaunchTokens: false, closeReachConnections: () => 0 } as never)
    await ctx.plugin(HomeAuthService, { secretsDirectory: join(home, 'secrets', 'home-auth') })
    const service = ctx.get('homeAuth')
    if (service === undefined) throw new Error('home-auth did not mount')

    // The CLI over the real service, answering as the home process does.
    const approval: PinApproval = service
    const out = { stdout: '', stderr: '' }
    const commandContext: CommandContext = { env: { ...process.env, DELORUN_HOME: home, HOME: home }, stdout: (t) => { out.stdout += t }, stderr: (t) => { out.stderr += t } }
    const responses: string[] = []
    const send = async (_home: string, _profile: string, request: UnsignedRequest): Promise<ResponseLine[]> => {
      let line: ResponseLine
      try {
        line = { ok: true, ...await changePin(request as never, 'person', approval) }
      } catch (error) {
        line = { ok: false, error: String((error as { code?: unknown }).code ?? 'ERROR'), message: String(error instanceof Error ? error.message : error) }
      }
      responses.push(JSON.stringify(line))
      return [line]
    }
    const pinCommand = (typed: string[], line?: string): ReturnType<typeof createDevicesCommand> => createDevicesCommand({
      running: () => true, send, ask: () => Promise.resolve(undefined), terminal: false,
      pin: { secret: () => Promise.resolve(typed.shift()), stdinLine: () => Promise.resolve(line), interactive: line === undefined, stdinIsTerminal: false, now: Date.now },
    })

    // A device with a live session, and a real HTTP server for the unlock route.
    service.serve({ listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', elevationMinutes: 20 })
    const issued = await service.issueOwnerCode()
    await service.claim(claimOf(issued.code, { address: ADDRESS }))
    const opened = await service.openSession({ deviceId: deviceIdOf(keyOf(1)), listener: LISTENER, address: ADDRESS, factor: 'tailnet-membership', lifetimeMs: SESSION_LIMITS.reach.absoluteMs })
    const unlock = handlers.get('/auth/pin/unlock')
    if (unlock === undefined) throw new Error('the unlock route is not registered')
    server = createServer((request, response) => { stampListener(request, LISTENER); void unlock(request, response) })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/auth/pin/unlock`
    const post = async (body: string): Promise<{ status: number; text: string }> => {
      const reply = await fetch(url, { method: 'POST', headers: { cookie: `${REACH_SESSION_COOKIE}=${opened.token}`, 'content-type': 'application/json' }, body })
      const text = await reply.text()
      responses.push(text)
      return { status: reply.status, text }
    }

    // The set succeeds, with the real registry refusing anything under 8 characters.
    await expect(pinCommand([PIN, PIN]).run(['pin', 'set'], commandContext)).resolves.toBe(EXIT.ok)
    expect(out.stdout).toContain('PIN mode is on, with a PIN.')
    // The unlocks: wrong, malformed, correct.
    const wrong = await post(JSON.stringify({ secret: WRONG }))
    expect(wrong.status).toBe(403)
    expect(wrong.text).toContain('PIN_INVALID')
    expect((await post(`{"secret": ${PIN}`)).status).toBe(400)
    expect((await post(JSON.stringify({ secret: Number(PIN) }))).status).toBe(400)
    const good = await post(JSON.stringify({ secret: PIN }))
    expect(good.status).toBe(200)
    // A re-set, and a bad input line made of the PIN's digits.
    await expect(pinCommand([PIN, PIN]).run(['pin', 'set'], commandContext)).resolves.toBe(EXIT.ok)
    await expect(pinCommand([], PIN.slice(0, 5)).run(['pin', 'set', '--stdin'], commandContext)).resolves.toBe(EXIT.failed)
    expect(out.stderr).not.toBe('')

    // Nothing was registered: the redactor leaves both values in text.
    for (const value of [PIN, WRONG]) expect(log.redactor.text(`x ${value} y`)).toBe(`x ${value} y`)

    ctx.logger.info('home-auth: pin wiring finished')
    log.log.close()
    const files = [...logTexts(home), ...filesUnder(join(home, 'secrets')).map(path => ({ path, text: readFileSync(path, 'utf8') }))]
    expect(files.some(file => file.path.includes(`${join(home, 'logs')}`))).toBe(true)
    const surfaces: { readonly name: string; readonly text: string }[] = [
      ...files.map(file => ({ name: file.path, text: file.text })),
      { name: 'stdout', text: out.stdout }, { name: 'stderr', text: out.stderr }, { name: 'responses', text: responses.join('\n') },
    ]
    for (const surface of surfaces) {
      for (const value of [PIN, WRONG]) for (const form of encodings(value)) expect(surface.text.includes(form), `${form} in ${surface.name}`).toBe(false)
    }
  }, 120_000)
})
