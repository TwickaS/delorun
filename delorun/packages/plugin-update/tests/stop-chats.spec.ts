/**
 * "Stop running chats and update": the stop-chats route needs what beginning the update needs and an update that waits for
 * chats; it records the chats before it cancels them; the continue-chat route sends one message per stopped chat; and the
 * updated Host continues the recorded chats once, only while the setting is on.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromDevice, get, json, post, send } from '../../plugin-changes/tests/routes-fixture.ts'
import { UPDATE_PATHS } from '../src/wire.ts'
import { readStopped, stoppedPath, writeStopped } from '../src/stopped.ts'
import { serveUpdate, updateWaiting, type UpdateServer } from './update-fixture.ts'

const RUNNING = [{ sessionId: 's-1', title: 'First chat' }, { sessionId: 's-2', title: 'Second chat' }]

/** @returns the path of the stopped-chats record of a served update. */
const recordPath = (update: UpdateServer): string => stoppedPath(join(update.home, 'run', 'default'))

describe('the stop-chats route', () => {
  it('is refused from another site, and a phone without the strong access, before anything is stopped', async () => {
    const update = await serveUpdate({ powers: 'full' })
    updateWaiting(update)
    update.chats.running = [...RUNNING]
    const cross = await send(update.server.port, UPDATE_PATHS.stopChats, { method: 'POST', headers: ['Sec-Fetch-Site: cross-site'], body: {}, withholdBody: true })
    expect(cross.status).toBe(403)
    for (const unlock of ['none', 'grace'] as const) {
      const refused = await send(update.server.port, UPDATE_PATHS.stopChats, fromDevice(unlock, {}))
      expect(json(refused)).toMatchObject({ code: 'ELEVATION_REQUIRED' })
    }
    const careful = await serveUpdate({ powers: 'careful' })
    updateWaiting(careful)
    careful.chats.running = [...RUNNING]
    expect(json(await send(careful.server.port, UPDATE_PATHS.stopChats, fromDevice('fresh', {})))).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    for (const each of [update, careful]) {
      expect(each.chats.cancelled).toBe(0)
      expect(existsSync(recordPath(each))).toBe(false)
    }
  })

  it('is refused when no update waits for chats, and stops and records nothing', async () => {
    const update = await serveUpdate()
    update.chats.running = [...RUNNING]
    expect(json(await post(update.server.port, UPDATE_PATHS.stopChats, {}))).toMatchObject({ code: 'NO_UPDATE_PENDING' })
    updateWaiting(update, 'switching')
    expect(json(await post(update.server.port, UPDATE_PATHS.stopChats, {}))).toMatchObject({ code: 'NO_UPDATE_PENDING' })
    expect(update.chats.cancelled).toBe(0)
    expect(existsSync(recordPath(update))).toBe(false)
  })

  it('records the running chats, then cancels them, and rejects a body field', async () => {
    const update = await serveUpdate()
    updateWaiting(update)
    update.chats.running = [...RUNNING]
    expect((await post(update.server.port, UPDATE_PATHS.stopChats, { chats: ['x'] })).status).toBe(400)
    const reply = await post(update.server.port, UPDATE_PATHS.stopChats, {})
    expect(reply.status, reply.body).toBe(200)
    expect(json(reply)).toEqual({ chats: RUNNING })
    expect(update.chats.cancelled).toBe(1)
    const record = await readStopped(recordPath(update))
    expect(record?.automatic).toBe(true)
    expect(record?.chats).toEqual(RUNNING.map(chat => ({ ...chat, state: 'stopped' })))
  })

  it('records the setting as it stands, and stops and records nothing when no chat runs', async () => {
    const off = await serveUpdate()
    updateWaiting(off)
    off.setting.automatic = false
    off.chats.running = [...RUNNING]
    await post(off.server.port, UPDATE_PATHS.stopChats, {})
    expect((await readStopped(recordPath(off)))?.automatic).toBe(false)
    const none = await serveUpdate()
    updateWaiting(none)
    expect(json(await post(none.server.port, UPDATE_PATHS.stopChats, {}))).toEqual({ chats: [] })
    expect(none.chats.cancelled).toBe(0)
    expect(existsSync(recordPath(none))).toBe(false)
  })

  it('names the running chats in the state only for a request that may begin an update, and only while an update waits', async () => {
    const update = await serveUpdate()
    update.chats.running = [...RUNNING]
    expect(json(await get(update.server.port, UPDATE_PATHS.state)).runningChats).toBeUndefined()
    updateWaiting(update)
    expect(json(await get(update.server.port, UPDATE_PATHS.state)).runningChats).toEqual(RUNNING)
  })
})

describe('the stopped chats in the state, and the continue-chat route', () => {
  /** Stop two chats through the route. */
  async function stopped(update: UpdateServer): Promise<void> {
    updateWaiting(update)
    update.chats.running = [...RUNNING]
    await post(update.server.port, UPDATE_PATHS.stopChats, {})
  }

  it('shows each stopped chat with its state, and the setting', async () => {
    const update = await serveUpdate()
    await stopped(update)
    const state = json(await get(update.server.port, UPDATE_PATHS.state))
    expect(state.continueStopped).toBe(true)
    expect(state.stopped).toEqual({ automatic: true, chats: RUNNING.map(chat => ({ ...chat, state: 'stopped' })) })
  })

  it('sends the continue message once per chat: marked before it is sent, and a second press is refused', async () => {
    const update = await serveUpdate()
    await stopped(update)
    const first = await post(update.server.port, UPDATE_PATHS.continueChat, { sessionId: 's-1' })
    expect(json(first)).toEqual({ state: 'continued' })
    expect(update.sent.ids).toEqual(['s-1'])
    expect(json(await post(update.server.port, UPDATE_PATHS.continueChat, { sessionId: 's-1' }))).toMatchObject({ code: 'NOT_STOPPED_BY_UPDATE' })
    expect(update.sent.ids).toEqual(['s-1'])
    expect((await readStopped(recordPath(update)))?.chats.map(chat => chat.state)).toEqual(['continued', 'stopped'])
  })

  it('refuses a chat the update did not stop, and notes a chat that no longer exists', async () => {
    const update = await serveUpdate()
    await stopped(update)
    expect(json(await post(update.server.port, UPDATE_PATHS.continueChat, { sessionId: 'other' }))).toMatchObject({ code: 'NOT_STOPPED_BY_UPDATE' })
    expect((await post(update.server.port, UPDATE_PATHS.continueChat, { sessionId: 7 })).status).toBe(400)
    update.sent.answer = 'skipped-missing'
    expect(json(await post(update.server.port, UPDATE_PATHS.continueChat, { sessionId: 's-2' }))).toEqual({ state: 'skipped-missing' })
    expect((await readStopped(recordPath(update)))?.chats.find(chat => chat.sessionId === 's-2')?.state).toBe('skipped-missing')
    expect(update.sent.ids).toEqual(['s-2'])
  })

  it('dismissing the outcome forgets the record', async () => {
    const update = await serveUpdate()
    await stopped(update)
    await post(update.server.port, UPDATE_PATHS.dismiss, {})
    expect(existsSync(recordPath(update))).toBe(false)
    expect(json(await get(update.server.port, UPDATE_PATHS.state)).stopped).toBeUndefined()
  })
})

describe('an update cancelled after the stop', () => {
  /** Stop two chats, then cancel the waiting update. */
  async function cancelled(update: UpdateServer): Promise<void> {
    updateWaiting(update)
    update.chats.running = [...RUNNING]
    await post(update.server.port, UPDATE_PATHS.stopChats, {})
    expect((await post(update.server.port, UPDATE_PATHS.cancel, {})).status).toBe(200)
  }

  it('continues each stopped chat at once with the setting on, and clears the record', async () => {
    const update = await serveUpdate()
    await cancelled(update)
    expect(update.sent.ids).toEqual(['s-1', 's-2'])
    expect(existsSync(recordPath(update))).toBe(false)
  })

  it('keeps the record for the Continue buttons with the setting off, and sends nothing', async () => {
    const update = await serveUpdate()
    update.setting.automatic = false
    await cancelled(update)
    expect(update.sent.ids).toEqual([])
    expect((await readStopped(recordPath(update)))?.chats.map(chat => chat.state)).toEqual(['stopped', 'stopped'])
  })

  it('names the background jobs in the state while an update waits', async () => {
    const update = await serveUpdate()
    updateWaiting(update)
    update.chats.running = [...RUNNING]
    update.chats.jobs = 3
    expect(json(await get(update.server.port, UPDATE_PATHS.state)).runningJobs).toBe(3)
  })
})

describe('the updated Host continuing the stopped chats', () => {
  /** @returns a record on disk and the sends the continuation made. */
  async function after(automatic: boolean, answers: Record<string, 'continued' | 'skipped-missing' | 'skipped-running' | 'failed'> = {}, settingOn = true) {
    const update = await serveUpdate()
    await writeStopped(recordPath(update), { v: 1, automatic, at: '2026-11-19T10:00:00Z', chats: RUNNING.map(chat => ({ ...chat, state: 'stopped' as const })) })
    const sent: string[] = []
    const { continueAfterUpdate } = await import('../src/index.ts')
    const scope = { get: () => ({ home: update.home, name: 'default' }) } as never
    const run = async (): Promise<void> => { await continueAfterUpdate(scope, (id) => { sent.push(id); return Promise.resolve(answers[id] ?? 'continued') }, settingOn) }
    return { update, sent, run }
  }

  it('sends each recorded chat one message, notes the chats it skipped, and sends nothing the second time the Host starts', async () => {
    const { update, sent, run } = await after(true, { 's-2': 'skipped-missing' })
    await run()
    await run()
    expect(sent).toEqual(['s-1', 's-2'])
    expect((await readStopped(recordPath(update)))?.chats.map(chat => chat.state)).toEqual(['continued', 'skipped-missing'])
  })

  it('sends nothing while the setting is off, or when the record was made with it off, and leaves the chats stopped for the Continue button', async () => {
    const off = await after(true, {}, false)
    await off.run()
    const recordedOff = await after(false)
    await recordedOff.run()
    expect(off.sent).toEqual([])
    expect(recordedOff.sent).toEqual([])
    expect((await readStopped(recordPath(recordedOff.update)))?.chats.map(chat => chat.state)).toEqual(['stopped', 'stopped'])
  })

  it('reads a record that survived the restart, and ignores a damaged one', async () => {
    const { update, sent, run } = await after(true)
    expect(readFileSync(recordPath(update), 'utf8')).toContain('"sessionId":"s-1"')
    await writeStopped(recordPath(update), { v: 1, automatic: true, at: 'x', chats: [] })
    await run()
    expect(sent).toEqual([])
  })
})
