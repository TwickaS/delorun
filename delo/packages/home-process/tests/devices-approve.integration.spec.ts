/**
 * The update channel's `devices.approve` (contracts C5 and C19): the person's own command opens the approval window and
 * approves with the match code, and the Host's channel token, which acts for studio sessions on every listener, is
 * refused before anything opens.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { newStartToken } from '@delo/home'
import { approveDevices, ChannelTokenCheck, removeDevice, sendHomeRequest, type LocalDeviceApproval, type PendingDevice, type ResponseLine } from '../src/index.ts'
import type { DevicesApproveRequest, DevicesRemoveRequest } from '@delo/contract-home-process'
import { installFixture, killLockHolder, PROFILE, startHome, tempHome, V1, type InProcessHome, type TempHome } from './support.ts'

/** A fake of home-auth's half that records every call. */
class FakeDevices implements LocalDeviceApproval {
  readonly calls: string[] = []
  open: number | undefined
  queue: PendingDevice[] = []
  refusal: Error | undefined

  async openWindow(): Promise<number> {
    this.calls.push('open')
    this.open = 1_000
    return Promise.resolve(this.open)
  }

  windowOpenUntil(): number | undefined {
    return this.open
  }

  pending(): readonly PendingDevice[] {
    return this.queue
  }

  async approve(requestId: string, typedCode: string): Promise<{ readonly id: string; readonly label: string; readonly address: string }> {
    this.calls.push(`approve ${requestId} ${typedCode}`)
    if (this.refusal !== undefined) throw this.refusal
    return Promise.resolve({ id: 'device', label: 'Phone', address: 'https://home.example.ts.net' })
  }

  cancel(requestId: string): void {
    this.calls.push(`cancel ${requestId}`)
    if (this.refusal !== undefined) throw this.refusal
  }

  async remove(deviceId: string): Promise<{ readonly removed: boolean; readonly sessions: number; readonly connections: number }> {
    this.calls.push(`remove ${deviceId}`)
    if (this.refusal !== undefined) throw this.refusal
    return Promise.resolve({ removed: true, sessions: 2, connections: 1 })
  }
}

const PENDING: PendingDevice = { requestId: 'AAAAAAAAAAAAAAAAAAAAAA', label: 'Phone', platform: 'iOS', address: 'https://home.example.ts.net', createdAt: 0, expiresAt: 1 }

function request(args: DevicesApproveRequest['args'] = {}): DevicesApproveRequest {
  return { v: 1, token: newStartToken(), op: 'devices.approve', args }
}

function final(lines: readonly ResponseLine[]): ResponseLine | undefined {
  return lines.at(-1)
}

describe('devices.approve', () => {
  it('the channel token cannot call devices.approve', async () => {
    const devices = new FakeDevices()
    // Pins the caller rule: without it the Host's token opens the window and approves.
    await expect(approveDevices(request(), 'host', devices)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    await expect(approveDevices(request({ requestId: PENDING.requestId, typedCode: '12345678' }), 'host', devices)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    await expect(approveDevices(request({ cancelRequestId: PENDING.requestId }), 'host', devices)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    expect(devices.calls).toEqual([])
    expect(devices.open).toBeUndefined()
  })

  it('opens the window and answers once a request is pending', async () => {
    const devices = new FakeDevices()
    const waits: number[] = []
    const answer = await approveDevices(request(), 'person', devices, async (ms) => {
      waits.push(ms)
      devices.queue = [PENDING]
      return Promise.resolve()
    })
    expect(answer).toEqual({ closesAt: 1_000, pending: [PENDING] })
    expect(waits).toHaveLength(1)
    expect(devices.calls).toEqual(['open'])
  })

  it('answers with no request once the window closed', async () => {
    const devices = new FakeDevices()
    const answer = await approveDevices(request(), 'person', devices, async () => {
      devices.open = undefined
      return Promise.resolve()
    })
    expect(answer).toEqual({ closesAt: 1_000, pending: [] })
  })

  it('approves with the typed code and names home-auth\'s refusal', async () => {
    const devices = new FakeDevices()
    await expect(approveDevices(request({ requestId: PENDING.requestId, typedCode: '1234 5678' }), 'person', devices))
      .resolves.toEqual({ device: { id: 'device', label: 'Phone', address: 'https://home.example.ts.net' } })
    devices.refusal = Object.assign(new Error('wrong'), { code: 'APPROVAL_CODE_MISMATCH', detail: 'That code is wrong' })
    await expect(approveDevices(request({ requestId: PENDING.requestId, typedCode: '00000000' }), 'person', devices))
      .rejects.toMatchObject({ code: 'APPROVAL_FAILED', detail: 'APPROVAL_CODE_MISMATCH: That code is wrong' })
    devices.refusal = new Error('broken')
    await expect(approveDevices(request({ requestId: PENDING.requestId, typedCode: '00000000' }), 'person', devices))
      .rejects.toMatchObject({ code: 'APPROVAL_FAILED', detail: 'INTERNAL_ERROR: the approval failed' })
    await expect(approveDevices(request({ requestId: PENDING.requestId }), 'person', devices)).rejects.toMatchObject({ code: 'SCHEMA_VIOLATION' })
    await expect(approveDevices(request(), 'person', undefined)).rejects.toMatchObject({ code: 'APPROVALS_UNAVAILABLE' })
  })

  it('cancels the request the person chose, alone, and names home-auth\'s refusal', async () => {
    const devices = new FakeDevices()
    await expect(approveDevices(request({ cancelRequestId: PENDING.requestId }), 'person', devices)).resolves.toEqual({ cancelled: PENDING.requestId })
    // Pins the exclusive arguments: a cancel that also names an approval does neither.
    await expect(approveDevices(request({ cancelRequestId: PENDING.requestId, requestId: PENDING.requestId, typedCode: '12345678' }), 'person', devices))
      .rejects.toMatchObject({ code: 'SCHEMA_VIOLATION' })
    await expect(approveDevices(request({ cancelRequestId: PENDING.requestId, typedCode: '12345678' }), 'person', devices)).rejects.toMatchObject({ code: 'SCHEMA_VIOLATION' })
    devices.refusal = Object.assign(new Error('gone'), { code: 'APPROVAL_EXPIRED', detail: 'This request is no longer waiting' })
    await expect(approveDevices(request({ cancelRequestId: PENDING.requestId }), 'person', devices))
      .rejects.toMatchObject({ code: 'APPROVAL_FAILED', detail: 'APPROVAL_EXPIRED: This request is no longer waiting' })
    devices.refusal = new Error('broken')
    await expect(approveDevices(request({ cancelRequestId: PENDING.requestId }), 'person', devices))
      .rejects.toMatchObject({ code: 'APPROVAL_FAILED', detail: 'INTERNAL_ERROR: the cancel failed' })
    expect(devices.calls).toEqual([`cancel ${PENDING.requestId}`, `cancel ${PENDING.requestId}`, `cancel ${PENDING.requestId}`])
  })

  it('tells the two credentials apart and accepts each', () => {
    const person = newStartToken()
    const host = newStartToken()
    const check = new ChannelTokenCheck(person, host)
    expect([check.accepts(person), check.accepts(host), check.accepts(newStartToken()), check.accepts(undefined)]).toEqual([true, true, false, false])
    expect([check.callerOf(person), check.callerOf(host)]).toEqual(['person', 'host'])
  })
})

function removal(deviceId = 'device'): DevicesRemoveRequest {
  return { v: 1, token: newStartToken(), op: 'devices.remove', args: { deviceId } }
}

describe('devices.remove', () => {
  it('removes for the person only, and names home-auth\'s refusal', async () => {
    const devices = new FakeDevices()
    // Pins the caller rule: without it the Host's token, which acts for reach sessions, removes the person's devices.
    await expect(removeDevice(removal(), 'host', devices)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    expect(devices.calls).toEqual([])
    await expect(removeDevice(removal(), 'person', undefined)).rejects.toMatchObject({ code: 'APPROVALS_UNAVAILABLE' })
    await expect(removeDevice(removal(), 'person', devices)).resolves.toEqual({ removed: true, sessions: 2, connections: 1 })
    devices.refusal = Object.assign(new Error('no owner'), { code: 'NO_OWNER', detail: 'This home has no owner yet' })
    await expect(removeDevice(removal(), 'person', devices)).rejects.toMatchObject({ code: 'REMOVAL_FAILED', detail: 'NO_OWNER: This home has no owner yet' })
    devices.refusal = new Error('disk')
    await expect(removeDevice(removal(), 'person', devices)).rejects.toMatchObject({ code: 'REMOVAL_FAILED', detail: 'INTERNAL_ERROR: the removal failed' })
    expect(devices.calls).toEqual(['remove device', 'remove device', 'remove device'])
  })
})

describe('devices.approve on a running home process', () => {
  let temp: TempHome | undefined
  let running: InProcessHome | undefined
  afterEach(async () => {
    if (running !== undefined) {
      await running.process.shutdown(0)
      running.exit()
    }
    if (temp !== undefined) await killLockHolder(temp.home)
    temp?.remove()
    temp = undefined
    running = undefined
  })

  it('serves the person\'s command and refuses the Host\'s access, which still reaches every other operation', async () => {
    temp = await tempHome()
    installFixture(temp.home, V1)
    running = await startHome(temp.home, { updates: false })
    const devices = new FakeDevices()
    Object.defineProperty(running.hosts.latest, 'devices', { value: devices })
    // The request arrives while the person's command waits for it.
    setTimeout(() => { devices.queue = [PENDING] }, 100)
    const access = running.hosts.latest.access
    // Pins the Host's own credential: with the token file's token the Host would pass the caller rule.
    expect(final(await access.send({ op: 'devices.approve', args: {} }))).toMatchObject({ ok: false, error: 'LOOPBACK_REQUIRED' })
    expect(devices.calls).toEqual([])
    expect(final(await access.send({ op: 'status' }))).toMatchObject({ ok: true, status: { state: 'running' } })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'devices.approve', args: {} }))).toMatchObject({ ok: true, pending: [PENDING] })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'devices.approve', args: { requestId: PENDING.requestId, typedCode: '1234 5678' } })))
      .toMatchObject({ ok: true, device: { id: 'device' } })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'devices.approve', args: { requestId: '../../etc/passwd', typedCode: '1234' } })))
      .toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    expect(final(await access.send({ op: 'devices.approve', args: { cancelRequestId: PENDING.requestId } }))).toMatchObject({ ok: false, error: 'LOOPBACK_REQUIRED' })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'devices.approve', args: { cancelRequestId: PENDING.requestId } })))
      .toMatchObject({ ok: true, cancelled: PENDING.requestId })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'devices.approve', args: { cancelRequestId: '../x' } }))).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    expect(final(await access.send({ op: 'devices.remove', args: { deviceId: 'device' } }))).toMatchObject({ ok: false, error: 'LOOPBACK_REQUIRED' })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'devices.remove', args: { deviceId: 'device' } }))).toMatchObject({ ok: true, removed: true, sessions: 2 })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'devices.remove', args: { deviceId: '../x' } }))).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    expect(devices.calls).toEqual(['open', `approve ${PENDING.requestId} 1234 5678`, `cancel ${PENDING.requestId}`, 'remove device'])
  })
})
