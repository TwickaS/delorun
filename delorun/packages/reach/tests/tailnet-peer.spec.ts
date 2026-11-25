/**
 * The Tailscale local API check over a real Unix socket: a peer the daemon names, and every way the daemon can fail to
 * name one, each of which refuses rather than assuming the tailnet (A667).
 *
 * Each test's comment names the check whose removal makes that test fail.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkTailnetPeer, isTailnetAddress, tailscaledSocketPath } from '../src/tailnet-peer.ts'

/** The tailnet address the fake daemon knows. */
const PEER = '100.101.102.103'
/** The tailnet login that owns the device. */
const LOGIN = 'person@example.com'

/** A fake `tailscaled` local API on a Unix socket, and the directory holding it. */
interface FakeDaemon {
  readonly socketPath: string
  /** Stop answering, leaving the socket file behind as a daemon that died does. */
  readonly stop: () => Promise<void>
  /** Stop answering and remove the socket's directory. */
  readonly close: () => Promise<void>
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/**
 * Start a fake local API that answers every request with one status and body.
 * @param status - the status to answer.
 * @param body - the body to answer.
 * @returns the daemon.
 */
async function daemon(status: number, body: string): Promise<FakeDaemon> {
  const directory = await mkdtemp(join(tmpdir(), 'delorun-whois-'))
  const socketPath = join(directory, 'tailscaled.sock')
  const server: Server = createServer((_request, response) => {
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { resolve() })
  })
  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  const close = async (): Promise<void> => {
    await stop()
    await rm(directory, { recursive: true, force: true })
  }
  cleanups.push(close)
  return { socketPath, stop, close }
}

/**
 * The whois answer `tailscaled` prints for one device.
 * @param expiry - the node's `KeyExpiry`.
 * @returns the JSON.
 */
function whoisJson(expiry = '2099-01-01T00:00:00Z'): string {
  return JSON.stringify({
    Node: { ID: 542825148714174, StableID: 'nRYKaa6rE511CNTRL', Name: 'phone.tailnet.ts.net.', KeyExpiry: expiry },
    UserProfile: { ID: 6262859537397796, LoginName: LOGIN, DisplayName: 'The Person' },
  })
}

/** A directory with no socket in it, whose path is a socket path that is not there. */
async function absentSocket(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delorun-whois-absent-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  return join(directory, 'tailscaled.sock')
}

/**
 * A socket path a daemon left behind when it died: the file is there and nothing accepts on it, which a connection
 * answers with `ECONNREFUSED`. Node unlinks a Unix socket when its own server closes, so the file is made directly.
 * @returns the path.
 */
async function staleSocket(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'delorun-whois-stale-'))
  const socketPath = join(directory, 'tailscaled.sock')
  await writeFile(socketPath, '')
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  return socketPath
}

describe('the Tailscale local API check', () => {
  it('names the device and its user for an address the daemon knows', async () => {
    // Removing the whois call, or the fields it reads, makes this fail: no peer is named.
    const fake = await daemon(200, whoisJson())
    const check = await checkTailnetPeer(PEER, { socketPath: fake.socketPath })
    expect(check).toEqual({
      kind: 'peer',
      peer: { nodeId: '542825148714174', stableId: 'nRYKaa6rE511CNTRL', name: 'phone.tailnet.ts.net', login: LOGIN, displayName: 'The Person' },
    })
  })

  it('refuses when the socket is absent, rather than assuming the tailnet', async () => {
    // Removing the socket-absent refusal makes this fail: the check would answer a peer or a daemon-down.
    const check = await checkTailnetPeer(PEER, { socketPath: await absentSocket() })
    expect(check).toMatchObject({ kind: 'refused', refusal: 'socket-absent' })
  })

  it('refuses when the daemon is down, leaving its socket behind', async () => {
    // Removing the connection-refused refusal makes this fail: a socket with no daemon behind it would name a peer.
    const check = await checkTailnetPeer(PEER, { socketPath: await staleSocket() })
    expect(check).toMatchObject({ kind: 'refused', refusal: 'daemon-down' })
  })

  it('refuses when the daemon answers but does not know the peer', async () => {
    // Removing the 404 refusal makes this fail: an unknown address would be read as a peer.
    const fake = await daemon(404, 'no match for IP:port')
    const check = await checkTailnetPeer(PEER, { socketPath: fake.socketPath })
    expect(check).toMatchObject({ kind: 'refused', refusal: 'unknown-peer' })
  })

  it('refuses a device whose key has expired, which has left the tailnet', async () => {
    // Removing the expiry refusal makes this fail: a removed device would be named as a peer.
    const fake = await daemon(200, whoisJson('2020-01-01T00:00:00Z'))
    const check = await checkTailnetPeer(PEER, { socketPath: fake.socketPath })
    expect(check).toMatchObject({ kind: 'refused', refusal: 'device-removed' })
  })

  it('refuses an address that is not a tailnet address', async () => {
    // Removing the address check makes this fail: a loopback or LAN address would be asked about and could match.
    const fake = await daemon(200, whoisJson())
    for (const address of ['127.0.0.1', '192.168.1.5', '10.0.0.1', '100.63.0.1', '100.128.0.1', 'not-an-address']) {
      expect(await checkTailnetPeer(address, { socketPath: fake.socketPath })).toMatchObject({ kind: 'refused', refusal: 'not-a-tailnet-address' })
    }
  })

  it('refuses an answer that is not the whois JSON', async () => {
    // Removing the parse refusal makes this fail: unreadable output would be read as a peer.
    const fake = await daemon(200, 'not json at all')
    expect(await checkTailnetPeer(PEER, { socketPath: fake.socketPath })).toMatchObject({ kind: 'refused', refusal: 'daemon-down' })
  })

  it('refuses an answer that names no device or no user', async () => {
    // Removing the field refusal makes this fail: a half answer would be read as a peer.
    const noUser = await daemon(200, JSON.stringify({ Node: { ID: 1, Name: 'x.ts.net.' } }))
    expect(await checkTailnetPeer(PEER, { socketPath: noUser.socketPath })).toMatchObject({ kind: 'refused', refusal: 'daemon-down' })
  })

  it('refuses a daemon that answers with a status other than 200 or 404', async () => {
    // Removing the status refusal makes this fail: a 403 from a daemon that will not answer would name a peer.
    const fake = await daemon(403, 'whois access denied')
    expect(await checkTailnetPeer(PEER, { socketPath: fake.socketPath })).toMatchObject({ kind: 'refused', refusal: 'daemon-down' })
  })

  it('refuses a daemon that does not answer within the budget', async () => {
    // Removing the timeout refusal makes this fail: a hung daemon would hold the request open instead of refusing.
    const directory = await mkdtemp(join(tmpdir(), 'delorun-whois-hang-'))
    const socketPath = join(directory, 'tailscaled.sock')
    const server = createServer(() => { /* never answers */ })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { resolve() })
    })
    cleanups.push(async () => {
      await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) })
      await rm(directory, { recursive: true, force: true })
    })
    expect(await checkTailnetPeer(PEER, { socketPath, timeoutMs: 100 })).toMatchObject({ kind: 'refused', refusal: 'daemon-down' })
  })

  it('refuses on a platform whose daemon keeps no socket', async () => {
    // Removing the platform refusal makes this fail: Windows would be asked over a path that does not exist.
    expect(tailscaledSocketPath('win32')).toBeUndefined()
    expect(await checkTailnetPeer(PEER, { platform: 'win32' })).toMatchObject({ kind: 'refused', refusal: 'socket-absent' })
  })
})

describe('the tailnet address test', () => {
  it('accepts the ranges the tailnet hands out and nothing else', () => {
    // Removing either range check makes this fail.
    expect(isTailnetAddress('100.64.0.1')).toBe(true)
    expect(isTailnetAddress('100.127.255.254')).toBe(true)
    expect(isTailnetAddress('fd7a:115c:a1e0::5b2a:1e58')).toBe(true)
    expect(isTailnetAddress('100.63.255.255')).toBe(false)
    expect(isTailnetAddress('100.128.0.0')).toBe(false)
    expect(isTailnetAddress('127.0.0.1')).toBe(false)
    expect(isTailnetAddress('fd7a:115c:a1e1::1')).toBe(false)
    expect(isTailnetAddress('')).toBe(false)
  })
})
