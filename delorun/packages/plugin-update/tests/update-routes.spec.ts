/**
 * The studio's update routes (contract C19, "The studio's update"): the Changes gate decides the site, the device's
 * level and its unlock before any body is read or the home process is asked; the page holds a handle and never a report id
 * or token; an apply needs every tick the report asks for and cannot confirm a conflicted report; the home process's
 * refusals keep their codes; and the outcome record reaches the page.
 */
import { describe, expect, it } from 'vitest'
import { CREDENTIAL, fromDevice, get, json, post, send, type Reply } from '../../plugin-changes/tests/routes-fixture.ts'
import { UPDATE_PATHS } from '../src/wire.ts'
import { CHANNEL_TOKEN, CONFLICTED_HARNESS, DATA_ITEM, DISABLED_PLUGIN, REPORT_ID, report, serveUpdate, writeResult, type UpdateServer } from './update-fixture.ts'

/** Make the channel answer `update.prepare` with a report. */
function preparing(update: UpdateServer, items = report()): void {
  update.channel.answers.set('update.prepare', [{ ok: true, phase: 'installing' }, { ok: true, line: 'Downloading\n' }, { ok: true, reportId: REPORT_ID, report: items }])
  update.channel.answers.set('update.apply', [{ ok: true, phase: 'snapshot' }])
}

/** Prepare through the computer and return the handle. */
async function prepared(update: UpdateServer, items = report()): Promise<string> {
  preparing(update, items)
  const reply = await post(update.server.port, UPDATE_PATHS.prepare)
  expect(reply.status, reply.body).toBe(200)
  return (json(reply).prepared as { handle: string }).handle
}

const CONTROL_PATHS = [UPDATE_PATHS.prepare, UPDATE_PATHS.apply, UPDATE_PATHS.cancel, UPDATE_PATHS.rollback, UPDATE_PATHS.dismiss, UPDATE_PATHS.stop, UPDATE_PATHS.check] as const

describe('the update routes\' fence and levels', () => {
  it('update-begin-refused-from-other-site: a cross-site request asks the home process nothing', async () => {
    const update = await serveUpdate({ powers: 'full' })
    for (const path of CONTROL_PATHS) {
      for (const headers of [['Sec-Fetch-Site: cross-site'], ['Origin: https://elsewhere.example'], ['Origin: null']]) {
        const reply = await send(update.server.port, path, { method: 'POST', headers: [CREDENTIAL, ...headers], body: {}, withholdBody: true })
        expect(reply.status, `${path} ${headers.join()}`).toBe(403)
        expect(json(reply)).toMatchObject({ code: 'CROSS_SITE' })
      }
    }
    expect(update.channel.requests).toEqual([])
  })

  it('update-begin-refused-careful-phone and update-rollback-refused-careful-phone: even an unlocked phone updates and goes back at the computer', async () => {
    const update = await serveUpdate({ powers: 'careful' })
    for (const path of [UPDATE_PATHS.prepare, UPDATE_PATHS.apply, UPDATE_PATHS.rollback]) {
      const reply = await send(update.server.port, path, fromDevice('fresh', { chats: 'wait', handle: 'x', profileOnly: false }))
      expect(reply.status, path).toBe(403)
      expect(json(reply), path).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    }
    expect(update.channel.requests).toEqual([])
  })

  it('update-begin-refused-phone-without-unlock, update-begin-refused-phone-approval-grace-only and update-rollback-refused-phone-without-unlock: Full needs an unlock the person entered', async () => {
    const update = await serveUpdate({ powers: 'full' })
    for (const unlock of ['none', 'grace'] as const) {
      for (const path of [UPDATE_PATHS.prepare, UPDATE_PATHS.apply, UPDATE_PATHS.rollback, UPDATE_PATHS.stop]) {
        const reply = await send(update.server.port, path, fromDevice(unlock, { chats: 'wait', handle: 'x', profileOnly: false }))
        expect(reply.status, `${path} ${unlock}`).toBe(403)
        expect(json(reply), `${path} ${unlock}`).toMatchObject({ code: 'ELEVATION_REQUIRED' })
      }
    }
    expect(update.channel.requests).toEqual([])
  })

  it('a phone with an unlock under Full may prepare, apply, go back and stop; under Careful it may only cancel, dismiss and stop', async () => {
    const full = await serveUpdate({ powers: 'full' })
    preparing(full)
    const prepare = await send(full.server.port, UPDATE_PATHS.prepare, fromDevice('fresh'))
    expect(prepare.status, prepare.body).toBe(200)
    const handle = (json(prepare).prepared as { handle: string }).handle
    expect((await send(full.server.port, UPDATE_PATHS.apply, fromDevice('fresh', { handle, chats: 'wait', dataCopy: true, acknowledged: [] }))).status).toBe(200)
    expect((await send(full.server.port, UPDATE_PATHS.rollback, fromDevice('fresh', { chats: 'stop', profileOnly: false }))).status).toBe(200)
    expect((await send(full.server.port, UPDATE_PATHS.stop, fromDevice('fresh', { chats: 'wait' }))).status).toBe(200)
    const careful = await serveUpdate({ powers: 'careful' })
    expect((await send(careful.server.port, UPDATE_PATHS.cancel, fromDevice('fresh'))).status).toBe(200)
    expect((await send(careful.server.port, UPDATE_PATHS.dismiss, fromDevice('fresh'))).status).toBe(200)
    expect((await send(careful.server.port, UPDATE_PATHS.stop, fromDevice('fresh', { chats: 'wait' }))).status).toBe(200)
    expect(careful.channel.ops()).toEqual(['status', 'update.cancel', 'status', 'stop'])
  })

  it('the release check is open to a locked phone, but not to another site or a session that is no paired device\'s', async () => {
    const update = await serveUpdate({ powers: 'careful' })
    update.check = { state: () => Promise.resolve(undefined), checkNow: () => Promise.resolve({ checked: 5 }) }
    const locked = await send(update.server.port, UPDATE_PATHS.check, fromDevice('none'))
    expect(locked.status, locked.body).toBe(200)
    expect(json(locked)).toMatchObject({ enabled: true, checkedAt: 5 })
    const stranger = await send(update.server.port, UPDATE_PATHS.check, { method: 'POST', host: 'studio.example.ts.net', headers: [CREDENTIAL, 'x-test-remote: 1'], body: {} })
    expect(json(stranger)).toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    const cross = await send(update.server.port, UPDATE_PATHS.check, { method: 'POST', headers: [CREDENTIAL, 'Sec-Fetch-Site: cross-site'], body: {}, withholdBody: true })
    expect(json(cross)).toMatchObject({ code: 'CROSS_SITE' })
    update.check = undefined
    expect(json(await post(update.server.port, UPDATE_PATHS.check))).toMatchObject({ code: 'UPDATE_UNAVAILABLE' })
  })

  it('refuses a request without the studio\'s credential before anything else', async () => {
    const update = await serveUpdate()
    const reply = await send(update.server.port, UPDATE_PATHS.prepare, { method: 'POST', body: {} })
    expect(reply.status).toBe(401)
    expect(update.channel.requests).toEqual([])
  })

  it('a Host with no home process of an installed release refuses every control and says it is not available', async () => {
    const update = await serveUpdate({ noChannel: true })
    const bodies: readonly (readonly [string, object])[] = [
      [UPDATE_PATHS.prepare, {}],
      [UPDATE_PATHS.cancel, {}],
      [UPDATE_PATHS.rollback, { chats: 'wait', profileOnly: false }],
      [UPDATE_PATHS.stop, { chats: 'wait' }],
    ]
    for (const [path, body] of bodies) {
      expect(json(await post(update.server.port, path, body)), path).toMatchObject({ code: 'UPDATE_UNAVAILABLE' })
    }
    expect(json(await get(update.server.port, UPDATE_PATHS.state))).toMatchObject({ available: false })
  })
})

describe('prepare and apply', () => {
  it('update-apply-refuses-page-supplied-report: the page cannot name a report id, a forged handle or an expired one', async () => {
    const update = await serveUpdate()
    const handle = await prepared(update)
    const body = { handle, chats: 'wait', dataCopy: true, acknowledged: [] }
    const supplied = await post(update.server.port, UPDATE_PATHS.apply, { ...body, reportId: REPORT_ID })
    expect(supplied.status).toBe(400)
    const forged = await post(update.server.port, UPDATE_PATHS.apply, { ...body, handle: REPORT_ID })
    expect(json(forged)).toMatchObject({ code: 'REPORT_EXPIRED' })
    const sameLength = await post(update.server.port, UPDATE_PATHS.apply, { ...body, handle: 'f'.repeat(handle.length) })
    expect(json(sameLength)).toMatchObject({ code: 'REPORT_EXPIRED' })
    update.clock.now += 600_001
    expect(json(await post(update.server.port, UPDATE_PATHS.apply, body))).toMatchObject({ code: 'REPORT_EXPIRED' })
    expect(update.channel.ops()).not.toContain('update.apply')
  })

  it('an apply names the Host-held report id and the chosen drain, and the report is consumed', async () => {
    const update = await serveUpdate()
    const handle = await prepared(update)
    const reply = await post(update.server.port, UPDATE_PATHS.apply, { handle, chats: 'stop', dataCopy: false, acknowledged: [] })
    expect(reply.status, reply.body).toBe(200)
    expect(json(reply)).toEqual({ kind: 'update-begun', target: '0.1.1', runningChats: 2 })
    expect(update.channel.requests.at(-1)).toEqual({ op: 'update.apply', args: { reportId: REPORT_ID, wait: 'cancel', drainTimeoutS: 600, dataCopy: false } })
    expect(json(await post(update.server.port, UPDATE_PATHS.apply, { handle, chats: 'wait', dataCopy: true, acknowledged: [] }))).toMatchObject({ code: 'REPORT_EXPIRED' })
    expect(update.log.some(line => line.includes('update to 0.1.1 begun from the computer'))).toBe(true)
  })

  it('update-confirm-requires-ticks: a disabled plugin, the log check and declining the data copy each need a tick', async () => {
    const update = await serveUpdate()
    const handle = await prepared(update, report([DISABLED_PLUGIN, DATA_ITEM], { log: 'unchecked' }))
    const state = json(await get(update.server.port, UPDATE_PATHS.state)).prepared as { confirm: { ticks: string[], dataItem: number } }
    expect(state.confirm).toEqual({ ticks: ['item:0', 'log'], dataItem: 1 })
    const none = await post(update.server.port, UPDATE_PATHS.apply, { handle, chats: 'wait', dataCopy: true, acknowledged: [] })
    expect(none.status).toBe(409)
    expect(json(none)).toMatchObject({ code: 'ACKNOWLEDGEMENT_MISSING', missing: ['item:0', 'log'] })
    const declined = await post(update.server.port, UPDATE_PATHS.apply, { handle, chats: 'wait', dataCopy: false, acknowledged: ['item:0', 'log'] })
    expect(json(declined)).toMatchObject({ code: 'ACKNOWLEDGEMENT_MISSING', missing: ['data-no-copy'] })
    expect(update.channel.ops()).not.toContain('update.apply')
    const accepted = await post(update.server.port, UPDATE_PATHS.apply, { handle, chats: 'wait', dataCopy: false, acknowledged: ['item:0', 'log', 'data-no-copy'] })
    expect(accepted.status, accepted.body).toBe(200)
  })

  it('update-conflicted-harness-cannot-confirm and update-failed-log-check-cannot-confirm: no tick makes them apply', async () => {
    for (const [items, release, blocked] of [[[CONFLICTED_HARNESS], {}, 'harness-conflict'], [[], { log: 'failed' as const }, 'log-failed']] as const) {
      const update = await serveUpdate()
      const handle = await prepared(update, report(items, release))
      expect(json(await get(update.server.port, UPDATE_PATHS.state)).prepared).toMatchObject({ confirm: { blocked } })
      const reply = await post(update.server.port, UPDATE_PATHS.apply, { handle, chats: 'wait', dataCopy: true, acknowledged: ['item:0', 'log', 'data-no-copy'] })
      expect(reply.status).toBe(409)
      expect(json(reply)).toMatchObject({ code: 'REPORT_BLOCKED' })
      expect(update.channel.ops()).not.toContain('update.apply')
    }
  })

  it('update-apply-refuses-while-restarting: the home process\'s refusals keep their codes and the report survives to try again', async () => {
    const update = await serveUpdate()
    const handle = await prepared(update)
    for (const [error, code] of [['RESTART_IN_PROGRESS', 'RESTART_IN_PROGRESS'], ['UPDATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS'], ['DATA_COPY_NO_SPACE', 'DATA_COPY_NO_SPACE'], ['HARNESS_CHANGES_PENDING', 'HARNESS_CHANGES_PENDING'], ['SOMETHING_NEW', 'UPDATE_FAILED']] as const) {
      update.channel.answers.set('update.apply', [{ ok: false, error }])
      const reply = await post(update.server.port, UPDATE_PATHS.apply, { handle, chats: 'wait', dataCopy: true, acknowledged: [] })
      expect(json(reply), error).toMatchObject({ code })
    }
    update.channel.answers.set('update.apply', [{ ok: true, phase: 'snapshot' }])
    expect((await post(update.server.port, UPDATE_PATHS.apply, { handle, chats: 'wait', dataCopy: true, acknowledged: [] })).status).toBe(200)
  })

  it('prepare shows the install progress and refuses a second prepare', async () => {
    const update = await serveUpdate()
    preparing(update)
    const reply = await post(update.server.port, UPDATE_PATHS.prepare)
    expect(json(reply)).toMatchObject({ prepared: { kind: 'patch', runningChats: 2, report: { to: { delorun: '0.1.1' } } } })
    expect(update.channel.requests[0]).toEqual({ op: 'update.prepare', args: {} })
  })

  it('update-token-never-leaves-host: no answer carries the channel token or the home process\'s report id', async () => {
    const update = await serveUpdate({ powers: 'full' })
    const replies: Reply[] = []
    preparing(update)
    replies.push(await post(update.server.port, UPDATE_PATHS.prepare))
    replies.push(await get(update.server.port, UPDATE_PATHS.state))
    const handle = (json(replies[0]!).prepared as { handle: string }).handle
    replies.push(await post(update.server.port, UPDATE_PATHS.apply, { handle, chats: 'wait', dataCopy: true, acknowledged: [] }))
    update.channel.answers.set('stop', [{ ok: false, error: 'SOMETHING_NEW' }])
    replies.push(await post(update.server.port, UPDATE_PATHS.stop, { chats: 'wait' }))
    replies.push(await get(update.server.port, UPDATE_PATHS.state))
    for (const reply of replies) {
      expect(reply.body).not.toContain(CHANNEL_TOKEN)
      expect(reply.body).not.toContain(REPORT_ID)
    }
    expect(update.log.join('\n')).not.toContain(CHANNEL_TOKEN)
    expect(update.log.join('\n')).not.toContain(REPORT_ID)
  })
})

describe('rollback, cancel, stop and state', () => {
  it('a rollback sends the drain choice and profileOnly, and the home process\'s refusals keep their codes', async () => {
    const update = await serveUpdate()
    update.channel.answers.set('rollback', [{ ok: true, phase: 'reporting' }])
    expect(json(await post(update.server.port, UPDATE_PATHS.rollback, { chats: 'wait', profileOnly: true })).kind).toBe('rollback-begun')
    expect(update.channel.requests.at(-1)).toEqual({ op: 'rollback', args: { wait: 'drain', drainTimeoutS: 600, profileOnly: true } })
    update.channel.answers.set('rollback', [{ ok: false, error: 'ROLLBACK_NEEDS_DATA_COPY' }])
    expect(json(await post(update.server.port, UPDATE_PATHS.rollback, { chats: 'wait', profileOnly: false }))).toMatchObject({ code: 'ROLLBACK_NEEDS_DATA_COPY' })
    expect((await post(update.server.port, UPDATE_PATHS.rollback, { chats: 'someday' })).status).toBe(400)
  })

  it('stop sends the drain mode and says how many chats run; its refusal keeps its code', async () => {
    const update = await serveUpdate()
    expect(json(await post(update.server.port, UPDATE_PATHS.stop, { chats: 'stop' }))).toEqual({ kind: 'stopping', runningChats: 2 })
    expect(update.channel.requests.at(-1)).toEqual({ op: 'stop', args: { mode: 'cancel' } })
    expect((await post(update.server.port, UPDATE_PATHS.stop, {})).status).toBe(400)
  })

  it('cancel asks the home process and answers its refusal once the update is past waiting', async () => {
    const update = await serveUpdate()
    update.channel.answers.set('update.cancel', [{ ok: false, error: 'UPDATE_IN_PROGRESS' }])
    expect(json(await post(update.server.port, UPDATE_PATHS.cancel))).toMatchObject({ code: 'UPDATE_IN_PROGRESS' })
  })

  it('update-result-survives-switch: the outcome record reaches the page until the person dismisses it', async () => {
    const update = await serveUpdate({ powers: 'careful' })
    writeResult(update.home, { v: 1, kind: 'update', outcome: 'rolled-back', from: '0.1.0', to: '0.1.1', reason: 'HEALTH_CHECK_FAILED', criterion: 'H2-host-ready', at: '2026-11-17T12:00:00.000Z' })
    expect(json(await get(update.server.port, UPDATE_PATHS.state)).result).toEqual({ kind: 'update', outcome: 'rolled-back', from: '0.1.0', to: '0.1.1', reason: 'HEALTH_CHECK_FAILED', criterion: 'H2-host-ready', at: '2026-11-17T12:00:00.000Z' })
    expect((await post(update.server.port, UPDATE_PATHS.dismiss)).status).toBe(200)
    expect(json(await get(update.server.port, UPDATE_PATHS.state)).result).toBeUndefined()
  })

  it('state names every control\'s decision, and hides the report from a request that may not begin an update', async () => {
    const update = await serveUpdate({ powers: 'careful' })
    const handle = await prepared(update, report([DISABLED_PLUGIN]))
    const computer = json(await get(update.server.port, UPDATE_PATHS.state))
    expect(computer.prepared).toMatchObject({ handle })
    expect(computer.access).toMatchObject({ actor: 'computer', may: { 'update-begin': { ok: true }, 'update-rollback': { ok: true }, stop: { ok: true } } })
    const phone = json(await send(update.server.port, UPDATE_PATHS.state, { method: 'GET', host: 'studio.example.ts.net', headers: [CREDENTIAL, 'x-test-remote: 1', 'x-test-unlock: fresh'] }))
    expect(phone.access).toMatchObject({ actor: 'device-unlocked', phonePowers: 'careful', may: { 'update-check': { ok: true }, 'update-begin': { ok: false, needs: 'computer' }, 'update-rollback': { ok: false, needs: 'computer' }, 'update-cancel': { ok: true }, stop: { ok: true } } })
    expect(phone.prepared).toBeUndefined()
    expect(JSON.stringify(phone)).not.toContain('@x/plug')
  })

  it('state reports the home process\'s update phase and the rollback that is available', async () => {
    const update = await serveUpdate()
    update.channel.answers.set('status', [{ ok: true, status: { state: 'waiting', pid: 1, startId: 's', runtime: { current: '0.1.0', running: '0.1.0' }, chats: 3, update: { phase: 'waiting', target: '0.1.1' } } }])
    expect(json(await get(update.server.port, UPDATE_PATHS.state)).progress).toEqual({ kind: 'applying', phase: 'waiting', target: '0.1.1', runningChats: 3 })
    expect(json(await get(update.server.port, UPDATE_PATHS.state)).rollback).toEqual({ available: false })
  })
})

describe('one update at a time, and one check at a time', () => {
  it('update-apply-double-click: a second apply while the first starts is refused and sends nothing', async () => {
    const update = await serveUpdate()
    const handle = await prepared(update)
    const body = { handle, chats: 'wait', dataCopy: true, acknowledged: [] }
    const replies = await Promise.all([post(update.server.port, UPDATE_PATHS.apply, body), post(update.server.port, UPDATE_PATHS.apply, body)])
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 409])
    const refused = replies.find(reply => reply.status === 409)
    expect(['UPDATE_IN_PROGRESS', 'REPORT_EXPIRED']).toContain(json(refused as Reply).code)
    expect(update.channel.ops().filter(op => op === 'update.apply')).toHaveLength(1)
  })

  it('an update or rollback that ends with the Host still running leaves no stale phase behind', async () => {
    const update = await serveUpdate()
    update.channel.answers.set('rollback', [{ ok: true, phase: 'reporting' }])
    expect((await post(update.server.port, UPDATE_PATHS.rollback, { chats: 'wait', profileOnly: false })).status).toBe(200)
    update.channel.answers.set('status', [{ ok: true, status: { state: 'waiting', pid: 1, startId: 's', runtime: { current: '0.1.0', running: '0.1.0' }, chats: 0, update: { phase: 'waiting', target: '0.1.1' } } }])
    expect(json(await get(update.server.port, UPDATE_PATHS.state)).progress).toMatchObject({ kind: 'applying', phase: 'waiting' })
  })

  it('check now joins a running check and answers the last result inside the gap', async () => {
    const update = await serveUpdate()
    let runs = 0
    update.check = { state: () => Promise.resolve(undefined), checkNow: () => { runs += 1; return new Promise(resolve => setTimeout(() => resolve({ checked: runs }), 20)) } }
    const together = await Promise.all([post(update.server.port, UPDATE_PATHS.check), post(update.server.port, UPDATE_PATHS.check), post(update.server.port, UPDATE_PATHS.check)])
    expect(together.map(reply => json(reply).checkedAt)).toEqual([1, 1, 1])
    expect(json(await post(update.server.port, UPDATE_PATHS.check))).toMatchObject({ checkedAt: 1 })
    expect(runs).toBe(1)
    update.clock.now += 10_001
    expect(json(await post(update.server.port, UPDATE_PATHS.check))).toMatchObject({ checkedAt: 2 })
    expect(runs).toBe(2)
  })
})
