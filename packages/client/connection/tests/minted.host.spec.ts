/**
 * `authenticator/minted`: each loopback credential Connection mints, from the
 * launch-token exchange and from `/connect`, is announced once, before the
 * response that carries it is written, with the SHA-256 of its value and
 * never the value itself; requests that mint nothing announce nothing.
 */
import { createHash } from 'node:crypto'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply, inject, type MintedCredential } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

let contexts: Context[] = []
afterEach(async () => {
  const open = contexts
  contexts = []
  await Promise.all(open.map(ctx => ctx.fiber.dispose()))
})

interface Harness {
  readonly ctx: Context
  readonly port: number
  /** Each announcement, with how many responses had been written when it arrived. */
  readonly minted: { readonly credential: MintedCredential; readonly written: number }[]
  /** Responses written by the index fallback so far. */
  readonly written: { count: number }
}

async function start(): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  provideBrowserCredentials(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin({ inject: [...inject], apply })
  const written = { count: 0 }
  const minted: Harness['minted'] = []
  ctx.on('authenticator/minted', (credential) => { minted.push({ credential, written: written.count }) })
  ctx.webServer.registerFallback((req, res) => {
    const writeHead = res.writeHead.bind(res)
    res.writeHead = ((...args: Parameters<typeof writeHead>) => {
      written.count += 1
      return writeHead(...args)
    }) as typeof res.writeHead
    if (ctx.connection.authorizeIndex(req, res)) res.end('index')
  })
  return { ctx, port: ctx.webServer.port ?? 0, minted, written }
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; headers: IncomingHttpHeaders }>()
  const request = httpRequest({ host: '127.0.0.1', port, path, headers }, (response) => {
    response.resume()
    response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers }) })
  })
  request.on('error', reject)
  request.end()
  return promise
}

function cookieOf(headers: IncomingHttpHeaders): { readonly pair: string; readonly value: string } {
  const pair = headers['set-cookie']?.[0]?.split(';')[0] ?? ''
  return { pair, value: pair.slice(pair.indexOf('=') + 1) }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

describe('authenticator/minted', () => {
  it('announces the launch-token exchange\'s cookie before the response that sets it, by its hash only', async () => {
    const harness = await start()
    const token = new URL(harness.ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(harness.port)}/`)).search
    const before = Date.now()
    const reply = await get(harness.port, `/${token}`)
    expect(reply.status).toBe(303)
    const cookie = cookieOf(reply.headers)
    expect(harness.minted).toHaveLength(1)
    const [{ credential, written } = { credential: undefined, written: -1 }] = harness.minted
    expect(written).toBe(0)
    expect({ kind: credential?.kind, hash: credential?.hash, authority: credential?.authority, peer: credential?.peer }).toEqual({
      kind: 'browser',
      hash: sha256(cookie.value),
      authority: `127.0.0.1:${String(harness.port)}`,
      peer: undefined,
    })
    expect(credential?.issuedAt).toBeGreaterThanOrEqual(before)
    expect(credential?.expiresAt).toBe((credential?.issuedAt ?? 0) + 30 * 24 * 60 * 60 * 1000)
    expect(JSON.stringify(harness.minted)).not.toContain(cookie.value)
    // Using the cookie, and a wrong token, mint nothing.
    expect((await get(harness.port, '/', { cookie: cookie.pair })).status).toBe(200)
    expect((await get(harness.port, '/?token=wrong')).status).toBe(401)
    expect(harness.minted).toHaveLength(1)
  })

  it('announces each /connect cookie with the API Peer it admits', async () => {
    const harness = await start()
    const token = new URL(harness.ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(harness.port)}/`)).search
    const first = cookieOf((await get(harness.port, `/connect${token}`)).headers)
    const second = cookieOf((await get(harness.port, `/connect${token}&interactions=answer`)).headers)
    expect(harness.minted.map(entry => entry.credential.kind)).toEqual(['api', 'api'])
    expect(harness.minted.map(entry => entry.credential.hash)).toEqual([sha256(first.value), sha256(second.value)])
    const peers = harness.minted.map(entry => entry.credential.peer)
    expect(peers.every(peer => typeof peer === 'string' && peer.length > 0)).toBe(true)
    expect(new Set(peers).size).toBe(2)
    expect(JSON.stringify(harness.minted)).not.toContain(first.value)
    expect((await get(harness.port, '/connect?token=wrong')).status).toBe(401)
    expect(harness.minted).toHaveLength(2)
  })
})
