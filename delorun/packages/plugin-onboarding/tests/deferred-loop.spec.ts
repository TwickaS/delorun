/**
 * The phone-to-computer loop across both halves: the studio half's `defer` call reaches the harness half's route, the
 * step is kept in the profile directory, and the setup record the computer's studio reads lists it, until it is cleared.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, DEFER_STEP_PATH, DeferStepAnswer, inject, name, SETUP_RECORD_PATH, SetupRecord } from '../src/index.ts'
import { DEFERRED_FILENAME } from '../src/deferred.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** The studio half's call, as `hostApi.defer` makes it: a relative POST that answers the deferred steps, or undefined when refused. */
async function defer(id: string, deferred: boolean): Promise<readonly string[] | undefined> {
  const response = await fetch(DEFER_STEP_PATH.slice(1), { method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ id, deferred }) })
  return response.ok ? DeferStepAnswer.parse(await response.json()).deferred : undefined
}

/** The harness half over a stub Connection, with the studio half's `fetch` pointed at its routes. */
async function bothHalves() {
  const directory = await mkdtemp(join(tmpdir(), 'delorun-deferred-loop-'))
  const ctx = new Context()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  ctx.provide('connection', { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => { routes.set(route.path, route.fetch); return () => { routes.delete(route.path) } } } } as never)
  ctx.provide('settings', { configure: () => () => {} } as never)
  ctx.provide('profileContext', { dir: directory } as never)
  vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  await ctx.plugin({ name, inject: [...inject], Config, apply }).await()
  // The studio fetches routes without their leading slash, relative to the document.
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const route = routes.get(`/${path}`)
    if (route === undefined) return new Response('{}', { status: 404 })
    return route(new Request(`http://studio.test/${path}`, init))
  })
  const record = async () => SetupRecord.parse(await (await fetch(SETUP_RECORD_PATH.slice(1))).json())
  return { directory, record, dispose: async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

describe('deferring a step from a phone and finishing it at the computer', () => {
  it('lists the step on the setup record after the phone defers it, and drops it once it is cleared', async () => {
    const { directory, record, dispose } = await bothHalves()
    try {
      expect((await record()).deferred).toBeUndefined()
      expect(await defer('pin', true)).toEqual(['pin'])
      expect((await record()).deferred).toEqual(['pin'])
      expect(JSON.parse(await readFile(join(directory, DEFERRED_FILENAME), 'utf8'))).toEqual({ version: 1, deferred: ['pin'] })
      expect(await defer('pin', false)).toEqual([])
      expect((await record()).deferred).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('answers undefined, not a rejection, when the route refuses the call', async () => {
    const { dispose } = await bothHalves()
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(await defer('workspace', true)).toBeUndefined()
      expect(DEFER_STEP_PATH).toBe('/api/delorunOnboarding.deferStep')
    } finally {
      await dispose()
    }
  })
})
