/**
 * Three local HTTPS servers for the clone specs that need a server which redirects a clone: one that answers a credential and
 * then redirects to the second, a second that records every request and wants a credential of its own, and one that redirects to
 * a `file://` URL. All three present the same self-signed certificate for 127.0.0.1, so one extra certificate authority
 * reaches every server. They reach no real host or account.
 * @module tests/fixtures/redirect-server
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:https'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The password the second server accepts, a fake value. */
const TARGET_PASSWORD = 'fixture-redirect-target-password-not-a-credential'

/** The text of the file the `file://` redirect points at. */
const CANARY_TEXT = 'CANARY-NOT-A-REPOSITORY\n'

/** One request a server received. */
export interface RedirectRequest {
  /** The request path and query. */
  readonly url: string
  /** The `Authorization` header, or null when the request had none. */
  readonly authorization: string | null
}

/** The running servers. */
export interface RedirectFixture {
  /** The origin of the server that answers a credential and then redirects to {@link targetOrigin}, `https://127.0.0.1:<port>`. */
  readonly firstOrigin: string
  /** The origin of the server on another port, which requires the credential of {@link targetPassword}. */
  readonly targetOrigin: string
  /** The origin of the server that redirects every request to the {@link canaryFile}. */
  readonly fileOrigin: string
  /** The PEM file of the certificate all three servers present. */
  readonly caFile: string
  /** The file the `file://` redirect names; its text is {@link CANARY_TEXT}. */
  readonly canaryFile: string
  /** The password the target server accepts, with the user name `x-access-token`. */
  readonly targetPassword: string
  /** The requests the first server received, in arrival order. */
  readonly first: readonly RedirectRequest[]
  /** The requests the target server received, in arrival order. */
  readonly target: readonly RedirectRequest[]
  /** How many requests the `file://` redirecting server received. */
  readonly fileRequests: () => number
  /** Stops the servers and removes the fixture's files. */
  close(): Promise<void>
}

/**
 * Start the three servers on free ports of 127.0.0.1.
 * @returns the running fixture.
 * @throws Error when openssl cannot make the certificate.
 */
export async function startRedirectFixture(): Promise<RedirectFixture> {
  const root = await mkdtemp(join(tmpdir(), 'delorun-redirect-fixture-'))
  const caFile = join(root, 'cert.pem')
  const keyFile = join(root, 'key.pem')
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', caFile, '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'])
  const tls = { key: await readFile(keyFile), cert: await readFile(caFile) }
  const canaryFile = join(root, 'canary.txt')
  await writeFile(canaryFile, CANARY_TEXT)
  const first: RedirectRequest[] = []
  const target: RedirectRequest[] = []
  let fileRequests = 0
  const expected = `Basic ${Buffer.from(`x-access-token:${TARGET_PASSWORD}`).toString('base64')}`
  const targetServer = await listen(tls, (req, res) => {
    target.push(recorded(req))
    if (req.headers.authorization === expected) res.writeHead(200).end()
    else res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture-target"' }).end()
  })
  const targetOrigin = originOf(targetServer)
  const firstServer = await listen(tls, (req, res) => {
    first.push(recorded(req))
    // The first request is refused, so git asks its credential helper and holds the credential when the redirect arrives.
    if (req.headers.authorization === undefined) res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture-first"' }).end()
    else res.writeHead(301, { Location: `${targetOrigin}${req.url ?? '/'}` }).end()
  })
  const fileServer = await listen(tls, (_req, res) => {
    fileRequests += 1
    res.writeHead(302, { Location: `file://${canaryFile}` }).end()
  })
  const servers = [firstServer, targetServer, fileServer]
  return {
    firstOrigin: originOf(firstServer),
    targetOrigin,
    fileOrigin: originOf(fileServer),
    caFile,
    canaryFile,
    targetPassword: TARGET_PASSWORD,
    first,
    target,
    fileRequests: () => fileRequests,
    close: async () => {
      for (const server of servers) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Start one HTTPS server on a free port of 127.0.0.1.
 * @param tls - the key and certificate.
 * @param handler - answers each request.
 * @returns the listening server.
 */
async function listen(tls: { readonly key: Buffer, readonly cert: Buffer }, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer(tls, handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  return server
}

/**
 * The origin of a listening server.
 * @param server - the server.
 * @returns `https://127.0.0.1:<port>`.
 * @throws Error when the server has no TCP address.
 */
function originOf(server: Server): string {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the redirect fixture server has no TCP address')
  return `https://127.0.0.1:${address.port}`
}

/**
 * What a spec checks about a request.
 * @param req - the request.
 * @returns its URL and authorization.
 */
function recorded(req: IncomingMessage): RedirectRequest {
  return { url: req.url ?? '/', authorization: req.headers.authorization ?? null }
}
