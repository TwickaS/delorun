/**
 * The agent models route: any approved device may ask (class `free`), only the computer or an approved device reaches it,
 * and one listing runs per agent at a time.
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { AGENT_MODELS_PATH } from '../src/wire.ts'
import { apply, Config, inject, name } from '../src/index.ts'

interface Route {
  readonly fetch: (request: Request) => Promise<Response>
  readonly admitPeer?: (request: Request, peer: object) => boolean
}

/** Onboarding over a stub Connection, a registry, a subagent provider and a `homeAuth` service on the given listener. */
async function mount(listModels: () => Promise<readonly { model: string; displayName: string }[]>, listener: string = 'loopback') {
  const ctx = new Context()
  const routes = new Map<string, Route>()
  ctx.provide('connection', {
    fetch: { register: (route: Route & { path: string }) => { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
  } as never)
  ctx.provide('settings', { configure: () => () => {} } as never)
  ctx.provide('workspaceRegistry', { quarantined: [] } as never)
  ctx.provide('subagents', { getProvider: () => ({ listModels }) } as never)
  ctx.provide('homeAuth', { arrivalOf: (request: { headers: { host?: string } }) => ({ listener, host: request.headers.host, source: 'test' }) } as never)
  vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  await ctx.plugin({ name, inject: [...inject], Config, apply }).await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await vi.waitFor(() => { expect(routes.has(AGENT_MODELS_PATH)).toBe(true) })
  return { ctx, route: routes.get(AGENT_MODELS_PATH)! }
}

const ask = (agent: string): Request => new Request(`http://harness.test${AGENT_MODELS_PATH}`, { method: 'POST', body: JSON.stringify({ agent }) })

describe('the agent models route', () => {
  it('admits an approved device with no unlock and refuses any other peer', async () => {
    const { route } = await mount(async () => [])
    expect([route.admitPeer?.(ask('codex'), { principal: { kind: 'reach-device' } }), route.admitPeer?.(ask('codex'), { principal: { kind: 'sdk' } })]).toEqual([true, false])
  })

  it('refuses a foreign Host on the loopback listener before the route, and passes the computer', async () => {
    const { ctx } = await mount(async () => [])
    const arrive = (host: string) => {
      const request = new IncomingMessage(new Socket())
      request.url = AGENT_MODELS_PATH
      request.headers.host = host
      const response = new ServerResponse(request)
      const writeHead = vi.spyOn(response, 'writeHead').mockReturnValue(response)
      vi.spyOn(response, 'end').mockReturnValue(response)
      return { request, response, writeHead }
    }
    const foreign = arrive('studio.example')
    const refused = vi.fn(async () => {})
    await ctx.waterfall('connection/request', foreign.request, foreign.response, refused)
    expect([refused.mock.calls.length, foreign.writeHead.mock.calls[0]?.[0]]).toEqual([0, 403])
    const local = arrive('localhost:3080')
    const passed = vi.fn(async () => {})
    await ctx.waterfall('connection/request', local.request, local.response, passed)
    expect([passed.mock.calls.length, local.writeHead.mock.calls.length]).toEqual([1, 0])
  })

  it('runs one listing per agent at a time: a call made meanwhile joins it, and a later call starts a new one', async () => {
    let finish: () => void = () => {}
    const listModels = vi.fn(() => new Promise<readonly { model: string; displayName: string }[]>((resolve) => { finish = () => { resolve([{ model: 'm', displayName: 'M' }]) } }))
    const { route } = await mount(listModels)
    const first = route.fetch(ask('codex'))
    const second = route.fetch(ask('codex'))
    await vi.waitFor(() => { expect(listModels).toHaveBeenCalledTimes(1) })
    finish()
    const answers = await Promise.all([first, second].map(async response => (await response).json()))
    expect(answers).toEqual([{ state: 'listed', models: [{ model: 'm', displayName: 'M' }] }, { state: 'listed', models: [{ model: 'm', displayName: 'M' }] }])
    expect(listModels).toHaveBeenCalledTimes(1)
    const third = route.fetch(ask('codex'))
    await vi.waitFor(() => { expect(listModels).toHaveBeenCalledTimes(2) })
    finish()
    await third
  })

  it('does not join a listing of another agent', async () => {
    const listModels = vi.fn(() => new Promise<readonly { model: string; displayName: string }[]>(() => {}))
    const { route } = await mount(listModels)
    void route.fetch(ask('codex'))
    void route.fetch(ask('claude-code'))
    await vi.waitFor(() => { expect(listModels).toHaveBeenCalledTimes(2) })
  })
})
