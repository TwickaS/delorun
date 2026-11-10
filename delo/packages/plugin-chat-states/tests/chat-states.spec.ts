import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import Storage from '@deepseek-ai/dsh-storage'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  apply, AUTO_SETTLE_DAYS, CHAT_STATE_PATHS, CHAT_STATES_ROW_ID, ChatStateRefusal, ChatStateRefusedError, ChatStateRequest, ChatStates, Config,
  DEFAULT_CHAT_STATES_SETTINGS, inject, MAX_SNOOZE_MS, name, REFRESH_SECONDS, type ChatStateRefusalCode,
} from '../src/index.ts'

const sid = (id: string) => SessionId(id)

/** A storage table in memory; `gate` holds back each `put` until it resolves. */
function memoryTable() {
  const rows = new Map<SessionId, unknown>()
  const state = { gate: undefined as Promise<void> | undefined, failPuts: 0 }
  const table: KvTable<SessionId, unknown> = {
    get: key => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() { return rows.size },
    put: async (key, value) => {
      await state.gate
      if (state.failPuts > 0) {
        state.failPuts -= 1
        throw new Error('disk full')
      }
      rows.set(key, value)
    },
    delete: async key => rows.delete(key),
    deleteMany: async keys => keys.filter(key => rows.delete(key)).length,
    update: async (key, fn) => {
      const next = fn(rows.get(key))
      rows.set(key, next)
      return next
    },
  }
  return { rows, state, table }
}

function statesOf(rows = memoryTable(), now: () => number = () => 1_000) {
  const reports: string[] = []
  const states = new ChatStates(rows.table, now, (session, problem) => { reports.push(`${session}: ${problem}`) })
  return { ...rows, states, reports }
}

describe('the chat states', () => {
  it('settles and returns a chat, keeping when it was returned, snoozes and wakes one, and keeps a chat on one shelf at a time', async () => {
    let now = 1_000
    const { states, rows } = statesOf(memoryTable(), () => now)
    expect(await states.apply({ action: 'settle', session: sid('a') })).toEqual({ chats: { a: { settledAt: 1_000 } } })
    now = 2_000
    expect(await states.apply({ action: 'snooze', session: sid('a'), until: 5_000 })).toEqual({ chats: { a: { snoozedAt: 2_000, snoozedUntil: 5_000 } } })
    expect(await states.apply({ action: 'settle', session: sid('a') })).toEqual({ chats: { a: { settledAt: 2_000 } } })
    expect(await states.apply({ action: 'unsettle', session: sid('a') })).toEqual({ chats: { a: { keptAt: 2_000 } } })
    expect(await states.apply({ action: 'settle', session: sid('a') })).toEqual({ chats: { a: { settledAt: 2_000 } } })
    await states.apply({ action: 'snooze', session: sid('b'), until: 9_000 })
    expect(await states.apply({ action: 'wake', session: sid('b') })).toEqual({ chats: { a: { settledAt: 2_000 } } })
    // Waking a chat that is not snoozed changes nothing.
    expect(await states.apply({ action: 'wake', session: sid('c') })).toEqual({ chats: { a: { settledAt: 2_000 } } })
    expect(rows.size).toBe(1)
  })

  it('wakes a chat whose snooze ended when it lists the states, marked with when it woke', async () => {
    let now = 1_000
    const { states, rows } = statesOf(memoryTable(), () => now)
    await states.apply({ action: 'snooze', session: sid('a'), until: 2_000 })
    rows.set(sid('b'), { settledAt: 500, snoozedAt: 600, snoozedUntil: 1_500 })
    now = 2_000
    expect(await states.list()).toEqual({ chats: { a: { wokeAt: 2_000 }, b: { settledAt: 500, wokeAt: 1_500 } } })
    expect(rows.get(sid('a'))).toEqual({ wokeAt: 2_000 })
  })

  it('forgets a waking once the person has seen the chat', async () => {
    let now = 1_000
    const { states, rows } = statesOf(memoryTable(), () => now)
    await states.apply({ action: 'snooze', session: sid('a'), until: 2_000 })
    now = 2_000
    await states.list()
    expect(await states.apply({ action: 'seen', session: sid('a') })).toEqual({ chats: {} })
    expect(rows.has(sid('a'))).toBe(false)
  })

  it('refuses a snooze that ends now, in the past or more than a year away, and stores nothing', async () => {
    const { states, rows } = statesOf()
    for (const until of [1_000, 500, 1_000 + MAX_SNOOZE_MS + 1]) {
      const refused = await states.apply({ action: 'snooze', session: sid('a'), until }).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(ChatStateRefusedError)
      expect((refused as ChatStateRefusedError).code).toBe('snooze-out-of-range')
    }
    expect(rows.size).toBe(0)
    expect(await states.apply({ action: 'snooze', session: sid('a'), until: 1_000 + MAX_SNOOZE_MS })).toEqual({
      chats: { a: { snoozedAt: 1_000, snoozedUntil: 1_000 + MAX_SNOOZE_MS } },
    })
  })
})

describe('a request the types do not allow', () => {
  it('is a defect that fails the change and stores nothing, not a refusal', async () => {
    const { states, rows } = statesOf()
    await expect(states.apply({ action: 'archive', session: sid('a') } as never)).rejects.toThrow('unreachable action')
    expect(rows.size).toBe(0)
  })
})

describe('a malformed stored record', () => {
  const malformed: readonly [string, unknown][] = [
    ['a time that is not a number', { settledAt: 'yesterday' }],
    ['a negative time', { settledAt: -1 }],
    ['a field the plugin does not write', { settledAt: 1, mood: 'calm' }],
    ['a value that is not an object', 'settled'],
    ['a null value', null],
  ]

  it.each(malformed)('is left out of the list and reported once when it holds %s, and the other chats are still listed', async (_, record) => {
    const { states, rows, reports } = statesOf()
    rows.set(sid('bad'), record)
    rows.set(sid('good'), { settledAt: 7 })
    expect(await states.list()).toEqual({ chats: { good: { settledAt: 7 } } })
    expect(await states.list()).toEqual({ chats: { good: { settledAt: 7 } } })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.startsWith('bad: ')).toBe(true)
  })

  it('is replaced by the next change to that chat, and reported again if it is corrupted again', async () => {
    const { states, rows, reports } = statesOf()
    rows.set(sid('bad'), { settledAt: 'yesterday' })
    await states.list()
    expect(await states.apply({ action: 'settle', session: sid('bad') })).toEqual({ chats: { bad: { settledAt: 1_000 } } })
    rows.set(sid('bad'), { settledAt: 'yesterday' })
    await states.list()
    expect(reports).toHaveLength(2)
  })

  it('does not stand in for the current state of a change: waking it leaves the chat with no state', async () => {
    const { states, rows } = statesOf()
    rows.set(sid('bad'), { settledAt: 1, snoozedAt: 'now', snoozedUntil: 9_000 })
    expect(await states.apply({ action: 'wake', session: sid('bad') })).toEqual({ chats: {} })
    expect(rows.has(sid('bad'))).toBe(false)
  })
})

describe('the order of changes', () => {
  it('runs a change after the change before it, so concurrent changes to one chat end as if sent in turn', async () => {
    const { states, table, state } = statesOf()
    let release = (): void => {}
    state.gate = new Promise<void>((resolve) => { release = resolve })
    const snoozed = states.apply({ action: 'snooze', session: sid('a'), until: 5_000 })
    const woken = states.apply({ action: 'wake', session: sid('a') })
    release()
    await Promise.all([snoozed, woken])
    expect(await states.list()).toEqual({ chats: {} })
    expect(table.size).toBe(0)
  })

  it('goes on to the next change after one fails, and tells the failed change why', async () => {
    const { states, state } = statesOf()
    state.failPuts = 1
    const failed = states.apply({ action: 'settle', session: sid('a') })
    const next = states.apply({ action: 'settle', session: sid('b') })
    await expect(failed).rejects.toThrow('disk full')
    expect(await next).toEqual({ chats: { b: { settledAt: 1_000 } } })
  })
})

/** The routes of the plugin over one table, reached as the studio reaches them. */
async function mount(options: { readonly table?: KvTable<SessionId, unknown>; readonly storage?: boolean; readonly root?: string } = {}) {
  const ctx = new Context()
  const routes = new Map<string, { readonly methods: readonly string[]; readonly fetch: (request: Request) => Promise<Response> }>()
  const close = vi.fn()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  } as never)
  if (options.storage === true) {
    await ctx.plugin(Storage)
    if (options.root === undefined) throw new Error('a storage mount needs a root')
    await ctx.plugin(JsonStorage, { root: options.root })
    await ctx.plugin(Domains, { backend: 'json' })
  } else {
    ctx.provide('storageDomain', { open: async () => ({ table: () => options.table, close }) } as never)
  }
  const unconfigure = vi.fn()
  const configure = vi.fn(() => unconfigure)
  ctx.provide('settings', { configure } as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const fiber = ctx.plugin({ name, inject: [...inject], apply })
  await fiber.await()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const route = (path: string) => {
    const found = routes.get(path)
    if (found === undefined) throw new Error(`no route ${path}`)
    return found
  }
  const list = () => route(CHAT_STATE_PATHS.list).fetch(new Request('http://harness.test/api', { method: 'GET' }))
  const post = (body: unknown) => route(CHAT_STATE_PATHS.set).fetch(new Request('http://harness.test/api', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return { ctx, fiber, routes, route, list, post, close, warn, error, configure, unconfigure }
}

async function refusalOf(response: Response): Promise<{ status: number; code: string }> {
  return { status: response.status, code: ChatStateRefusal.parse(await response.json()).code }
}

describe('the routes', () => {
  it('register an exact GET route to list and an exact POST route to change, both uncached', async () => {
    const { routes, list, post } = await mount({ table: memoryTable().table })
    expect([...routes.entries()].map(([path, route]) => [path, route.methods])).toEqual([
      [CHAT_STATE_PATHS.list, ['GET']], [CHAT_STATE_PATHS.set, ['POST']],
    ])
    const listed = await list()
    expect([listed.status, listed.headers.get('cache-control'), await listed.json()]).toEqual([200, 'no-store', { chats: {} }])
    const settled = await post({ action: 'settle', session: 'a' })
    expect([settled.status, settled.headers.get('cache-control'), Object.keys(((await settled.json()) as { chats: object }).chats)]).toEqual([200, 'no-store', ['a']])
  })

  it('ask the settings service for no generated form, since the studio edits the settings, and give the request back with the plugin', async () => {
    const { fiber, configure, unconfigure } = await mount({ table: memoryTable().table })
    expect(configure).toHaveBeenCalledWith({ auto: false }, expect.anything())
    await fiber.dispose()
    expect(unconfigure).toHaveBeenCalledOnce()
  })

  it('close the storage with the plugin', async () => {
    const { fiber, close } = await mount({ table: memoryTable().table })
    await fiber.dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it.each<readonly [string, unknown]>([
    ['a body that is not JSON', 'not json'],
    ['an empty body', ''],
    ['a session id with a space', { action: 'settle', session: 'a b' }],
    ['a session id that is empty', { action: 'settle', session: '' }],
    ['a session id longer than 200 characters', { action: 'settle', session: 'a'.repeat(201) }],
    ['an action the plugin does not know', { action: 'archive', session: 'a' }],
    ['a snooze without an end', { action: 'snooze', session: 'a' }],
    ['a snooze end that is not an integer', { action: 'snooze', session: 'a', until: 1.5 }],
    ['an extra field', { action: 'settle', session: 'a', note: 'x' }],
    ['an array', [{ action: 'settle', session: 'a' }]],
  ])('refuse %s as an invalid request and change nothing', async (_, body) => {
    const { table, rows } = (() => { const made = memoryTable(); return { table: made.table, rows: made.rows } })()
    const { post } = await mount({ table })
    expect(await refusalOf(await post(body))).toEqual({ status: 400, code: 'invalid-request' })
    expect(rows.size).toBe(0)
  })

  it('refuse a snooze that ends in the past or more than a year away with its own code', async () => {
    const { table, rows } = (() => { const made = memoryTable(); return { table: made.table, rows: made.rows } })()
    const { post } = await mount({ table })
    for (const until of [1, Date.now() + MAX_SNOOZE_MS + 60_000]) {
      expect(await refusalOf(await post({ action: 'snooze', session: 'a', until }))).toEqual({ status: 400, code: 'snooze-out-of-range' })
    }
    expect(rows.size).toBe(0)
  })

  it('answer a storage failure as failed without the failure\'s own words, and log them', async () => {
    const made = memoryTable()
    const { post, list, error } = await mount({ table: made.table })
    made.state.failPuts = 1
    const failed = await post({ action: 'settle', session: 'a' })
    expect(failed.status).toBe(500)
    const body = ChatStateRefusal.parse(await failed.json())
    expect(body.code).toBe('failed')
    expect(JSON.stringify(body)).not.toContain('disk full')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('disk full'))
    expect((await list()).status).toBe(200)
  })
})

describe('the routes over the harness\'s storage', () => {
  async function storage() {
    const root = await mkdtemp(join(tmpdir(), 'chat-states-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    return { root, file: join(root, 'delo_chat_states.json') }
  }

  it('keep the states across a restart', async () => {
    const { root } = await storage()
    const first = await mount({ storage: true, root })
    await first.post({ action: 'settle', session: 'a' })
    await first.ctx.fiber.dispose()
    const second = await mount({ storage: true, root })
    const listed = (await (await second.list()).json()) as { chats: Record<string, { settledAt: number }> }
    expect(Object.keys(listed.chats)).toEqual(['a'])
    expect(listed.chats['a']?.settledAt).toBeGreaterThan(0)
  })

  it('start and answer when a stored record is malformed: the record is left out and reported, the others are listed', async () => {
    const { root, file } = await storage()
    await writeFile(file, JSON.stringify({
      unit: { name: 'delo_chat_states', version: 1 },
      global: null,
      tables: { chats: { bad: { settledAt: 'yesterday' }, worse: 7, fine: { settledAt: 5 } } },
    }))
    const { list, post, warn } = await mount({ storage: true, root })
    expect(await (await list()).json()).toEqual({ chats: { fine: { settledAt: 5 } } })
    expect(warn.mock.calls.map(([message]) => String(message).match(/chat (\S+) is not valid/)?.[1]).sort()).toEqual(['bad', 'worse'])
    // A change to the chat replaces its malformed record.
    expect((await post({ action: 'settle', session: 'bad' })).status).toBe(200)
    const stored = JSON.parse(await readFile(file, 'utf8')) as { tables: { chats: Record<string, unknown> } }
    expect(stored.tables.chats['bad']).toEqual({ settledAt: expect.any(Number) })
  })
})

describe('the wire messages', () => {
  it('brand the session id of a valid request and keep every field of it', () => {
    const parsed = ChatStateRequest.parse({ action: 'snooze', session: 'abc.def:1_2-3', until: 5 })
    expect(parsed).toEqual({ action: 'snooze', session: 'abc.def:1_2-3', until: 5 })
  })

  it('name the refusal codes the routes use', () => {
    const codes: readonly ChatStateRefusalCode[] = ['invalid-request', 'snooze-out-of-range', 'failed']
    for (const code of codes) expect(ChatStateRefusal.parse({ code, message: 'x' }).code).toBe(code)
    expect(ChatStateRefusal.safeParse({ code: 'other', message: 'x' }).success).toBe(false)
  })
})

describe('the settings', () => {
  it('default to T3 Code\'s presets, no auto-settle and a read every 30 seconds, and refuse values outside the limits', () => {
    const config = Config({})
    expect({
      snoozePresets: config.snoozePresets.get(), autoSettleDays: config.autoSettleDays.get(), refreshSeconds: config.refreshSeconds.get(),
    }).toEqual(DEFAULT_CHAT_STATES_SETTINGS)
    const after = (minutes: number) => ({ kind: 'after', minutes })
    for (const wrong of [
      { snoozePresets: [] }, { snoozePresets: Array.from({ length: 9 }, () => after(60)) }, { snoozePresets: [after(0)] }, { snoozePresets: [after(43_201)] },
      { snoozePresets: [{ kind: 'at', day: 'someday', time: '09:00' }] }, { snoozePresets: [{ kind: 'at', day: 'today', time: '25:00' }] },
      { autoSettleDays: AUTO_SETTLE_DAYS.max + 1 }, { autoSettleDays: -1 },
      { refreshSeconds: REFRESH_SECONDS.min - 1 }, { refreshSeconds: REFRESH_SECONDS.max + 1 },
    ]) {
      expect(Config['~standard'].validate(wrong)).toHaveProperty('issues')
    }
    expect(Config({ snoozePresets: [{ kind: 'at', day: 'friday', time: '17:30' }], autoSettleDays: 3, refreshSeconds: 60 }).refreshSeconds.get()).toBe(60)
  })

  it('name the row the studio half edits', () => {
    expect(CHAT_STATES_ROW_ID).toBe('delo-chat-states')
  })
})
