/**
 * `studio.open-token` (contract C19; contract C4, "Loopback sessions"): only the person's start token mints a studio
 * sign-in link; the token the Host's own requests carry is accepted for every other operation and refused for this
 * one, a caller without the start token is refused, a forwarded port reaches the Host only within 1 to 65535, and
 * neither the link nor its token reaches the home log.
 */
import { readFileSync } from 'node:fs'
import { newStartId, readStartTokenFile, startTokenFile } from '@delo/home'
import { resolveSurface } from '@delo/logs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StartToken } from '@delo/contract-home-layout'
import { afterEach, describe, expect, it } from 'vitest'
import { exchangeLines, openHomeLog, sendHomeRequest, updateSocketPath, type ResponseLine } from '../src/index.ts'
import { ChannelTokenCheck, studioOpenToken } from '../src/studio-link.ts'
import { FixtureStore, installFixture, killLockHolder, PROFILE, startHome, tempHome, V1, type InProcessHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
const homes: InProcessHome[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) {
    await home.process.shutdown(0)
    home.exit()
  }
  if (temp !== undefined) await killLockHolder(temp.home)
  temp?.remove()
  temp = undefined
})

async function running(options: Parameters<typeof startHome>[1] = {}): Promise<{ readonly home: string, readonly started: InProcessHome }> {
  temp = await tempHome()
  installFixture(temp.home, V1)
  await FixtureStore.seed(temp.home, V1)
  const started = await startHome(temp.home, options)
  homes.push(started)
  return { home: temp.home, started }
}

const TIMEOUT = { timeout: 60_000 }

describe('studio-open-token-person-only', TIMEOUT, () => {
  it('mints a fresh link for the start token from the token file', async () => {
    const { home } = await running()
    const first = await sendHomeRequest(home, PROFILE, { op: 'studio.open-token' })
    const second = await sendHomeRequest(home, PROFILE, { op: 'studio.open-token' })
    expect(first).toEqual([{ ok: true, url: 'http://127.0.0.1:1/?token=fixture-link-1', oneTime: true }])
    expect(second).toEqual([{ ok: true, url: 'http://127.0.0.1:1/?token=fixture-link-2', oneTime: true }])
  })

  it('passes a forwarded loopback port to the Host, and refuses a port outside 1 to 65535', async () => {
    const { home, started } = await running()
    expect(await sendHomeRequest(home, PROFILE, { op: 'studio.open-token', args: { port: 4000 } })).toEqual([{ ok: true, url: 'http://127.0.0.1:4000/?token=fixture-link-1', oneTime: true }])
    for (const port of [0, 65_536, 1.5]) {
      const [line] = await sendHomeRequest(home, PROFILE, { op: 'studio.open-token', args: { port } })
      expect(line).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    }
    expect(started.hosts.latest.linkPorts).toEqual([4000])
  })

  it('refuses the Host\'s channel token, which every other operation accepts', async () => {
    const { started } = await running()
    const access = started.hosts.latest.access
    expect(await access.send({ op: 'status' })).toEqual([expect.objectContaining({ ok: true, status: expect.objectContaining({ state: 'running' }) as object })])
    expect(await access.send({ op: 'studio.open-token' })).toEqual([{ ok: false, error: 'UNAUTHENTICATED' }])
    expect(started.hosts.latest.links).toBe(0)
  })

  it('refuses a caller without the start token, and a request with arguments', async () => {
    const { home, started } = await running()
    const socket = updateSocketPath(home, PROFILE)
    for (const token of [undefined, 'x'.repeat(43), 42]) {
      expect(await exchangeLines(socket, JSON.stringify({ v: 1, token, op: 'studio.open-token' }))).toEqual([{ ok: false, error: 'UNAUTHENTICATED' }])
    }
    const token = await readStartTokenFile(startTokenFile(home, PROFILE))
    const [line] = await exchangeLines(socket, JSON.stringify({ v: 1, token, op: 'studio.open-token', args: { host: 'elsewhere.example' } }))
    expect(line).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    expect(started.hosts.latest.links).toBe(0)
  })

  it('writes neither the link nor its token to the home log', async () => {
    temp = await tempHome()
    installFixture(temp.home, V1)
    await FixtureStore.seed(temp.home, V1)
    const startId = newStartId()
    const opened = openHomeLog({ home: temp.home, profile: PROFILE, startId, level: 'debug', onFailure: () => {} })
    try {
      const started = await startHome(temp.home, { logger: opened.logger, log: { redactor: opened.redactor, startId } })
      homes.push(started)
      const [line] = await sendHomeRequest(temp.home, PROFILE, { op: 'studio.open-token' }) as [ResponseLine & { readonly url: string }]
      await started.hosts.latest.access.send({ op: 'studio.open-token' })
      await started.process.shutdown(0)
      const text = readFileSync(resolveSurface({ kind: 'home', home: temp.home, profile: PROFILE }).file, 'utf8')
      const messages = text.split('\n').filter(line => line !== '').map(line => (JSON.parse(line) as { readonly msg: string }).msg)
      expect(messages).toEqual(expect.arrayContaining(['request {"op":"studio.open-token","outcome":"ok"}', 'request {"op":"studio.open-token","outcome":"UNAUTHENTICATED","detail":""}']))
      expect(text.includes(new URL(line.url).searchParams.get('token') ?? 'missing')).toBe(false)
    } finally {
      opened.log.close()
    }
  })
})

describe('studioOpenToken', () => {
  const start = brandString<StartToken>('s'.repeat(43))
  const host = brandString<StartToken>('h'.repeat(43))

  it('answers STUDIO_UNAVAILABLE without a Host or a studio, and checks both tokens', () => {
    const check = new ChannelTokenCheck(start, host)
    expect(check.accepts(start)).toBe(true)
    expect(check.accepts(host)).toBe(true)
    expect(check.accepts('other')).toBe(false)
    expect(check.acceptsStart(host)).toBe(false)
    const request = { v: 1, token: start, op: 'studio.open-token' } as const
    expect(() => studioOpenToken(request, check, undefined)).toThrow(/STUDIO_UNAVAILABLE/)
    const withoutStudio = { studioLink: () => ({ kind: 'unavailable', reason: 'the Host serves no studio' }) }
    expect(() => studioOpenToken(request, check, withoutStudio as never)).toThrow('STUDIO_UNAVAILABLE: the Host serves no studio')
  })
})
