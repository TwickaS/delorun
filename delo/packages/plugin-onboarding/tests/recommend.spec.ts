/**
 * Which connections each recommended plugin is for: read from an installed package's manifest, and from the registry
 * only when the person asks; a package neither can be read for is shown without a match, never hidden.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, Config, declaredConnections, inject, name, RECOMMEND_PATH, RecommendAnswer } from '../src/index.ts'
import { installedReader, recommend, registryReader, type RecommendDeps } from '../src/recommend.ts'

let scratch = ''
beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), 'delo-onboarding-recommend-')) })
afterEach(async () => { await rm(scratch, { recursive: true, force: true }) })

/** Install a package under a directory's node_modules with the given manifest. */
async function install(directory: string, manifest: Record<string, unknown> | string): Promise<void> {
  const name = typeof manifest === 'string' ? 'raw' : String(manifest['name'])
  const target = join(directory, 'node_modules', name)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
}

/** A local registry that answers each package's latest manifest from a table, recording what it was asked. */
async function registry(handle: (path: string, response: ServerResponse) => void): Promise<{ readonly url: string; readonly paths: string[] }> {
  const paths: string[] = []
  const server: Server = createServer((request, response) => { paths.push(request.url ?? ''); handle(request.url ?? '', response) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${String(address.port)}/`, paths }
}

const answer = (response: ServerResponse, status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }

describe('a manifest\'s connections', () => {
  it('are the delo.connections list, empty without one, and unreadable when it is malformed', () => {
    expect(declaredConnections({ delo: { connections: ['agent:codex', 'provider:deepseek-official', 'tool:tailscale'] } })).toEqual(['agent:codex', 'provider:deepseek-official', 'tool:tailscale'])
    expect(declaredConnections({ name: 'x' })).toEqual([])
    expect(declaredConnections({ delo: { state: 'shipped' } })).toEqual([])
    for (const bad of [{ delo: { connections: ['codex'] } }, { delo: { connections: ['agent:Codex'] } }, { delo: { connections: 'agent:codex' } }, { delo: { connections: Array.from({ length: 17 }, () => 'agent:codex') } }, 'text']) {
      expect(declaredConnections(bad)).toBeUndefined()
    }
  })
})

describe('the recommendations', () => {
  const deps = (change: Partial<RecommendDeps> = {}): RecommendDeps => ({
    installed: async (pkg) => (pkg === 'local' ? { delo: { connections: ['agent:codex'] } } : pkg === 'malformed' ? { delo: { connections: 'x' } } : undefined),
    registry: vi.fn(async (pkg: string) => (pkg === 'remote' ? { delo: { connections: ['tool:tailscale'] } } : pkg === 'unpublished' ? undefined : { name: pkg })),
    timeoutMs: 1000,
    ...change,
  })

  it('read installed packages from disk and leave the rest unknown without asking the registry', async () => {
    const parts = deps()
    expect(await recommend(['local', 'remote', 'malformed'], false, parts)).toEqual({ plugins: [
      { name: 'local', connections: ['agent:codex'], source: 'installed' },
      { name: 'remote', connections: [], source: 'unknown' },
      { name: 'malformed', connections: [], source: 'unknown' },
    ], registry: 'not-asked' })
    expect(parts.registry).not.toHaveBeenCalled()
  })

  it('read the rest from the registry when asked, a package it does not have as unknown', async () => {
    const parts = deps()
    expect(await recommend(['local', 'remote', 'plain', 'unpublished'], true, parts)).toEqual({ plugins: [
      { name: 'local', connections: ['agent:codex'], source: 'installed' },
      { name: 'remote', connections: ['tool:tailscale'], source: 'registry' },
      { name: 'plain', connections: [], source: 'registry' },
      { name: 'unpublished', connections: [], source: 'unknown' },
    ], registry: 'reached' })
    expect(parts.registry).not.toHaveBeenCalledWith('local', expect.anything())
  })

  it('say the registry could not be reached when one request fails, and show what they know', async () => {
    const parts = deps({ registry: async (pkg) => { if (pkg === 'down') throw new Error('ECONNREFUSED'); return { delo: { connections: ['agent:codex'] } } } })
    expect(await recommend(['remote', 'down'], true, parts)).toEqual({ plugins: [
      { name: 'remote', connections: ['agent:codex'], source: 'registry' },
      { name: 'down', connections: [], source: 'unknown' },
    ], registry: 'unreachable' })
    expect(RecommendAnswer.parse(await recommend([], true, parts))).toEqual({ plugins: [], registry: 'reached' })
  })
})

describe('reading an installed package', () => {
  it('reads the profile\'s directory first, then the installation', async () => {
    const profile = join(scratch, 'profile')
    const installation = join(scratch, 'installation')
    await install(profile, { name: '@scope/both', delo: { connections: ['agent:codex'] } })
    await install(installation, { name: '@scope/both', delo: { connections: ['tool:tailscale'] } })
    await install(installation, { name: 'only-installed', version: '1.0.0' })
    await mkdir(installation, { recursive: true })
    const read = installedReader(profile, join(installation, 'anchor.js'))
    expect(await read('@scope/both')).toMatchObject({ delo: { connections: ['agent:codex'] } })
    expect(await read('only-installed')).toMatchObject({ version: '1.0.0' })
    expect(await read('absent')).toBeUndefined()
    expect(await installedReader(undefined, join(installation, 'anchor.js'))('@scope/both')).toMatchObject({ delo: { connections: ['tool:tailscale'] } })
  })

  it('treats a manifest it cannot parse, or one over the limit, as not installed', async () => {
    const installation = join(scratch, 'installation')
    await install(installation, { name: 'broken' })
    await writeFile(join(installation, 'node_modules', 'broken', 'package.json'), '{ not json')
    await install(installation, { name: 'huge', padding: 'x'.repeat(600 * 1024) })
    const read = installedReader(undefined, join(installation, 'anchor.js'))
    expect(await read('broken')).toBeUndefined()
    expect(await read('huge')).toBeUndefined()
  })
})

describe('reading the registry', () => {
  it('asks for a package\'s latest manifest, with a scoped name escaped', async () => {
    const local = await registry((_path, response) => { answer(response, 200, { delo: { connections: ['agent:codex'] } }) })
    const read = registryReader(local.url)
    expect(await read('@scope/pkg', AbortSignal.timeout(5000))).toEqual({ delo: { connections: ['agent:codex'] } })
    expect(local.paths).toEqual(['/@scope%2fpkg/latest'])
  })

  it('reads a 404 as a package it does not have, and refuses another failure, a redirect and an oversized answer', async () => {
    const local = await registry((path, response) => {
      if (path.startsWith('/missing')) answer(response, 404, { error: 'Not found' })
      else if (path.startsWith('/error')) answer(response, 500, {})
      else if (path.startsWith('/moved')) { response.writeHead(302, { location: 'http://example.invalid/' }); response.end() }
      else answer(response, 200, { padding: 'x'.repeat(600 * 1024) })
    })
    const read = registryReader(local.url)
    expect(await read('missing', AbortSignal.timeout(5000))).toBeUndefined()
    await expect(read('error', AbortSignal.timeout(5000))).rejects.toThrow(/HTTP 500/)
    await expect(read('moved', AbortSignal.timeout(5000))).rejects.toThrow()
    await expect(read('huge', AbortSignal.timeout(5000))).rejects.toThrow(/more than a manifest/)
  })
})

describe('the recommendations route', () => {
  async function mount(plugins: string[]) {
    const ctx = new Context()
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    ctx.provide('connection', { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route.fetch); return () => { routes.delete(route.path) } } } } as never)
    const fiber = ctx.plugin({ name, inject: [...inject], Config, apply }, { plugins })
    await fiber.await()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const route = routes.get(RECOMMEND_PATH)
    if (route === undefined) throw new Error('no route')
    return (body: string) => route(new Request('http://harness.test/api', { method: 'POST', body }))
  }

  it('answers the configured packages without asking the registry', async () => {
    const post = await mount(['not-installed-anywhere'])
    const response = await post(JSON.stringify({ registry: false }))
    expect(response.status).toBe(200)
    expect(RecommendAnswer.parse(await response.json())).toEqual({ plugins: [{ name: 'not-installed-anywhere', connections: [], source: 'unknown' }], registry: 'not-asked' })
  })

  it.each(['not json', '{}', JSON.stringify({ registry: 'yes' }), JSON.stringify({ registry: true, extra: 1 })])('refuses the body %s with 400', async (body) => {
    const post = await mount([])
    expect((await post(body)).status).toBe(400)
  })
})
