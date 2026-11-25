import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { DEFERRED_FILENAME } from '../src/deferred.ts'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  apply, Config, DEFAULT_SETTINGS, inject, MAX_ANSWERS_BYTES, name, NO_RECORD, ONBOARDING_ROW_ID, readSetupRecord, RECOMMENDED_LIMIT,
  DEFER_STEP_PATH, KEY_TEST_PATH, LOCAL_MODELS_PATH, READINESS_PATH, Readiness, RECOMMEND_PATH, SETUP_ANSWERS_FILENAME, SETUP_RECORD_PATH, SetupRecord, START_ID, START_PATH, StartAnswer, type OnboardingSettings,
} from '../src/index.ts'
import { THEME_ROW_ID } from '../src/config.ts'
import { THEME_ROW_ID as THEME_ROW } from '../../plugin-theme/src/config.ts'
import { REACH_OPTIONS, SECTION_STATUSES } from '../../contract-setup-answers/src/index.ts'

/** A marker no served field or log line may contain. */
const SECRET = 'sk-test-secret-marker-7f3a'

/** A profile directory holding one file, or none. */
async function profile(file?: string | { readonly raw: string }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delorun-onboarding-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  if (file !== undefined) await writeFile(join(directory, SETUP_ANSWERS_FILENAME), typeof file === 'string' ? file : file.raw)
  return directory
}

const answers = (extra: object = {}) => JSON.stringify({ schemaVersion: 2, reach: { option: 'none', identityFactor: null }, sections: [], ...extra })

/** The configuration as plain values: each volatile field read. */
function plain(value: object | undefined): OnboardingSettings {
  const config = Config(value)
  return { done: config.done.get(), step: config.step.get(), plugins: [...config.plugins.get()], optionalRows: [...config.optionalRows.get()], pausedStart: config.pausedStart.get(), addWaitSeconds: config.addWaitSeconds.get(), browser: config.browser.get(), browserPack: config.browserPack.get(), dismissedSteps: [...config.dismissedSteps.get()] }
}

describe('the configuration', () => {
  // Browser is on until the person turns it off, so an empty choice must stay accepted and anything else but on or off refused.
  it('keeps the Browser choice empty until the person chooses, and accepts only on or off', () => {
    expect(plain({}).browser).toBe('')
    expect(plain({ browser: 'on' }).browser).toBe('on')
    expect(plain({ browser: 'off' }).browser).toBe('off')
    expect(() => plain({ browser: 'maybe' })).toThrow()
  })

  // A dismissal names the steps it covered, so it can be lifted when a step the person has not dismissed arrives.
  it('keeps the dismissed steps empty until the person dismisses the entry, and accepts only step ids', () => {
    expect(plain({}).dismissedSteps).toEqual([])
    expect(plain({ dismissedSteps: ['pin', 'reach'] }).dismissedSteps).toEqual(['pin', 'reach'])
    expect(() => plain({ dismissedSteps: ['Not A Step'] })).toThrow()
    expect(() => plain({ dismissedSteps: ['pin', 'pin', 'reach', 'approve'] })).toThrow()
  })

  it('names the row, defaults to a profile that has not started and offers no packages', () => {
    expect(ONBOARDING_ROW_ID).toBe('delorun-onboarding')
    expect(DEFAULT_SETTINGS).toEqual({ done: false, step: '', plugins: [], optionalRows: [], pausedStart: '', addWaitSeconds: 60, browser: '', browserPack: '', dismissedSteps: [] })
    expect(plain(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps the theme row id the look step edits the same as the theme plugin names it', () => {
    expect(THEME_ROW_ID).toBe(THEME_ROW)
  })

  it('makes every field volatile, so the studio can read and write all of them', () => {
    for (const field of Object.keys(DEFAULT_SETTINGS)) expect(Config.dict?.[field]?.meta.volatile).toBe(true)
  })

  it.each<readonly [string, object]>([
    ['a step id with a capital', { step: 'Look' }],
    ['a step id of a path', { step: '../look' }],
    ['a paused start that is not an id', { pausedStart: 'a b' }],
    ['a registry that is not https', { registry: 'http://registry.example' }],
    ['a timeout of zero', { keyTestTimeoutMs: 0 }],
    ['a package name with a capital', { plugins: ['Bad'] }],
    ['a package that is a path', { plugins: ['../x'] }],
    ['a row id with a capital', { optionalRows: ['Delorun-Cost-Meter'] }],
    ['a row id that is a path', { optionalRows: ['../x'] }],
    ['a package that is a URL', { plugins: ['https://example.test/p.tgz'] }],
    ['more packages than the step lists', { plugins: Array.from({ length: RECOMMENDED_LIMIT + 1 }, (_, index) => `p${String(index)}`) }],
  ])('refuses %s', (_, value) => {
    expect(() => Config(value)).toThrow()
  })

  it('accepts scoped and plain package names', () => {
    expect(plain({ plugins: ['@scope/plugin-name', 'plain.name'], step: 'thinking.reader', done: true, addWaitSeconds: 60 }))
      .toEqual({ plugins: ['@scope/plugin-name', 'plain.name'], optionalRows: [], pausedStart: '', step: 'thinking.reader', done: true, addWaitSeconds: 60, browser: '', browserPack: '', dismissedSteps: [] })
  })
})

describe('the setup record', () => {
  it('is empty where the harness has no profile directory, and where the file is absent, without a warning', async () => {
    const warn = vi.fn()
    expect(await readSetupRecord(undefined, warn)).toBe(NO_RECORD)
    expect(await readSetupRecord(await profile(), warn)).toBe(NO_RECORD)
    expect(warn).not.toHaveBeenCalled()
  })

  it('says reach is not set up for the none option and set up for every other option setup offers', async () => {
    expect(await readSetupRecord(await profile(answers()), vi.fn())).toEqual({ sections: [], reachSetUp: false })
    for (const option of REACH_OPTIONS.filter(each => each !== 'none')) {
      expect(await readSetupRecord(await profile(answers({ reach: { option, identityFactor: 'passkey' } })), vi.fn())).toEqual({ sections: [], reachSetUp: true })
    }
  })

  it('reads the profile directory file name the CLI writes', () => {
    const source = readFileSync(join(import.meta.dirname, '../../setup-apply/src/answers-record.ts'), 'utf8')
    expect(source).toContain(`export const ANSWERS_FILENAME = '${SETUP_ANSWERS_FILENAME}'`)
  })

  it('carries the sections the terminal showed or asked, and leaves out the ones it skipped', async () => {
    const sections = [{ id: 'privacy', status: 'seen' }, { id: 'key', status: 'answered' }, { id: 'reach', status: 'skipped' }]
    expect(await readSetupRecord(await profile(answers({ sections })), vi.fn())).toEqual({ sections: ['privacy', 'key'], reachSetUp: false })
  })

  it('reads the section statuses setup writes', () => {
    expect(SECTION_STATUSES).toEqual(['seen', 'answered', 'skipped'])
  })

  it('ignores a sections record it does not read, with a warning, and keeps the reach answer', async () => {
    const warn = vi.fn()
    const row = (id: string, status = 'answered') => ({ id, status })
    for (const sections of ['reach', ['reach'], [1], [row('Has Capital')], [row('a'.repeat(41))], [row('reach', 'maybe')], Array.from({ length: 33 }, () => row('a'))]) {
      expect(await readSetupRecord(await profile(answers({ sections })), warn)).toEqual({ reachSetUp: false })
    }
    expect(warn).toHaveBeenCalledTimes(7)
  })

  it('reads a record that carries no sections field as covering nothing by name', async () => {
    expect(await readSetupRecord(await profile(JSON.stringify({ schemaVersion: 2, reach: { option: 'none', identityFactor: null } })), vi.fn())).toEqual({ reachSetUp: false })
  })

  it('tolerates fields it does not use and never serves them', async () => {
    const record = await readSetupRecord(await profile(answers({ modelProvider: { credential: { name: SECRET } }, extra: SECRET })), vi.fn())
    expect(record).toEqual({ sections: [], reachSetUp: false })
    expect(JSON.stringify(record)).not.toContain(SECRET)
  })

  it.each<readonly [string, string]>([
    ['not JSON', `{"reach": ${SECRET}`],
    ['an empty file', ''],
    ['a JSON array', `[{"reach":{"option":"${SECRET}"}}]`],
    ['a JSON null', 'null'],
    ['a document without the reach answer', JSON.stringify({ note: SECRET })],
    ['a reach answer that is not an object', JSON.stringify({ reach: SECRET })],
    ['a reach option that is not a string', JSON.stringify({ reach: { option: { secret: SECRET } } })],
    ['an empty reach option', JSON.stringify({ reach: { option: '' } })],
    ['a reach option over 64 characters', JSON.stringify({ reach: { option: SECRET.padEnd(65, 'x') } })],
  ])('shows every step and warns, without quoting the file, for %s', async (_, text) => {
    const warn = vi.fn()
    expect(await readSetupRecord(await profile(text), warn)).toBe(NO_RECORD)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(SECRET)
  })

  it('refuses a file over the size limit without reading it', async () => {
    const warn = vi.fn()
    const big = answers({ filler: 'x'.repeat(MAX_ANSWERS_BYTES) })
    expect(await readSetupRecord(await profile({ raw: big }), warn)).toBe(NO_RECORD)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('refuses a name that is a directory, and one that is a link to a directory', async () => {
    const warn = vi.fn()
    const directory = await profile()
    await mkdir(join(directory, SETUP_ANSWERS_FILENAME))
    expect(await readSetupRecord(directory, warn)).toBe(NO_RECORD)
    const linked = await profile()
    await symlink(directory, join(linked, SETUP_ANSWERS_FILENAME))
    expect(await readSetupRecord(linked, warn)).toBe(NO_RECORD)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('warns, without the system message, when the file cannot be read', async () => {
    const warn = vi.fn()
    const file = join(await profile(), 'not-a-directory')
    await writeFile(file, 'x')
    expect(await readSetupRecord(file, warn)).toBe(NO_RECORD)
    const locked = await profile(answers())
    await chmod(join(locked, SETUP_ANSWERS_FILENAME), 0o000)
    // A superuser reads the file anyway, which is not the case under test.
    const reads = process.getuid?.() === 0 ? 1 : 0
    expect(await readSetupRecord(locked, warn)).toEqual(reads === 1 ? { reachSetUp: false } : NO_RECORD)
    expect(warn).toHaveBeenCalledTimes(1 + (1 - reads))
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('EACCES')
  })

  it('parses only the shape the route answers', () => {
    expect(SetupRecord.parse({ reachSetUp: true, sections: ['reach'] })).toEqual({ reachSetUp: true, sections: ['reach'] })
    expect(() => SetupRecord.parse({ reachSetUp: true, secret: SECRET })).toThrow()
    expect(() => SetupRecord.parse({})).toThrow()
  })
})

/** The plugin over a stub Connection, reached as the studio reaches the route. */
async function mount(directory: string | undefined) {
  const ctx = new Context()
  const routes = new Map<string, { readonly methods: readonly string[]; readonly requestBody: string; readonly fetch: (request: Request) => Promise<Response> }>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; methods: readonly string[]; requestBody: string; fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  } as never)
  const unconfigure = vi.fn()
  const configure = vi.fn(() => unconfigure)
  ctx.provide('settings', { configure } as never)
  if (directory !== undefined) ctx.provide('profileContext', { dir: directory } as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const fiber = ctx.plugin({ name, inject: [...inject], Config, apply })
  await fiber.await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const route = routes.get(SETUP_RECORD_PATH)
  if (route === undefined) throw new Error('no route')
  const defer = (body: unknown) => routes.get(DEFER_STEP_PATH)!.fetch(new Request('http://harness.test/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
  return { defer, ctx, fiber, routes, route, warn, configure, unconfigure, get: () => route.fetch(new Request('http://harness.test/api', { method: 'GET' })) }
}

describe('the route', () => {
  it('is one exact GET route that serves the record uncached, beside the guide\'s read-only routes', async () => {
    const { routes, route, get } = await mount(await profile(answers({ reach: { option: 'tailscale-private' }, sections: [{ id: 'reach', status: 'answered' }] })))
    expect([...routes.keys()]).toEqual([SETUP_RECORD_PATH, DEFER_STEP_PATH, READINESS_PATH, START_PATH, KEY_TEST_PATH, LOCAL_MODELS_PATH, RECOMMEND_PATH])
    expect(SETUP_RECORD_PATH).toBe('/api/delorunOnboarding.setupRecord')
    expect([route.methods, route.requestBody]).toEqual([['GET'], 'buffered'])
    const response = await get()
    expect([response.status, response.headers.get('cache-control'), response.headers.get('content-type')]).toEqual([200, 'no-store', 'application/json'])
    expect(await response.json()).toEqual({ sections: ['reach'], reachSetUp: true })
  })

  it('answers this computer\'s readiness and, without a model runtime, a key test that lists no provider', async () => {
    // An empty home and a PATH without tailscale, so the answer does not depend on this computer.
    const empty = await mkdtemp(join(tmpdir(), 'delorun-onboarding-readiness-'))
    onTestFinished(async () => { vi.unstubAllEnvs(); await rm(empty, { recursive: true, force: true }) })
    vi.stubEnv('HOME', empty)
    vi.stubEnv('PATH', empty)
    vi.stubEnv('CODEX_HOME', '')
    const { routes } = await mount(undefined)
    const call = async (path: string, method: string) => (await routes.get(path)?.fetch(new Request('http://harness.test/api', { method })))?.json()
    expect(Readiness.parse(await call(READINESS_PATH, 'GET'))).toEqual({ agents: { 'claude-code': 'missing', 'codex': 'missing' }, tailscale: { state: 'not-installed' } })
    expect(await call(KEY_TEST_PATH, 'POST')).toEqual({ hidden: [], providers: [] })
  })

  it('names this start with an id that changes with the next start', async () => {
    const first = await mount(undefined)
    const second = await mount(undefined)
    const ask = async (mounted: typeof first) => StartAnswer.parse(await (await mounted.routes.get(START_PATH)?.fetch(new Request('http://harness.test/api')))?.json()).startId
    const [one, two] = [await ask(first), await ask(second)]
    expect(one).toMatch(START_ID)
    expect(await ask(first)).toBe(one)
    expect(two).not.toBe(one)
  })

  it('lets an approved device read the start id and no other peer, so Complete setup later holds on a phone', async () => {
    const { routes } = await mount(undefined)
    const route = routes.get(START_PATH) as { methods: readonly string[]; admitPeer?: (request: Request, peer: { readonly principal: { readonly kind: string } }) => boolean } | undefined
    const asks = (kind: string): boolean | undefined => route?.admitPeer?.(new Request('http://harness.test/api'), { principal: { kind } })
    expect(route?.methods).toEqual(['GET'])
    expect([asks('reach-device'), asks('guest')]).toEqual([true, false])
  })

  it('serves a record that covers nothing without a profile directory', async () => {
    const { get, warn } = await mount(undefined)
    expect(await (await get()).json()).toEqual({ reachSetUp: false })
    expect(warn).not.toHaveBeenCalled()
  })

  it('never serves or logs a hostile file’s other fields, and still answers', async () => {
    const hostile = JSON.stringify({ reach: { option: 'tailscale-funnel', note: SECRET }, sections: [{ id: 'reach', status: 'answered' }, { id: SECRET, status: SECRET }], modelProvider: { credential: SECRET }, __proto__: { polluted: SECRET } })
    const { get, warn } = await mount(await profile(hostile))
    const response = await get()
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).not.toContain(SECRET)
    expect(JSON.parse(body)).toEqual({ reachSetUp: true })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET)
    expect(({} as { polluted?: string }).polluted).toBeUndefined()
  })

  it('answers a malformed file with the record that covers nothing, and logs the reason under the plugin’s name without the file’s text', async () => {
    const { get, warn } = await mount(await profile(`{"reach":${SECRET}`))
    expect(await (await get()).json()).toEqual({ reachSetUp: false })
    expect(warn).toHaveBeenCalledOnce()
    const logged = String(warn.mock.calls[0]?.[0])
    expect(logged.startsWith(`${name}: `)).toBe(true)
    expect(logged).not.toContain(SECRET)
  })

  it('reads the file on each request, so a record written after the studio opened shows at the next read', async () => {
    const directory = await profile(answers())
    const { get } = await mount(directory)
    expect(await (await get()).json()).toEqual({ sections: [], reachSetUp: false })
    await writeFile(join(directory, SETUP_ANSWERS_FILENAME), answers({ reach: { option: 'tailscale-private', identityFactor: 'tailnet' } }))
    expect(await (await get()).json()).toEqual({ sections: [], reachSetUp: true })
  })

  it('asks the settings service for no generated form, and gives the request back with the plugin', async () => {
    const { fiber, configure, unconfigure } = await mount(undefined)
    expect(configure).toHaveBeenCalledWith({ auto: false }, expect.anything())
    await fiber.dispose()
    expect(unconfigure).toHaveBeenCalledOnce()
  })

  it('requires only the Connection', () => {
    expect(inject).toEqual(['connection'])
  })
})

describe('the deferred steps', () => {
  it('is a POST route a paired phone may call, which only notes a step for the computer', async () => {
    const { routes } = await mount(await profile())
    const route = routes.get(DEFER_STEP_PATH) as { methods: readonly string[]; admitPeer?: unknown } | undefined
    expect(route?.methods).toEqual(['POST'])
    expect(typeof route?.admitPeer).toBe('function')
  })

  it('keeps a deferred step in the profile directory and serves it with the record, in the list\'s order', async () => {
    const directory = await profile(answers())
    const { defer, get } = await mount(directory)
    expect((await get().then(response => response.json()))).toEqual({ sections: [], reachSetUp: false })
    expect(await (await defer({ id: 'pin', deferred: true })).json()).toEqual({ deferred: ['pin'] })
    expect(await (await defer({ id: 'reach', deferred: true })).json()).toEqual({ deferred: ['reach', 'pin'] })
    expect(await get().then(response => response.json())).toEqual({ sections: [], reachSetUp: false, deferred: ['reach', 'pin'] })
    expect(SetupRecord.parse(await get().then(response => response.json())).deferred).toEqual(['reach', 'pin'])
    expect(statSync(join(directory, DEFERRED_FILENAME)).mode & 0o777).toBe(0o600)
  })

  it('clears a step, and does nothing the second time', async () => {
    const { defer, get } = await mount(await profile())
    await defer({ id: 'pin', deferred: true })
    expect(await (await defer({ id: 'pin', deferred: false })).json()).toEqual({ deferred: [] })
    expect(await (await defer({ id: 'pin', deferred: false })).json()).toEqual({ deferred: [] })
    expect(await get().then(response => response.json())).toEqual({ reachSetUp: false })
  })

  it('keeps both of two requests made at once', async () => {
    const { defer, get } = await mount(await profile())
    await Promise.all([defer({ id: 'pin', deferred: true }), defer({ id: 'approve', deferred: true })])
    expect((await get().then(response => response.json())).deferred).toEqual(['pin', 'approve'])
  })

  it.each<readonly [string, unknown]>([
    ['an id outside the list', { id: 'workspace', deferred: true }],
    ['a missing flag', { id: 'pin' }],
    ['an extra field', { id: 'pin', deferred: true, more: 1 }],
    ['text that is not JSON', 'not json sk-test-secret-marker-7f3a'],
  ])('refuses %s with 400 and writes nothing', async (_, body) => {
    const directory = await profile()
    const { defer, get } = await mount(directory)
    const response = await defer(body)
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).not.toContain(SECRET)
    expect(await get().then(r => r.json())).toEqual({ reachSetUp: false })
  })

  it('reads an unusable file as none, with a warning that does not quote it', async () => {
    const directory = await profile()
    await writeFile(join(directory, DEFERRED_FILENAME), `{"version":1,"deferred":["${SECRET}"]}`)
    const { get, warn } = await mount(directory)
    expect(await get().then(response => response.json())).toEqual({ reachSetUp: false })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(SECRET)
  })

  it('refuses a write where there is no profile directory, with 500', async () => {
    const { defer } = await mount(undefined)
    expect((await defer({ id: 'pin', deferred: true })).status).toBe(500)
  })
})

describe('the optional rows', () => {
  it('checks the configured rows against the Loader when it applies', () => {
    const ctx = new Context()
    ctx.provide('loader', { entries: () => [{ id: 'include:delorun-cost-meter', options: { id: 'delorun-cost-meter' } }] } as never)
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    expect(() => apply(ctx, Config({ optionalRows: ['delorun-cost-meter'] }))).not.toThrow()
    expect(() => apply(ctx, Config({ optionalRows: ['delorun-nope'] }))).toThrow('"delorun-nope"')
  })
})
