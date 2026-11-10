/**
 * The whole data plane over loopback: the relay's real TCP listener, its TLS termination for the
 * tunnel host, the HTTP token endpoint, the WebSocket upgrade, and a fixture home that completes
 * C6's handshake and terminates the browser's TLS with its own certificate. The browser trusts
 * only the home's certificate, so a completed handshake proves the relay held no key for the
 * bound name and passed bytes it could not read; the home's log grep proves it never saw the
 * plaintext; the `OPEN` payload proves the peer facts it received are the browser socket's own.
 */
import { X509Certificate } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { RELAY_PATHS, RELAY_PROTOCOL_VERSION } from '@delo/contract-relay-protocol'
import { canonicalJson } from '@delo/release-formats/sign/json'
import { generate } from 'selfsigned'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRelayConfig } from '../../src/config.ts'
import { generateEd25519, rawPublicKey, signBytes, toBase64Url, utf8 } from '../../src/keys.ts'
import { openRelayLog, type RelayLogHandle } from '../../src/log.ts'
import { startRelayServer, type RelayServer } from '../../src/node/server.ts'
import { FixtureHome } from '../fixtures/home.ts'
import { configText, tempDir, type TempDir } from '../support.ts'

const RELAY_NAME = 'relay.example.test'
const HOME_NAME = 'studio.example.test'
const ECHO = 'hello through the relay'

interface Stack {
  readonly dir: TempDir
  readonly server: RelayServer
  readonly log: RelayLogHandle
  readonly homeKey: KeyObject
  readonly relayCertificate: string
  readonly homeCertificate: string
}

const stacks: Stack[] = []
afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await stack.server.close()
    stack.log.close()
    stack.dir.remove()
  }
})

/** A self-signed certificate for one name. */
function certificateFor(name: string): { readonly cert: string; readonly key: string } {
  const { cert, private: key } = generate([{ name: 'commonName', value: name }], {
    keySize: 2048,
    days: 30,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: name }] },
    ],
  })
  return { cert, key }
}

/** Start the relay and the files its configuration names. */
async function stack(): Promise<Stack> {
  const dir = tempDir('delo-relay-e2e-')
  const relay = certificateFor(RELAY_NAME)
  const home = certificateFor(HOME_NAME)
  mkdirSync(join(dir.dir, 'tls'), { recursive: true })
  writeFileSync(join(dir.dir, 'tls', 'relay-cert.pem'), relay.cert)
  writeFileSync(join(dir.dir, 'tls', 'relay-key.pem'), relay.key, { mode: 0o600 })
  writeFileSync(join(dir.dir, 'tls', 'home-cert.pem'), home.cert)
  writeFileSync(join(dir.dir, 'tls', 'home-key.pem'), home.key, { mode: 0o600 })
  const homeKey = generateEd25519()
  const settings = parseRelayConfig(
    configText({
      bindings: [{ name: HOME_NAME, homeKey }],
      tunnelHost: RELAY_NAME,
      stateDir: join(dir.dir, 'state'),
      tunnelCertFile: join(dir.dir, 'tls', 'relay-cert.pem'),
      tunnelKeyFile: join(dir.dir, 'tls', 'relay-key.pem'),
    }),
    { tokenKey: generateEd25519(), now: Date.now },
  )
  const log = openRelayLog({ dir: join(dir.dir, 'logs') })
  const server = await startRelayServer({ settings, log: log.log, port: 0, host: '127.0.0.1' })
  const started: Stack = { dir, server, log, homeKey, relayCertificate: relay.cert, homeCertificate: home.cert }
  stacks.push(started)
  return started
}

/** A token request signed by the home key. */
function requestBody(homeKey: KeyObject, timestamp: number): string {
  const homePublicKey = toBase64Url(rawPublicKey(homeKey))
  const signed = { name: HOME_NAME, homePublicKey, timestamp, v: RELAY_PROTOCOL_VERSION }
  return JSON.stringify({ ...signed, signature: toBase64Url(signBytes(homeKey, utf8(canonicalJson(signed)))) })
}

/** `POST /v1/tunnel-token` over the relay's TLS. */
function tokenRequest(started: Stack, body: string): Promise<{ readonly status: number; readonly text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port: started.server.port,
        servername: RELAY_NAME,
        ca: started.relayCertificate,
        method: 'POST',
        path: RELAY_PATHS.tunnelToken,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      },
      response => {
        let text = ''
        response.on('data', chunk => {
          text += String(chunk)
        })
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, text })
        })
      },
    )
    request.on('error', reject)
    request.end(body)
  })
}

/** A browser connection that trusts the home's certificate and asks for the home's name. */
function browser(started: Stack): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port: started.server.port, servername: HOME_NAME, ca: started.homeCertificate }, () => {
      resolve(socket)
    })
    socket.on('error', reject)
  })
}

/** Await one line the browser receives. */
function readOnce(socket: TLSSocket): Promise<string> {
  return new Promise(resolve => {
    socket.once('data', chunk => {
      resolve(String(chunk))
    })
  })
}

describe('the data plane over loopback', () => {
  it('completes a browser\'s TLS handshake with the home\'s certificate, which the relay does not hold', async () => {
    const started = await stack()
    const issued = await tokenRequest(started, requestBody(started.homeKey, Date.now()))
    expect(issued.status).toBe(200)
    const token = (JSON.parse(issued.text) as { token: string }).token
    const home = await FixtureHome.connect({
      url: `wss://127.0.0.1:${String(started.server.port)}${RELAY_PATHS.tunnel}`,
      relayName: RELAY_NAME,
      relayCertificate: started.relayCertificate,
      name: HOME_NAME,
      homeKey: started.homeKey,
      token,
      certificateFile: join(started.dir.dir, 'tls', 'home-cert.pem'),
      keyFile: join(started.dir.dir, 'tls', 'home-key.pem'),
      relayId: started.server.core.relayId,
    })
    expect(home.messages.map(message => message.type)).toEqual(['challenge', 'ready'])
    const socket = await browser(started)
    expect(socket.authorized).toBe(true)
    const peer = socket.getPeerCertificate()
    expect(peer.fingerprint256).toBe(new X509Certificate(started.homeCertificate).fingerprint256)
    expect(peer.fingerprint256).not.toBe(new X509Certificate(started.relayCertificate).fingerprint256)
    expect(home.opens).toHaveLength(1)
    expect(home.opens[0]?.sni).toBe(HOME_NAME)
    socket.destroy()
    home.close()
  }, 20_000)

  it('carries the browser\'s bytes to the home and back, with the peer facts the relay observed', async () => {
    const started = await stack()
    const token = (JSON.parse((await tokenRequest(started, requestBody(started.homeKey, Date.now()))).text) as { token: string }).token
    const home = await FixtureHome.connect({
      url: `wss://127.0.0.1:${String(started.server.port)}${RELAY_PATHS.tunnel}`,
      relayName: RELAY_NAME,
      relayCertificate: started.relayCertificate,
      name: HOME_NAME,
      homeKey: started.homeKey,
      token,
      certificateFile: join(started.dir.dir, 'tls', 'home-cert.pem'),
      keyFile: join(started.dir.dir, 'tls', 'home-key.pem'),
      relayId: started.server.core.relayId,
    })
    const socket = await browser(started)
    const localPort = socket.localPort
    const echoed = readOnce(socket)
    socket.write(ECHO)
    expect(await echoed).toBe(ECHO)
    expect(home.received(1).toString('utf8')).toBe(ECHO)
    expect(home.opens[0]?.clientAddress).toBe('127.0.0.1')
    expect(home.opens[0]?.clientPort).toBe(localPort)
    socket.destroy()
    home.close()
  }, 20_000)

  it('writes no plaintext of the stream to its log', async () => {
    const started = await stack()
    const token = (JSON.parse((await tokenRequest(started, requestBody(started.homeKey, Date.now()))).text) as { token: string }).token
    const home = await FixtureHome.connect({
      url: `wss://127.0.0.1:${String(started.server.port)}${RELAY_PATHS.tunnel}`,
      relayName: RELAY_NAME,
      relayCertificate: started.relayCertificate,
      name: HOME_NAME,
      homeKey: started.homeKey,
      token,
      certificateFile: join(started.dir.dir, 'tls', 'home-cert.pem'),
      keyFile: join(started.dir.dir, 'tls', 'home-key.pem'),
      relayId: started.server.core.relayId,
    })
    const socket = await browser(started)
    const echoed = readOnce(socket)
    socket.write(ECHO)
    await echoed
    started.log.close()
    const text = readFileSync(join(started.dir.dir, 'logs', 'relay.log'), 'utf8')
    expect(text).toContain('browser connection routed')
    expect(text).not.toContain(ECHO)
    expect(text).not.toContain(token)
    socket.destroy()
    home.close()
  }, 20_000)

  it('answers a refused token request with C6\'s status and code', async () => {
    const started = await stack()
    const refused = await tokenRequest(started, JSON.stringify({ v: 1 }))
    expect(refused.status).toBe(400)
    expect(JSON.parse(refused.text)).toMatchObject({ error: 'TOKEN_REQUEST_INVALID' })
    const unboundBody = requestBody(started.homeKey, Date.now()).replace(HOME_NAME, 'unbound.example.test')
    const unbound = await tokenRequest(started, unboundBody)
    expect(unbound.status).toBe(403)
    expect(JSON.parse(unbound.text)).toMatchObject({ error: 'NAME_NOT_BOUND' })
  }, 20_000)
})
