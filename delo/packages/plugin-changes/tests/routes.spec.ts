/**
 * The studio's Changes routes over a real HTTP server, without a profile history: a caller without the studio's
 * credential, a remote session and another site are refused before anything is read, the body included; no route
 * changes the protection setting; and every malformed request is refused with its own code.
 *
 * Each test's comment names the check whose removal makes it fail, so the suite is also the mutation record.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attestStudio, protectionPath, readProtection, setProtection, writeChangeLog } from '@delo/changes'
import { describe, expect, it, vi } from 'vitest'
import { ACTION_PATHS, arrivalOf, changesRoutes, LOOPBACK_REQUIRED_SENTENCE, MAX_BODY_BYTES, SHOW_PATH, STATE_PATH, type ChangesAction } from '../src/routes.ts'
import { CREDENTIAL, get, json, post, routeHome, send, serveRoutes } from './routes-fixture.ts'

// Each case starts a server on a loopback port and writes a temporary home; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

/** Every action route. */
const ACTIONS = Object.keys(ACTION_PATHS) as ChangesAction[]

/** Every route with the method it answers. */
const ROUTES: readonly { readonly path: string, readonly method: string }[] = [
  { path: STATE_PATH, method: 'GET' },
  { path: `${SHOW_PATH}?id=c0123456789`, method: 'GET' },
  ...ACTIONS.map(action => ({ path: ACTION_PATHS[action], method: 'POST' })),
]

describe('who reaches the Changes routes', () => {
  it('an HTTP caller without the studio\'s credential cannot reach any Changes route', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    for (const { path, method } of ROUTES) {
      // Pins `connection.admit` running first: without it a caller with no cookie reads the state or acts.
      const anonymous = await send(server.port, path, { method, body: { id: 'c0123456789', plugin: 'plug' }, unfinished: 5 })
      expect(anonymous.status, path).toBe(401)
      expect(json(anonymous)).toMatchObject({ code: 'NOT_SIGNED_IN' })
      const fenced = await send(server.port, path, { method, headers: ['x-test-fence: refuse', CREDENTIAL], body: {}, unfinished: 5 })
      expect(fenced.status, path).toBe(403)
      expect(json(fenced)).toMatchObject({ code: 'FORBIDDEN' })
    }
    expect(server.profileReads()).toBe(0)
    expect((await get(server.port, STATE_PATH)).status).toBe(200)
  })

  it('a remote session cannot use the recovery actions', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const remote = [
      // A reach listener stamped the request.
      { headers: [CREDENTIAL, 'x-test-listener: reach-tailscale-private'] },
      // A reach dispatcher admitted the session, whatever the Host says.
      { headers: [CREDENTIAL, 'x-test-remote: 1'] },
      // The request names another address than the loopback listener's.
      { headers: [CREDENTIAL], host: 'studio.example.ts.net' },
      { headers: [CREDENTIAL], host: 'localhost@evil.example' },
    ]
    for (const action of ACTIONS) {
      for (const request of remote) {
        // Pins `attestStudio` before the body: without it a remote session turns plugins off or starts safe mode.
        const reply = await send(server.port, ACTION_PATHS[action], { method: 'POST', ...request, body: { plugin: 'plug' }, unfinished: 5 })
        expect(reply.status, `${action} ${JSON.stringify(request)}`).toBe(403)
        expect(json(reply)).toEqual({ code: 'LOOPBACK_REQUIRED', message: LOOPBACK_REQUIRED_SENTENCE })
      }
    }
    expect(server.profileReads()).toBe(0)
    expect(server.reloads()).toBe(0)
    // A remote session still reads, and the state says it is not at the computer.
    const read = await send(server.port, STATE_PATH, { headers: [CREDENTIAL, 'x-test-remote: 1'] })
    expect(read.status).toBe(200)
    expect(json(read)).toMatchObject({ atComputer: false })
    expect(json(await get(server.port, STATE_PATH))).toMatchObject({ atComputer: true })
  })

  it('a cross-site request is refused before its body is read', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const port = String(server.port)
    for (const headers of [['Sec-Fetch-Site: cross-site'], ['Sec-Fetch-Site: same-site'], ['Origin: http://evil.example'], ['Origin: null'], [`Origin: https://127.0.0.1:${port}`]]) {
      // Pins the site check: without it a page the person visits posts the action with the studio's cookie.
      const reply = await send(server.port, ACTION_PATHS['safe-mode'], { method: 'POST', headers: [CREDENTIAL, ...headers], body: {}, unfinished: 5 })
      expect(reply.status, headers.join()).toBe(403)
      expect(json(reply)).toMatchObject({ code: 'CROSS_SITE' })
    }
    expect(server.profileReads()).toBe(0)
    // The studio's own page, and a program that sends neither header, reach the action.
    for (const headers of [[`Origin: http://127.0.0.1:${port}`, 'Sec-Fetch-Site: same-origin'], ['Sec-Fetch-Site: none'], []]) {
      const reply = await send(server.port, ACTION_PATHS['safe-mode'], { method: 'POST', headers: [CREDENTIAL, ...headers], body: {} })
      expect(json(reply), headers.join()).toMatchObject({ code: 'SAFE_MODE_UNAVAILABLE' })
    }
  })

  it('the studio cannot change the protection setting', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    // No route names the protection setting, and the studio's proof is refused by the setting's writer.
    const paths = changesRoutes({ connection: { admit: () => ({ rejection: 401 }) }, profile: () => undefined, reload: () => Promise.resolve(undefined), installationBundles: [], logger: { warn: () => {} } }).map(route => route.path)
    expect(paths.filter(path => path.includes('protection'))).toEqual([])
    expect((await post(server.port, '/delo/changes/protection', { level: 'off' })).status).toBe(404)
    await expect(setProtection(ctx.home, 'off', attestStudio({ loopback: true, credential: true, remoteSession: false }))).rejects.toMatchObject({ code: 'NOT_AT_COMPUTER' })
    expect(await readProtection(ctx.home)).toBe('block')
  })

  it('decides the arrival from the listener, the Host and the admission', () => {
    const request = (host: string | undefined) => ({ headers: host === undefined ? {} : { host } }) as never
    expect(arrivalOf(request('127.0.0.1:3080'), true, false)).toEqual({ loopback: true, credential: true, remoteSession: false })
    expect(arrivalOf(request('[::1]:3080'), true, true)).toEqual({ loopback: true, credential: true, remoteSession: true })
    expect(arrivalOf(request(undefined), true, false)).toEqual({ loopback: false, credential: true, remoteSession: true })
  })
})

describe('what a route refuses', () => {
  it('answers a Host that runs no profile, a wrong method and a rolled credential', async () => {
    const server = await serveRoutes(undefined)
    expect(json(await get(server.port, STATE_PATH))).toMatchObject({ code: 'NO_PROFILE' })
    expect((await post(server.port, ACTION_PATHS.off, { plugin: 'plug' })).status).toBe(503)
    expect(json(await send(server.port, STATE_PATH, { method: 'POST', headers: [CREDENTIAL], body: {} }))).toMatchObject({ code: 'METHOD_NOT_ALLOWED' })
    expect((await get(server.port, ACTION_PATHS.off)).status).toBe(405)
    const rolled = await send(server.port, STATE_PATH, { headers: [CREDENTIAL, 'x-test-roll: 1'] })
    expect(rolled.head).toContain('set-cookie: studio=rolled; httponly')
    expect(rolled.head).toContain('cache-control: no-store')
    expect(rolled.head).toContain('x-content-type-options: nosniff')
  })

  it('refuses a body that is not one small JSON object naming what the action takes', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const cases: readonly [ChangesAction, unknown, number, string][] = [
      ['off', 'x'.repeat(MAX_BODY_BYTES + 1), 413, 'BODY_TOO_LARGE'],
      ['off', '{ not json', 400, 'BAD_REQUEST'],
      ['off', '[1]', 400, 'BAD_REQUEST'],
      ['off', 'null', 400, 'BAD_REQUEST'],
      ['off', {}, 400, 'BAD_REQUEST'],
      ['off', { plugin: '../escape' }, 400, 'BAD_REQUEST'],
      ['on', { plugin: 'plug', extra: true }, 400, 'BAD_REQUEST'],
      ['apply', { id: 'not-an-id' }, 400, 'BAD_REQUEST'],
      ['apply', { id: 7 }, 400, 'BAD_REQUEST'],
      ['apply', { id: 'c0123456789', confirmedRisk: 'yes' }, 400, 'BAD_REQUEST'],
      ['undo', { id: 'c0123456789', confirmedRisk: 1 }, 400, 'BAD_REQUEST'],
      ['work', { plugin: 'plug', minutes: 0 }, 400, 'BAD_REQUEST'],
      ['work', { plugin: 'plug', minutes: 481 }, 400, 'BAD_REQUEST'],
      ['work', { plugin: 'plug', minutes: 1.5 }, 400, 'BAD_REQUEST'],
      ['work', { plugin: 'plug', minutes: '5' }, 400, 'BAD_REQUEST'],
      ['done', { plugin: 'plug' }, 400, 'BAD_REQUEST'],
      ['done', { plugin: 'plug', version: 'abc' }, 400, 'BAD_REQUEST'],
      ['safe-mode', { reason: 'x' }, 400, 'BAD_REQUEST'],
    ]
    for (const [action, body, status, code] of cases) {
      const reply = await post(server.port, ACTION_PATHS[action], body)
      expect(reply.status, `${action} ${JSON.stringify(body).slice(0, 40)}`).toBe(status)
      expect(json(reply)).toMatchObject({ code })
    }
    expect(json(await post(server.port, ACTION_PATHS.off, ''))).toMatchObject({ code: 'BAD_REQUEST', message: 'Name the plugin by its package name.' })
    expect(server.reloads()).toBe(0)
  })

  it('refuses a show without exactly one well-formed query, and answers a refusal of Changes with its code', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    for (const query of ['', '?id=c0123456789&work=plug', '?other=1', '?id=nope', '?work=..%2Fescape']) {
      expect(json(await get(server.port, `${SHOW_PATH}${query}`)), query).toMatchObject({ code: 'BAD_REQUEST' })
    }
    const unknown = await get(server.port, `${SHOW_PATH}?id=c0123456789`)
    expect(unknown.status).toBe(404)
    expect(json(unknown)).toMatchObject({ code: 'UNKNOWN_CHANGE' })
    expect(json(await get(server.port, `${SHOW_PATH}?work=plug`))).toMatchObject({ code: 'NO_WORK_SESSION' })
    const undo = await post(server.port, ACTION_PATHS.undo, { id: 'c0123456789' })
    expect(undo.status).toBe(404)
    expect(json(await post(server.port, ACTION_PATHS.off, { plugin: 'plug' }))).toMatchObject({ code: 'NOT_ALLOWED' })
  })

  it('reports a failure that is neither a refusal of Changes nor of profile safety as INTERNAL, to the Host log', async () => {
    const server = await serveRoutes(undefined, { profile: () => { throw new Error('disk on fire') } })
    const reply = await post(server.port, ACTION_PATHS.off, { plugin: 'plug' })
    expect(reply.status).toBe(500)
    expect(json(reply)).toEqual({ code: 'INTERNAL', message: 'Delo could not answer; the Host log says why.' })
    expect(server.warnings).toEqual(['changes route failed: disk on fire'])
    const thrown = await serveRoutes(undefined, { profile: () => { throw 'not an error' as unknown as Error } })
    expect((await get(thrown.port, STATE_PATH)).status).toBe(500)
    expect(thrown.warnings).toEqual(['changes route failed: not an error'])
  })

  it('reads the state of an empty profile, and names each part it cannot read', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const state = json(await get(server.port, STATE_PATH))
    expect(state).toEqual({ atComputer: true, profile: 'default', protection: 'block', leftOut: [], pending: [], requests: [], recent: [], problems: [] })
    const broken = await serveRoutes({ ...ctx, home: `${ctx.home}/missing`, profileDir: `${ctx.profileDir}/missing` })
    const problems = json(await get(broken.port, STATE_PATH)).problems as string[]
    expect(problems.map(problem => problem.split(':')[0])).toEqual(['The changes waiting for review cannot be read'])
  })
})

describe('the recovery state from the records', () => {
  it('shows each record as the person reads it, and names each one it cannot read', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const at = '2026-11-10T10:00:00.000Z'
    await writeChangeLog(ctx.home, ctx.profile, {
      schema: 'delo.changes-log/1',
      entries: [
        { id: 'c0000000001' as never, kind: 'guard-weakening', state: 'applied', subject: { setting: 'protection' }, summary: 'Protection lowered from block to warn', createdAt: at, decidedAt: at, decidedFrom: 'terminal' },
        { id: 'c0000000002' as never, kind: 'plugin-off', state: 'applied', subject: { plugin: 'plug' }, summary: 'Turned off plug', createdAt: at, decidedAt: at, decidedFrom: 'studio' },
        { id: 'c0000000003' as never, kind: 'plugin-edit', state: 'pending', subject: { plugin: 'plug', source: '/elsewhere' }, summary: 'Edits plug', createdAt: at },
      ],
    })
    const run = join(ctx.home, 'run', ctx.profile)
    mkdirSync(run, { recursive: true, mode: 0o700 })
    writeFileSync(join(run, 'changes-boot.json'), JSON.stringify({ schema: 'delo.changes-boot/1', at, plugins: [{ plugin: 'plug', rows: [], loaded: true }] }), { mode: 0o600 })
    const state = json(await get(server.port, STATE_PATH))
    // Two changes decided at the same time list the later-logged one first; a pending one is not a recent change.
    expect(state.recent).toEqual([
      { id: 'c0000000002', kind: 'plugin-off', state: 'applied', summary: 'Turned off plug', plugin: 'plug', createdAt: at, decidedAt: at, decidedFrom: 'studio', undoable: true },
      { id: 'c0000000001', kind: 'guard-weakening', state: 'applied', summary: 'Protection lowered from block to warn', createdAt: at, decidedAt: at, decidedFrom: 'terminal', undoable: false },
    ])
    expect(state.lastStart).toEqual({ at, plugins: [{ plugin: 'plug', loaded: true }] })
    writeFileSync(protectionPath(ctx.home), 'not json', { mode: 0o600 })
    writeFileSync(join(ctx.home, 'changes', 'profiles', ctx.profile, 'log.json'), 'not json', { mode: 0o600 })
    const broken = json(await get(server.port, STATE_PATH))
    expect((broken.problems as string[]).map(problem => problem.split(' cannot be read')[0])).toEqual(['The change log', 'The protection setting', 'The changes waiting for review'])
    expect(broken).toMatchObject({ recent: [], leftOut: [] })
    expect(broken.protection).toBeUndefined()
  })
})
