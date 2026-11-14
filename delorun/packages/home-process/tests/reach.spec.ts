/**
 * The update channel's reach operations (contracts C7 and C19): `reach.status` and `reach.apply` serve the person's own
 * `delorun` only, and the Host's channel token, which acts for studio sessions on every listener, reach sessions
 * included, is refused before the Host's reach service is asked anything.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { describe, expect, it } from 'vitest'
import { newStartToken } from '@delorun/home'
import type { ReachApplyRequest, ReachOptionStatus, ReachStatusRequest } from '@delorun/contract-home-process'
import { reachApply, reachStatus, type LocalReach } from '../src/index.ts'

const READY: ReachOptionStatus = { option: 'tailscale-private', state: 'ready', address: 'https://home.example.ts.net' }

/** A fake of the Host's reach service that records every call. */
class FakeReach implements LocalReach {
  readonly calls: string[] = []
  private readonly answer: readonly ReachOptionStatus[] | undefined

  constructor(answer: readonly ReachOptionStatus[] | undefined) {
    this.answer = answer
  }

  status(): readonly ReachOptionStatus[] | undefined {
    this.calls.push('status')
    return this.answer
  }

  async apply(): Promise<readonly ReachOptionStatus[] | undefined> {
    this.calls.push('apply')
    return Promise.resolve(this.answer)
  }
}

const STATUS: ReachStatusRequest = { v: 1, token: newStartToken(), op: 'reach.status' }
const APPLY: ReachApplyRequest = { v: 1, token: newStartToken(), op: 'reach.apply' }

describe('reach.status and reach.apply', () => {
  it('refuse the Host\'s channel token before the reach service is asked', async () => {
    const reach = new FakeReach([READY])
    // Pins the caller rule: without it the Host's token, which acts for reach sessions, reads the tailnet address and
    // turns remote access on and off.
    expect(() => reachStatus(STATUS, 'host', reach)).toThrow(expect.objectContaining({ code: 'LOOPBACK_REQUIRED' }))
    await expect(reachApply(APPLY, 'host', reach)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    expect(reach.calls).toEqual([])
  })

  it('answer the person with each option\'s state', async () => {
    const reach = new FakeReach([READY])
    expect(reachStatus(STATUS, 'person', reach)).toEqual({ options: [READY] })
    await expect(reachApply(APPLY, 'person', reach)).resolves.toEqual({ options: [READY] })
    expect(reach.calls).toEqual(['status', 'apply'])
  })

  it('name a Host without the reach service as unavailable', async () => {
    expect(() => reachStatus(STATUS, 'person', undefined)).toThrow(expect.objectContaining({ code: 'REACH_UNAVAILABLE', detail: 'no Host is running' }))
    await expect(reachApply(APPLY, 'person', undefined)).rejects.toMatchObject({ code: 'REACH_UNAVAILABLE' })
    const unloaded = new FakeReach(undefined)
    expect(() => reachStatus(STATUS, 'person', unloaded)).toThrow(expect.objectContaining({ code: 'REACH_UNAVAILABLE' }))
    await expect(reachApply(APPLY, 'person', unloaded)).rejects.toMatchObject({ code: 'REACH_UNAVAILABLE' })
  })
})
