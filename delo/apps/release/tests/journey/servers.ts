/**
 * The journey's servers, all in the spec's process on this computer's loopback address: the release channel, a static
 * server over the channel directory as GitHub Pages and GitHub Releases serve one; the release log, a stand-in that the
 * spec switches between agreeing, staying silent and contradicting the release, behind one origin because the launcher
 * reads the log at an origin fixed when it is built; and the model, upstream's `llm-mock-server` with a scripted
 * sequence. The containers reach each one through the forwarders of `machine.ts`, on the same port number.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import type { LogEndpoints } from '../../src/log/client.ts'
import { readEntryRequest } from '@delo/release-formats/log/entry'
import { LogStandIn } from '../log/standin.ts'
import type { Trust } from '../local/support.ts'

/** A server the journey started, with its port and the way to stop it. */
export interface Running {
  readonly port: number
  readonly origin: string
  close(): Promise<void>
}

/**
 * Listen on an OS-assigned loopback port.
 * @param server - the server.
 * @returns its port, origin and closer.
 */
async function listen(server: Server): Promise<Running> {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => done())
    }),
  }
}

/**
 * Serve a channel directory read-only.
 * @param directory - the channel directory `local-release.ts` writes.
 * @returns the server.
 */
export function serveChannel(directory: string): Promise<Running> {
  const root = resolve(directory)
  return listen(createServer((request, response) => {
    const path = join(root, new URL(request.url ?? '/', 'http://channel').pathname)
    if (!path.startsWith(`${root}/`) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-length': statSync(path).size })
    createReadStream(path).pipe(response)
  }))
}

/** How the log answers the launcher. */
export type LogMode = 'agree' | 'silent' | 'contradict'

/** The release log the spec runs. */
export interface JourneyLog extends Running {
  /** The endpoints `local-release.ts` submits to; they always reach the agreeing log. */
  readonly endpoints: LogEndpoints
  /** How the log answers reads from now on. */
  mode: LogMode
}

/**
 * Answer one request as the stand-in log answers it: Rekor v2's entry submission, the checkpoint the witness has
 * cosigned, and `tlog-tiles` under `/tile/` (a launcher's reads) and `/tiles/` (the release tooling's reads).
 * @param log - the log whose tree is served.
 * @param trusted - the witness that cosigns its checkpoints.
 * @param request - the request.
 * @param body - the request's body.
 * @param response - the response.
 */
function answerLog(log: LogStandIn, trusted: Trust, request: IncomingMessage, body: Buffer, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://log')
  if (url.pathname === '/api/v2/log/entries') {
    const index = log.submit(readEntryRequest(body))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ...(index === 0 ? {} : { logIndex: String(index) }), kindVersion: { kind: 'hashedrekord', version: '0.0.2' }, canonicalizedBody: log.body(index).toString('base64') }))
    return
  }
  if (url.pathname === '/checkpoint') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(trusted.witness.cosign(log.checkpoint(), Math.floor(Date.now() / 1000)))
    return
  }
  const path = url.pathname.startsWith('/tiles/') ? url.pathname.slice('/tiles/'.length) : url.pathname.startsWith('/tile/') ? url.pathname.slice(1) : undefined
  const tile = path === undefined ? undefined : log.tile(path)
  response.writeHead(tile === undefined ? 404 : 200, { 'content-type': 'application/octet-stream' })
  response.end(tile)
}

/**
 * Serve the release log at one origin. `agree` serves the log the releases were submitted to; `silent` closes every
 * connection before answering, as an unreachable log does; `contradict` serves a fork signed with the same log key and
 * cosigned by the same witness, which holds other entries and never held the releases, so its checkpoint is well formed
 * and signed but no consistency proof leads to it from a release's bundle.
 * @param trusted - the throwaway keys, the log and the witness.
 * @returns the log, in mode `agree`.
 */
export async function serveJourneyLog(trusted: Trust): Promise<JourneyLog> {
  const fork = Object.assign(new LogStandIn(), { key: trusted.log.key })
  for (let entry = 0; entry < 8; entry++) fork.append(Buffer.from(`an entry of a fork that never held a Delo release: ${String(entry)}`))
  const state = { mode: 'agree' as LogMode }
  const running = await listen(createServer((request, response) => {
    if (state.mode === 'silent' && request.method === 'GET') {
      request.socket.destroy()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => answerLog(state.mode === 'contradict' && request.method === 'GET' ? fork : trusted.log, trusted, request, Buffer.concat(chunks), response))
  }))
  return {
    ...running,
    endpoints: { submit: `${running.origin}/api/v2/log/entries`, checkpoint: `${running.origin}/checkpoint`, tiles: `${running.origin}/tiles/` },
    get mode() { return state.mode },
    set mode(next: LogMode) { state.mode = next },
  }
}

/** The text the scripted model answers every chat with, which the spec finds in the chat on disk. */
export const MODEL_REPLY = 'The journey model answers: the release under test is installed and talking.'

/**
 * Start upstream's mock model server, which answers every request with {@link MODEL_REPLY}.
 * @returns the server; `requests` records what it was asked.
 */
export function serveModel(): Promise<MockLlmServer> {
  return startMockLlmServer({ host: '127.0.0.1', port: 0, sequence: ['success'], repeatLast: true, successText: MODEL_REPLY })
}
