/**
 * The plugin's registration of the studio's Changes routes: registered once the web server and Connection are present,
 * removed with the plugin, and named to upstream's boot page through the index, whatever the C16 switch says; their
 * profile is the one the Host runs and their reload the Host's own hot reload.
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import * as plugin from '../src/index.ts'
import { ACTION_PATHS, CHANGES_ROUTE_PREFIX, SHOW_PATH, STATE_PATH, type ChangesRoute } from '../src/routes.ts'

it('registers the Changes routes with the web server and names them to the boot page, and removes them with the plugin', async () => {
  for (const enabled of [false, true]) {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('tools', { guard: () => () => {} } as never)
    const registered: ChangesRoute[] = []
    const removed: string[] = []
    ctx.provide('webServer', {
      register: (route: ChangesRoute) => {
        registered.push(route)
        return () => { removed.push(route.path) }
      },
    } as never)
    ctx.provide('connection', { admit: () => ({ rejection: 401 }), isReachPeer: () => false } as never)
    const fiber = await ctx.plugin(plugin, { enabled, installationBundles: [] })
    const paths = [STATE_PATH, SHOW_PATH, ...Object.values(ACTION_PATHS)]
    expect(registered.map(route => [route.kind, route.path])).toEqual(paths.map(path => ['exact', path]))
    const table: { kind: string, name?: string, value?: unknown }[] = []
    ctx.emit('webserver/index-inject', table as never, {} as never)
    expect(table).toEqual([{ kind: 'global', name: plugin.RECOVERY_ROUTES_GLOBAL, value: CHANGES_ROUTE_PREFIX }])
    await fiber.dispose()
    expect(removed).toEqual(paths)
  }
})

it('gives the routes the profile the Host runs and its hot reload', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('tools', { guard: () => () => {} } as never)
  const handlers = new Map<string, ChangesRoute['handler']>()
  ctx.provide('webServer', { port: 3080, register: (route: ChangesRoute) => { handlers.set(route.path, route.handler); return () => {} } } as never)
  ctx.provide('connection', { admit: () => ({ peer: {} }), isReachPeer: () => false } as never)
  ctx.provide('hmr', { runExclusive: <T>(operation: () => Promise<T>) => operation(), reconcileProfile: () => Promise.resolve({}) } as never)
  await ctx.plugin(plugin, { enabled: false, installationBundles: [] })
  // Without a profile the state route says so; with one, it reads that profile.
  const answer = async (): Promise<{ status: number, body: Record<string, unknown> }> => {
    let status = 0
    let text = ''
    await handlers.get(STATE_PATH)!({ method: 'GET', url: STATE_PATH, headers: { host: '127.0.0.1:3080' }, socket: { localAddress: '127.0.0.1', localPort: 3080 } } as never, {
      writeHead: (code: number) => { status = code },
      end: (body: string) => { text = body },
    } as never)
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  expect(await answer()).toMatchObject({ status: 503, body: { code: 'NO_PROFILE' } })
  ctx.provide('profileContext', { name: 'default', dir: '/nonexistent/profiles/default', home: '/nonexistent' } as never)
  expect(await answer()).toMatchObject({ status: 200, body: { profile: 'default', atComputer: true } })
})

it('registers no Changes route when Connection cannot name a remote session', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('tools', { guard: () => () => {} } as never)
  const registered: ChangesRoute[] = []
  ctx.provide('webServer', { register: (route: ChangesRoute) => { registered.push(route); return () => {} } } as never)
  // Without `isReachPeer` every admitted session would read as the person at their computer.
  ctx.provide('connection', { admit: () => ({ peer: {} }) } as never)
  await ctx.plugin(plugin, { enabled: false, installationBundles: [] })
  expect(registered).toEqual([])
  expect(() => plugin.routeConnection({ admit: () => ({ peer: {} }) } as never)).toThrow(/cannot tell a remote session/)
})
