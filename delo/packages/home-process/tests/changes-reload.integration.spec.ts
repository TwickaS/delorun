/**
 * Contract C19's `changes.reload`: the closed schema admits it with no field beyond `v`, `token` and `op`, and the home
 * process answers it with the Host's reload outcome while it runs and no update does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { checkUpdateRequest, HomeProcessError, sendHomeRequest, type ResponseLine } from '../src/index.ts'
import { FixtureStore, installFixture, killLockHolder, PROFILE, startHome, tempHome, until, V1, V2, type InProcessHome, type TempHome } from './support.ts'

let temp: TempHome | undefined
const homes: InProcessHome[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) {
    await home.process.shutdown(0)
    home.exit()
  }
  if (temp !== undefined) await killLockHolder(temp.home)
  temp?.remove()
  temp = undefined
})

/**
 * @param lines - an exchange's lines.
 * @returns the last one.
 */
function final(lines: readonly ResponseLine[]): ResponseLine {
  const line = lines.at(-1)
  if (line === undefined) throw new Error('no response line')
  return line
}

/**
 * @param request - a parsed request line.
 * @returns the refusal's code, or `accepted`.
 */
function verdict(request: object): string {
  try {
    checkUpdateRequest(request)
    return 'accepted'
  } catch (error) {
    if (error instanceof HomeProcessError) return error.code
    throw error
  }
}

describe('changes.reload carries no arguments', () => {
  it('accepts the bare request and refuses one with args or any other field', () => {
    expect(checkUpdateRequest({ v: 1, token: 't', op: 'changes.reload' })).toEqual({ v: 1, token: 't', op: 'changes.reload' })
    expect(verdict({ v: 1, token: 't', op: 'changes.reload', args: {} })).toBe('SCHEMA_VIOLATION')
    expect(verdict({ v: 1, token: 't', op: 'changes.reload', args: { id: 'c0123456789' } })).toBe('SCHEMA_VIOLATION')
    expect(verdict({ v: 1, token: 't', op: 'changes.reload', plugin: '/tmp/plugin' })).toBe('SCHEMA_VIOLATION')
    expect(verdict({ v: 1, token: 't', op: 'changes.apply' })).toBe('SCHEMA_VIOLATION')
  })
})

describe('the home process answers changes.reload', { timeout: 90_000 }, () => {
  it("with the Host's outcome while it runs, and refuses while an update waits", async () => {
    temp = await tempHome()
    installFixture(temp.home, V1)
    installFixture(temp.home, V2)
    await FixtureStore.seed(temp.home, V1)
    const running = await startHome(temp.home)
    homes.push(running)
    const host = running.hosts.latest
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'changes.reload' }))).toEqual({ ok: true, reload: { ok: true } })
    host.reloadOutcome = { ok: false, error: 'plug failed to start' }
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'changes.reload' }))).toEqual({ ok: true, reload: { ok: false, error: 'plug failed to start' } })
    expect(host.reloads).toBe(2)

    const end = host.chats.begin(() => {})
    const prepared = final(await sendHomeRequest(temp.home, PROFILE, { op: 'update.prepare', args: { target: V2 } }))
    const applying = sendHomeRequest(temp.home, PROFILE, { op: 'update.apply', args: { reportId: prepared.reportId as string, wait: 'drain', dataCopy: false } })
    const home = temp.home
    await until(async () => {
      const lines = await sendHomeRequest(home, PROFILE, { op: 'status' })
      return (final(lines).status as { readonly update?: { readonly phase: string } } | undefined)?.update?.phase === 'waiting'
    }, 10_000, 'waiting')
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'changes.reload' }))).toMatchObject({ ok: false, error: 'UPDATE_IN_PROGRESS' })
    expect(host.reloads).toBe(2)
    await sendHomeRequest(temp.home, PROFILE, { op: 'update.cancel' })
    end()
    await applying
  })
})
