/**
 * Loopback plumbing shared by the stand-ins: an HTTPS server bound to `127.0.0.1` with a
 * certificate from the stack's test authority, bounded body reading, JSON answers, and an
 * HTTPS client that trusts only that authority. No stand-in binds another address.
 *
 * @module @delorun/tools/stack/loopback
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { createServer, request as httpsRequest, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TestAuthority } from './certificates.ts'

/** The only address a stand-in binds. */
export const LOOPBACK_HOST = '127.0.0.1'

/** Largest request body a stand-in reads; a longer body is answered 413. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024

/** A request handler that may answer asynchronously. */
export type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>

/** A running loopback HTTPS server. */
export interface LoopbackServer {
  /** `https://127.0.0.1:<port>`. */
  readonly origin: string
  readonly port: number
  /** Stop listening and end open connections. */
  readonly close: () => Promise<void>
}

/** A request body over {@link MAX_REQUEST_BODY_BYTES}. */
export class BodyTooLarge extends Error {
  constructor() {
    super(`request body over ${String(MAX_REQUEST_BODY_BYTES)} bytes`)
  }
}

/**
 * Start an HTTPS server on `127.0.0.1` with an ephemeral port and a certificate for `127.0.0.1`
 * and the given names. A handler that throws answers 500 with the error's message.
 * @param authority - the stack's test authority, which signs the server certificate.
 * @param dnsNames - further names the certificate carries.
 * @param handler - the request handler.
 * @returns the running server.
 */
export async function listenHttps(authority: TestAuthority, dnsNames: readonly string[], handler: Handler): Promise<LoopbackServer> {
  const certificate = await authority.issue({ dnsNames, ipAddresses: [LOOPBACK_HOST] })
  const server: Server = createServer({ key: certificate.keyPem, cert: certificate.pem }, (request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (error instanceof BodyTooLarge) {
        sendJson(response, 413, { error: 'body_too_large' })
        return
      }
      if (!response.headersSent) sendJson(response, 500, { error: 'stand_in_failure', message: error instanceof Error ? error.message : String(error) })
      else response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    origin: `https://${LOOPBACK_HOST}:${String(port)}`,
    port,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    },
  }
}

/**
 * Read a request body up to {@link MAX_REQUEST_BODY_BYTES}.
 * @param request - the request.
 * @returns the body bytes.
 * @throws BodyTooLarge when the body is longer.
 */
export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = chunk as Buffer
    length += bytes.length
    if (length > MAX_REQUEST_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

/**
 * Answer with a JSON body.
 * @param response - the response.
 * @param status - the HTTP status.
 * @param body - the value to serialise.
 * @param headers - further headers.
 */
export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(text)), ...headers })
  response.end(text)
}

/** A response read by {@link requestOverTls}. */
export interface TlsResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
  /**
   * The body parsed as JSON.
   * @returns the parsed value.
   */
  readonly json: () => unknown
}

/** A request for {@link requestOverTls}. */
export interface TlsRequest {
  /** The authority certificate PEM the client trusts; no other root is trusted. */
  readonly ca: string
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string | Uint8Array
}

/**
 * Send one HTTPS request that trusts only the given authority and follows no redirect.
 * @param url - an `https` URL.
 * @param options - the trusted authority, method, headers and body.
 * @returns the status, headers and body.
 */
export async function requestOverTls(url: string, options: TlsRequest): Promise<TlsResponse> {
  return new Promise((resolve, reject) => {
    const sent = httpsRequest(url, { method: options.method ?? 'GET', headers: options.headers, ca: options.ca, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body, json: (): unknown => JSON.parse(body.toString('utf8')) })
      })
    })
    sent.on('error', reject)
    sent.end(options.body)
  })
}
