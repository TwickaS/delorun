/**
 * Specs of Delorun's egress proxy on a real Unix socket, with a resolver and a dialer that map documentation addresses
 * (`203.0.113.0/24`, which the fetch guard allows) to local listeners, so no request leaves the machine: a listed host
 * is tunnelled and forwarded, an unlisted one is refused before any lookup, a listed name that resolves to a refused
 * address is refused, a port no entry admits is refused, a forwarded request carries the checked host, every refusal
 * is reported, the proxy refuses a connection beyond its cap and closes an idle one, and closing it ends its tunnels.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EgressProxy, parseAuthority, refusalSentence, type EgressRefusal, type ResolvedAddress } from '../src/egress-proxy.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** Close a server and its open connections. */
function closer(server: Server): () => Promise<void> {
  return () => new Promise((resolve) => { server.close(() => { resolve() }); (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.() })
}

/** A TCP server that echoes every byte back, on loopback. */
async function echoServer(): Promise<number> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => { sockets.add(socket); socket.pipe(socket) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(async () => { for (const socket of sockets) socket.destroy(); await closer(server)() })
  return (server.address() as { port: number }).port
}

/** An HTTP server that answers with the request's method, path and Host header. */
async function httpServer(): Promise<number> {
  const server = createHttpServer((request, response) => {
    response.writeHead(201, { 'x-origin': 'yes' })
    response.end(`${request.method} ${request.url} ${request.headers.host} ${request.headers['proxy-connection'] ?? 'no-proxy-header'}`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(closer(server))
  return (server.address() as { port: number }).port
}

interface Started {
  readonly socket: string
  readonly proxy: EgressProxy
  readonly refusals: EgressRefusal[]
  readonly lookups: string[]
}

/**
 * Start a proxy for `hosts` whose resolver answers from `names` and whose dialer sends every `203.0.113.0/24` address to
 * the loopback port `target`.
 */
async function started(hosts: readonly string[], names: Record<string, readonly string[]>, target: number, limits: { readonly maxConnections?: number, readonly idleTimeoutMs?: number } = {}): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'delorun-egress-'))
  const socket = join(dir, 'p.sock')
  const refusals: EgressRefusal[] = []
  const lookups: string[] = []
  const proxy = new EgressProxy({
    socket,
    hosts,
    connectTimeoutMs: 2_000,
    maxConnections: limits.maxConnections ?? 8,
    idleTimeoutMs: limits.idleTimeoutMs ?? 60_000,
    onRefusal: (refusal) => { refusals.push(refusal) },
    resolve: (host) => {
      lookups.push(host)
      const addresses = names[host]
      return addresses === undefined
        ? Promise.reject(new Error(`no answer for ${host}`))
        : Promise.resolve(addresses.map((address): ResolvedAddress => ({ address, family: address.includes(':') ? 6 : 4 })))
    },
    // Any other address goes to a closed loopback port, so its connection fails at once.
    dial: (address) => connect({ host: '127.0.0.1', port: address.startsWith('203.0.113.') ? target : 1 }),
  })
  await proxy.listen()
  closers.push(async () => { await proxy.close(); rmSync(dir, { recursive: true, force: true }) })
  return { socket, proxy, refusals, lookups }
}

/** Send raw bytes to the proxy and collect everything it answers until it closes or `until` matches. */
function exchange(socket: string, request: string, then?: string, until?: RegExp): Promise<string> {
  return new Promise((resolve) => {
    const client = connect(socket, () => { client.write(request) })
    let answer = ''
    client.on('data', (data) => {
      answer += data.toString()
      if (then !== undefined && answer.includes('\r\n\r\n') && answer.startsWith('HTTP/1.1 200')) {
        client.write(then)
        then = undefined
      }
      if (until?.test(answer) === true) { client.destroy(); resolve(answer) }
    })
    client.on('close', () => { resolve(answer) })
    client.on('error', () => { resolve(answer) })
  })
}

describe('CONNECT tunnels', () => {
  it('tunnels to a listed host at the address it resolved to', async () => {
    const { socket, refusals } = await started(['allowed.example'], { 'allowed.example': ['203.0.113.10'] }, await echoServer())
    const answer = await exchange(socket, 'CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n', 'ping', /ping$/u)
    expect(answer).toBe('HTTP/1.1 200 Connection Established\r\n\r\nping')
    expect(refusals).toEqual([])
  })

  it('refuses an unlisted host without looking it up, so DNS carries nothing out', async () => {
    const { socket, refusals, lookups } = await started(['allowed.example'], { 'secret.attacker.example': ['203.0.113.66'] }, await echoServer())
    const answer = await exchange(socket, 'CONNECT secret.attacker.example:443 HTTP/1.1\r\n\r\n')
    expect(answer).toMatch(/^HTTP\/1\.1 403 Host not on this workspace's network allowlist\r\n/u)
    expect(answer).toContain('refused "secret.attacker.example"')
    expect(lookups).toEqual([])
    expect(refusals).toEqual([{ host: 'secret.attacker.example', port: 443, code: 'not-listed' }])
  })

  it.each([
    ['10.0.0.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['::ffff:192.168.0.9', 'private'],
  ])('refuses a listed name that resolves to %s (%s)', async (address, code) => {
    const { socket, refusals } = await started(['allowed.example'], { 'allowed.example': ['203.0.113.10', address] }, await echoServer())
    const answer = await exchange(socket, 'CONNECT allowed.example:443 HTTP/1.1\r\n\r\n')
    expect(answer).toMatch(/^HTTP\/1\.1 403 Host resolves to a refused address\r\n/u)
    expect(refusals).toEqual([{ host: 'allowed.example', port: 443, code }])
  })

  it('refuses a listed private address literal and allows a listed public one without a lookup', async () => {
    const { socket, lookups } = await started(['203.0.113.10:22', '*.example'], {}, await echoServer())
    expect(await exchange(socket, 'CONNECT 203.0.113.10:22 HTTP/1.1\r\n\r\n', 'x', /x$/u)).toBe('HTTP/1.1 200 Connection Established\r\n\r\nx')
    expect(await exchange(socket, 'CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 403 /u)
    expect(lookups).toEqual([])
  })

  it('matches a wildcard entry below its domain only', async () => {
    const { socket, refusals } = await started(['*.npmjs.org'], { 'registry.npmjs.org': ['203.0.113.10'], 'npmjs.org': ['203.0.113.10'] }, await echoServer())
    expect(await exchange(socket, 'CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n', 'y', /y$/u)).toBe('HTTP/1.1 200 Connection Established\r\n\r\ny')
    expect(await exchange(socket, 'CONNECT npmjs.org:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 403 /u)
    expect(refusals.map(refusal => refusal.code)).toEqual(['not-listed'])
  })

  it('refuses a listed host on a port no entry admits without looking it up, and admits the port an entry names', async () => {
    const { socket, refusals, lookups } = await started(['allowed.example', 'git.example:22'], { 'allowed.example': ['203.0.113.10'], 'git.example': ['203.0.113.10'] }, await echoServer())
    const answer = await exchange(socket, 'CONNECT allowed.example:22 HTTP/1.1\r\n\r\n')
    expect(answer).toMatch(/^HTTP\/1\.1 403 Port not on this workspace's network allowlist\r\n/u)
    expect(answer).toContain('such as allowed.example:22')
    expect(await exchange(socket, 'CONNECT git.example:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 403 Port not on /u)
    expect(lookups).toEqual([])
    expect(await exchange(socket, 'CONNECT git.example:22 HTTP/1.1\r\n\r\n', 'z', /z$/u)).toBe('HTTP/1.1 200 Connection Established\r\n\r\nz')
    expect(await exchange(socket, 'CONNECT allowed.example:80 HTTP/1.1\r\n\r\n', 'w', /w$/u)).toBe('HTTP/1.1 200 Connection Established\r\n\r\nw')
    expect(refusals).toEqual([{ host: 'allowed.example', port: 22, code: 'port-not-listed' }, { host: 'git.example', port: 443, code: 'port-not-listed' }])
  })

  it('answers 502 for a listed host that does not resolve or that no address answers', async () => {
    const { socket, refusals } = await started(['gone.example', 'dark.example'], { 'dark.example': ['198.51.100.1'] }, await echoServer())
    expect(await exchange(socket, 'CONNECT gone.example:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 502 Listed host did not resolve\r\n/u)
    expect(refusals).toEqual([{ host: 'gone.example', port: 443, code: 'unresolved' }])
    expect(await exchange(socket, 'CONNECT dark.example:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/u)
  })

  it('refuses a CONNECT target without a valid port', async () => {
    const { socket, refusals } = await started(['allowed.example'], {}, await echoServer())
    expect(await exchange(socket, 'CONNECT allowed.example HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 400 Not a proxy request\r\n/u)
    expect(refusals).toEqual([{ host: 'allowed.example', port: 0, code: 'bad-request' }])
  })

  it('ends open tunnels when the proxy closes', async () => {
    const { socket, proxy } = await started(['allowed.example'], { 'allowed.example': ['203.0.113.10'] }, await echoServer())
    const client = connect(socket, () => { client.write('CONNECT allowed.example:443 HTTP/1.1\r\n\r\n') })
    await new Promise<void>((resolve) => { client.once('data', () => { resolve() }) })
    const closed = new Promise<void>((resolve) => { client.on('close', () => { resolve() }) })
    await proxy.close()
    await closed
    expect(client.destroyed).toBe(true)
  })
})

describe('absolute http:// requests', () => {
  it('forwards a listed host\'s request to the address it resolved to, without the proxy\'s own headers', async () => {
    const { socket } = await started(['allowed.example'], { 'allowed.example': ['203.0.113.10'] }, await httpServer())
    const answer = await exchange(socket, 'GET http://allowed.example/path?q=1 HTTP/1.1\r\nHost: allowed.example\r\nProxy-Connection: keep-alive\r\nConnection: close\r\n\r\n')
    expect(answer).toMatch(/^HTTP\/1\.1 201 Created\r\n/u)
    expect(answer).toContain('x-origin: yes')
    expect(answer).toContain('GET /path?q=1 allowed.example no-proxy-header')
  })

  it('refuses an unlisted host and a request that is not an absolute http:// URL', async () => {
    const { socket, refusals, lookups } = await started(['allowed.example'], {}, await httpServer())
    expect(await exchange(socket, 'GET http://other.example/ HTTP/1.1\r\nHost: other.example\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 403 Host not on this workspace's network allowlist\r\n/u)
    expect(await exchange(socket, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 400 /u)
    expect(await exchange(socket, 'GET https://allowed.example/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 400 /u)
    expect(lookups).toEqual([])
    expect(refusals.map(refusal => refusal.code)).toEqual(['not-listed', 'bad-request', 'bad-request'])
  })

  it('refuses a listed name that resolves to a private address, and answers 502 when no address answers', async () => {
    const { socket, refusals } = await started(['private.example', 'dark.example'], { 'private.example': ['192.168.0.9'], 'dark.example': ['198.51.100.1'] }, await httpServer())
    expect(await exchange(socket, 'GET http://private.example/ HTTP/1.1\r\nHost: private.example\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 403 Host resolves to a refused address\r\n/u)
    expect(refusals).toEqual([{ host: 'private.example', port: 80, code: 'private' }])
    expect(await exchange(socket, 'GET http://dark.example/ HTTP/1.1\r\nHost: dark.example\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 502 /u)
  })

  it('sends the host of the checked URL, never another Host the command sent', async () => {
    const { socket } = await started(['allowed.example', 'alt.example:8080'], { 'allowed.example': ['203.0.113.10'], 'alt.example': ['203.0.113.10'] }, await httpServer())
    expect(await exchange(socket, 'GET http://allowed.example/a HTTP/1.1\r\nHost: internal.example\r\nConnection: close\r\n\r\n')).toContain('GET /a allowed.example no-proxy-header')
    expect(await exchange(socket, 'GET http://alt.example:8080/b HTTP/1.1\r\nHost: internal.example\r\nConnection: close\r\n\r\n')).toContain('GET /b alt.example:8080 no-proxy-header')
  })
})

describe('connection limits', () => {
  /** Open a connection to the proxy and wait until it is accepted. */
  async function opened(socket: string): Promise<Socket> {
    const client = connect(socket)
    closers.push(() => { client.destroy(); return Promise.resolve() })
    await new Promise<void>((resolve) => { client.once('connect', () => { resolve() }) })
    return client
  }

  it('refuses a connection beyond its cap with a sentence, serves none of its requests, and accepts again once one closes', async () => {
    const { socket, refusals, lookups } = await started(['allowed.example'], { 'allowed.example': ['203.0.113.10'] }, await echoServer(), { maxConnections: 2 })
    const first = await opened(socket)
    await opened(socket)
    const refused = await exchange(socket, 'CONNECT allowed.example:443 HTTP/1.1\r\n\r\n')
    expect(refused).toMatch(/^HTTP\/1\.1 503 Too many connections through this allowlist\r\n/u)
    expect(refused).toContain('as many connections through this workspace\'s allowlist are open as it allows')
    expect(lookups).toEqual([])
    expect(refusals).toEqual([{ host: '', port: 0, code: 'busy' }])
    const closed = new Promise<void>((resolve) => { first.once('close', () => { resolve() }) })
    first.destroy()
    await closed
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await exchange(socket, 'CONNECT allowed.example:443 HTTP/1.1\r\n\r\n', 'ok', /ok$/u)).toBe('HTTP/1.1 200 Connection Established\r\n\r\nok')
  })

  it('closes a tunnel that carries no byte for its idle time, and keeps one that does', async () => {
    const { socket } = await started(['allowed.example'], { 'allowed.example': ['203.0.113.10'] }, await echoServer(), { idleTimeoutMs: 300 })
    const idle = connect(socket, () => { idle.write('CONNECT allowed.example:443 HTTP/1.1\r\n\r\n') })
    const busy = connect(socket, () => { busy.write('CONNECT allowed.example:443 HTTP/1.1\r\n\r\n') })
    closers.push(() => { idle.destroy(); busy.destroy(); return Promise.resolve() })
    await Promise.all([idle, busy].map(client => new Promise<void>((resolve) => { client.once('data', () => { resolve() }) })))
    const idleClosed = new Promise<number>((resolve) => { idle.once('close', () => { resolve(Date.now()) }) })
    const start = Date.now()
    const timer = setInterval(() => { busy.write('.') }, 100)
    const closedAt = await idleClosed
    expect(closedAt - start).toBeGreaterThanOrEqual(250)
    await new Promise(resolve => setTimeout(resolve, 400))
    clearInterval(timer)
    expect(busy.destroyed).toBe(false)
  })
})

describe('the refusal text and the authority parser', () => {
  it('names the host and what to do', () => {
    expect(refusalSentence({ host: 'x.example', port: 443, code: 'not-listed' })).toContain('Settings, Network')
    expect(refusalSentence({ host: 'x.example', port: 443, code: 'loopback' })).toContain('a loopback address')
    expect(refusalSentence({ host: 'x.example', port: 443, code: 'unresolved' })).toContain('could not resolve')
    expect(refusalSentence({ host: '', port: 0, code: 'bad-request' })).toContain('CONNECT host:port')
    expect(refusalSentence({ host: 'x.example', port: 22, code: 'port-not-listed' })).toContain('ports 80 and 443 unless an entry names another port, such as x.example:22')
    expect(refusalSentence({ host: '', port: 0, code: 'busy' })).toContain('Close some and try again')
  })

  it('splits host and port, IPv6 brackets included, and refuses a missing or out-of-range port', () => {
    expect(parseAuthority('Example.COM:443')).toEqual({ host: 'example.com', port: 443 })
    expect(parseAuthority('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 })
    expect(parseAuthority('example.com')).toBeUndefined()
    expect(parseAuthority(':443')).toBeUndefined()
    expect(parseAuthority('example.com:0')).toBeUndefined()
    expect(parseAuthority('example.com:65536')).toBeUndefined()
    expect(parseAuthority('example.com:http')).toBeUndefined()
  })
})
