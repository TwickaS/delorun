/**
 * The update channel's consent operations (contract C19): `permission.reload` and `mcp.list` for either token, and
 * `mcp.accept`, `mcp.decline` and `mcp.revoke` for the person's own command only. The Host's channel token, which acts for studio
 * sessions on every listener, is refused with `LOOPBACK_REQUIRED` before anything is read; a stale review and a
 * profile without the consent are refused with their codes, and a request carrying a path is refused by the schema.
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { newStartToken } from '@delo/home'
import type { McpAcceptRequest, McpDeclineRequest, McpRevokeRequest } from '@delo/contract-home-process'
import {
  acceptServer, declineServer, listServers, reloadPermissions, revokeServer, sendHomeRequest,
  type AcceptedMcpServer, type LocalConsents, type PendingMcpServer, type ResponseLine,
} from '../src/index.ts'
import { installFixture, killLockHolder, PROFILE, startHome, tempHome, V1, type InProcessHome, type TempHome } from './support.ts'

const SERVER: PendingMcpServer = {
  serverName: 'files', reviewId: 'a'.repeat(32), command: 'npx', args: [], cwd: '',
  resolvedCommand: '/opt/bin/npx', resolvedCwd: '/home/person', env: [{ name: 'PATH', value: '/opt/bin' }, { name: 'TOKEN' }], files: [], writableByChats: [],
  reason: 'not accepted', change: 'environment', changedVariables: ['TOKEN'], state: 'waiting', reviewedAt: 0,
}

const ACCEPTED: AcceptedMcpServer = { acceptanceId: 'c'.repeat(32), serverName: 'git', command: 'uvx', args: [], cwd: '',
  resolvedCommand: '/usr/bin/uvx', resolvedCwd: '/home/person', resolvedShell: '/bin/sh', env: [], files: [], acceptedAt: 1, configured: true }

/** A fake of the Host's consents that records every call and refuses a review id other than the one it holds. */
class FakeConsents implements LocalConsents {
  readonly calls: string[] = []

  async reloadPermissions(): Promise<{ readonly digest: string }> {
    this.calls.push('reload')
    return Promise.resolve({ digest: 'sha256:entries' })
  }

  pendingServers(): readonly PendingMcpServer[] {
    return [SERVER]
  }

  async acceptServer(serverName: string, reviewId: string): Promise<{ readonly started: number }> {
    this.calls.push(`accept ${serverName}`)
    if (reviewId !== SERVER.reviewId) throw Object.assign(new Error('reviewed again'), { code: 'STALE_REVIEW' })
    return Promise.resolve({ started: 1 })
  }

  async declineServer(serverName: string, reviewId: string): Promise<boolean> {
    this.calls.push(`decline ${serverName}`)
    if (reviewId !== SERVER.reviewId) throw Object.assign(new Error('reviewed again'), { code: 'STALE_REVIEW' })
    return Promise.resolve(true)
  }

  async acceptedServers(): Promise<readonly AcceptedMcpServer[]> {
    return Promise.resolve([ACCEPTED])
  }

  async revokeServer(acceptanceId: string): Promise<{ readonly stopped: number }> {
    this.calls.push(`revoke ${acceptanceId.slice(0, 4)}`)
    if (acceptanceId !== ACCEPTED.acceptanceId) throw Object.assign(new Error('accepted again'), { code: 'STALE_REVIEW' })
    return Promise.resolve({ stopped: 1 })
  }
}

/** The fake of a profile whose consent switches are off: every service is absent. */
const ABSENT: LocalConsents = {
  reloadPermissions: async () => Promise.resolve(undefined),
  pendingServers: () => undefined,
  acceptServer: async () => Promise.resolve(undefined),
  declineServer: async () => Promise.resolve(false),
  acceptedServers: async () => Promise.resolve(undefined),
  revokeServer: async () => Promise.resolve(undefined),
}

function revocation(acceptanceId = ACCEPTED.acceptanceId): McpRevokeRequest {
  return { v: 1, token: newStartToken(), op: 'mcp.revoke', args: { acceptanceId } }
}

function answer(op: 'mcp.accept', reviewId?: string): McpAcceptRequest
function answer(op: 'mcp.decline', reviewId?: string): McpDeclineRequest
function answer(op: 'mcp.accept' | 'mcp.decline', reviewId = SERVER.reviewId): McpAcceptRequest | McpDeclineRequest {
  return { v: 1, token: newStartToken(), op, args: { serverName: 'files', reviewId } }
}

function final(lines: readonly ResponseLine[]): ResponseLine | undefined {
  return lines.at(-1)
}

describe('the consent operations', () => {
  it('refuse an answer from the Host\'s channel token before the consent is read', async () => {
    const consents = new FakeConsents()
    // Pins the caller rule of each answer: without it the Host's token, which acts for reach sessions, would accept.
    await expect(acceptServer(answer('mcp.accept'), 'host', consents)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    await expect(declineServer(answer('mcp.decline'), 'host', consents)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    await expect(revokeServer(revocation(), 'host', consents)).rejects.toMatchObject({ code: 'LOOPBACK_REQUIRED' })
    expect(consents.calls).toEqual([])
  })

  it('accept and decline for the person, and name a stale review', async () => {
    const consents = new FakeConsents()
    await expect(acceptServer(answer('mcp.accept'), 'person', consents)).resolves.toEqual({ started: 1 })
    await expect(declineServer(answer('mcp.decline'), 'person', consents)).resolves.toEqual({ declined: true })
    // Pins the mapping of the Host's stale review: without it the answer would read as an unknown failure.
    await expect(acceptServer(answer('mcp.accept', 'b'.repeat(32)), 'person', consents)).rejects.toMatchObject({ code: 'STALE_REVIEW' })
    await expect(declineServer(answer('mcp.decline', 'b'.repeat(32)), 'person', consents)).rejects.toMatchObject({ code: 'STALE_REVIEW' })
    await expect(acceptServer(answer('mcp.accept'), 'person', { ...ABSENT, acceptServer: async () => Promise.reject(new Error('disk full')) }))
      .rejects.toMatchObject({ code: 'CONSENT_FAILED', detail: 'INTERNAL_ERROR: disk full' })
    await expect(acceptServer(answer('mcp.accept'), 'person', { ...ABSENT, acceptServer: async () => Promise.reject('gone') }))
      .rejects.toMatchObject({ code: 'CONSENT_FAILED', detail: 'INTERNAL_ERROR: the answer was not recorded' })
  })

  it('revoke for the person, and name a stale acceptance and a store the Host cannot write', async () => {
    const consents = new FakeConsents()
    await expect(revokeServer(revocation(), 'person', consents)).resolves.toEqual({ stopped: 1 })
    // Pins the mapping of the Host's stale acceptance: without it the answer would read as an unknown failure.
    await expect(revokeServer(revocation('d'.repeat(32)), 'person', consents)).rejects.toMatchObject({ code: 'STALE_REVIEW' })
    const refused = Object.assign(new Error('disk full'), { code: 'STORE_REFUSED' })
    await expect(revokeServer(revocation(), 'person', { ...ABSENT, revokeServer: async () => Promise.reject(refused) }))
      .rejects.toMatchObject({ code: 'CONSENT_FAILED', detail: 'STORE_REFUSED: disk full' })
    await expect(revokeServer(revocation(), 'person', ABSENT)).rejects.toMatchObject({ code: 'CONSENT_UNAVAILABLE' })
  })

  it('list and reload for either caller, and refuse a profile without the consent', async () => {
    const consents = new FakeConsents()
    await expect(listServers(consents)).resolves.toEqual({ servers: [SERVER], accepted: [ACCEPTED] })
    await expect(reloadPermissions(consents)).resolves.toEqual({ digest: 'sha256:entries' })
    await expect(listServers(ABSENT)).rejects.toMatchObject({ code: 'CONSENT_UNAVAILABLE' })
    await expect(reloadPermissions(undefined)).rejects.toMatchObject({ code: 'CONSENT_UNAVAILABLE' })
    await expect(acceptServer(answer('mcp.accept'), 'person', ABSENT)).rejects.toMatchObject({ code: 'CONSENT_UNAVAILABLE' })
    await expect(declineServer(answer('mcp.decline'), 'person', ABSENT)).rejects.toMatchObject({ code: 'CONSENT_UNAVAILABLE' })
  })
})

describe('the consent operations on a running home process', () => {
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

  it('the channel token cannot answer an MCP server', async () => {
    temp = await tempHome()
    installFixture(temp.home, V1)
    running = await startHome(temp.home, { updates: false })
    const consents = new FakeConsents()
    Object.defineProperty(running.hosts.latest, 'consents', { value: consents })
    const access = running.hosts.latest.access
    const args = { serverName: 'files', reviewId: SERVER.reviewId }
    const revoked = { acceptanceId: ACCEPTED.acceptanceId }
    expect(final(await access.send({ op: 'mcp.list' }))).toMatchObject({ ok: true, servers: [SERVER], accepted: [ACCEPTED] })
    expect(final(await access.send({ op: 'mcp.accept', args }))).toMatchObject({ ok: false, error: 'LOOPBACK_REQUIRED' })
    expect(final(await access.send({ op: 'mcp.decline', args }))).toMatchObject({ ok: false, error: 'LOOPBACK_REQUIRED' })
    expect(final(await access.send({ op: 'mcp.revoke', args: revoked }))).toMatchObject({ ok: false, error: 'LOOPBACK_REQUIRED' })
    expect(consents.calls).toEqual([])
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'permission.reload' }))).toMatchObject({ ok: true, digest: 'sha256:entries' })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'mcp.accept', args }))).toMatchObject({ ok: true, started: 1 })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'mcp.accept', args: { serverName: 'files', reviewId: 'b'.repeat(32) } })))
      .toMatchObject({ ok: false, error: 'STALE_REVIEW' })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'mcp.decline', args: { serverName: '../etc', reviewId: SERVER.reviewId } })))
      .toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'mcp.revoke', args: revoked }))).toMatchObject({ ok: true, stopped: 1 })
    expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'mcp.revoke', args: { acceptanceId: 'd'.repeat(32) } })))
      .toMatchObject({ ok: false, error: 'STALE_REVIEW' })
    // The schema admits only an acceptance id: a command, or an id of another form, is refused before the Host is asked.
    for (const args of [{ acceptanceId: 'uvx' }, { command: 'uvx', acceptedAt: 1 }]) {
      expect(final(await sendHomeRequest(temp.home, PROFILE, { op: 'mcp.revoke', args } as never))).toMatchObject({ ok: false, error: 'SCHEMA_VIOLATION' })
    }
    expect(consents.calls).toEqual(['reload', 'accept files', 'accept files', 'revoke cccc', 'revoke dddd'])
  })
})
