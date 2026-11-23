/**
 * Specs of the pending reviews of `@delorun/plugin-mcp-consent`: each refused stdio server start is kept for the studio's
 * Permissions section and `delorun mcp`, with a value only of a run-affecting environment variable; an acceptance
 * records exactly the start shown for its server name and starts the refused row again; a decline sets the start aside
 * as `declined` until it changes. The denial cases prove that an unconfirmed answer, a stale review and a request from a
 * reach device record nothing, and so does an answer to a review whose command or working directory now resolves to
 * other paths than it showed. A review names what changed since the acceptance and which variables, the accepted
 * starts are listed one per server name with the paths they resolved to, and a revoke withdraws one server's acceptance
 * and stops that server's rows only; a stale or unconfirmed revoke changes nothing. The suite's starts name a real
 * executable and real directories under a private temporary root, because an acceptance resolves its start again.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { McpConsentRefusedError, type McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, DelorunMcpConsent, MCP_CONSENT_ROUTES, mcpReviewId } from '../src/index.ts'
import { registerMcpConsentRoutes } from '../src/routes.ts'
import { acceptanceStorePath } from '../src/store.ts'
import { showsEnvValue } from '../src/review.ts'

/** The secret value of the suite's configured environment, which no review or answer may hold. */
const SECRET = 'secret-token-value'

let root: string
let ctx: Context
let consent: DelorunMcpConsent
/** The server start the suite's reviews judge: an absolute executable under the root, run in `srv/mcp`. */
let START: McpServerCommand
/** A second existing working directory, `srv/other`. */
let OTHER: string

/**
 * Write an executable file.
 * @param path - its absolute path.
 */
function executable(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-mcp-reviews-')))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  executable(join(root, 'bin', 'npx'))
  mkdirSync(join(root, 'srv', 'mcp'), { recursive: true })
  OTHER = join(root, 'srv', 'other')
  mkdirSync(OTHER)
  START = {
    serverName: 'files',
    command: join(root, 'bin', 'npx'),
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/data'],
    env: { API_TOKEN: SECRET },
    cwd: join(root, 'srv', 'mcp'),
    resolvedCommand: join(root, 'bin', 'npx'),
    resolvedCwd: join(root, 'srv', 'mcp'),
  }
  vi.stubEnv('DELORUN_HOME', home)
  ctx = new Context()
  consent = new DelorunMcpConsent(ctx)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
})

/**
 * The id of the review of a start, its files pinned as the review pins them: the executable and each argument that
 * names a regular file, by canonical path and SHA-256; no file when the executable cannot be read.
 * @param start - the start.
 * @returns the review id.
 */
function reviewIdOf(start: McpServerCommand): string {
  const pin = (path: string) => {
    const canonical = realpathSync(path)
    return { path: canonical, sha256: `sha256:${createHash('sha256').update(readFileSync(canonical)).digest('hex')}` }
  }
  if (!isAbsolute(start.resolvedCommand) || !existsSync(start.resolvedCommand)) return mcpReviewId({ ...start, files: [] })
  const files = [pin(start.resolvedCommand), ...start.args.flatMap((argument, index) => {
    const path = resolve(start.resolvedCwd, argument)
    return argument !== '' && existsSync(path) && statSync(path).isFile() ? [{ argument: index, ...pin(path) }] : []
  })]
  return mcpReviewId({ ...start, files })
}

/**
 * The acceptance store's text, or undefined while none exists.
 * @returns the text.
 */
function storeText(): string | undefined {
  const path = acceptanceStorePath(join(root, 'home'))
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

describe('a refused start', () => {
  it('waits as a pending review that names the start without an environment value', async () => {
    await expect(consent.review(START)).resolves.toMatchObject({ allow: false })
    const [pending] = consent.pending()
    expect(pending).toEqual({
      serverName: 'files', reviewId: reviewIdOf(START), origin: { kind: 'unknown' }, command: START.command, args: START.args, cwd: START.cwd,
      resolvedCommand: START.resolvedCommand, resolvedCwd: START.resolvedCwd, env: [{ name: 'API_TOKEN' }],
      files: [{ path: START.resolvedCommand, sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }],
      // The suite's tree lies in the temporary directory, which chats can write.
      writableByChats: [START.resolvedCwd, START.resolvedCommand],
      reason: 'no server is accepted yet (the acceptance store does not exist)', change: 'new', changedVariables: [], state: 'waiting',
      reviewedAt: expect.any(Number),
    })
    expect(JSON.stringify(consent.pending())).not.toContain(SECRET)
  })

  it('names the part of an accepted start that changed', async () => {
    await consent.review(START)
    await consent.acceptReview('files', reviewIdOf(START), true)
    executable(join(root, 'elsewhere', 'npx'))
    for (const [changed, change, changedVariables] of [
      [{ ...START, command: 'uvx' }, 'command', []],
      [{ ...START, args: [...START.args, '/home'] }, 'arguments', []],
      [{ ...START, cwd: OTHER, resolvedCwd: OTHER }, 'directory', []],
      [{ ...START, resolvedCommand: join(root, 'elsewhere', 'npx') }, 'resolved', []],
      [{ ...START, resolvedCwd: OTHER }, 'resolved', []],
      [{ ...START, env: { API_TOKEN: 'another-value' } }, 'environment', ['API_TOKEN']],
      [{ ...START, env: { PATH: '/opt/bin', NODE_ENV: 'test' } }, 'environment', ['API_TOKEN', 'NODE_ENV', 'PATH']],
      [{ ...START, serverName: 'other' }, 'new', []],
    ] as const) {
      await consent.review(changed)
      const review = consent.pending().find(entry => entry.serverName === changed.serverName)
      expect([review?.change, review?.changedVariables, review?.state]).toEqual([change, changedVariables, 'waiting'])
    }
  })

  it('shows the value of a variable that changes what runs, and never another value', async () => {
    const env = { PATH: '/opt/bin', NODE_OPTIONS: '--require ./hook.js', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', PYTHONPATH: '/py', LD_PRELOAD: '/l.so', LD_LIBRARY_PATH: '/lib', API_TOKEN: SECRET, PATHS: 'not-shown' }
    await consent.review({ ...START, env })
    expect(consent.pending()[0]?.env).toEqual([
      { name: 'API_TOKEN' }, { name: 'DYLD_INSERT_LIBRARIES', value: '/tmp/x.dylib' }, { name: 'LD_LIBRARY_PATH', value: '/lib' },
      { name: 'LD_PRELOAD', value: '/l.so' }, { name: 'NODE_OPTIONS', value: '--require ./hook.js' }, { name: 'PATH', value: '/opt/bin' },
      { name: 'PATHS' }, { name: 'PYTHONPATH', value: '/py' },
    ])
    expect(JSON.stringify(consent.pending())).not.toContain(SECRET)
    expect(JSON.stringify(consent.pending())).not.toContain('not-shown')
    expect([showsEnvValue('path'), showsEnvValue('DYLD_'), showsEnvValue('XDYLD_X')]).toEqual([true, true, false])
  })

  it('ends its refusal with where the person accepts it', async () => {
    await expect(consent.review(START)).resolves.toMatchObject({ reason: expect.stringContaining('`delorun mcp accept files`') })
  })

  it('is replaced by the review of the changed start, whose id differs', async () => {
    await consent.review(START)
    const first = consent.pending()[0]?.reviewId
    await consent.review({ ...START, env: { API_TOKEN: 'another-value' } })
    expect(consent.pending()).toHaveLength(1)
    expect(consent.pending()[0]?.reviewId).not.toBe(first)
  })

  it('leaves the list once a review allows the server', async () => {
    await consent.review(START)
    await consent.acceptReview('files', reviewIdOf(START), true)
    await expect(consent.review(START)).resolves.toMatchObject({ allow: true })
    expect(consent.pending()).toEqual([])
  })
})

describe('an answer to a pending review', () => {
  it('records exactly the start shown once the person confirmed it, and later reviews allow it', async () => {
    await consent.review(START)
    await expect(consent.acceptReview('files', reviewIdOf(START), true)).resolves.toEqual({ started: 0 })
    expect(storeText()).not.toContain(SECRET)
    await expect(consent.review(START)).resolves.toMatchObject({ allow: true })
  })

  it('records nothing without the person\'s confirmation', async () => {
    await consent.review(START)
    await expect(consent.acceptReview('files', reviewIdOf(START), false)).rejects.toThrow(expect.objectContaining({ code: 'UNCONFIRMED' }))
    expect(storeText()).toBeUndefined()
    expect(consent.pending()).toHaveLength(1)
  })

  it('records nothing for a stale review: the start changed after it was shown', async () => {
    await consent.review(START)
    const shown = reviewIdOf(START)
    const changed = { ...START, args: [...START.args, '/home'] }
    await consent.review(changed)
    await expect(consent.acceptReview('files', shown, true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    expect(storeText()).toBeUndefined()
    await expect(consent.review(changed)).resolves.toMatchObject({ allow: false })
  })

  it('records nothing when the bare command now resolves to another executable than the review showed, and reviews it again', async () => {
    // `first/tool` is found on PATH when the review is shown; then `ahead/tool`, earlier on PATH, appears.
    executable(join(root, 'first', 'tool'))
    mkdirSync(join(root, 'ahead'))
    vi.stubEnv('PATH', `${join(root, 'ahead')}:${join(root, 'first')}`)
    const shown = { ...START, command: 'tool', resolvedCommand: join(root, 'first', 'tool') }
    await consent.review(shown)
    executable(join(root, 'ahead', 'tool'))
    const failure: unknown = await consent.acceptReview('files', reviewIdOf(shown), true).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'STALE_REVIEW', message: expect.stringContaining('now resolves to other paths or runs other file contents than this review showed') })
    expect(storeText()).toBeUndefined()
    const [again] = consent.pending()
    expect(again).toMatchObject({ resolvedCommand: join(root, 'ahead', 'tool'), state: 'waiting' })
    expect(again?.reviewId).not.toBe(reviewIdOf(shown))
    await expect(consent.acceptReview('files', again?.reviewId ?? '', true)).resolves.toEqual({ started: 0 })
    await expect(consent.review({ ...shown, resolvedCommand: join(root, 'ahead', 'tool') })).resolves.toMatchObject({ allow: true })
    await expect(consent.review(shown)).resolves.toMatchObject({ allow: false })
    expect(consent.pending()[0]?.change).toBe('resolved')
  })

  it('records nothing when the working directory now resolves to another directory than the review showed', async () => {
    const link = join(root, 'srv', 'current')
    symlinkSync(START.cwd, link)
    const shown = { ...START, cwd: link }
    await consent.review(shown)
    rmSync(link)
    symlinkSync(OTHER, link)
    await expect(consent.acceptReview('files', reviewIdOf(shown), true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    expect(storeText()).toBeUndefined()
    expect(consent.pending()[0]).toMatchObject({ cwd: link, resolvedCwd: OTHER })
  })

  it('records nothing when the shown start no longer resolves, and keeps its review', async () => {
    await consent.review(START)
    const shown = reviewIdOf(START)
    rmSync(START.resolvedCommand)
    const failure: unknown = await consent.acceptReview('files', shown, true).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'STALE_REVIEW', message: expect.stringContaining('no longer resolves or reads as it was shown') })
    expect(storeText()).toBeUndefined()
    expect(consent.pending()[0]?.reviewId).toBe(shown)
  })

  it('refuses a shown start whose resolved paths are not absolute, recording nothing', async () => {
    for (const shown of [{ ...START, resolvedCommand: 'npx' }, { ...START, resolvedCwd: 'srv/mcp' }, { ...START, resolvedShell: 'cmd.exe' }]) {
      await consent.review(shown)
      const failure: unknown = await consent.acceptReview('files', reviewIdOf(shown), true).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'STORE_REFUSED', message: 'the start to accept holds a resolved path that is not absolute' })
    }
    expect(storeText()).toBeUndefined()
  })

  it('records nothing for a server with no pending review', async () => {
    await expect(consent.acceptReview('files', reviewIdOf(START), true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    await expect(consent.declineReview('files', reviewIdOf(START))).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    expect(storeText()).toBeUndefined()
  })

  it('declines a review: it stays listed as declined, the server stopped, and no acceptance is recorded', async () => {
    await consent.review(START)
    await consent.declineReview('files', reviewIdOf(START))
    expect(consent.pending()).toEqual([expect.objectContaining({ serverName: 'files', state: 'declined', change: 'new' })])
    expect(storeText()).not.toContain(SECRET)
    await expect(consent.review(START)).resolves.toMatchObject({ allow: false, reason: expect.stringContaining('the person declined this start') })
    expect(consent.pending()[0]?.state).toBe('declined')
  })

  it('keeps a declined start declined across a new service instance, until the start changes', async () => {
    await consent.review(START)
    await consent.declineReview('files', reviewIdOf(START))
    const restarted = new DelorunMcpConsent(new Context())
    await restarted.review(START)
    expect(restarted.pending()[0]?.state).toBe('declined')
    const changed = { ...START, args: [...START.args, '/home'] }
    await restarted.review(changed)
    expect(restarted.pending()[0]).toMatchObject({ state: 'waiting', change: 'new' })
    // The changed start dropped the set-aside one, so the declined start, configured again, waits too.
    await restarted.review(START)
    expect(restarted.pending()[0]?.state).toBe('waiting')
  })

  it('declines in this process only while the store cannot be read, leaving the store unchanged', async () => {
    const path = acceptanceStorePath(join(root, 'home'))
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, '{ not json', { mode: 0o600 })
    await consent.review(START)
    await consent.declineReview('files', reviewIdOf(START))
    expect(consent.pending()[0]?.state).toBe('declined')
    expect(storeText()).toBe('{ not json')
  })

  it('accepts a declined review like a waiting one', async () => {
    await consent.review(START)
    await consent.declineReview('files', reviewIdOf(START))
    await expect(consent.acceptReview('files', reviewIdOf(START), true)).resolves.toEqual({ started: 0 })
    await expect(consent.review(START)).resolves.toMatchObject({ allow: true })
    expect(storeText()).not.toContain('declined')
  })

  it('starts again each Loader row of the server this consent refused at its boot or held at a reconnect, and no other row', async () => {
    const update = vi.fn(async () => {})
    const held = vi.fn(async () => {})
    const unrelated = vi.fn(async () => {})
    const refusedRow = (serverName: string, onUpdate: () => Promise<void>) => ({
      id: `mcp-${serverName}`,
      fiber: {
        config: { serverName },
        await: () => Promise.reject(new McpConsentRefusedError({ ...START, serverName }, 'not accepted')),
        update: onUpdate,
      },
    })
    ctx.provide('loader', {
      entries: () => [
        refusedRow('files', update),
        refusedRow('other', unrelated),
        { id: 'held-at-reconnect', fiber: { config: { serverName: 'files' }, await: () => Promise.resolve(), update: held } },
        { id: 'active-other', fiber: { config: { serverName: 'other' }, await: () => Promise.resolve(), update: unrelated } },
        { id: 'failed-otherwise', fiber: { config: { serverName: 'files' }, await: () => Promise.reject(new Error('another failure')), update: unrelated } },
        { id: 'not-a-server', fiber: { config: 'files', await: () => Promise.reject(new Error('never awaited')), update: unrelated } },
        { id: 'not-loaded' },
      ],
    } as never)
    await consent.review(START)
    await expect(consent.acceptReview('files', reviewIdOf(START), true)).resolves.toEqual({ started: 2 })
    expect(update).toHaveBeenCalledWith({ serverName: 'files' }, true)
    expect(held).toHaveBeenCalledWith({ serverName: 'files' }, true)
    expect(unrelated).not.toHaveBeenCalled()
  })
})

/**
 * Register the routes on a fake Connection with a `homeAuth` that places every request on the listener given.
 * @param listener - the listener `homeAuth` reports.
 * @param dangerous - whether `homeAuth` reports dangerous mode.
 * @returns the captured hook and a caller of the captured routes.
 */
function routesOver(listener: string, dangerous = false) {
  let hook: ((request: object, response: ServerResponse, next: () => Promise<void>) => Promise<void>) | undefined
  type Route = { path: string, fetch: (request: Request) => Promise<Response>, admitPeer?: (request: Request, peer: object) => boolean }
  const routes = new Map<string, Route>()
  registerMcpConsentRoutes({
    on: (_name: string, registered: typeof hook) => { hook = registered },
    get: (name: string) => (name === 'homeAuth' ? { arrivalOf: () => ({ listener }), dangerousMode: () => dangerous, unlockModeEnabled: () => false, faceGrants: () => undefined, deviceHasPasskey: () => false, elevationOf: (deviceId: string) => (deviceId === 'unlocked-phone' ? { id: 'e' } : deviceId === 'grace-phone' ? { id: 'g', grace: true } : undefined) } : undefined),
    connection: { fetch: { register: (route: Route) => { routes.set(route.path, route) } } },
  } as never, consent)
  return {
    hook: (path: string, host: string) => {
      const answered: { status?: number, body?: string } = {}
      let reached = false
      const response = { writeHead(status: number) { answered.status = status }, end(body: string) { answered.body = body } }
      return hook!({ url: path, headers: { host } }, response as never, async () => { reached = true }).then(() => ({ reached, ...answered }))
    },
    post: (path: string, body: object) => routes.get(path)!.fetch(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })),
    raw: (path: string, text: string) => routes.get(path)!.fetch(new Request(`http://localhost${path}`, { method: 'POST', body: text })),
    get: (path: string) => routes.get(path)!.fetch(new Request(`http://localhost${path}`)),
    // Run the route as a Peer: admitPeer first, then fetch with the same request, as the Connection does.
    callAs: async (path: string, principal: object, body: object) => {
      const request = new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })
      const route = routes.get(path)!
      if (route.admitPeer?.(request, { principal } as never) !== true) return new Response('forbidden', { status: 403 })
      return route.fetch(request)
    },
    gate: (path: string, principal: object, request: Request) => (routes.get(path)?.admitPeer?.(request, { principal }) === true ? 'admitted' : undefined),
    admits: (path: string, principal: object) => routes.get(path)?.admitPeer?.(new Request(`http://localhost${path}`), { principal }) === true,
  }
}

describe('an accepted start', () => {
  /**
   * A Loader holding one row per server name given, each configured to start the suite's command.
   * @param names - the rows' server names.
   * @returns the rows' update spies, by name.
   */
  function loaderWith(...names: string[]) {
    const updates = new Map(names.map(name => [name, vi.fn(async () => {})]))
    ctx.provide('loader', {
      entries: () => [
        ...names.map(serverName => ({
          id: `mcp-${serverName}`,
          fiber: {
            config: { serverName, command: START.command },
            update: updates.get(serverName),
            await: () => Promise.reject(new McpConsentRefusedError({ ...START, serverName }, 'not accepted')),
          },
        })),
        { id: 'http', fiber: { config: { serverName: 'web', url: 'https://example.com' }, update: vi.fn(), await: () => Promise.resolve() } },
      ],
    } as never)
    return updates
  }

  /**
   * Accept one start through its review.
   * @param start - the start.
   * @returns the start.
   */
  async function accepted(start: McpServerCommand): Promise<McpServerCommand> {
    await consent.review(start)
    await consent.acceptReview(start.serverName, reviewIdOf(start), true)
    return start
  }

  it('is listed per server name, with a value only of a run-affecting variable its configured row still sets', async () => {
    loaderWith('files')
    await accepted({ ...START, env: { ...START.env, PATH: '/opt/bin' } })
    await expect(consent.accepted()).resolves.toEqual([{
      acceptanceId: expect.stringMatching(/^[0-9a-f]{32}$/), serverName: 'files', command: START.command, args: START.args, cwd: START.cwd,
      resolvedCommand: START.resolvedCommand, resolvedCwd: START.resolvedCwd, env: [{ name: 'API_TOKEN' }, { name: 'PATH' }],
      files: [{ path: START.resolvedCommand, sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }], acceptedAt: expect.any(Number), configured: true,
    }])
    expect(JSON.stringify(await consent.accepted())).not.toContain(SECRET)
  })

  it('shows a run-affecting value from the configured row whose value the acceptance holds', async () => {
    const env = { ...START.env, PATH: '/opt/bin' }
    ctx.provide('loader', { entries: () => [{ id: 'mcp-files', fiber: { config: { serverName: 'files', command: 'npx', env }, await: () => Promise.resolve(), update: vi.fn() } }] } as never)
    await accepted({ ...START, env })
    const [listed] = await consent.accepted()
    expect(listed?.env).toEqual([{ name: 'API_TOKEN' }, { name: 'PATH', value: '/opt/bin' }])
    expect(JSON.stringify(listed)).not.toContain(SECRET)
  })

  it('keeps two servers of the same command apart: neither overwrites the other, and each is allowed only its own start', async () => {
    const files = await accepted(START)
    const memory = await accepted({ ...START, serverName: 'memory', args: ['-y', '@modelcontextprotocol/server-memory'] })
    const listed = await consent.accepted()
    expect(listed.map(entry => [entry.serverName, entry.args, entry.configured])).toEqual([['files', files.args, false], ['memory', memory.args, false]])
    expect(new Set(listed.map(entry => entry.acceptanceId)).size).toBe(2)
    await expect(consent.review(files)).resolves.toMatchObject({ allow: true })
    await expect(consent.review(memory)).resolves.toMatchObject({ allow: true })
    await expect(consent.review({ ...memory, serverName: 'files' })).resolves.toMatchObject({ allow: false })
  })

  it('is revoked for one server: the store drops it, only that server\'s rows stop, and its next review is revoked', async () => {
    const updates = loaderWith('files', 'memory')
    await accepted(START)
    const memory = await accepted({ ...START, serverName: 'memory', args: ['-y', '@modelcontextprotocol/server-memory'] })
    updates.get('files')?.mockClear()
    updates.get('memory')?.mockClear()
    const files = (await consent.accepted()).find(entry => entry.serverName === 'files')
    await expect(consent.revokeAcceptance(files?.acceptanceId ?? '', true)).resolves.toEqual({ stopped: 1 })
    expect(updates.get('files')).toHaveBeenCalledWith({ serverName: 'files', command: START.command }, true)
    expect(updates.get('memory')).not.toHaveBeenCalled()
    expect((await consent.accepted()).map(entry => entry.serverName)).toEqual(['memory'])
    await expect(consent.review(memory)).resolves.toMatchObject({ allow: true })
    await expect(consent.review(START)).resolves.toMatchObject({ allow: false, reason: expect.stringContaining('the person revoked this server\'s acceptance') })
    expect(consent.pending()).toEqual([expect.objectContaining({ serverName: 'files', state: 'revoked', change: 'new' })])
  })

  it('stays revoked across a new service instance until the start changes or the person accepts it', async () => {
    await accepted(START)
    const [listed] = await consent.accepted()
    await consent.revokeAcceptance(listed?.acceptanceId ?? '', true)
    const restarted = new DelorunMcpConsent(new Context())
    await restarted.review(START)
    expect(restarted.pending()[0]?.state).toBe('revoked')
    await expect(restarted.acceptReview('files', reviewIdOf(START), true)).resolves.toEqual({ started: 0 })
    await expect(restarted.review(START)).resolves.toMatchObject({ allow: true })
    await restarted.revokeAcceptance((await restarted.accepted())[0]?.acceptanceId ?? '', true)
    await restarted.review({ ...START, cwd: OTHER, resolvedCwd: OTHER })
    expect(restarted.pending()[0]).toMatchObject({ state: 'waiting', change: 'new' })
  })

  it('stays accepted after an unconfirmed or stale revoke', async () => {
    const updates = loaderWith('files')
    await accepted(START)
    // The acceptance itself started the refused row again.
    updates.get('files')?.mockClear()
    const [listed] = await consent.accepted()
    const acceptanceId = listed?.acceptanceId ?? ''
    await expect(consent.revokeAcceptance(acceptanceId, false)).rejects.toThrow(expect.objectContaining({ code: 'UNCONFIRMED' }))
    await expect(consent.revokeAcceptance('0'.repeat(32), true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    // Accepting a changed start of the server replaces the acceptance, so the id shown before it is stale.
    await accepted({ ...START, cwd: OTHER, resolvedCwd: OTHER })
    await expect(consent.revokeAcceptance(acceptanceId, true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    await expect(consent.review({ ...START, cwd: OTHER, resolvedCwd: OTHER })).resolves.toMatchObject({ allow: true })
  })
})

describe('the routes', () => {

  const device = (deviceId: string) => ({ kind: 'reach-device', deviceId, listener: 'reach-tailscale-private' })

  it('lets any approved device read the pending reviews and decline or revoke, locked or not, and nothing else', async () => {
    for (const path of [MCP_CONSENT_ROUTES.pending, MCP_CONSENT_ROUTES.decline, MCP_CONSENT_ROUTES.revoke]) {
      const remote = routesOver('tailscale-private')
      expect(await remote.hook(path, 'home.example.ts.net')).toMatchObject({ reached: true })
      expect(remote.admits(path, device('locked-phone')), path).toBe(true)
      expect(remote.admits(path, device('unlocked-phone')), path).toBe(true)
      expect(remote.admits(path, { kind: 'sdk' }), path).toBe(false)
    }
  })

  it('answers a locked device ELEVATION_REQUIRED on accept and runs it for an unlocked one, in either dangerous mode', async () => {
    for (const mode of [false, true]) {
      const remote = routesOver('tailscale-private', mode)
      const request = new Request(`http://localhost${MCP_CONSENT_ROUTES.accept}`, { method: 'POST', body: JSON.stringify({ serverName: 'files', reviewId: 'x', confirmed: false }) })
      expect(await remote.hook(MCP_CONSENT_ROUTES.accept, 'home.example.ts.net')).toMatchObject({ reached: true })
      // Pins the unlock check: a locked device is admitted to the route but refused by it, with a typed code.
      expect(remote.gate(MCP_CONSENT_ROUTES.accept, device('locked-phone'), request)).toBeDefined()
      const locked = await remote.callAs(MCP_CONSENT_ROUTES.accept, device('locked-phone'), { serverName: 'files', reviewId: 'x', confirmed: false })
      expect([locked.status, await locked.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
      const unlocked = await remote.callAs(MCP_CONSENT_ROUTES.accept, device('unlocked-phone'), { serverName: 'files', reviewId: 'x', confirmed: false })
      expect(unlocked.status).not.toBe(403)
      expect((await remote.callAs(MCP_CONSENT_ROUTES.accept, { kind: 'sdk' }, {})).status).toBe(403)
    }
  })

  it('answers a device holding only the approval grace ELEVATION_REQUIRED on accept, and runs it after a code', async () => {
    const remote = routesOver('tailscale-private')
    const body = { serverName: 'files', reviewId: 'x', confirmed: false }
    // Pins the grace exclusion: accepting a server lets its command run on the computer.
    const grace = await remote.callAs(MCP_CONSENT_ROUTES.accept, device('grace-phone'), body)
    expect([grace.status, await grace.json()]).toEqual([403, expect.objectContaining({ error: 'ELEVATION_REQUIRED' })])
    expect((await remote.callAs(MCP_CONSENT_ROUTES.accept, device('unlocked-phone'), body)).status).not.toBe(403)
    expect(remote.admits(MCP_CONSENT_ROUTES.decline, device('grace-phone'))).toBe(true)
  })

  it('refuses a request the home cannot place, or that names a foreign Host on the loopback listener, before any route runs', async () => {
    const guarded = Object.values(MCP_CONSENT_ROUTES).filter(path => path !== MCP_CONSENT_ROUTES.waiting)
    for (const path of guarded.flatMap(path => [path, path.replace('/api/', '/api/x/../'), path.replace('/api/', '/api/x/%2e%2e/'), path.replace('/api/', '/api\\x\\..\\')])) {
      for (const answered of [await routesOver('loopback').hook(path, 'home.example.ts.net'), await routesOver('unplaced').hook(path, 'localhost:3080')]) {
        if (answered.reached) continue
        expect(answered.status).toBe(403)
        expect(JSON.parse(answered.body ?? '{}')).toMatchObject({ error: 'LOOPBACK_REQUIRED' })
      }
    }
    expect((await routesOver('loopback').hook(MCP_CONSENT_ROUTES.accept, 'home.example.ts.net')).reached).toBe(false)
    expect((await routesOver('loopback').hook(MCP_CONSENT_ROUTES.accept, 'localhost:3080')).reached).toBe(true)
  })

  it('let a reach device read only the waiting servers\' names and what changed', async () => {
    const remote = routesOver('tailscale-private')
    expect((await remote.hook(MCP_CONSENT_ROUTES.waiting, 'home.example.ts.net')).reached).toBe(true)
    expect(remote.admits(MCP_CONSENT_ROUTES.waiting, { kind: 'reach-device', deviceId: 'phone', listener: 'reach-tailscale-private' })).toBe(true)
    expect(remote.admits(MCP_CONSENT_ROUTES.waiting, { kind: 'sdk' })).toBe(false)
        await consent.review(START)
    await consent.review({ ...START, serverName: 'declined' })
    await consent.declineReview('declined', reviewIdOf({ ...START, serverName: 'declined' }))
    const answered = await (await remote.get(MCP_CONSENT_ROUTES.waiting)).text()
    expect(JSON.parse(answered)).toEqual({ servers: [{ serverName: 'files', change: 'new' }] })
    expect(answered).not.toContain('npx')
    expect(answered).not.toContain('API_TOKEN')
  })

  it('revoke a confirmed, current acceptance, and refuse an unconfirmed, stale or malformed revoke with its code', async () => {
    const routes = routesOver('loopback')
    await consent.review(START)
    await consent.acceptReview('files', reviewIdOf(START), true)
    const listed = await (await routes.get(MCP_CONSENT_ROUTES.pending)).json() as { accepted: { acceptanceId: string }[] }
    const acceptanceId = listed.accepted[0]?.acceptanceId ?? ''
    const unconfirmed = await routes.post(MCP_CONSENT_ROUTES.revoke, { acceptanceId, confirmed: false })
    expect([unconfirmed.status, await unconfirmed.json()]).toEqual([400, expect.objectContaining({ error: 'UNCONFIRMED' })])
    const stale = await routes.post(MCP_CONSENT_ROUTES.revoke, { acceptanceId: 'f'.repeat(32), confirmed: true })
    expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ error: 'STALE_REVIEW' })])
    for (const body of [{ acceptanceId: 'files', confirmed: true }, { command: 'npx', acceptedAt: 1, confirmed: true }, { acceptanceId, confirmed: true, extra: 1 }]) {
      const malformed = await routes.post(MCP_CONSENT_ROUTES.revoke, body)
      expect([malformed.status, await malformed.json()]).toEqual([400, expect.objectContaining({ error: 'INVALID_REQUEST' })])
    }
    await expect(consent.review(START)).resolves.toMatchObject({ allow: true })
    const revoked = await routes.post(MCP_CONSENT_ROUTES.revoke, { acceptanceId, confirmed: true })
    expect([revoked.status, await revoked.json()]).toEqual([200, { stopped: 0 }])
    await expect(consent.review(START)).resolves.toMatchObject({ allow: false })
  })

  it('accept a confirmed, current review, and refuse an unconfirmed, stale or malformed answer with its code', async () => {
    const routes = routesOver('loopback')
    await consent.review(START)
    const listed = await (await routes.get(MCP_CONSENT_ROUTES.pending)).json() as { servers: { reviewId: string }[] }
    const reviewId = listed.servers[0]?.reviewId ?? ''
    const unconfirmed = await routes.post(MCP_CONSENT_ROUTES.accept, { serverName: 'files', reviewId, confirmed: false })
    expect([unconfirmed.status, await unconfirmed.json()]).toEqual([400, expect.objectContaining({ error: 'UNCONFIRMED' })])
    const stale = await routes.post(MCP_CONSENT_ROUTES.accept, { serverName: 'files', reviewId: '0'.repeat(32), confirmed: true })
    expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ error: 'STALE_REVIEW' })])
    const malformed = await routes.post(MCP_CONSENT_ROUTES.decline, { serverName: 'files; rm', reviewId })
    expect([malformed.status, await malformed.json()]).toEqual([400, expect.objectContaining({ error: 'INVALID_REQUEST' })])
    expect(storeText()).toBeUndefined()
    const accepted = await routes.post(MCP_CONSENT_ROUTES.accept, { serverName: 'files', reviewId, confirmed: true })
    expect([accepted.status, await accepted.json()]).toEqual([200, { started: 0 }])
    await expect(consent.review(START)).resolves.toMatchObject({ allow: true })
  })
})

describe('the mounted plugin', () => {
  it('provides its pending reviews as mcpReviews while the switch is on', async () => {
    const mountedCtx = new Context()
    try {
      await apply(mountedCtx, { enabled: true, ask: 'outside' })
      expect(mountedCtx.get('mcpReviews')).toBeInstanceOf(DelorunMcpConsent)
      expect(mountedCtx.get('mcpReviews')?.pending()).toEqual([])
    } finally {
      await mountedCtx.fiber.dispose()
    }
  })
})

/**
 * Run a check with the acceptance store's directory unwritable, restoring it afterwards.
 * @param check - the check.
 */
async function withReadOnlyStoreDirectory(check: () => Promise<void>): Promise<void> {
  const directory = join(acceptanceStorePath(join(root, 'home')), '..')
  chmodSync(directory, 0o500)
  try {
    await check()
  } finally {
    chmodSync(directory, 0o700)
  }
}

describe('the service when something fails', () => {
  it('lists no accepted server while the home cannot be resolved, and refuses a revoke there', async () => {
    vi.stubEnv('DELORUN_HOME', join(homedir(), '.dsh'))
    await expect(consent.accepted()).resolves.toEqual([])
    await expect(consent.revokeAcceptance('0'.repeat(32), true)).rejects.toThrow(expect.objectContaining({ code: 'STORE_REFUSED' }))
  })

  it('lists accepted servers sorted by name, with the command shell of a batch file', async () => {
    for (const serverName of ['mid', 'alpha', 'zed']) await consent.accept({ ...START, serverName })
    await consent.accept({ ...START, serverName: 'shell', resolvedShell: '/Windows/System32/cmd.exe' })
    const listed = await consent.accepted()
    expect(listed.map(entry => entry.serverName)).toEqual(['alpha', 'mid', 'shell', 'zed'])
    expect(listed.find(entry => entry.serverName === 'shell')?.resolvedShell).toBe('/Windows/System32/cmd.exe')
    expect(listed.find(entry => entry.serverName === 'alpha')).not.toHaveProperty('resolvedShell')
  })

  it('refuses a revoke while no store exists or the store cannot be read or written, changing nothing', async () => {
    await expect(consent.revokeAcceptance('0'.repeat(32), true)).rejects.toThrow(expect.objectContaining({ code: 'STALE_REVIEW' }))
    await consent.accept(START)
    const [listed] = await consent.accepted()
    await withReadOnlyStoreDirectory(async () => {
      await expect(consent.revokeAcceptance(listed?.acceptanceId ?? '', true)).rejects.toThrow(expect.objectContaining({ code: 'STORE_REFUSED' }))
    })
    expect((await consent.accepted()).map(entry => entry.serverName)).toEqual(['files'])
    writeFileSync(acceptanceStorePath(join(root, 'home')), '{ not json', { mode: 0o600 })
    await expect(consent.revokeAcceptance(listed?.acceptanceId ?? '', true)).rejects.toThrow(expect.objectContaining({ code: 'STORE_REFUSED' }))
  })

  it('counts only rows that stop with this consent\'s refusal after a revoke', async () => {
    const config = { serverName: 'files', command: START.command, env: { PATH: '/opt/bin', COUNT: 1 } }
    const refusal = Object.assign(new Error('not accepted'), { name: 'McpConsentRefusedError' })
    ctx.provide('loader', {
      entries: () => [
        { id: 'still-running', fiber: { config, update: vi.fn(async () => {}), await: () => Promise.resolve() } },
        { id: 'update-fails', fiber: { config, update: vi.fn(async () => Promise.reject(new Error('cannot apply'))), await: () => Promise.resolve() } },
        { id: 'update-throws-text', fiber: { config, update: vi.fn(async () => Promise.reject('cannot apply')), await: () => Promise.resolve() } },
        { id: 'refusal-without-server', fiber: { config, update: vi.fn(async () => {}), await: () => Promise.reject(refusal) } },
        { id: 'no-name', fiber: { config: { command: START.command }, update: vi.fn(), await: () => Promise.resolve() } },
        { id: 'not-an-object', fiber: { config: 'files', update: vi.fn(), await: () => Promise.resolve() } },
      ],
    } as never)
    await consent.accept(START)
    const [listed] = await consent.accepted()
    expect(listed?.configured).toBe(true)
    await expect(consent.revokeAcceptance(listed?.acceptanceId ?? '', true)).resolves.toEqual({ stopped: 0 })
  })

  it('records nothing and refuses an acceptance while the store cannot be read', async () => {
    const path = acceptanceStorePath(join(root, 'home'))
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(path, '{ not json', { mode: 0o600 })
    await consent.review(START)
    await expect(consent.acceptReview('files', reviewIdOf(START), true)).rejects.toThrow(expect.objectContaining({ code: 'STORE_REFUSED' }))
    expect(storeText()).toBe('{ not json')
    expect(consent.pending()).toHaveLength(1)
  })

  it('keeps a review of the server made while its acceptance was recorded', async () => {
    const changed = { ...START, args: [...START.args, '/home'] }
    const accept = consent.accept.bind(consent)
    vi.spyOn(consent, 'accept').mockImplementation(async (start) => {
      await consent.review(changed)
      return accept(start)
    })
    await consent.review(START)
    await consent.acceptReview('files', reviewIdOf(START), true)
    expect(consent.pending()).toEqual([expect.objectContaining({ reviewId: reviewIdOf(changed) })])
  })

  it('keeps an accepted server stopped when its refused row does not start again', async () => {
    ctx.provide('loader', {
      entries: () => [{
        id: 'mcp-files',
        fiber: {
          config: { serverName: 'files' },
          await: () => Promise.reject(new McpConsentRefusedError(START, 'not accepted')),
          update: vi.fn(async () => Promise.reject(new Error('cannot apply'))),
        },
      }],
    } as never)
    await consent.review(START)
    await expect(consent.acceptReview('files', reviewIdOf(START), true)).resolves.toEqual({ started: 0 })
  })

  it('keeps a set-aside start when it cannot be dropped, and drops it once only when two reviews race', async () => {
    await consent.review(START)
    await consent.declineReview('files', reviewIdOf(START))
    await withReadOnlyStoreDirectory(async () => {
      await expect(consent.review({ ...START, args: [] })).resolves.toMatchObject({ allow: false })
    })
    expect(storeText()).toContain('declined')
    await Promise.all([consent.review({ ...START, args: ['a'] }), consent.review({ ...START, args: ['b'] })])
    expect(storeText()).not.toContain('declined')
  })

  it('keeps a set-aside start when the store cannot be read by the time it would be dropped', async () => {
    await consent.review(START)
    await consent.declineReview('files', reviewIdOf(START))
    const path = acceptanceStorePath(join(root, 'home'))
    const serial: unknown = Reflect.get(consent, 'serial')
    if (typeof serial !== 'function') throw new Error('no serial queue')
    Reflect.set(consent, 'serial', (change: () => Promise<unknown>) => {
      // The store is replaced after the review read it and before the drop reads it again.
      writeFileSync(path, '{ not json', { mode: 0o600 })
      return Reflect.apply(serial, consent, [change])
    })
    await expect(consent.review({ ...START, args: [] })).resolves.toMatchObject({ allow: false })
    expect(storeText()).toBe('{ not json')
  })
})

describe('the routes when a request is not the message', () => {
  it('refuse a body over the limit, a body that is not JSON and a decline without its fields', async () => {
    const routes = routesOver('loopback')
    await consent.review(START)
    const oversized = await routes.post(MCP_CONSENT_ROUTES.accept, { serverName: 'files', reviewId: 'x'.repeat(9000), confirmed: true })
    expect([oversized.status, await oversized.json()]).toEqual([400, expect.objectContaining({ error: 'INVALID_REQUEST' })])
    const notJson = await routes.raw(MCP_CONSENT_ROUTES.accept, '{')
    expect(notJson.status).toBe(400)
    const decline = await routes.post(MCP_CONSENT_ROUTES.decline, { serverName: 'files' })
    expect([decline.status, await decline.json()]).toEqual([400, expect.objectContaining({ error: 'INVALID_REQUEST' })])
    const declined = await routes.post(MCP_CONSENT_ROUTES.decline, { serverName: 'files', reviewId: reviewIdOf(START) })
    expect([declined.status, await declined.json()]).toEqual([200, { declined: true }])
    expect(storeText()).toContain('declined')
  })

  it('pass on a failure that is not a refusal to the Connection', async () => {
    const routes = routesOver('loopback')
    vi.spyOn(consent, 'pending').mockImplementation(() => { throw new Error('broken') })
    await expect(routes.get(MCP_CONSENT_ROUTES.pending)).rejects.toThrow('broken')
  })

  it('are registered when the plugin is mounted where a Connection serves the studio', async () => {
    const mountedCtx = new Context()
    const register = vi.fn<(route: { readonly path: string }) => void>()
    try {
      mountedCtx.provide('connection', { fetch: { register } } as never)
      await apply(mountedCtx, { enabled: true, ask: 'outside' })
      expect(register.mock.calls.map(([route]) => route.path).sort()).toEqual(Object.values(MCP_CONSENT_ROUTES).sort())
    } finally {
      await mountedCtx.fiber.dispose()
    }
  })
})
