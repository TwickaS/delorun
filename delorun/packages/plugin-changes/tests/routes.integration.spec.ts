/**
 * The studio's Changes routes acting on a real profile with its history, at the computer: applying asks the second
 * confirmation the checks call for, undo, discard, turning a plugin off and on, a work session opened and ended, safe
 * mode, and the agent's plugin requests applied through the Host's plugin operation after a second confirmation. The
 * profile history runs `git`, so these cases start processes.
 *
 * Each test's comment names the check whose removal makes it fail, so the suite is also the mutation record.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { attestTerminal, readApproved, readChangeLog, setProtection, writeChangeLog, type ChangesContext } from '@delorun/changes'
import { recordPluginRequest } from '@delorun/changes/install'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { ACTION_PATHS, SHOW_PATH, STATE_PATH, type ChangesRoute } from '../src/routes.ts'
import { approvedPlugin, CREDENTIAL, get, json, post, send, serveRoutes } from './routes-fixture.ts'

/** The `show?pending` route, which reads the folders and lists the changes waiting for review. */
const PENDING_PATH = `${SHOW_PATH}?pending`

// Each case writes git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 90_000 })

/** A line every risk check of "runs commands" finds. */
const RUNS_COMMANDS = "import { execFile } from 'node:child_process'\nexport default execFile\n"

/**
 * @param ctx - the profile.
 * @returns the plugin's approved version.
 */
async function approved(ctx: ChangesContext): Promise<string | undefined> {
  return (await readApproved(ctx.profileDir)).plugins.plug?.version
}

describe('acting on a change at the computer', () => {
  it('apply asks the second confirmation when the change has a risk', async () => {
    const { ctx, source } = await approvedPlugin()
    const server = await serveRoutes(ctx)
    const before = await approved(ctx)
    writeFileSync(join(source, 'index.js'), RUNS_COMMANDS)
    // A .js file that is not text: the diff cannot show it, so the confirmation names it.
    writeFileSync(join(source, 'blob.js'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    expect(json(await get(server.port, STATE_PATH)).folders).toEqual([{ plugin: 'plug', source, kind: 'plugin-edit' }])
    const pending = json(await get(server.port, PENDING_PATH)).pending as [{ id: string, riskKinds: string[] }]
    expect(pending).toHaveLength(1)
    const [{ id, riskKinds }] = pending
    expect(riskKinds).toContain('commands')
    const shown = json(await get(server.port, `${SHOW_PATH}?id=${id}`))
    expect(shown).toMatchObject({ kind: 'pending', change: { id, plugin: 'plug', source, files: [{ path: 'blob.js', status: 'added', binary: true }, { path: 'index.js', status: 'modified', binary: false, dependency: false }] } })
    expect(JSON.stringify(shown)).toContain('child_process')
    // Pins the route's second confirmation: without it a flagged change applies on the first request.
    const first = await post(server.port, ACTION_PATHS.apply, { id })
    expect(first.status).toBe(409)
    expect(json(first)).toMatchObject({ code: 'CONFIRM_RISK', kinds: riskKinds })
    expect(JSON.stringify(json(first).notShown)).toContain('blob.js')
    expect(await approved(ctx)).toBe(before)
    expect(server.reloads()).toBe(0)
    const second = await post(server.port, ACTION_PATHS.apply, { id, confirmedRisk: true })
    expect(second.status).toBe(200)
    expect(json(second)).toMatchObject({ entry: { id, state: 'applied', decidedFrom: 'studio', undoable: true }, reload: { kind: 'reloaded' } })
    expect(await approved(ctx)).not.toBe(before)
    expect(server.reloads()).toBe(1)
    expect(json(await get(server.port, `${SHOW_PATH}?id=${id}`))).toMatchObject({ kind: 'logged', entry: { id, state: 'applied' } })
    // Undo takes it back, as the recovery screen does.
    expect(json(await post(server.port, ACTION_PATHS.undo, { id }))).toMatchObject({ entry: { id, state: 'undone', undoable: false } })
    expect(await approved(ctx)).toBe(before)
    const recent = json(await get(server.port, STATE_PATH)).recent as { id: string, state: string }[]
    expect(recent.map(entry => entry.state)).toEqual(['undone', 'applied'])
  })

  it('applies a change without a risk at once, and discards another', async () => {
    const { ctx, source } = await approvedPlugin()
    const server = await serveRoutes(ctx)
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    const [{ id }] = json(await get(server.port, PENDING_PATH)).pending as [{ id: string }]
    expect(json(await post(server.port, ACTION_PATHS.apply, { id }))).toMatchObject({ entry: { state: 'applied' } })
    writeFileSync(join(source, 'index.js'), 'export default "three"\n')
    const [next] = json(await get(server.port, PENDING_PATH)).pending as [{ id: string }]
    expect(json(await post(server.port, ACTION_PATHS.discard, { id: next.id }))).toMatchObject({ entry: { id: next.id, state: 'discarded' } })
    expect(json(await get(server.port, PENDING_PATH)).pending).toEqual([])
  })

  it('turns a plugin off and on again', async () => {
    const { ctx } = await approvedPlugin()
    const server = await serveRoutes(ctx)
    expect(json(await post(server.port, ACTION_PATHS.off, { plugin: 'plug' }))).toMatchObject({ entry: { kind: 'plugin-off', state: 'applied' }, reload: { kind: 'reloaded' } })
    expect(json(await post(server.port, ACTION_PATHS.on, { plugin: 'plug' }))).toMatchObject({ entry: { kind: 'plugin-on', state: 'applied' } })
  })

  it('opens a work session and ends it with exactly the version it showed', async () => {
    const { ctx, source } = await approvedPlugin()
    const server = await serveRoutes(ctx)
    expect(json(await post(server.port, ACTION_PATHS.work, { plugin: 'plug', minutes: 5 }))).toMatchObject({ session: { plugin: 'plug', source }, load: { kind: 'loaded' } })
    writeFileSync(join(source, 'index.js'), RUNS_COMMANDS)
    const review = json(await get(server.port, `${SHOW_PATH}?work=plug`))
    expect(review).toMatchObject({ kind: 'work', plugin: 'plug', failedToLoad: false, change: { plugin: 'plug' } })
    const version = review.version as string
    expect(json(await post(server.port, ACTION_PATHS.done, { plugin: 'plug', version: 'f'.repeat(64) }))).toMatchObject({ code: 'CHANGED_SINCE_REVIEW' })
    expect(json(await post(server.port, ACTION_PATHS.done, { plugin: 'plug', version }))).toMatchObject({ code: 'CONFIRM_RISK' })
    expect(json(await post(server.port, ACTION_PATHS.done, { plugin: 'plug', version, confirmedRisk: true }))).toMatchObject({ kind: 'ended', plugin: 'plug', entry: { kind: 'plugin-edit', state: 'applied' } })
    expect(await approved(ctx)).toBe(version)
    // A session whose folder did not change ends approving nothing new.
    expect(json(await post(server.port, ACTION_PATHS.work, { plugin: 'plug' }))).toMatchObject({ session: { plugin: 'plug' } })
    const unchanged = json(await get(server.port, `${SHOW_PATH}?work=plug`))
    expect(unchanged.change).toBeUndefined()
    expect(json(await post(server.port, ACTION_PATHS.done, { plugin: 'plug', version: unchanged.version }))).toEqual({ kind: 'ended', plugin: 'plug' })
  })

  it('reports a work session whose content fails to load, and approves nothing', async () => {
    const { ctx, source } = await approvedPlugin()
    const before = await approved(ctx)
    const server = await serveRoutes(ctx, { reloadOutcome: { ok: false, error: 'plug failed to start' } })
    expect(json(await post(server.port, ACTION_PATHS.work, { plugin: 'plug', minutes: 5 }))).toMatchObject({ load: { kind: 'went-back', failure: 'plug failed to start' } })
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    const { version } = json(await get(server.port, `${SHOW_PATH}?work=plug`)) as { version: string }
    expect(json(await post(server.port, ACTION_PATHS.done, { plugin: 'plug', version }))).toEqual({ kind: 'went-back', plugin: 'plug', failure: 'plug failed to start' })
    expect(await approved(ctx)).toBe(before)
  })
})

describe('the agent\'s plugin requests in the studio', () => {
  it('the studio applies a queued install with protection on through the plugin operation, after a second confirmation', async () => {
    const { ctx } = await approvedPlugin()
    await setProtection(ctx.home, 'on', attestTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }))
    const server = await serveRoutes(ctx)
    const request = await recordPluginRequest(ctx, { action: 'install', spec: 'left-pad@1.3.0' })
    expect(json(await get(server.port, STATE_PATH)).requests).toMatchObject([{ id: request.id, spec: 'left-pad@1.3.0' }])
    // A remote session and another site are refused before the body is read, and run nothing.
    const remote = await send(server.port, ACTION_PATHS.apply, { method: 'POST', headers: [CREDENTIAL, 'x-test-remote: 1'], body: { id: request.id, confirmedRisk: true }, withholdBody: true })
    expect(json(remote)).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    const crossSite = await send(server.port, ACTION_PATHS.apply, { method: 'POST', headers: [CREDENTIAL, 'Origin: http://evil.example'], body: { id: request.id, confirmedRisk: true }, withholdBody: true })
    expect(json(crossSite)).toMatchObject({ code: 'CROSS_SITE' })
    // Pins the second confirmation of a request: without it the first Apply installs what the agent named, unseen.
    const first = await post(server.port, ACTION_PATHS.apply, { id: request.id })
    expect(first.status).toBe(409)
    expect(json(first)).toEqual({
      code: 'CONFIRM_RISK',
      message: 'This installs left-pad@1.3.0, which the agent asked for, as pnpm resolves it; Delorun does not show its content before it runs. A plugin\'s code can do anything Delorun can. Confirm again to apply it.',
      kinds: ['dependency-or-build', 'not-shown'],
      notShown: ['left-pad@1.3.0'],
    })
    expect(server.operations).toEqual([])
    expect(server.reloads()).toBe(0)
    const second = await post(server.port, ACTION_PATHS.apply, { id: request.id, confirmedRisk: true })
    expect(second.status).toBe(200)
    expect(json(second)).toMatchObject({ entry: { id: request.id, kind: 'plugin-install', state: 'applied', decidedFrom: 'studio', spec: 'left-pad@1.3.0' }, reload: { kind: 'reloaded' } })
    expect(server.operations).toEqual([['add', 'left-pad@1.3.0']])
    expect(server.reloads()).toBe(1)
    expect(json(await get(server.port, STATE_PATH)).requests).toEqual([])
  })

  it('a removal asks the second confirmation too, a failed operation leaves the request waiting, and Discard declines one', async () => {
    const { ctx } = await approvedPlugin()
    const server = await serveRoutes(ctx, { operationResult: { exitCode: 1, failure: 'plug is needed' } })
    const removal = await recordPluginRequest(ctx, { action: 'remove', spec: 'plug' })
    expect(json(await post(server.port, ACTION_PATHS.apply, { id: removal.id }))).toEqual({ code: 'CONFIRM_RISK', message: 'This removes plug, which the agent asked for. Confirm again to apply it.', kinds: ['dependency-or-build'], notShown: [] })
    const failed = await post(server.port, ACTION_PATHS.apply, { id: removal.id, confirmedRisk: true })
    expect(failed.status).toBe(409)
    expect(json(failed)).toMatchObject({ code: 'OPERATION_FAILED', message: `Change ${removal.id} was not applied: plug is needed` })
    expect(server.operations).toEqual([['remove', 'plug']])
    expect(json(await get(server.port, STATE_PATH)).requests).toMatchObject([{ id: removal.id, state: 'pending', lastFailure: { failure: 'plug is needed' } }])
    expect(json(await post(server.port, ACTION_PATHS.discard, { id: removal.id }))).toMatchObject({ entry: { id: removal.id, state: 'discarded' } })
    expect(json(await get(server.port, STATE_PATH)).requests).toEqual([])
    expect(server.reloads()).toBe(0)
  })

  it('names the change that holds a folder\'s content after applying a request for a folder', async () => {
    const { ctx, source } = await approvedPlugin()
    const server = await serveRoutes(ctx, { reloadOutcome: { ok: false, error: 'boom' } })
    const folder = join(source, '..', 'other')
    mkdirSync(folder)
    writeFileSync(join(folder, 'package.json'), '{"name":"other","version":"1.0.0"}\n')
    const request = await recordPluginRequest(ctx, { action: 'install', spec: `link:${folder}` })
    const applied = json(await post(server.port, ACTION_PATHS.apply, { id: request.id, confirmedRisk: true }))
    expect(applied).toMatchObject({ entry: { id: request.id, state: 'applied' }, reload: { kind: 'failed', failure: 'boom' }, folderChange: expect.stringMatching(/^c[0-9a-f]{10}$/) as string })
    expect(server.operations).toEqual([['add', expect.stringContaining('link:') as string]])
  })
})

describe('a change that fails to load', () => {
  it('waits for review again with its failure, and a work session whose folder is gone shows no version', async () => {
    const { ctx, source } = await approvedPlugin()
    const server = await serveRoutes(ctx, { reloadOutcome: { ok: false, error: 'plug failed to start' } })
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    const [{ id }] = json(await get(server.port, PENDING_PATH)).pending as [{ id: string }]
    expect(json(await post(server.port, ACTION_PATHS.apply, { id }))).toMatchObject({ entry: { id, state: 'pending' }, reload: { kind: 'went-back', failure: 'plug failed to start' } })
    expect(json(await get(server.port, PENDING_PATH)).pending).toMatchObject([{ id, lastFailure: { failure: 'plug failed to start' } }])
    expect(json(await get(server.port, `${SHOW_PATH}?id=${id}`))).toMatchObject({ kind: 'pending', change: { id, lastFailure: { failure: 'plug failed to start' } } })
    // A plugin turned off that failed to load is applied again by its id, with no second confirmation.
    const off = json(await post(server.port, ACTION_PATHS.off, { plugin: 'plug' })) as { entry: { id: string, state: string } }
    expect(off.entry.state).toBe('pending')
    expect(json(await post(server.port, ACTION_PATHS.apply, { id: off.entry.id }))).toMatchObject({ entry: { id: off.entry.id, kind: 'plugin-off' }, reload: { kind: 'went-back' } })
    await post(server.port, ACTION_PATHS.work, { plugin: 'plug', minutes: 5 })
    rmSync(source, { recursive: true })
    const review = json(await get(server.port, `${SHOW_PATH}?work=plug`))
    expect(review).toMatchObject({ kind: 'work', plugin: 'plug' })
    expect(review.version).toBeUndefined()
  })
})

describe('the recovery state and safe mode', () => {
  it('names what failed at the last start, what was left out with its failure, and the work session', async () => {
    const { ctx } = await approvedPlugin()
    const run = join(ctx.home, 'run', ctx.profile)
    mkdirSync(run, { recursive: true, mode: 0o700 })
    writeFileSync(join(run, 'changes-boot.json'), JSON.stringify({ schema: 'delorun.changes-boot/1', at: '2026-11-10T10:00:00.000Z', plugins: [{ plugin: 'plug', rows: [{ id: 'plug-row', state: 'failed' }], loaded: false, error: 'TypeError: boom' }], failure: 'the profile did not boot' }), { mode: 0o600 })
    const log = await readChangeLog(ctx.home, ctx.profile)
    await writeChangeLog(ctx.home, ctx.profile, { ...log, entries: [...log.entries, { id: 'c00000000ff' as never, kind: 'plugin-edit', state: 'left-out-at-start', subject: { plugin: 'plug', source: '/elsewhere' }, summary: 'Edits plug', createdAt: '2026-11-10T09:00:00.000Z', leftOut: { at: '2026-11-10T10:00:00.000Z', failure: 'plug did not load' }, lastFailure: { at: '2026-11-10T10:00:00.000Z', failure: 'did not load' } }] })
    const server = await serveRoutes(ctx)
    await post(server.port, ACTION_PATHS.work, { plugin: 'plug', minutes: 5 })
    const state = json(await get(server.port, STATE_PATH))
    expect(state).toMatchObject({
      atComputer: true,
      lastStart: { at: '2026-11-10T10:00:00.000Z', failure: 'the profile did not boot', plugins: [{ plugin: 'plug', loaded: false, error: 'TypeError: boom' }] },
      leftOut: [{ id: 'c00000000ff', summary: 'Edits plug', leftOut: { failure: 'plug did not load' }, lastFailure: { failure: 'did not load' }, undoable: false }],
      workSession: { plugin: 'plug' },
      problems: [],
    })
  })

  it('starts safe mode keeping the installation\'s bundles, and answers a profile it cannot read', async () => {
    const { ctx } = await approvedPlugin()
    const server = await serveRoutes(ctx, { installationBundles: ['@delorun/bundle-local'] })
    const reply = json(await post(server.port, ACTION_PATHS['safe-mode']))
    expect(reply).toMatchObject({ skipped: ['plug'] })
    expect((reply.lines as string[]).join(' ')).toContain('The next start leaves out plug')
    expect(json(await get(server.port, STATE_PATH)).safeMode).toMatchObject({ skipped: ['plug'], reason: 'the person asked for safe mode in the studio' })
    const left = json(await post(server.port, ACTION_PATHS['exit-safe-mode']))
    expect((left.lines as string[]).join(' ')).toContain('Safe mode is off')
    expect(json(await get(server.port, STATE_PATH)).safeMode).toBeUndefined()
    expect((json(await post(server.port, ACTION_PATHS['exit-safe-mode'])).lines as string[]).join(' ')).toContain('Safe mode was not on')
    writeFileSync(join(ctx.profileDir, 'cordis.patch.yml'), 'not: [a list\n')
    const refused = await post(server.port, ACTION_PATHS['safe-mode'])
    expect(refused.status).toBe(409)
    expect(json(refused)).toMatchObject({ code: 'PROFILE_UNREADABLE' })
    rmSync(join(ctx.profileDir, 'cordis.patch.yml'))
  })
})

describe('the plugin\'s routes in the Host', () => {
  it('reloads the Host it runs in through its own hot reload', async () => {
    const { ctx } = await approvedPlugin()
    const host = new Context()
    onTestFinished(() => host.fiber.dispose())
    host.provide('tools', { guard: () => () => {} } as never)
    const handlers = new Map<string, ChangesRoute['handler']>()
    host.provide('webServer', { port: 3080, register: (route: ChangesRoute) => { handlers.set(route.path, route.handler); return () => {} } } as never)
    host.provide('connection', { admit: () => ({ peer: {} }), isReachPeer: () => false } as never)
    host.provide('profileContext', { name: ctx.profile, dir: ctx.profileDir, home: ctx.home } as never)
    let reconciled = 0
    host.provide('hmr', { runExclusive: <T>(operation: () => Promise<T>) => operation(), reconcileProfile: () => { reconciled += 1; return Promise.resolve({}) } } as never)
    await host.plugin(plugin, { enabled: false, installationBundles: [], restartWaitSeconds: 600 })
    const request = Object.assign(Readable.from([Buffer.from('{"plugin":"plug"}')]), { method: 'POST', url: ACTION_PATHS.off, headers: { host: '127.0.0.1:3080' }, socket: { localAddress: '127.0.0.1', localPort: 3080 } })
    let status = 0
    let text = ''
    await handlers.get(ACTION_PATHS.off)!(request as never, { writeHead: (code: number) => { status = code }, end: (body: string) => { text = body } } as never)
    expect(status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ entry: { kind: 'plugin-off', decidedFrom: 'studio' }, reload: { kind: 'reloaded' } })
    expect(reconciled).toBe(1)
    // An agent's request runs the Host's plugin operation, which checks the package a folder holds before pnpm runs.
    const folder = join(ctx.profileDir, '..', '..', '..', 'not-a-bundle')
    mkdirSync(folder)
    writeFileSync(join(folder, 'package.json'), '{"name":"not-a-bundle","version":"1.0.0"}\n')
    const held = await recordPluginRequest(ctx, { action: 'install', spec: `link:${folder}` })
    const apply = Object.assign(Readable.from([Buffer.from(JSON.stringify({ id: held.id, confirmedRisk: true }))]), { method: 'POST', url: ACTION_PATHS.apply, headers: { host: '127.0.0.1:3080' }, socket: { localAddress: '127.0.0.1', localPort: 3080 } })
    await handlers.get(ACTION_PATHS.apply)!(apply as never, { writeHead: (code: number) => { status = code }, end: (body: string) => { text = body } } as never)
    expect(status).toBe(409)
    expect(JSON.parse(text)).toMatchObject({ code: 'OPERATION_FAILED', message: expect.stringContaining('is no DSH plugin bundle') as string })
  })
})
