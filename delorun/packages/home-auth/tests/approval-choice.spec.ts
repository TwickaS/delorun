/**
 * The person's choice among pending approval requests: every request on the Tailscale route shares the source
 * `127.0.0.1`, so a tailnet device polling for the window can hold places among the 5 pending. A full home refuses a
 * new request, a request leaves only by the person's cancel, approval, three wrong codes or expiry, and three wrong
 * codes end that request alone.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StudioAddress } from '@delorun/contract-admission'
import { DEVICE_APPROVAL_LIMITS, type ApprovalRequestAccepted, type Base64Url } from '@delorun/contract-device-approval'
import { deviceIdOf } from '../src/records.ts'
import { claimOf, homeFixture, keyOf, type Home } from './fixtures/home.ts'

const ADDRESS = brandString<StudioAddress>('https://home.example.ts.net')
const WHERE = { listener: 'reach-tailscale-private', source: '127.0.0.1' } as const

let home: Home

beforeEach(async () => {
  home = await homeFixture()
  home.auth.serve({ listener: WHERE.listener, address: ADDRESS, factor: 'tailnet-membership' })
  await home.auth.openApprovalWindow()
})

afterEach(async () => {
  await home.dispose()
})

/**
 * Send one approval request from the device of a fill.
 * @param fill - the device key's fill.
 * @returns the home's answer.
 */
function ask(fill: number): Promise<ApprovalRequestAccepted> {
  const devicePublicKey = keyOf(fill)
  return home.auth.requestApproval({
    devicePublicKey,
    deviceId: deviceIdOf(devicePublicKey),
    deviceNonce: brandString<Base64Url>(Buffer.alloc(16, fill).toString('base64url')),
    label: `Device ${String(fill)}`,
    platform: '',
  }, WHERE)
}

describe('the person\'s choice among pending requests', () => {
  it('a full home refuses a new request until the person cancels one', async () => {
    const accepted: ApprovalRequestAccepted[] = []
    for (let fill = 1; fill <= DEVICE_APPROVAL_LIMITS.pendingRequestsPerHome; fill += 1) accepted.push(await ask(fill))
    // Pins the pending cap: a sixth request never replaces a waiting one on its own.
    await expect(ask(6)).rejects.toMatchObject({ code: 'APPROVAL_PENDING_LIMIT', detail: expect.stringContaining('delorun devices approve') })
    expect(home.auth.pendingApprovals().map(request => request.label)).toEqual(['Device 1', 'Device 2', 'Device 3', 'Device 4', 'Device 5'])
    const [oldest] = accepted
    if (oldest === undefined) throw new Error('no request was accepted')
    // Pins the cancel: without it the oldest stays pending and the sixth is refused again.
    home.auth.approvals.cancel(oldest.requestId)
    expect(home.auth.approvalState(oldest.requestId, oldest.requestSecret)).toBe('cancelled')
    await expect(ask(6)).resolves.toMatchObject({ requestId: expect.any(String) })
    expect(home.auth.pendingApprovals().map(request => request.label)).toEqual(['Device 2', 'Device 3', 'Device 4', 'Device 5', 'Device 6'])
    // A cancelled request is approved by no code.
    await expect(home.auth.approveLocally(oldest.requestId, '00000000')).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
  })

  it('cancels only a pending request', async () => {
    const accepted = await ask(1)
    home.auth.approvals.cancel(accepted.requestId)
    // Pins the state check: a cancelled, unknown or expired request is not cancelled again.
    expect(() => { home.auth.approvals.cancel(accepted.requestId) }).toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
    expect(() => { home.auth.approvals.cancel('unknown') }).toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
    const later = await ask(2)
    home.clock.advance(DEVICE_APPROVAL_LIMITS.approvalRequestExpiryMs)
    expect(() => { home.auth.approvals.cancel(later.requestId) }).toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
  })

  it('three wrong codes cancel that request alone', async () => {
    const first = await ask(1)
    const second = await ask(2)
    for (let attempt = 0; attempt < DEVICE_APPROVAL_LIMITS.wrongTypedCodesPerRequest; attempt += 1) {
      await expect(home.auth.approveLocally(first.requestId, '00000000')).rejects.toMatchObject({ code: 'APPROVAL_CODE_MISMATCH' })
    }
    // Pins the per-request count: the other request keeps its place and its own three tries.
    expect(home.auth.pendingApprovals().map(request => request.requestId)).toEqual([second.requestId])
    await expect(home.auth.approveLocally(second.requestId, '00000000')).rejects.toMatchObject({ code: 'APPROVAL_CODE_MISMATCH', detail: expect.not.stringMatching(/cancelled/) })
    expect(home.auth.pendingApprovals()).toHaveLength(1)
  })
})

describe('the owner claim\'s label', () => {
  it('refuses a control or bidirectional formatting character', async () => {
    const issued = await home.auth.issueOwnerCode()
    // Pins the label check on the claim, which shares it with an approval request.
    await expect(home.auth.claim(claimOf(issued.code, { label: 'This ‮retupmoc' }))).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
