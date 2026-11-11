/**
 * `requireComputer`, which another Delo plugin's route calls so that only the person at the home's own computer reaches
 * it: a request is let through only when the home places it on the loopback listener under a loopback `Host`, and
 * every other request — a reach session's, one naming another `Host`, one the home cannot place, and any while no
 * `homeAuth` is mounted — is answered `403 LOOPBACK_REQUIRED` naming the action.
 */
import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { requireComputer } from '../src/index.ts'

/**
 * A response that records what was answered.
 * @returns the response and the answer.
 */
function recording(): { response: ServerResponse; answered: { status?: number; body?: string } } {
  const answered: { status?: number; body?: string } = {}
  const response = { writeHead(status: number) { answered.status = status }, end(body: string) { answered.body = body } }
  return { response: response as never, answered }
}

/**
 * A `homeAuth` that places every request on one listener.
 * @param listener - the listener, or undefined for a request it cannot place.
 * @returns the service's arrival check.
 */
function placing(listener: string | undefined) {
  return { arrivalOf: () => ({ listener, host: undefined, source: 'unknown' as const }) } as never
}

describe('requireComputer', () => {
  it('lets a loopback request under a loopback Host through and answers nothing', () => {
    const { response, answered } = recording()
    expect(requireComputer({ headers: { host: 'localhost:3080' } } as never, response, placing('loopback'), 'Turning on full access')).toBe(true)
    expect(answered).toEqual({})
  })

  it('refuses a reach session, another Host, an unplaced request and a home without homeAuth with LOOPBACK_REQUIRED', () => {
    const cases: [string | undefined, string, boolean][] = [
      ['tailscale-private', 'home.example.ts.net', true],
      ['loopback', 'attacker.example', true],
      [undefined, 'localhost:3080', true],
      ['loopback', 'localhost:3080', false],
    ]
    for (const [listener, host, mounted] of cases) {
      const { response, answered } = recording()
      expect(requireComputer({ headers: { host } } as never, response, mounted ? placing(listener) : undefined, 'Turning on full access')).toBe(false)
      expect(answered.status).toBe(403)
      expect(JSON.parse(answered.body ?? '{}')).toEqual({ error: 'LOOPBACK_REQUIRED', message: 'Turning on full access needs you at your computer: open the studio on the home\'s own computer' })
    }
  })
})
