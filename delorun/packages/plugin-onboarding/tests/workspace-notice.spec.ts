/**
 * The route that tells the studio which workspace records the registry set aside: it is mounted by onboarding only while
 * the workspace registry is present, serves file names and never paths, and answers every approved device.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, Config, inject, MAX_SET_ASIDE, name, WORKSPACE_NOTICE_PATH, WorkspaceNoticeAnswer } from '../src/index.ts'

/** A registry that holds the given quarantined files. */
const registryFake = (quarantined: readonly string[] = []) => ({ quarantined })

/** Onboarding over a stub Connection and, unless `null`, a registry. */
async function mount(registry: ReturnType<typeof registryFake> | null) {
  const ctx = new Context()
  const routes = new Map<string, { readonly methods: readonly string[]; readonly requestBody: string; readonly fetch: (request: Request) => Promise<Response>; readonly admitPeer?: (request: Request, peer: object) => boolean }>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; methods: readonly string[]; requestBody: string; fetch: (request: Request) => Promise<Response>; admitPeer?: (request: Request, peer: object) => boolean }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  } as never)
  ctx.provide('settings', { configure: () => () => {} } as never)
  if (registry !== null) ctx.provide('workspaceRegistry', registry as never)
  vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const fiber = ctx.plugin({ name, inject: [...inject], Config, apply })
  await fiber.await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return routes
}

describe('the workspace notice route', () => {
  const get = async (registry: ReturnType<typeof registryFake>) => {
    const route = (await mount(registry)).get(WORKSPACE_NOTICE_PATH)
    return { route, response: await route?.fetch(new Request('http://harness.test/api')) }
  }

  it('is one exact GET route, present only while the workspace registry is', async () => {
    expect(WORKSPACE_NOTICE_PATH).toBe('/api/delorunOnboarding.workspaceNotice')
    const { route } = await get(registryFake())
    expect([route?.methods, route?.requestBody]).toEqual([['GET'], 'buffered'])
    expect((await mount(null)).has(WORKSPACE_NOTICE_PATH)).toBe(false)
  })

  it('exposes the quarantine by file name, not path, oldest first', async () => {
    const { response } = await get(registryFake(['/home/p/.delorun/workspaces.json.quarantined-1.json', '/home/p/.delorun/workspaces.json.quarantined-2.json']))
    expect([response?.status, response?.headers.get('cache-control')]).toEqual([200, 'no-store'])
    expect(WorkspaceNoticeAnswer.parse(await response?.json())).toEqual({ setAside: ['workspaces.json.quarantined-1.json', 'workspaces.json.quarantined-2.json'] })
  })

  it('answers an empty list when nothing was set aside', async () => {
    const { response } = await get(registryFake())
    expect(await response?.json()).toEqual({ setAside: [] })
  })

  it('lists only the newest files beyond the most it keeps', async () => {
    const files = Array.from({ length: MAX_SET_ASIDE + 2 }, (_, index) => `/h/w.quarantined-${String(index)}.json`)
    const { response } = await get(registryFake(files))
    const { setAside } = WorkspaceNoticeAnswer.parse(await response?.json())
    expect([setAside.length, setAside[0], setAside.at(-1)]).toEqual([MAX_SET_ASIDE, 'w.quarantined-2.json', `w.quarantined-${String(MAX_SET_ASIDE + 1)}.json`])
  })

  it('admits an approved device, which the route needs no unlock for', async () => {
    const { route } = await get(registryFake())
    expect([route?.admitPeer?.(new Request('http://harness.test/api'), { principal: { kind: 'reach-device' } }), route?.admitPeer?.(new Request('http://harness.test/api'), { principal: { kind: 'sdk' } })]).toEqual([true, false])
  })
})
