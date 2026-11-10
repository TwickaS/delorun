/**
 * The studio's Changes routes acting on a real profile with its history, at the computer: applying asks the second
 * confirmation the checks call for, undo, discard, turning a plugin off and on, a work session opened and ended, safe
 * mode, and the agent's plugin requests left to the terminal. The profile history runs `git`, so these cases start
 * processes.
 *
 * Each test's comment names the check whose removal makes it fail, so the suite is also the mutation record.
 */
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { enforceApprovedContent, readApproved, readChangeLog, writeChangeLog, type ChangesContext } from '@delo/changes'
import { recordPluginRequest } from '@delo/changes/install'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { ACTION_PATHS, SHOW_PATH, STATE_PATH, type ChangesRoute } from '../src/routes.ts'
import { get, json, post, routeHome, serveRoutes } from './routes-fixture.ts'

// Each case writes git histories and scans folders; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 90_000 })

/** A line every risk check of "runs commands" finds. */
const RUNS_COMMANDS = "import { execFile } from 'node:child_process'\nexport default execFile\n"

/**
 * A home whose profile links the plugin `plug` from a folder, turned on in its bundle list and approved by the first
 * start under Changes.
 * @returns the profile and the folder.
 */
async function approvedPlugin(): Promise<{ readonly ctx: ChangesContext, readonly source: string }> {
  const { root, ctx } = routeHome()
  const source = join(root, 'plug')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), '{"name":"plug","version":"1.0.0"}\n')
  writeFileSync(join(source, 'index.js'), 'export default "one"\n')
  const manifestPath = join(ctx.profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string>, dsh: { profile: { bundles: string[] } } }
  manifest.dependencies.plug = `link:${source}`
  manifest.dsh.profile.bundles = ['plug']
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(ctx.profileDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      plug:\n        specifier: link:${source}\n        version: link:${relative(ctx.profileDir, source)}\n`)
  const link = join(ctx.profileDir, 'node_modules', 'plug')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(relative(dirname(link), source), link)
  await enforceApprovedContent({ home: ctx.home, profile: ctx.profile, profileDir: ctx.profileDir })
  return { ctx, source }
}

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
    const pending = json(await get(server.port, STATE_PATH)).pending as [{ id: string, riskKinds: string[] }]
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
    const [{ id }] = json(await get(server.port, STATE_PATH)).pending as [{ id: string }]
    expect(json(await post(server.port, ACTION_PATHS.apply, { id }))).toMatchObject({ entry: { state: 'applied' } })
    writeFileSync(join(source, 'index.js'), 'export default "three"\n')
    const [next] = json(await get(server.port, STATE_PATH)).pending as [{ id: string }]
    expect(json(await post(server.port, ACTION_PATHS.discard, { id: next.id }))).toMatchObject({ entry: { id: next.id, state: 'discarded' } })
    expect(json(await get(server.port, STATE_PATH)).pending).toEqual([])
  })

  it('turns a plugin off and on again, and leaves the agent\'s plugin request to the terminal', async () => {
    const { ctx } = await approvedPlugin()
    const server = await serveRoutes(ctx)
    expect(json(await post(server.port, ACTION_PATHS.off, { plugin: 'plug' }))).toMatchObject({ entry: { kind: 'plugin-off', state: 'applied' }, reload: { kind: 'reloaded' } })
    expect(json(await post(server.port, ACTION_PATHS.on, { plugin: 'plug' }))).toMatchObject({ entry: { kind: 'plugin-on', state: 'applied' } })
    const request = await recordPluginRequest(ctx, { action: 'install', spec: 'left-pad@1.3.0' })
    expect(json(await get(server.port, STATE_PATH)).requests).toMatchObject([{ id: request.id, spec: 'left-pad@1.3.0' }])
    // Pins the refusal of an agent's request: the studio has no plugin operation, which the terminal runs.
    const reply = await post(server.port, ACTION_PATHS.apply, { id: request.id })
    expect(reply.status).toBe(409)
    expect(json(reply)).toMatchObject({ code: 'APPLY_AT_TERMINAL', message: expect.stringContaining(`delorun changes apply ${request.id}`) as unknown })
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

describe('a change that fails to load', () => {
  it('waits for review again with its failure, and a work session whose folder is gone shows no version', async () => {
    const { ctx, source } = await approvedPlugin()
    const server = await serveRoutes(ctx, { reloadOutcome: { ok: false, error: 'plug failed to start' } })
    writeFileSync(join(source, 'index.js'), 'export default "two"\n')
    const [{ id }] = json(await get(server.port, STATE_PATH)).pending as [{ id: string }]
    expect(json(await post(server.port, ACTION_PATHS.apply, { id }))).toMatchObject({ entry: { id, state: 'pending' }, reload: { kind: 'went-back', failure: 'plug failed to start' } })
    expect(json(await get(server.port, STATE_PATH)).pending).toMatchObject([{ id, lastFailure: { failure: 'plug failed to start' } }])
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
    writeFileSync(join(run, 'changes-boot.json'), JSON.stringify({ schema: 'delo.changes-boot/1', at: '2026-11-10T10:00:00.000Z', plugins: [{ plugin: 'plug', rows: [{ id: 'plug-row', state: 'failed' }], loaded: false, error: 'TypeError: boom' }], failure: 'the profile did not boot' }), { mode: 0o600 })
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
    const server = await serveRoutes(ctx, { installationBundles: ['@delo/bundle-local'] })
    const reply = json(await post(server.port, ACTION_PATHS['safe-mode']))
    expect(reply).toMatchObject({ skipped: ['plug'] })
    expect((reply.lines as string[]).join(' ')).toContain('The next start leaves out plug')
    expect(json(await get(server.port, STATE_PATH)).safeMode).toMatchObject({ skipped: ['plug'], reason: 'the person asked for safe mode in the studio' })
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
    host.provide('webServer', { register: (route: ChangesRoute) => { handlers.set(route.path, route.handler); return () => {} } } as never)
    host.provide('connection', { admit: () => ({ peer: {} }) } as never)
    host.provide('profileContext', { name: ctx.profile, dir: ctx.profileDir, home: ctx.home } as never)
    let reconciled = 0
    host.provide('hmr', { runExclusive: <T>(operation: () => Promise<T>) => operation(), reconcileProfile: () => { reconciled += 1; return Promise.resolve({}) } } as never)
    await host.plugin(plugin, { enabled: false, installationBundles: [] })
    const request = Object.assign(Readable.from([Buffer.from('{"plugin":"plug"}')]), { method: 'POST', url: ACTION_PATHS.off, headers: { host: '127.0.0.1:3080' } })
    let status = 0
    let text = ''
    await handlers.get(ACTION_PATHS.off)!(request as never, { writeHead: (code: number) => { status = code }, end: (body: string) => { text = body } } as never)
    expect(status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ entry: { kind: 'plugin-off', decidedFrom: 'studio' }, reload: { kind: 'reloaded' } })
    expect(reconciled).toBe(1)
  })
})
