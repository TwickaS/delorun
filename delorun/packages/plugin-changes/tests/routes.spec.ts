/**
 * The studio's Changes routes over a real HTTP server, without a profile history: a caller without the studio's
 * credential, a remote session and another site are refused before anything is read, the body included; no route
 * changes the protection setting; and every malformed request is refused with its own code.
 *
 * Each test's comment names the check whose removal makes it fail, so the suite is also the mutation record.
 */
import { lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { attestStudio, harnessLogPath, protectionPath, readHarnessLog, readProtection, setProtection, writeChangeLog } from '@delorun/changes'
import { describe, expect, it, vi } from 'vitest'
import { ACTION_PATHS, arrivalOf, changesRoutes, HOME_IN_ANSWERS, HOME_WITHHELD_SENTENCE, LOOPBACK_REQUIRED_SENTENCE, MAX_BODY_BYTES, SHOW_PATH, STATE_PATH, type ChangesAction } from '../src/routes.ts'
import { CREDENTIAL, get, json, logHarnessChanges, post, routeHome, RUNTIME, send, serveRoutes } from './routes-fixture.ts'

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
      const anonymous = await send(server.port, path, { method, body: { id: 'c0123456789', plugin: 'plug' }, withholdBody: true })
      expect(anonymous.status, path).toBe(401)
      expect(json(anonymous)).toMatchObject({ code: 'NOT_SIGNED_IN' })
      const fenced = await send(server.port, path, { method, headers: ['x-test-fence: refuse', CREDENTIAL], body: {}, withholdBody: true })
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
        const reply = await send(server.port, ACTION_PATHS[action], { method: 'POST', ...request, body: { plugin: 'plug' }, withholdBody: true })
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
      const reply = await send(server.port, ACTION_PATHS['safe-mode'], { method: 'POST', headers: [CREDENTIAL, ...headers], body: {}, withholdBody: true })
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
    const paths = changesRoutes({ connection: { admit: () => ({ rejection: 401 }), isReachPeer: () => false }, profile: () => undefined, reload: () => Promise.resolve(undefined), pluginOperation: () => () => Promise.resolve({ exitCode: 0 }), installationBundles: [], logger: { warn: () => {} }, loopbackPort: () => undefined, scaffold: () => { throw new Error('unused') }, workspaces: () => [], reveal: () => {} }).map(route => route.path)
    expect(paths.filter(path => path.includes('protection'))).toEqual([])
    expect((await post(server.port, '/delorun/changes/protection', { level: 'off' })).status).toBe(404)
    await expect(setProtection(ctx.home, 'on', attestStudio({ loopback: true, credential: true, remoteSession: false }))).rejects.toMatchObject({ code: 'NOT_AT_COMPUTER' })
    expect(await readProtection(ctx.home)).toBe('off')
  })

  it('decides the arrival from the listener, the Host and the admission', () => {
    const request = (host: string | undefined, localPort = 3080) => ({ headers: host === undefined ? {} : { host }, socket: { localAddress: '127.0.0.1', localPort } }) as never
    const port = (): number => 3080
    expect(arrivalOf(request('127.0.0.1:3080'), port, true, false)).toEqual({ loopback: true, credential: true, remoteSession: false })
    expect(arrivalOf(request('[::1]:3080'), port, true, true)).toEqual({ loopback: true, credential: true, remoteSession: true })
    expect(arrivalOf(request(undefined), port, true, false)).toEqual({ loopback: false, credential: true, remoteSession: true })
    // A loopback Host on a socket other than the loopback listener's, or before it is bound, is not at the computer.
    expect(arrivalOf(request('127.0.0.1:3080', 4000), port, true, false)).toEqual({ loopback: false, credential: true, remoteSession: true })
    expect(arrivalOf(request('127.0.0.1:3080'), () => undefined, true, false)).toEqual({ loopback: false, credential: true, remoteSession: true })
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
    for (const query of ['', '?id=c0123456789&work=plug', '?other=1', '?id=nope', '?work=..%2Fescape', '?pending=1', '?pending&id=c0123456789']) {
      expect(json(await get(server.port, `${SHOW_PATH}${query}`)), query).toMatchObject({ code: 'BAD_REQUEST' })
    }
    expect(json(await get(server.port, `${SHOW_PATH}?pending`))).toEqual({ kind: 'pending-list', pending: [] })
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
    expect(json(reply)).toEqual({ code: 'INTERNAL', message: 'Delorun could not answer; the Host log says why.' })
    expect(server.warnings).toEqual(['changes route failed: disk on fire'])
    const thrown = await serveRoutes(undefined, { profile: () => { throwValue('not an error') } })
    expect((await get(thrown.port, STATE_PATH)).status).toBe(500)
    expect(thrown.warnings).toEqual(['changes route failed: not an error'])
  })

  it('reads the state of an empty profile, and names each part it cannot read', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const state = json(await get(server.port, STATE_PATH))
    expect(state).toEqual({ atComputer: true, profile: 'default', protection: 'off', leftOut: [], folders: [], requests: [], recent: [], harness: [], problems: [] })
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
      schema: 'delorun.changes-log/1',
      entries: [
        { id: 'c0000000001' as never, kind: 'guard-weakening', state: 'applied', subject: { setting: 'protection' }, summary: 'Protection turned off', createdAt: at, decidedAt: at, decidedFrom: 'terminal' },
        { id: 'c0000000002' as never, kind: 'plugin-off', state: 'applied', subject: { plugin: 'plug' }, summary: 'Turned off plug', createdAt: at, decidedAt: at, decidedFrom: 'studio' },
        { id: 'c0000000003' as never, kind: 'plugin-edit', state: 'pending', subject: { plugin: 'plug', source: '/elsewhere' }, summary: 'Edits plug', createdAt: at },
      ],
    })
    const run = join(ctx.home, 'run', ctx.profile)
    mkdirSync(run, { recursive: true, mode: 0o700 })
    writeFileSync(join(run, 'changes-boot.json'), JSON.stringify({ schema: 'delorun.changes-boot/1', at, plugins: [{ plugin: 'plug', rows: [], loaded: true }] }), { mode: 0o600 })
    const state = json(await get(server.port, STATE_PATH))
    // Two changes decided at the same time list the later-logged one first; a pending one is not a recent change.
    expect(state.recent).toEqual([
      { id: 'c0000000002', kind: 'plugin-off', state: 'applied', summary: 'Turned off plug', plugin: 'plug', createdAt: at, decidedAt: at, decidedFrom: 'studio', undoable: true },
      { id: 'c0000000001', kind: 'guard-weakening', state: 'applied', summary: 'Protection turned off', createdAt: at, decidedAt: at, decidedFrom: 'terminal', undoable: false },
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

describe('what an answer says of the home', () => {
  it('a route\'s error answer names the code and no path under the home', async () => {
    const { root, ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const logPath = join(ctx.home, 'changes', 'profiles', ctx.profile, 'log.json')
    mkdirSync(join(ctx.home, 'changes', 'profiles', ctx.profile), { recursive: true, mode: 0o700 })
    writeFileSync(logPath, 'not json', { mode: 0o600 })
    // Pins `sayable` in `sendThrown`: without it the refusal's words carry the log's path to any admitted session.
    const refused = await get(server.port, `${SHOW_PATH}?id=c0123456789`)
    expect(refused.status).toBe(500)
    expect(json(refused)).toEqual({ code: 'RECORD_UNREADABLE', message: HOME_WITHHELD_SENTENCE })
    expect(refused.body).not.toContain(root)
    // Pins `sayable` in `part`: an unreadable record in the state names its code, not its path.
    const state = await get(server.port, STATE_PATH)
    expect(state.body).not.toContain(root)
    expect(json(state).problems).toEqual([
      `The change log cannot be read: ${HOME_WITHHELD_SENTENCE}`,
      `The changes waiting for review cannot be read: ${HOME_WITHHELD_SENTENCE}`,
    ])
    // The Host log keeps the words.
    expect(server.warnings.every(warning => warning.includes(logPath))).toBe(true)
    expect(server.warnings).toHaveLength(3)
    // A recorded failure names the home as a placeholder.
    rmSync(logPath)
    const run = join(ctx.home, 'run', ctx.profile)
    mkdirSync(run, { recursive: true, mode: 0o700 })
    const active = join(ctx.home, 'changes', 'active', ctx.profile, 'plug', 'index.js')
    writeFileSync(join(run, 'changes-boot.json'), JSON.stringify({ schema: 'delorun.changes-boot/1', at: '2026-11-10T10:00:00.000Z', plugins: [{ plugin: 'plug', rows: [], loaded: false, error: `Cannot find module '${active}'` }], failure: `${active} did not load` }), { mode: 0o600 })
    const recorded = await get(server.port, STATE_PATH)
    expect(recorded.body).not.toContain(root)
    expect(json(recorded).lastStart).toEqual({
      at: '2026-11-10T10:00:00.000Z',
      failure: `${HOME_IN_ANSWERS}/changes/active/default/plug/index.js did not load`,
      plugins: [{ plugin: 'plug', loaded: false, error: `Cannot find module '${HOME_IN_ANSWERS}/changes/active/default/plug/index.js'` }],
    })
    // A home the Host names through a link is withheld under both spellings.
    const linked = join(root, 'linked-home')
    symlinkSync(ctx.home, linked)
    const throughLink = await serveRoutes({ ...ctx, home: linked })
    const viaLink = await get(throughLink.port, STATE_PATH)
    expect(viaLink.body).not.toContain(root)
    expect(json(viaLink).lastStart).toMatchObject({ failure: `${HOME_IN_ANSWERS}/changes/active/default/plug/index.js did not load` })
    // A refusal whose words name no path under the home keeps them.
    const unknown = json(await get(server.port, `${SHOW_PATH}?id=c0123456789`))
    expect(unknown.code).toBe('UNKNOWN_CHANGE')
    expect(unknown.message).not.toBe(HOME_WITHHELD_SENTENCE)
  })
})

/** A file of Delorun itself, relative to the runtime's directory. */
const SELF_FILE = 'app/node_modules/delorun/lib/main.js'

/**
 * Every entry under a directory with its kind, size and modification time.
 * @param root - the directory.
 * @returns one line per entry, by path.
 */
function snapshot(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort().map((path) => {
    const stats = lstatSync(join(root, path))
    return `${path} ${String(stats.size)} ${String(stats.mtimeMs)}`
  })
}

describe('changes to Delorun itself', () => {
  it('the studio lists changes to Delorun itself with their diff from the store', async () => {
    const { root, ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const [applied, leftOut, discarded, undone, pending, unnamed, lost] = await logHarnessChanges(ctx.home, [
      { file: SELF_FILE, before: 'export default "one"\n', after: 'export default "two"\n', state: 'applied', at: '2026-11-10T10:00:00.000Z' },
      { file: 'app/node_modules/delorun/lib/added.js', after: 'export {}\n', state: 'left-out-at-start', at: '2026-11-10T11:00:00.000Z', leftOut: { at: '2026-11-10T11:00:00.000Z', failure: 'SyntaxError: no' } },
      { file: SELF_FILE, before: 'export default "two"\n', after: 'export default "three"\n', state: 'discarded', at: '2026-11-10T09:00:00.000Z', kept: false },
      { file: SELF_FILE, before: 'a\n', after: 'b\n', state: 'undone', at: '2026-11-10T08:00:00.000Z' },
      // A change waiting for review is not a decided one.
      { file: SELF_FILE, before: 'c\n', after: 'd\n', state: 'pending', at: '2026-11-10T12:00:00.000Z' },
      { file: SELF_FILE, before: 'e\n', after: 'f\n', state: 'applied', at: '2026-11-10T07:00:00.000Z' },
      { file: SELF_FILE, before: 'g\n', after: 'h\n', state: 'applied', at: '2026-11-10T06:00:00.000Z', kept: false },
    ])
    // An entry that names no runtime is no change to Delorun itself the studio can show.
    const log = await readHarnessLog(ctx.home)
    const { runtime: _runtime, ...withoutRuntime } = unnamed!.subject
    // An undone change whose log entry names neither side, nor when it was decided, has nothing to review.
    const { from: _from, to: _to, decidedAt: _decidedAt, ...sideless } = undone!
    const entries = log.entries.map(entry => entry.id === unnamed!.id ? { ...entry, subject: withoutRuntime } : entry.id === undone!.id ? sideless : entry)
    writeFileSync(harnessLogPath(ctx.home), JSON.stringify({ ...log, entries }), { mode: 0o600 })
    const state = json(await get(server.port, STATE_PATH))
    const harness = state.harness as Record<string, unknown>[]
    expect(harness).toEqual([
      { id: leftOut!.id, state: 'left-out-at-start', file: 'app/node_modules/delorun/lib/added.js', runtime: RUNTIME, summary: `Delorun ${RUNTIME} itself: app/node_modules/delorun/lib/added.js`, createdAt: '2026-11-10T11:00:00.000Z', decidedAt: '2026-11-10T11:00:00.000Z', leftOut: { at: '2026-11-10T11:00:00.000Z', failure: 'SyntaxError: no' } },
      { id: applied!.id, state: 'applied', file: SELF_FILE, runtime: RUNTIME, summary: `Delorun ${RUNTIME} itself: ${SELF_FILE}`, createdAt: '2026-11-10T10:00:00.000Z', decidedAt: '2026-11-10T10:00:00.000Z' },
      expect.objectContaining({ id: discarded!.id, state: 'discarded' }),
      expect.objectContaining({ id: undone!.id, state: 'undone' }),
      expect.objectContaining({ id: lost!.id, state: 'applied' }),
    ])
    // Changes to Delorun itself are not a profile's changes.
    expect(state).toMatchObject({ recent: [], leftOut: [], problems: [] })
    const shown = await get(server.port, `${SHOW_PATH}?id=${applied!.id}`)
    expect(json(shown)).toEqual({
      kind: 'harness',
      entry: harness[1],
      review: {
        kind: 'harness-edit',
        files: [{ path: SELF_FILE, status: 'modified', binary: false, dependency: false }],
        risk: { kinds: [], phrases: [], needsSecondConfirmation: false, findings: [] },
        diff: { text: expect.stringContaining('-export default "one"\n+export default "two"') as string, truncated: false, omitted: [] },
      },
    })
    expect(shown.body).not.toContain(root)
    expect(json(await get(server.port, `${SHOW_PATH}?id=${leftOut!.id}`))).toMatchObject({ kind: 'harness', review: { files: [{ path: 'app/node_modules/delorun/lib/added.js', status: 'added' }] } })
    // Collection removed the content of a discarded change, and an undone change names neither side: each is answered
    // without its review.
    expect(json(await get(server.port, `${SHOW_PATH}?id=${discarded!.id}`))).toEqual({ kind: 'harness', entry: harness[2] })
    expect(json(await get(server.port, `${SHOW_PATH}?id=${undone!.id}`))).toEqual({ kind: 'harness', entry: harness[3] })
    // An applied change whose content the store lacks is a failure of the store, named without the home's path.
    const corrupt = await get(server.port, `${SHOW_PATH}?id=${lost!.id}`)
    expect(corrupt.status).toBe(500)
    expect(json(corrupt)).toEqual({ code: 'STORE_CORRUPT', message: HOME_WITHHELD_SENTENCE })
    expect(json(await get(server.port, `${SHOW_PATH}?id=${unnamed!.id}`))).toMatchObject({ code: 'UNKNOWN_CHANGE' })
    // A change waiting for review in the copy of Delorun is listed by the terminal only.
    expect(json(await get(server.port, `${SHOW_PATH}?id=${pending!.id}`))).toMatchObject({ code: 'UNKNOWN_CHANGE' })
  })

  it('lists the 20 newest changes to Delorun itself', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const logged = await logHarnessChanges(ctx.home, Array.from({ length: 21 }, (_, index) => ({ file: SELF_FILE, before: String(index), after: String(index + 1), state: 'applied' as const, at: new Date(Date.UTC(2026, 10, 10, 0, index)).toISOString() })))
    const listed = (json(await get(server.port, STATE_PATH)).harness as { id: string }[]).map(entry => entry.id)
    expect(listed).toEqual(logged.slice(1).reverse().map(entry => entry.id))
  })

  it('a harness change cannot be applied, discarded or undone from the studio', async () => {
    const { ctx } = routeHome()
    const server = await serveRoutes(ctx)
    const logged = await logHarnessChanges(ctx.home, [
      { file: SELF_FILE, before: 'one\n', after: 'two\n', state: 'applied', at: '2026-11-10T10:00:00.000Z' },
      { file: SELF_FILE, before: 'two\n', after: 'three\n', state: 'left-out-at-start', at: '2026-11-10T11:00:00.000Z', leftOut: { at: '2026-11-10T11:00:00.000Z', failure: 'boom' } },
    ])
    const before = snapshot(ctx.home)
    const log = await readHarnessLog(ctx.home)
    for (const { id } of logged) {
      for (const action of ['apply', 'discard', 'undo'] as const) {
        // Pins `refuseHarnessChange` in `act`: without it the route runs a profile's action on the id.
        const reply = await post(server.port, ACTION_PATHS[action], { id })
        expect(reply.status, `${action} ${id}`).toBe(409)
        expect(json(reply)).toEqual({ code: 'DECIDE_AT_TERMINAL', message: `Change ${id} changes Delorun itself, which you ${action} at a terminal: delorun changes ${action} ${id}` })
        // The refusals of a remote session and of another site still come first.
        expect(json(await send(server.port, ACTION_PATHS[action], { method: 'POST', headers: [CREDENTIAL, 'x-test-remote: 1'], body: { id }, withholdBody: true }))).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
        expect(json(await send(server.port, ACTION_PATHS[action], { method: 'POST', headers: [CREDENTIAL, 'Sec-Fetch-Site: cross-site'], body: { id }, withholdBody: true }))).toMatchObject({ code: 'CROSS_SITE' })
      }
    }
    expect(snapshot(ctx.home)).toEqual(before)
    expect(await readHarnessLog(ctx.home)).toEqual(log)
    expect(server.reloads()).toBe(0)
  })

  it('names the log of changes to Delorun itself when it cannot be read, and acts on no change until it can be', async () => {
    const { root, ctx } = routeHome()
    const server = await serveRoutes(ctx)
    mkdirSync(dirname(harnessLogPath(ctx.home)), { recursive: true, mode: 0o700 })
    writeFileSync(harnessLogPath(ctx.home), 'not json', { mode: 0o600 })
    const state = await get(server.port, STATE_PATH)
    expect(state.body).not.toContain(root)
    expect(json(state)).toMatchObject({ harness: [], problems: [`The log of changes to Delorun itself cannot be read: ${HOME_WITHHELD_SENTENCE}`] })
    const refused = await post(server.port, ACTION_PATHS.undo, { id: 'c0123456789' })
    expect(refused.status).toBe(500)
    expect(json(refused)).toEqual({ code: 'RECORD_UNREADABLE', message: HOME_WITHHELD_SENTENCE })
    expect(json(await get(server.port, `${SHOW_PATH}?id=c0123456789`))).toEqual({ code: 'RECORD_UNREADABLE', message: HOME_WITHHELD_SENTENCE })
  })
})

/**
 * Throw a value that is not an `Error`, as a plugin's code can.
 * @param value - the value thrown.
 */
function throwValue(value: string): never {
  throw value
}
