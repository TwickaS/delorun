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
  DEFAULT_CHAT_STATES_SETTINGS, inject, MAX_RECORDS, MAX_SNOOZE_MS, name, PRUNE_MINUTES, REFRESH_SECONDS, type ChatStateRefusalCode,
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
async function mount(options: {
  readonly table?: KvTable<SessionId, unknown>
  readonly storage?: boolean
  readonly root?: string
  /** The session list the harness holds; absent, the harness has no session query service. */
  readonly sessions?: (signal: AbortSignal | undefined) => Promise<readonly { readonly header: { readonly id: string } }[]>
  readonly config?: object
} = {}) {
  const ctx = new Context()
  const routes = new Map<string, { readonly methods: readonly string[]; readonly fetch: (request: Request) => Promise<Response>; readonly admitPeer?: (request: Request, peer: object) => boolean }>()
  const close = vi.fn()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response>; admitPeer?: (request: Request, peer: object) => boolean }) => {
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
  if (options.sessions !== undefined) ctx.provide('sessionQuery', { listSessions: options.sessions } as never)
  const unconfigure = vi.fn()
  const configure = vi.fn(() => unconfigure)
  ctx.provide('settings', { configure } as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => {})
  const fiber = ctx.plugin({ name, inject: [...inject], apply, Config }, options.config ?? {})
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
  return { ctx, fiber, routes, route, list, post, close, warn, error, info, configure, unconfigure }
}

async function refusalOf(response: Response): Promise<{ status: number; code: string }> {
  return { status: response.status, code: ChatStateRefusal.parse(await response.json()).code }
}

/** A session list holding these chats. */
const holding = (...ids: string[]) => () => Promise.resolve(ids.map(id => ({ header: { id } })))

describe('forgetting the states of chats that no longer exist', () => {
  const RETENTION = 1_000_000
  const present = (...ids: string[]) => async () => ids.map(sid)

  function seeded(start = 5_000) {
    const clock = { now: start }
    const made = statesOf(memoryTable(), () => clock.now)
    for (const id of ['a', 'b', 'c']) made.rows.set(sid(id), { settledAt: 5 })
    return { ...made, clock }
  }

  it('keeps the state of a chat the first time it is missing from the session list, marked with when it was first missing', async () => {
    const { states, rows } = seeded()
    expect(await states.forgetGone(present('a', 'c'), RETENTION)).toBe(0)
    expect(rows.get(sid('b'))).toEqual({ settledAt: 5, missingSince: 5_000 })
    expect(rows.get(sid('a'))).toEqual({ settledAt: 5 })
  })

  it('never shows the studio the mark', async () => {
    const { states } = seeded()
    await states.forgetGone(present('a', 'c'), RETENTION)
    expect(await states.list()).toEqual({ chats: { a: { settledAt: 5 }, b: { settledAt: 5 }, c: { settledAt: 5 } } })
  })

  it('clears the mark when the chat reappears, and keeps the first time it was missing while it stays missing', async () => {
    const { states, rows, clock } = seeded()
    await states.forgetGone(present('a', 'c'), RETENTION)
    clock.now = 6_000
    await states.forgetGone(present('a', 'c'), RETENTION)
    expect(rows.get(sid('b'))).toEqual({ settledAt: 5, missingSince: 5_000 })
    clock.now = 7_000
    await states.forgetGone(present('a', 'b', 'c'), RETENTION)
    expect(rows.get(sid('b'))).toEqual({ settledAt: 5 })
  })

  it('forgets the state of a chat that has been missing for the retention, and keeps the others', async () => {
    const { states, rows, clock } = seeded()
    await states.forgetGone(present('a', 'c'), RETENTION)
    clock.now = 5_000 + RETENTION - 1
    expect(await states.forgetGone(present('a', 'c'), RETENTION)).toBe(0)
    clock.now = 5_000 + RETENTION
    expect(await states.forgetGone(present('a', 'c'), RETENTION)).toBe(1)
    expect([...rows.keys()]).toEqual(['a', 'c'])
  })

  it('returns a chat restored within the retention with its state intact', async () => {
    const { states, rows, clock } = seeded()
    await states.forgetGone(present('a', 'c'), RETENTION)
    clock.now = 5_000 + RETENTION - 1
    await states.forgetGone(present('a', 'b', 'c'), RETENTION)
    clock.now = 5_000 + 3 * RETENTION
    await states.forgetGone(present('a', 'b', 'c'), RETENTION)
    expect(rows.get(sid('b'))).toEqual({ settledAt: 5 })
  })

  it('leaves a record that is not valid to the limit', async () => {
    const { states, rows, reports } = seeded()
    rows.set(sid('broken'), { settledAt: 'yesterday' })
    await states.forgetGone(present('a', 'b', 'c'), 0)
    expect(rows.get(sid('broken'))).toEqual({ settledAt: 'yesterday' })
    expect(reports).toHaveLength(1)
  })

  it('changes nothing when the list cannot be read in full, and tells why', async () => {
    const { states, rows } = seeded()
    await expect(states.forgetGone(() => Promise.reject(new Error('listing stopped halfway')), RETENTION)).rejects.toThrow('listing stopped halfway')
    expect([...rows.values()]).toEqual([{ settledAt: 5 }, { settledAt: 5 }, { settledAt: 5 }])
  })

  it('changes nothing when the list is empty, since an empty list cannot be told from a corpus that has not loaded', async () => {
    const { states, rows } = seeded()
    expect(await states.forgetGone(present(), 0)).toBe(0)
    expect([...rows.values()]).toEqual([{ settledAt: 5 }, { settledAt: 5 }, { settledAt: 5 }])
  })

  it('reads the list inside the queue of changes, so a change queued before it is not marked missing', async () => {
    const { states, rows } = statesOf()
    const settled = states.apply({ action: 'settle', session: sid('new') })
    expect(await states.forgetGone(async () => [sid('other'), ...rows.keys()], RETENTION)).toBe(0)
    await settled
    expect(rows.get(sid('new'))).toEqual({ settledAt: 1_000 })
  })
})

describe('bounding the stored states', () => {
  it('forgets the states with the oldest changes beyond the limit, counting an invalid record as the oldest', async () => {
    const { states, rows, reports } = statesOf()
    rows.set(sid('newest'), { keptAt: 90 })
    rows.set(sid('broken'), { settledAt: 'yesterday' })
    rows.set(sid('old'), { settledAt: 10 })
    rows.set(sid('middle'), { snoozedAt: 50, snoozedUntil: 5_000 })
    rows.set(sid('woke'), { wokeAt: 70 })
    expect(await states.enforceLimit(3)).toBe(2)
    expect([...rows.keys()].sort()).toEqual(['newest', 'middle', 'woke'].sort())
    expect(reports).toHaveLength(1)
  })

  it('keeps every state while they are within the limit', async () => {
    const { states, rows } = statesOf()
    rows.set(sid('a'), { settledAt: 1 })
    expect(await states.enforceLimit(1)).toBe(0)
    expect(rows.size).toBe(1)
  })
})

describe('the harness sweeping its states', () => {
  const seed = (rows: Map<SessionId, unknown>, count: number, prefix = 'chat') => {
    for (let index = 0; index < count; index += 1) rows.set(sid(`${prefix}${String(index)}`), { settledAt: index + 1 })
  }

  it('marks the state of a chat missing from the session list, and forgets it once it has been missing for the trash retention, and logs it', async () => {
    const made = memoryTable()
    seed(made.rows, 4)
    made.rows.set(sid('chat3'), { settledAt: 4, missingSince: 1 })
    const { list, info } = await mount({ table: made.table, sessions: holding('chat0', 'chat2') })
    await vi.waitFor(() => { expect(made.rows.has(sid('chat3'))).toBe(false) })
    expect(made.rows.get(sid('chat1'))).toEqual({ settledAt: 2, missingSince: expect.any(Number) })
    expect(made.rows.get(sid('chat0'))).toEqual({ settledAt: 1 })
    expect(Object.keys(((await (await list()).json()) as { chats: object }).chats)).toEqual(['chat0', 'chat1', 'chat2'])
    expect(info).toHaveBeenCalledWith(expect.stringContaining('1 chats'))
  })

  it('holds the stored states to maxRecords, the oldest first, with or without a session list', async () => {
    const made = memoryTable()
    seed(made.rows, MAX_RECORDS.min + 5)
    const { info } = await mount({ table: made.table, config: { maxRecords: MAX_RECORDS.min } })
    await vi.waitFor(() => { expect(made.rows.size).toBe(MAX_RECORDS.min) })
    expect(made.rows.has(sid('chat0'))).toBe(false)
    expect(made.rows.has(sid(`chat${String(MAX_RECORDS.min + 4)}`))).toBe(true)
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`limit of ${String(MAX_RECORDS.min)}`))
  })

  it('forgets no chat\'s state when the session list fails, warns, and still holds the limit', async () => {
    const made = memoryTable()
    seed(made.rows, MAX_RECORDS.min + 2)
    const { warn } = await mount({ table: made.table, sessions: () => Promise.reject(new Error('index offline')), config: { maxRecords: MAX_RECORDS.min } })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('index offline')) })
    await vi.waitFor(() => { expect(made.rows.size).toBe(MAX_RECORDS.min) })
    expect(made.rows.has(sid(`chat${String(MAX_RECORDS.min + 1)}`))).toBe(true)
  })

  it('forgets nothing about deleted chats where the harness has no session list', async () => {
    const made = memoryTable()
    seed(made.rows, 3)
    const { list } = await mount({ table: made.table })
    await list()
    await vi.waitFor(() => { expect(made.rows.size).toBe(3) })
  })

  it('schedules no sweep after the plugin is disposed while one is still reading the session list', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    let finish: (chats: readonly { readonly header: { readonly id: string } }[]) => void = () => {}
    let sweeps = 0
    const { fiber } = await mount({
      table: memoryTable().table,
      sessions: () => { sweeps += 1; return new Promise((resolve) => { finish = resolve }) },
      config: { pruneMinutes: PRUNE_MINUTES.min },
    })
    await vi.advanceTimersByTimeAsync(0)
    await fiber.dispose()
    finish([])
    await vi.advanceTimersByTimeAsync(PRUNE_MINUTES.min * 60_000 * 2)
    expect(sweeps).toBe(1)
  })

  it('logs a failure to forget instead of stopping, and sweeps again after the configured minutes until the plugin is disposed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    const made = memoryTable()
    seed(made.rows, 2)
    let present = ['chat0', 'chat1']
    let sweeps = 0
    const { fiber, error } = await mount({
      table: made.table,
      sessions: () => { sweeps += 1; return Promise.resolve(present.map(id => ({ header: { id } }))) },
      config: { pruneMinutes: PRUNE_MINUTES.min, maxRecords: MAX_RECORDS.min },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sweeps).toBe(1)
    present = ['chat1']
    await vi.advanceTimersByTimeAsync(PRUNE_MINUTES.min * 60_000)
    expect(sweeps).toBe(2)
    expect(made.rows.get(sid('chat0'))).toEqual({ settledAt: 1, missingSince: expect.any(Number) })
    const limitFailure = vi.spyOn(made.table, 'deleteMany').mockRejectedValue(new Error('disk full'))
    seed(made.rows, MAX_RECORDS.min + 1, 'extra')
    await vi.advanceTimersByTimeAsync(PRUNE_MINUTES.min * 60_000)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('disk full'))
    limitFailure.mockRestore()
    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(PRUNE_MINUTES.min * 60_000 * 3)
    expect(sweeps).toBe(3)
  })
})

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

  it('admit any approved device to list and change a chat\'s state, locked or not, and no other Peer', async () => {
    const { routes } = await mount({ table: memoryTable().table })
    for (const route of routes.values()) {
      expect(route.admitPeer?.(new Request('http://harness.test/api'), { principal: { kind: 'reach-device', deviceId: 'phone', listener: 'reach-tailscale-private' } })).toBe(true)
      expect(route.admitPeer?.(new Request('http://harness.test/api'), { principal: { kind: 'sdk' } })).toBe(false)
    }
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
    return { root, file: join(root, 'delorun_chat_states.json') }
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
      unit: { name: 'delorun_chat_states', version: 1 },
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
      { maxRecords: MAX_RECORDS.min - 1 }, { maxRecords: MAX_RECORDS.max + 1 },
      { pruneMinutes: PRUNE_MINUTES.min - 1 }, { pruneMinutes: PRUNE_MINUTES.max + 1 },
    ]) {
      expect(Config['~standard'].validate(wrong)).toHaveProperty('issues')
    }
    expect(Config({ snoozePresets: [{ kind: 'at', day: 'friday', time: '17:30' }], autoSettleDays: 3, refreshSeconds: 60 }).refreshSeconds.get()).toBe(60)
  })

  it('bound the stored states at 2,000 by default and sweep hourly', () => {
    const config = Config({})
    expect([config.maxRecords.get(), config.pruneMinutes.get()]).toEqual([2000, 60])
    expect(Config({ maxRecords: 500, pruneMinutes: 5 }).maxRecords.get()).toBe(500)
  })

  it('name the row the studio half edits', () => {
    expect(CHAT_STATES_ROW_ID).toBe('delorun-chat-states')
  })
})
